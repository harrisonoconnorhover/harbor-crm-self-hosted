import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {delimiter,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import postgres from 'postgres';
import S3rver from '@20minutes/s3rver';

const host='127.0.0.1';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
const pgBin=process.env.HARBOR_TEST_PG_BIN;
const env={PATH:[pgBin,process.env.PATH].filter(Boolean).join(delimiter),
  HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG};

function checkPrerequisites(){
  if(!['darwin','linux'].includes(process.platform)||!['arm64','x64'].includes(process.arch)||process.getuid?.()===0){
    throw Error('Run the portable fixtures as a normal user on arm64 or x64 macOS or Linux.');
  }
  if(pgBin&&!isAbsolute(pgBin))throw Error('HARBOR_TEST_PG_BIN must be an absolute directory.');
  const versions=['pg_dump','pg_restore','psql'].map(tool=>{
    const result=spawnSync(tool,['--version'],{env,encoding:'utf8',timeout:3000});
    return result.status===0?Number(result.stdout.match(/\(PostgreSQL\) (\d+)/)?.[1]):0;
  });
  if(versions[0]<18||!versions.every(version=>version===versions[0])){
    throw Error('Put matching PostgreSQL 18 or newer client tools on PATH or set HARBOR_TEST_PG_BIN.');
  }
}

async function freePort(){
  const socket=createServer().listen(0,host);
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  return port;
}

const cleanup=[];
let child,interrupted;
function signalTestGroup(signal){
  if(!child?.pid)return;
  try{process.kill(-child.pid,signal);}
  catch(error){if(error.code!=='ESRCH')throw error;}
}
function interrupt(signal){
  interrupted=signal;
  if(child?.exitCode===null&&child.signalCode===null)signalTestGroup(signal);
}
process.on('SIGINT',interrupt);
process.on('SIGTERM',interrupt);

async function fixtureCertificate(root){
  const key=join(root,'key.pem'),cert=join(root,'cert.pem'),config=join(root,'openssl.cnf');
  await writeFile(config,`[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Harbor synthetic acceptance fixture
[ext]
subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:fictional-private-bucket.storage.harbor.test
basicConstraints=critical,CA:true
`,{mode:0o600});
  const result=spawnSync('openssl',['req','-new','-x509','-nodes','-newkey','rsa:2048','-days','1',
    '-config',config,'-keyout',key,'-out',cert],{env,stdio:'ignore',timeout:10_000});
  if(result.status!==0)throw Error('Install OpenSSL and make it available on PATH for the loopback TLS fixture.');
  return {key,cert};
}

async function secureStorageProxy(port,certificate){
  const server=httpsServer({key:await readFile(certificate.key),cert:await readFile(certificate.cert)},(request,response)=>{
    const forward=httpRequest({hostname:host,port,path:request.url,method:request.method,headers:request.headers},upstream=>{
      response.writeHead(upstream.statusCode,upstream.headers);
      upstream.pipe(response);
    });
    forward.on('error',()=>{
      if(!response.headersSent)response.writeHead(502);
      response.end();
    });
    request.on('aborted',()=>forward.destroy());
    request.pipe(forward);
  });
  server.listen(0,host);
  await once(server,'listening');
  cleanup.push(()=>new Promise((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
    server.closeAllConnections();
  }));
  return 'https://'+host+':'+server.address().port;
}

async function fixture(root,name,certificate,binaries){
  const port=await freePort(),password=randomBytes(24).toString('hex');
  const database=join(root,name),passwordFile=join(root,name+'-password');
  await writeFile(passwordFile,password+'\n',{mode:0o600});
  try{
    const init=spawnSync(binaries.initdb,['-D',database,'--encoding=UTF8','--username=postgres','--auth=scram-sha-256',
      '--pwfile='+passwordFile],{env,stdio:'ignore',timeout:15000});
    if(init.status!==0)throw Error('Could not initialize the disposable Postgres database.');
  }finally{await unlink(passwordFile);}
  const server=spawn(binaries.postgres,['-D',database,'-p',String(port),'-c','listen_addresses='+host,
    '-c','unix_socket_directories=','-c','ssl=on','-c','ssl_cert_file='+certificate.cert,
    '-c','ssl_key_file='+certificate.key],{env,stdio:'ignore'});
  const stopped=once(server,'close');
  void stopped.catch(()=>{});
  cleanup.push(async()=>{
    if(server.exitCode===null&&server.signalCode===null)server.kill('SIGINT');
    await stopped;
  });
  const base='postgres://postgres:'+password+'@'+host+':'+port+'/';
  const admin=postgres(base+'postgres',{ssl:false,max:1,connect_timeout:1});
  try{
    let ready=false;
    for(let attempt=0;attempt<40&&!ready&&!interrupted&&server.exitCode===null;attempt++){
      ready=await admin`SELECT 1`.then(()=>true,()=>false);
      if(!ready)await delay(100);
    }
    if(!ready)throw Error('Could not start the disposable Postgres server.');
    await admin`CREATE DATABASE ${admin(name)}`;
  }finally{await admin.end({timeout:3});}
  // Keep the old simulator's SigV4 behavior for SDK-signed bucket paths.
  const store=new S3rver({address:host,port:0,directory:join(root,name+'-s3'),silent:true,allowMismatchedSignatures:true});
  const address=await store.run();
  cleanup.push(()=>store.close());
  const secureS3=await secureStorageProxy(address.port,certificate);
  return {db:base+name,s3:'http://'+host+':'+address.port,secureS3};
}

try{
  checkPrerequisites();
  process.umask(0o077);
  const root=await mkdtemp(join(tmpdir(),'harbor-portable-test.'));
  cleanup.push(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const certificate=await fixtureCertificate(root);
  const binaries=await import('@embedded-postgres/'+process.platform+'-'+process.arch);
  const source=await fixture(root,'harbor_identity_test',certificate,binaries);
  if(!interrupted){
    const target=await fixture(root,'harbor_restore_test',certificate,binaries);
    if(!interrupted){
      child=spawn(process.execPath,['--test','tests/portable-web.test.mjs'],{cwd,stdio:'inherit',detached:true,env:{
        ...env,TMPDIR:root,HARBOR_TEST_MONITOR_ROLE:'true',NODE_EXTRA_CA_CERTS:certificate.cert,PGSSLROOTCERT:certificate.cert,
        HARBOR_TEST_TLS_KEY:certificate.key,
        HARBOR_TEST_POSTGRES_URL:source.db,HARBOR_TEST_S3_ENDPOINT:source.s3,
        HARBOR_TEST_RESTORE_POSTGRES_URL:target.db,HARBOR_TEST_RESTORE_S3_ENDPOINT:target.s3,
        HARBOR_TEST_HOSTED_S3_ENDPOINT:source.secureS3,HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT:target.secureS3,
        HARBOR_TEST_RESTORE_POSTGRES_SSLMODE:'verify-full',
        HARBOR_TEST_SUITE_TIMEOUT_MS:process.env.HARBOR_TEST_SUITE_TIMEOUT_MS,
        HARBOR_TEST_RECOVERY_ONLY:process.env.HARBOR_TEST_RECOVERY_ONLY,
        HARBOR_TEST_RAILWAY_ROLLBACK_COMMAND:process.env.HARBOR_TEST_RAILWAY_ROLLBACK_COMMAND,
      }});
      const [code]=await once(child,'exit');
      if(interrupted)signalTestGroup('SIGKILL');
      process.exitCode=code??1;
    }
  }
}catch(error){
  console.error(error instanceof Error?error.message:'The local Harbor fixture could not start.');
  process.exitCode=1;
}finally{
  for(const close of cleanup.reverse()){
    try{await close();}
    catch{
      console.error('Could not finish cleaning up a local Harbor fixture.');
      process.exitCode=1;
    }
  }
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',interrupt);
  if(interrupted)process.exitCode=interrupted==='SIGINT'?130:143;
}
