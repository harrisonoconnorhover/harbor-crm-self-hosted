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

async function fixture(root,name,certificate,binaries,postgresOptions=[]){
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
    '-c','ssl_key_file='+certificate.key,...postgresOptions],{env,stdio:'ignore'});
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
  const mode=process.argv.slice(2).join(' ');
  const web='tests/portable-web.test.mjs',identity='tests/portable-microsoft-identity.test.mjs';
  const saml='tests/portable-saml-identity.test.mjs';
  const suitesByMode=new Map([
    ['', [web,identity,saml]],
    ['--saml', [saml]],
    ['--keycloak', [saml]],
    ['--directory', [identity]],
    ['--team-upgrade', [identity]],
    ['--teams', [web]],
    ['--booking', [web]],
    ['--recovery', [web]],
    ['--sales-week', [web]],
    ['--custom-objects', [web]],
    ['--team-inbox', [web]],
    ['--webhooks', [web]],
    ['--workflow-webhooks', [web]],
    ['--ticket-workflows', [web]],
    ['--company-workflows', [web]],
    ['--custom-record-workflows', [web]],
    ['--external-writes', [web]],
    ['--deal-tasks', [web]],
    ['--quote-signing', [web]],
    ['--aircall', [web]],
    ['--commerce-search', [web]],
    ['--contact-archive', [web]],
    ['--file-access', [web]],
    ['--file-search', [web]],
    ['--record-list-search', [web]],
    ['--inquiry-search', [web]],
    ['--stripe-invoices', [web]],
    ['--lists', [web]],
    ['--navigation', [web]],
    ['--settings', [web]],
    ['--conditional-paths', [web]],
    ['--branch-steps', [web]],
    ['--pool', [web]],
    ['--sales-sequences', ['tests/portable-sales-sequence-store.test.mjs','tests/portable-sales-sequence-processor.test.mjs',web]],
    ['--record-reporting', [web]],
    ['--web-attribution', [web]],
    ['--landing-pages', [web]],
    ['--help-center', [web]],
    ['--access-history', [web]],
    ['--first-response', [web]],
    ['--search', ['tests/portable-search-upgrade.test.mjs',web]],
    ['--campaign-replicas', ['tests/portable-marketing-operator.test.mjs']],
    ['--marketing', ['audience','designs','native-render','forms','suppression-import','suppression-export','campaign','operator','drain']
      .map(name=>'tests/portable-marketing-'+name+'.test.mjs')],
  ]);
  const suites=suitesByMode.get(mode);
  if(!suites)throw Error('Choose --sales-week, --recovery, --saml, --keycloak, --directory, --team-upgrade, --marketing, --campaign-replicas, --teams, --booking, --help-center, --landing-pages, --custom-objects, --team-inbox, --web-attribution, --first-response, --access-history, --webhooks, --workflow-webhooks, --ticket-workflows, --company-workflows, --custom-record-workflows, --external-writes, --quote-signing, --contact-archive, --file-access, --file-search, --record-list-search, --inquiry-search, --commerce-search, --stripe-invoices, --aircall, --lists, --settings, --navigation, --branch-steps, --conditional-paths, --deal-tasks, --sales-sequences, --record-reporting, --pool or --search for a focused rehearsal.');
  if(mode==='--team-upgrade'&&!isAbsolute(process.env.HARBOR_TEST_UPGRADE_BUNDLE??''))throw Error('Set HARBOR_TEST_UPGRADE_BUNDLE to the absolute path of a local pre-team backup.');
  checkPrerequisites();
  if(mode==='--pool'&&spawnSync(process.env.HARBOR_TEST_PGBOUNCER||'pgbouncer',['--version'],{stdio:'ignore',timeout:3000}).status!==0){
    throw Error('Install PgBouncer or point HARBOR_TEST_PGBOUNCER at its executable for the pool rehearsal.');
  }
  process.umask(0o077);
  const root=await mkdtemp(join(tmpdir(),'harbor-portable-test.'));
  cleanup.push(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const certificate=await fixtureCertificate(root);
  const binaries=await import('@embedded-postgres/'+process.platform+'-'+process.arch);
  // The load rehearsals seed at least 200,000 records. Recycle their temporary WAL more frequently.
  const source=await fixture(root,'harbor_identity_test',certificate,binaries,['--pool','--search'].includes(mode)?['-c','max_wal_size=128MB']:[]);
  if(!interrupted){
    const needsRestore=!mode||mode==='--quote-signing'||mode==='--recovery'||mode==='--sales-week';
    const target=needsRestore?await fixture(root,'harbor_restore_test',certificate,binaries):source;
    if(!interrupted){
      child=spawn(process.execPath,['--test','--test-concurrency=2',...suites],{cwd,stdio:'inherit',detached:true,env:{
        ...env,TMPDIR:root,HARBOR_TEST_MONITOR_ROLE:'true',NODE_EXTRA_CA_CERTS:certificate.cert,PGSSLROOTCERT:certificate.cert,
        HARBOR_TEST_TLS_KEY:certificate.key,
        ...(mode==='--team-upgrade'?{HARBOR_TEST_UPGRADE_BUNDLE:process.env.HARBOR_TEST_UPGRADE_BUNDLE}:{}),
        HARBOR_TEST_POSTGRES_URL:source.db,HARBOR_TEST_S3_ENDPOINT:source.s3,
        HARBOR_TEST_RESTORE_POSTGRES_URL:target.db,HARBOR_TEST_RESTORE_S3_ENDPOINT:target.s3,
        HARBOR_TEST_HOSTED_S3_ENDPOINT:source.secureS3,HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT:target.secureS3,
        HARBOR_TEST_RESTORE_POSTGRES_SSLMODE:'verify-full',
        ...(['--sales-week','--search','--lists','--team-upgrade','--contact-archive','--file-access','--commerce-search','--access-history','--saml','--keycloak','--directory','--teams','--booking','--help-center','--landing-pages','--first-response','--team-inbox','--sales-sequences','--marketing','--web-attribution','--external-writes','--quote-signing','--stripe-invoices','--aircall','--custom-objects','--settings','--navigation','--branch-steps','--conditional-paths','--deal-tasks','--webhooks','--workflow-webhooks','--ticket-workflows','--company-workflows','--custom-record-workflows','--record-reporting'].includes(mode)?{HARBOR_TEST_PLAYWRIGHT:process.env.HARBOR_TEST_PLAYWRIGHT,HARBOR_TEST_CHROME:process.env.HARBOR_TEST_CHROME}:{}),
        ...(mode==='--pool'?{HARBOR_TEST_POOL:'true',HARBOR_TEST_PGBOUNCER:process.env.HARBOR_TEST_PGBOUNCER||'pgbouncer'}:{}),
        HARBOR_TEST_CAMPAIGN_REPLICAS:String(mode==='--campaign-replicas'),
        HARBOR_TEST_KEYCLOAK:String(mode==='--keycloak'),
        HARBOR_TEST_SAML_UI:String(mode==='--saml'),
        ...(mode==='--saml'&&process.env.HARBOR_TEST_OIDC_PROVIDER?{HARBOR_TEST_OIDC_PROVIDER:process.env.HARBOR_TEST_OIDC_PROVIDER}:{}),
        HARBOR_TEST_DIRECTORY_UI:String(mode==='--directory'),
        HARBOR_TEST_WEBHOOKS:String(mode==='--webhooks'),
        HARBOR_TEST_CUSTOM_RECORD_WORKFLOWS:String(mode==='--custom-record-workflows'),
        HARBOR_TEST_COMPANY_WORKFLOWS:String(mode==='--company-workflows'),
        HARBOR_TEST_TICKET_WORKFLOWS:String(mode==='--ticket-workflows'),
        HARBOR_TEST_WORKFLOW_WEBHOOKS:String(mode==='--workflow-webhooks'),
        HARBOR_TEST_RECORD_REPORTING:String(mode==='--record-reporting'),
        HARBOR_TEST_SALES_SEQUENCES:String(mode==='--sales-sequences'),
        HARBOR_TEST_QUOTE_SIGNING:String(mode==='--quote-signing'),
        HARBOR_TEST_CONTACT_ARCHIVE:String(mode==='--contact-archive'),
        HARBOR_TEST_FILE_ACCESS:String(mode==='--file-access'),
        HARBOR_TEST_FILE_SEARCH:String(mode==='--file-search'),
        HARBOR_TEST_RECORD_LIST_SEARCH:String(mode==='--record-list-search'),
        HARBOR_TEST_INQUIRY_SEARCH:String(mode==='--inquiry-search'),
        HARBOR_TEST_COMMERCE_SEARCH:String(mode==='--commerce-search'),
        HARBOR_TEST_AIRCALL:String(mode==='--aircall'),
        HARBOR_TEST_STRIPE_INVOICES:String(mode==='--stripe-invoices'),
        HARBOR_TEST_LISTS:String(mode==='--lists'),
        HARBOR_TEST_SALES_WEEK:String(mode==='--sales-week'),
        HARBOR_TEST_SETTINGS:String(mode==='--settings'),
        HARBOR_TEST_NAVIGATION:String(mode==='--navigation'),
        HARBOR_TEST_BRANCH_STEPS:String(mode==='--branch-steps'),
        HARBOR_TEST_CONDITIONAL_PATHS:String(mode==='--conditional-paths'),
        HARBOR_TEST_DEAL_TASKS:String(mode==='--deal-tasks'),
        HARBOR_TEST_EXTERNAL_WRITES:String(mode==='--external-writes'),HARBOR_TEST_ATTRIBUTION:String(mode==='--web-attribution'),HARBOR_TEST_TEAM_INBOX:String(mode==='--team-inbox'),
        HARBOR_TEST_CUSTOM_OBJECTS:String(mode==='--custom-objects'),HARBOR_TEST_LANDING:String(mode==='--landing-pages'),HARBOR_TEST_ACCESS_HISTORY:String(mode==='--access-history'),HARBOR_TEST_FIRST_RESPONSE:String(mode==='--first-response'),HARBOR_TEST_HELP_CENTER:String(mode==='--help-center'),HARBOR_TEST_TEAM_BOOKING:String(mode==='--booking'),HARBOR_TEST_TEAMS_ONLY:String(mode==='--teams'),HARBOR_TEST_SEARCH_ONLY:String(mode==='--search'),
        HARBOR_TEST_SUITE_TIMEOUT_MS:process.env.HARBOR_TEST_SUITE_TIMEOUT_MS,
        HARBOR_TEST_RECOVERY_ONLY:mode==='--recovery'?'true':process.env.HARBOR_TEST_RECOVERY_ONLY,
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
