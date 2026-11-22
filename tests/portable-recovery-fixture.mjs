import {seedEquipmentImport,verifyRestoredEquipmentImport} from './portable-equipment-recovery-fixture.mjs';
import {seedPortablePilot,verifyRestoredPortablePilot,verifyRestoredPilotSharing} from './portable-pilot-fixture.mjs';
import {verifyRestoredPortableTaskRepeats} from './portable-task-repeats-fixture.mjs';
import {verifyRestoredPortableContactArchive} from './portable-contact-archive-fixture.mjs';
import {verifyRestoredPortableCompanyArchive} from './portable-company-archive-fixture.mjs';
import {verifyRestoredPortableCompanyMerge} from './portable-company-merge-fixture.mjs';
import {verifyRestoredPortableContactMerge} from './portable-contact-merge-fixture.mjs';
import {verifyRestoredPortableDealArchive} from './portable-deal-archive-fixture.mjs';
import {verifyRestoredContactArchiveReads} from './portable-contact-archive-reads-fixture.mjs';
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {access,chmod,cp,mkdir,readFile,readdir,rename,rm,stat,truncate,utimes,writeFile} from 'node:fs/promises';
import {createServer as createHttpServer,request as httpRequest} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {createServer} from 'node:net';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {CreateBucketCommand,DeleteBucketCommand,DeleteObjectCommand,GetObjectCommand,ListObjectsV2Command,PutObjectCommand} from '@aws-sdk/client-s3';
import postgres from 'postgres';
import {localFileFixture} from './portable-files-fixture.mjs';
import {verifyRestoredPortableDealStageProperties} from './portable-deal-stage-properties-fixture.mjs';
import {verifyRestoredRecordActivities} from './portable-record-activity-fixture.mjs';
import {verifyRestoredActivityMutations} from './portable-activity-mutations-fixture.mjs';
import {verifyRestoredRecordOwners} from './portable-record-owner-fixture.mjs';
import {verifyRestoredSharedAssociations} from './portable-associations-fixture.mjs';
import {verifyRestoredPortableReport} from './portable-reports-fixture.mjs';
import {verifyRestoredManualNoteBatch} from './portable-manual-note-batch-fixture.mjs';
import {verifyRestoredManualWorkflow} from './portable-manual-workflow-fixture.mjs';
import {verifyRestoredTaskWorkflow} from './portable-task-workflow-fixture.mjs';
import {verifyRestoredPortableSegment} from './portable-segments-fixture.mjs';
import {verifyRestoredPortableStaticSegments} from './portable-static-segments-fixture.mjs';
import {verifyRestoredPortableFormNotes} from './portable-form-note-fixture.mjs';
import {verifyRestoredSegmentWorkflow} from './portable-segment-workflow-fixture.mjs';
import {verifyRestoredPortableDashboard} from './portable-dashboards-fixture.mjs';
import {verifyRestoredSavedViews} from './portable-saved-views-fixture.mjs';
import {seedCustomPropertyRecovery,verifyRestoredCustomProperty} from './portable-custom-properties-fixture.mjs';
import {verifyRestoredAdditionalImports} from './portable-additional-import-fixture.mjs';
import {verifyRestoredLead} from './portable-leads-fixture.mjs';
import {verifyRestoredPortableTicketSla} from './portable-ticket-sla-fixture.mjs';
import {verifyRestoredGmailReconciliation} from './portable-gmail-fixture.mjs';
import {postgresReplyProxy} from './portable-hosting-fixture.mjs';

const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;
const sourceMarker='.harbor-backup-source';
const servicePollMarker='.harbor-backup-service-poll';
const failureMarker=day=>'.harbor-backup-failed-'+day;
const execute=promisify(execFile);
function run(env,...args){
  return execFileSync(process.execPath,[command,...args],{env,cwd,timeout:20_000,stdio:['ignore','pipe','pipe'],encoding:'utf8'});
}
function assertRefused(env,bundle,message,args=[]){
  assert.throws(()=>run(env,'restore',bundle,...args),error=>message.test(error.stderr||''));
}

async function verifyHostedBackupReplyLoss(env,bundle,args){
  const parent=dirname(bundle),before=(await readdir(parent)).sort();
  for(const query of ['ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT']){
    // pg_dump joins the exported snapshot on another connection. Let that connection finish.
    const proxy=await postgresReplyProxy(env.DATABASE_URL,{
      holdHalfOpen:true,blockOnQuery:query,firstConnectionOnly:true,
    });
    proxy.url.searchParams.set('sslmode','disable');
    try{
      await assert.rejects(execute(process.execPath,[command,...args],{
        env:{...env,DATABASE_URL:proxy.url.href},cwd,timeout:12_000,
      }),error=>{
        assert.equal(error.code,1,error.stderr||error.message);
        assert.equal(error.stdout,'');
        assert.match(error.stderr,/A backup database reply timed out\. The recovery point was not published\./);
        return true;
      });
      assert.equal(proxy.stalled.size,1,'the authenticated '+query+' reply was withheld');
      assert.deepEqual((await readdir(parent)).sort(),before,'the recovery point and staging directory were not retained');
    }finally{await proxy.close();}
  }
}

async function verifyRestoreReplyLoss(env,bundle,args,db,objectCount){
  for(const query of ['SELECT pg_try_advisory_lock(', 'AS populated, current_setting']){
    const proxy=await postgresReplyProxy(env.DATABASE_URL,{holdHalfOpen:true,blockOnQuery:query});
    // The proxy must be able to recognize the query text. Other restore checks exercise TLS.
    if(proxy.url.search)proxy.url.searchParams.set('sslmode','disable');
    try{
      await assert.rejects(execute(process.execPath,[command,'restore',bundle,...args],{
        env:{...env,DATABASE_URL:proxy.url.href},cwd,timeout:12_000,
      }),error=>{
        assert.equal(error.code,1,error.stderr||error.message);
        assert.equal(error.stdout,'');
        assert.match(error.stderr,/A restore database reply timed out\. File copy and database import did not start\./);
        return true;
      });
      assert.equal(proxy.stalled.size,1,'one authenticated database reply was withheld');
      assert.equal((await db`SELECT to_regclass('public.login_identities') AS identities`)[0].identities,null);
      assert.equal(await objectCount(),0);
    }finally{await proxy.close();}
  }
}

async function verifyRestoreCommitReplyLoss(env,bundle,admin,contactId,secureStorage){
  const database='harbor_restore_lost_commit';
  const target=new URL(env.DATABASE_URL);
  target.pathname='/'+database;
  const {bucket,storage,env:bucketEnv}=localFileFixture(env.HARBOR_S3_ENDPOINT);
  await admin`CREATE DATABASE ${admin(database)}`;
  const db=postgres(target.href,{onnotice:()=>{}});
  let bucketCreated=false;
  try{
    await storage.send(new CreateBucketCommand({Bucket:bucket}));
    bucketCreated=true;
    // psql sends a standalone simple-query COMMIT for --single-transaction.
    const proxy=await postgresReplyProxy(target.href,{holdHalfOpen:true,blockOnQuery:'Q\0\0\0\x0bCOMMIT\0'});
    proxy.url.searchParams.set('sslmode','disable');
    const child=spawn(process.execPath,[command,'restore',bundle,'--target',database,bucket],{
      env:{...env,...bucketEnv,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_RESTORE_ENABLED:'true',
        DATABASE_URL:proxy.url.href,HARBOR_S3_ENDPOINT:secureStorage},cwd,stdio:['ignore','pipe','pipe'],timeout:20_000,
    });
    const closed=once(child,'close');
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    try{
      for(let poll=0;poll<150&&!proxy.stalled.size&&child.exitCode===null;poll++)await delay(50);
      assert.equal(proxy.stalled.size,1,'Withhold the final psql COMMIT response. '+stderr+stdout);
      const [{id}]=await db`SELECT id FROM public.contacts WHERE id=${contactId}`;
      assert.equal(id,contactId,'A separate session must see the committed restore before cutting the socket.');
      for(const client of proxy.stalled)client.destroy();
      assert.deepEqual(await closed,[1,null],stderr);
      assert.equal(stdout,'','An unacknowledged restore must not print a success receipt.');
      assert.match(stderr,/^Error: Harbor could not confirm the database restore\. Keep the target stopped and inspect the database and bucket before retrying\.$/m);
      assert.doesNotMatch(stderr,/psql:|server closed the connection|connection to server/);
      assert.ok(!stderr.includes(proxy.url.href));
      const {files}=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
      assert.ok(files.length);
      const {Contents=[]}=await storage.send(new ListObjectsV2Command({Bucket:bucket}));
      assert.deepEqual(Contents.map(({Key})=>Key).sort(),files.map(({key})=>key).sort());
      for(const {key,size,sha256} of files){
        const {Body}=await storage.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        const bytes=await Body.transformToByteArray();
        assert.equal(bytes.length,size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256);
      }
    }finally{
      await proxy.close();
      if(child.exitCode===null&&child.signalCode===null)child.kill();
      await closed;
    }
  }finally{
    try{
      if(bucketCreated){
        const {Contents=[]}=await storage.send(new ListObjectsV2Command({Bucket:bucket}));
        for(const {Key} of Contents)await storage.send(new DeleteObjectCommand({Bucket:bucket,Key}));
        await storage.send(new DeleteBucketCommand({Bucket:bucket}));
      }
    }finally{
      storage.destroy();
      await db.end();
      await admin`DROP DATABASE ${admin(database)}`;
    }
  }
}

async function backupDuringWrite(env,directory,root,write){
  const wrappers=join(directory,'wrappers'),ready=join(directory,'snapshot-open'),resume=join(directory,'resume-dump');
  await mkdir(wrappers);
  await writeFile(join(wrappers,'pg_dump'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const pause=new Int32Array(new SharedArrayBuffer(4));
writeFileSync(${JSON.stringify(ready)},'ready');
while(!existsSync(${JSON.stringify(resume)}))Atomics.wait(pause,0,0,10);
const result=spawnSync('pg_dump',process.argv.slice(2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(env.PATH)}}});
process.exit(result.status??1);
`,{mode:0o700});
  const child=spawn(process.execPath,[command,'backup-service',root],{env:{...env,PATH:wrappers+':'+env.PATH},cwd,
    stdio:['ignore','pipe','pipe'],timeout:20_000});
  const closed=once(child,'close');
  let output='';
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{output+=data;});
  try{
    let snapshotOpen=false;
    for(let attempt=0;attempt<100&&child.exitCode===null;attempt++){
      snapshotOpen=await access(ready).then(()=>true,()=>false);
      if(snapshotOpen)break;
      await delay(50);
    }
    assert.ok(snapshotOpen,output);
    await write();
  }finally{
    child.kill('SIGTERM');
    await writeFile(resume,'continue');
    const [code]=await closed;
    assert.equal(code,0,output);
  }
  return output;
}

export async function verifyBackupServiceRetry(env,directory,sql){
  const root=join(directory,'automatic-backups'),wrappers=join(directory,'backup-service-wrappers');
  const timerLog=join(directory,'backup-service-timers'),failedOnce=join(directory,'backup-service-failed-once');
  await mkdir(root,{mode:0o700});
  await mkdir(wrappers,{mode:0o700});
  await writeFile(join(wrappers,'pg_dump'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
if(!existsSync(${JSON.stringify(failedOnce)})){
  writeFileSync(${JSON.stringify(failedOnce)},'failed');
  process.exit(1);
}
const result=spawnSync('pg_dump',process.argv.slice(2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(env.PATH)}}});
process.exit(result.status??1);
`,{mode:0o700});
  const fakeTimer=join(wrappers,'timer.mjs');
  await writeFile(fakeTimer,`
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const timers=createRequire(import.meta.url)('node:timers/promises'),original=timers.setTimeout;
timers.setTimeout=(ms,...args)=>{
  if(ms===300_000||ms===3_600_000)appendFileSync(${JSON.stringify(timerLog)},String(ms)+'\\n');
  return original(ms===300_000&&process.env.HARBOR_TEST_FAST_BACKUP_RETRY==='1'?10:ms,...args);
};
syncBuiltinESMExports();
`);
  async function observe(override={},interval='3600000'){
    await writeFile(timerLog,'');
    const child=spawn(process.execPath,['--import',fakeTimer,command,'backup-service',root],{
      env:{...env,PATH:wrappers+':'+env.PATH,HARBOR_BACKUP_MIN_FREE_MIB:'1',
        HARBOR_TEST_FAST_BACKUP_RETRY:interval==='3600000'?'1':'0',...override},
      cwd,stdio:['ignore','pipe','pipe'],timeout:15_000,
    });
    const closed=once(child,'close');
    let output='',errors='',timers='';
    child.stdout.on('data',data=>{output+=data;});
    child.stderr.on('data',data=>{errors+=data;});
    try{
      for(let attempt=0;attempt<120&&child.exitCode===null;attempt++){
        timers=await readFile(timerLog,'utf8');
        if(timers.includes(interval))break;
        await delay(50);
      }
      assert.ok(timers.includes(interval),`Expected backup polling interval ${interval}, got ${timers.trim()}. ${errors}`);
    }finally{
      child.kill('SIGTERM');
      const [code]=await closed;
      assert.equal(code,0,errors);
    }
    return {timers,result:output?JSON.parse(output):null,errors};
  }
  const first=await observe();
  assert.equal(first.timers,'300000\n3600000\n');
  assert.equal(JSON.parse(first.errors).result,'failed');
  assert.equal(first.result.result,'complete');
  const bundle=join(root,first.result.day);
  const manifest=await readFile(join(bundle,'manifest.json'));
  const marker=join(root,servicePollMarker);
  const monitor=(...args)=>{
    const result=spawnSync(process.execPath,[command,'monitor-status',root,'--worker-off',...args],
      {env,cwd,timeout:20_000,encoding:'utf8'});
    assert.ok([0,2].includes(result.status),result.stdout||result.stderr);
    return result;
  };
  const backupStatus=(...args)=>JSON.parse(monitor(...args).stdout).backups;
  assert.equal(backupStatus('--expect-backup-service').result,'fresh');
  const aged=new Date(Date.now()-3*60*60_000);
  await utimes(marker,aged,aged);
  assert.equal(backupStatus().result,'fresh');
  const alert=monitor('--expect-backup-service','--prometheus');
  assert.equal(alert.status,2);
  assert.match(alert.stdout,/^harbor_monitor_backup_issue\{issue="backup_service_not_reporting"\} 1$/m);
  assert.equal(JSON.parse(run(env,'backup-tick',root)).result,'already_complete');
  assert.ok((await stat(marker)).mtimeMs<Date.now()-2*60*60_000);
  const restarted=await observe();
  assert.equal(restarted.timers,'3600000\n');
  assert.equal(restarted.errors,'');
  assert.equal(restarted.result.result,'already_complete');
  assert.deepEqual(await readFile(join(bundle,'manifest.json')),manifest);
  assert.equal(backupStatus('--expect-backup-service').result,'fresh');

  const denied=new URL(env.DATABASE_URL);
  denied.password='fictional-denied-backup-password';
  const lastSuccess=(await stat(marker)).mtimeMs;
  assert.throws(()=>run({...env,DATABASE_URL:denied.href},'backup-tick',root),error=>
    error.status===1&&JSON.parse(error.stderr).result==='failed');
  assert.equal((await stat(marker)).mtimeMs,lastSuccess);
  for(const [settings,reason] of [
    [{DATABASE_URL:denied.href}],
    [{DATABASE_URL:'invalid-fixture-database-url'}],
    [{HARBOR_S3_BUCKET:'missing-harbor-test-bucket'},'Could not verify a committed attachment in the source bucket.'],
  ]){
    const failed=await observe(settings,'300000');
    assert.equal(failed.timers,'300000\n');
    const failure=JSON.parse(failed.errors);
    assert.equal(failure.result,'failed');
    if(reason){
      assert.ok(failure.reason.startsWith(reason));
      assert.doesNotMatch(failed.errors,/missing-harbor-test-bucket|contact-files\//);
    }
    assert.equal(await readFile(marker,'utf8'),'failed\n');
    const issue=monitor('--expect-backup-service','--prometheus');
    assert.equal(issue.status,2);
    assert.match(issue.stdout,/^harbor_monitor_backup_issue\{issue="backup_service_poll_failed"\} 1$/m);
    assert.equal(backupStatus('--expect-backup-service').issue,'backup_service_poll_failed');
    assert.equal(JSON.parse(run(env,'backup-status',root,'--day',first.result.day,'--verify')).result,'verified');
  }
  const failedAt=(await stat(marker)).mtimeMs;
  await sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(943157310)`;
    const busy=await observe({},'300000');
    assert.equal(busy.result.result,'busy');
    assert.equal((await stat(marker)).mtimeMs,failedAt);
  });
  assert.equal(await readFile(marker,'utf8'),'failed\n');
  const recovered=await observe();
  assert.equal(recovered.result.result,'already_complete');
  assert.equal(backupStatus('--expect-backup-service').result,'fresh');
  assert.equal((await stat(marker)).size,0);
  assert.deepEqual(await readFile(join(bundle,'manifest.json')),manifest);
  assert.deepEqual((await readdir(root)).sort(),[servicePollMarker,sourceMarker,first.result.day]);
}

async function verifyScheduledBackupReplyLoss(env,directory,root,priorDay,day,manifest,sql){
  const wrappers=join(directory,'backup-reply-wrappers'),ready=join(wrappers,'dump-complete'),resume=join(wrappers,'resume');
  await mkdir(wrappers,{mode:0o700});
  await writeFile(join(wrappers,'pg_dump'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const result=spawnSync('pg_dump',process.argv.slice(2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(env.PATH)}}});
if(result.status!==0)process.exit(result.status??1);
writeFileSync(${JSON.stringify(ready)},'ready');
const pause=new Int32Array(new SharedArrayBuffer(4));
while(!existsSync(${JSON.stringify(resume)}))Atomics.wait(pause,0,0,10);
`,{mode:0o700});
  const proxy=await postgresReplyProxy(env.DATABASE_URL,{holdHalfOpen:true});
  const child=spawn(process.execPath,[command,'backup-tick',root],{
    env:{...env,DATABASE_URL:proxy.url.href,PATH:wrappers+':'+env.PATH},cwd,stdio:['ignore','pipe','pipe'],timeout:19_000,
  });
  const closed=once(child,'close');
  let output='',errors='';
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{errors+=data;});
  try{
    let dumped=false;
    for(let attempt=0;attempt<100&&child.exitCode===null;attempt++){
      dumped=await access(ready).then(()=>true,()=>false);
      if(dumped)break;
      await delay(40);
    }
    assert.ok(dumped,errors);
    // This wait is longer than the database deadline, but pg_dump has its own budget.
    await delay(5_100);
    assert.equal(child.exitCode,null,errors);
    await sql.begin(async tx=>{
      await tx`LOCK TABLE public.contact_file_versions IN ACCESS EXCLUSIVE MODE`;
      await writeFile(resume,'continue');
      let waiting=false;
      for(let attempt=0;attempt<80&&!waiting;attempt++){
        [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE NOT granted
          AND relation='public.contact_file_versions'::regclass) AS waiting`;
        if(!waiting)await delay(30);
      }
      assert.ok(waiting,'the established backup session reached its file-receipt cursor');
      proxy.block();
    });
    assert.deepEqual(await closed,[1,null],errors);
    assert.equal(output,'');
    assert.deepEqual(JSON.parse(errors),{event:'harbor_portable_backup',result:'failed',
      reason:'A scheduled backup database reply timed out. The backup will retry.'});
    assert.equal(proxy.stalled.size,1,'one established database reply was withheld');
    assert.deepEqual((await readdir(root)).sort(),[failureMarker(day),sourceMarker,priorDay]);
    assert.equal((await stat(join(root,failureMarker(day)))).size,0);
    assert.throws(()=>run(env,'monitor-status',root),error=>{
      const report=JSON.parse(error.stdout);
      return error.status===2&&report.worker.result!=='unavailable'&&report.backups.result==='attention'&&
        report.backups.issue==='capture_failed'&&
        /newer scheduled Harbor backup failed/.test(report.backups.reason);
    });
    assert.throws(()=>run(env,'backup-status',root),error=>
      error.status===1&&/newer scheduled Harbor backup failed/.test(error.stderr),
      'routine disk-only status must notice the newer failure while the previous bundle is fresh');
    assert.deepEqual(await readFile(join(root,priorDay,'manifest.json')),manifest);
    assert.equal(JSON.parse(run(env,'backup-status',root,'--verify')).result,'verified');
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await writeFile(resume,'continue');
    await proxy.close();
    await closed;
  }
  const retry=async()=>JSON.parse((await execute(process.execPath,[command,'backup-tick',root],{env,cwd,timeout:15_000})).stdout);
  const retried=await Promise.all([retry(),retry()]);
  const complete=retried.find(result=>result.result==='complete');
  assert.ok(complete);
  assert.equal(retried.filter(result=>['busy','already_complete'].includes(result.result)).length,1);
  assert.deepEqual((await readdir(root)).sort(),[sourceMarker,priorDay,complete.day]);
  assert.deepEqual(await readFile(join(root,priorDay,'manifest.json')),manifest);
  assert.deepEqual(JSON.parse(run(env,'backup-status',root,'--verify')).day,complete.day);
  const lateFailure=join(root,failureMarker(complete.day));
  await writeFile(lateFailure,'');
  try{
    assert.equal(JSON.parse(run(env,'backup-status',root)).result,'fresh','a same-day bundle supersedes a late failure on disk');
    let monitor;
    try{monitor=run(env,'monitor-status',root,'--verify','--worker-off');}
    catch(error){assert.equal(error.status,2);monitor=error.stdout;}
    assert.equal(JSON.parse(monitor).backups.result,'verified','a published bundle supersedes a late failure receipt');
  }finally{await rm(lateFailure);}
}

async function restoreAtCommitBarrier(env,directory,bundle,args,db,whileLoading){
  const wrappers=join(directory,'restore-wrappers'),barrier=join(wrappers,'barrier.sql');
  await mkdir(wrappers,{mode:0o700});
  await writeFile(barrier,'SELECT pg_advisory_xact_lock(943157312);');
  await writeFile(join(wrappers,'psql'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
args.splice(-2,0,'--file',${JSON.stringify(barrier)});
const result=spawnSync('psql',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(env.PATH)}}});
process.exit(result.status??1);
`,{mode:0o700});
  const connection=await db.reserve();
  await connection`SELECT pg_advisory_lock(943157312)`;
  const child=spawn(process.execPath,[command,'restore',bundle,...args],{env:{...env,PATH:wrappers+':'+env.PATH},cwd,
    stdio:['ignore','pipe','pipe'],timeout:20_000});
  const closed=once(child,'close');
  let output='';
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{output+=data;});
  try{
    let waiting=false;
    for(let attempt=0;attempt<100&&child.exitCode===null;attempt++){
      [{waiting}]=await db`SELECT EXISTS (SELECT FROM pg_locks WHERE locktype='advisory' AND objid=943157312 AND NOT granted) AS waiting`;
      if(waiting)break;
      await delay(50);
    }
    assert.ok(waiting,output);
    await whileLoading();
  }finally{
    try{await connection`SELECT pg_advisory_unlock(943157312)`;}
    finally{connection.release();}
    const [code]=await closed;
    assert.equal(code,0,output);
  }
  return output;
}

async function restoreWithFileFaults({env,directory,bundle,args,db,fixture,s3Endpoint,files},whileLoading){
  assert.ok(files.length>1);
  const {bucket,storage}=fixture;
  const targetPath='/'+bucket+'/'+files[1].key;
  let fault,accepted=false;
  const attempts=[];
  const reject=(request,response,status,code)=>{
    request.resume();
    response.writeHead(status,{'content-type':'application/xml'}).end('<Error><Code>'+code+'</Code></Error>');
  };
  const handler=(request,response)=>{
    const url=new URL(request.url,s3Endpoint);
    const selected=url.pathname===targetPath;
    if(selected){
      attempts.push([request.method,request.headers['if-none-match']??null]);
      if(request.method===fault.method&&fault.remaining>0){
        fault.remaining--;
        return reject(request,response,fault.status,fault.code);
      }
      if(request.method==='PUT'&&accepted)return reject(request,response,412,'PreconditionFailed');
    }
    const forward=httpRequest(url,{method:request.method,headers:request.headers},upstream=>{
      if(selected&&request.method==='PUT'&&upstream.statusCode>=200&&upstream.statusCode<300)accepted=true;
      response.writeHead(upstream.statusCode,upstream.headers);
      upstream.pipe(response);
    });
    forward.on('error',()=>{
      if(!response.headersSent)response.writeHead(502);
      response.end();
    });
    request.on('aborted',()=>forward.destroy());
    request.pipe(forward);
  };
  const protocol=new URL(env.HARBOR_S3_ENDPOINT).protocol;
  const proxy=protocol==='https:'?createHttpsServer({
    key:await readFile(process.env.HARBOR_TEST_TLS_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS),
  },handler):createHttpServer(handler);
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  try{
    const settings={...env,HARBOR_S3_ENDPOINT:protocol+'//127.0.0.1:'+proxy.address().port};
    const put=['PUT','*'],get=['GET',null];
    for(const failure of [
      {method:'PUT',status:503,code:'ServiceUnavailable',remaining:2,expected:[put,get,put,get]},
      {method:'PUT',status:403,code:'AccessDenied',remaining:1,expected:[put]},
    ]){
      fault=failure;
      await assert.rejects(
        execute(process.execPath,[command,'restore',bundle,...args],{env:settings,cwd,timeout:20_000}),
        error=>error.code===1&&/Could not verify a file in the restore bucket\. Database import did not start\./.test(error.stderr),
      );
      assert.deepEqual(attempts.splice(0),failure.expected);
      assert.equal((await db`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
      const {Contents}=await storage.send(new ListObjectsV2Command({Bucket:bucket}));
      assert.deepEqual(Contents.map(object=>object.Key),[files[0].key]);
      await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:files[0].key}));
    }
    // The first PUT succeeded before its readback failed. Its retry must use the same conditional write.
    fault={method:'GET',status:503,code:'ServiceUnavailable',remaining:1};
    const result=await restoreAtCommitBarrier(settings,directory,bundle,args,db,whileLoading);
    assert.equal(fault.remaining,0);
    assert.deepEqual(attempts,[put,get,put,get]);
    const copied=await storage.send(new GetObjectCommand({Bucket:bucket,Key:files[1].key}));
    const bytes=await copied.Body.transformToByteArray();
    assert.equal(bytes.length,files[1].size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),files[1].sha256);
    return result;
  }finally{await new Promise(resolve=>proxy.close(resolve));}
}

async function verifyPortableLegacyFileRecovery({env,directory,target,targetSql,s3Endpoint,hosted=false,rollback}){
  const {applyPortableMigrations,readPortableMigrations}=await import('../runtime/portable-migrations.mjs');
  const folder=fileURLToPath(new URL('../db/postgres/migrations/',import.meta.url));
  const migrations=readPortableMigrations(folder);
  const journal=JSON.parse(await readFile(join(folder,'meta/_journal.json'),'utf8'));
  const legacyCount=hosted?35:journal.entries.findIndex(({tag})=>tag==='0106_portable_contact_file_storage_owner');
  if(hosted)assert.equal(journal.entries[legacyCount-1].tag,'0034_portable_calendar_rejected');
  assert.ok(legacyCount>0);
  const sourceName=hosted?'harbor_railway_source':'harbor_legacy_source',restoreName=sourceName+'_copy';
  await targetSql`CREATE DATABASE ${targetSql(sourceName)}`;
  await targetSql`CREATE DATABASE ${targetSql(restoreName)}`;
  const sourceUrl=new URL(target),restoreUrl=new URL(target);
  sourceUrl.pathname='/'+sourceName;restoreUrl.pathname='/'+restoreName;
  const source=postgres(sourceUrl.href,{onnotice:()=>{}});
  const restored=postgres(restoreUrl.href,{onnotice:()=>{}});
  const original=localFileFixture(s3Endpoint),copy=localFileFixture(s3Endpoint);
  try{
    assert.equal(await applyPortableMigrations(source,migrations.slice(0,legacyCount)),'ok');
    const user=rollback?'rollback-owner':'legacy-file-test',workspace=randomUUID(),contact=randomUUID(),file=randomUUID(),version=randomUUID();
    const bytes=Buffer.from('A private file from before contact merge.\n');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const key=`contact-files/${workspace}/${contact}/${file}/${version}`;
    const email=rollback?'owner@example.test':'legacy-file@example.test';
    const subject=rollback?'portable-'+email:user;
    await source`INSERT INTO login_identities (id,google_subject,email,created_at,updated_at)
      VALUES (${user},${subject},${email},0,0)`;
    await source`INSERT INTO private_workspaces (id,owner_id) VALUES (${workspace},${user})`;
    await source`INSERT INTO contacts (workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspace},${contact},1,${source.json({name:'Fictional rollback contact'})},now(),now())`;
    await source`INSERT INTO contact_file_versions (workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
      VALUES (${workspace},${contact},${file},${version},1,'legacy.txt',${bytes.length},${sha256},now())`;
    const noteId=randomUUID();
    if(rollback){
      const note='Fictional completed Note before upgrade';
      await source`INSERT INTO portable_jobs (workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,
        available_at,created_at,status,attempts,finished_at) VALUES
        (${workspace},${noteId},${contact},${user},'note',${note},0,0,0,'succeeded',1,1)`;
      await source`INSERT INTO portable_notes (workspace_id,job_id,body,created_at) VALUES (${workspace},${noteId},${note},1)`;
      await source`INSERT INTO portable_job_attempts (workspace_id,job_id,number,started_at,ended_at,outcome)
        VALUES (${workspace},${noteId},1,0,1,'succeeded')`;
    }
    await original.storage.send(new CreateBucketCommand({Bucket:original.bucket}));
    await copy.storage.send(new CreateBucketCommand({Bucket:copy.bucket}));
    await original.storage.send(new PutObjectCommand({Bucket:original.bucket,Key:key,Body:bytes}));
    const bundle=join(directory,sourceName+'-backup');
    const sourceEnv={...env,...original.env,HARBOR_PORTABLE_MODE:'local',DATABASE_URL:sourceUrl.href};
    const copyEnv={...env,...copy.env,HARBOR_PORTABLE_MODE:'local',DATABASE_URL:restoreUrl.href};
    if(hosted){
      const hostedEnv=(base,url,endpoint)=>{
        const db=new URL(url);
        db.searchParams.set('sslmode','verify-full');
        return {...base,HARBOR_PORTABLE_MODE:'hosted',DATABASE_URL:db.href,HARBOR_S3_ENDPOINT:endpoint};
      };
      const endpoint=process.env.HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT;
      const capture=hostedEnv(sourceEnv,sourceUrl,endpoint);
      const destination=hostedEnv(copyEnv,restoreUrl,endpoint);
      assert.throws(()=>run(capture,'backup',bundle),error=>/--source/.test(error.stderr));
      assert.throws(()=>run(capture,'backup',bundle,'--source',sourceName,copy.bucket),error=>/Backup source names/.test(error.stderr));
      const publicParent=join(directory,'shared-parent');
      await mkdir(publicParent,{mode:0o755});
      await chmod(publicParent,0o755);
      assert.throws(()=>run(capture,'backup',join(publicParent,'bundle'),'--source',sourceName,original.bucket),
        error=>/owner-only/.test(error.stderr));
      const captureArgs=['backup',bundle,'--source',sourceName,original.bucket];
      await source.begin(async tx=>{
        await tx`SELECT pg_advisory_xact_lock(943157310)`;
        assert.throws(()=>run(capture,...captureArgs),error=>error.status===1&&/maintenance lock/.test(error.stderr));
        await assert.rejects(stat(bundle),{code:'ENOENT'});
      });
      await verifyHostedBackupReplyLoss(capture,bundle,captureArgs);
      assert.match(run(capture,...captureArgs),/Verified file versions: 1/);
      const offline={PATH:env.PATH};
      const archived=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
      assert.deepEqual(JSON.parse(run(offline,'doctor','bundle',bundle)),{
        profile:'bundle',result:'verified',checks:{restoreTool:'ok',archive:'ok'},versions:1,
        dumpSha256:archived.dumpSha256,migrationHistory:'migration_required',
        captureStartedAt:Date.parse((await readFile(join(bundle,'capture-started-at'),'utf8')).trim()),completedAt:archived.completedAt,
      });
      const preflight=JSON.parse(run(destination,'doctor','restore','--bundle',bundle));
      assert.equal(preflight.checks.archive,'ok');
      run({...destination,HARBOR_PORTABLE_RESTORE_ENABLED:'true'},'restore',bundle,'--target',restoreName,copy.bucket);
      const {portableMigrationHistory}=await import('../runtime/portable-migrations.mjs');
      assert.equal((await portableMigrationHistory(restored,migrations.slice(0,legacyCount))).status,'ok');
      assert.equal((await portableMigrationHistory(source,migrations)).applied,legacyCount);
      if(rollback)await verifyRailwayRollback({env:copyEnv,rollback,source,sourceUrl,workspace,contact,file,version,bytes,noteId,legacyCount,migrations});
    }else{
      run(sourceEnv,'backup',bundle);
      run(copyEnv,'restore',bundle);
    }
    const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
    assert.equal(manifest.migrations.length,legacyCount);
    assert.deepEqual(manifest.files,[{key,size:bytes.length,sha256}]);
    const copied=await copy.storage.send(new GetObjectCommand({Bucket:copy.bucket,Key:key}));
    assert.deepEqual(Buffer.from(await copied.Body.transformToByteArray()),bytes);
    assert.equal(await applyPortableMigrations(restored,migrations),'ok');
    const [row]=await restored`SELECT contact_id AS contact,storage_contact_id AS "storageContact" FROM contact_file_versions`;
    assert.deepEqual(row,{contact,storageContact:null});
  }finally{
    original.storage.destroy();
    copy.storage.destroy();
    await Promise.all([source.end(),restored.end()]);
  }
}

async function verifyRailwayRollback({env,rollback,source,sourceUrl,workspace,contact,file,version,bytes,noteId,legacyCount,migrations}){
  const {applyPortableMigrations,readPortableMigrations}=await import('../runtime/portable-migrations.mjs');
  const oldCwd=dirname(dirname(rollback.command));
  const oldEnv={...env,HARBOR_PORTABLE_MODE:'local'};
  const runOld=(settings,...args)=>execFileSync(process.execPath,[rollback.command,...args],{
    cwd:oldCwd,env:settings,timeout:10_000,stdio:['ignore','pipe','pipe'],encoding:'utf8',
  });
  const legacy=readPortableMigrations(join(oldCwd,'db/postgres/migrations'));
  assert.deepEqual(legacy,migrations.slice(0,legacyCount));
  assert.equal(await applyPortableMigrations(source,migrations),'ok');
  assert.throws(()=>runOld({...oldEnv,DATABASE_URL:sourceUrl.href},'migrate'),
    error=>error.status===1&&/requires a newer Harbor release/.test(error.stderr));
  assert.match(runOld(oldEnv,'migrate'),/migrations applied/);
  const socket=createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port,origin='http://127.0.0.1:'+port;
  await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['--import',rollback.mock,rollback.command,'start'],{
    cwd:oldCwd,env:{...oldEnv,PORT:String(port),HARBOR_LOGIN_ORIGIN:origin},stdio:['ignore','ignore','inherit'],
  });
  const closed=once(child,'close');
  const request=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(3000),...options});
  try{
    let ready=false;
    for(let attempt=0;attempt<100&&child.exitCode===null&&!ready;attempt++){
      ready=(await request('/healthz').catch(()=>null))?.status===200;
      if(!ready)await delay(100);
    }
    assert.ok(ready,'Earlier Railway release must start on restored storage.');
    const owner=await rollback.signIn('owner@example.test',request,origin);
    const other=await rollback.signIn('other@example.test',request,origin);
    const record='/api/crm?kind=contacts&id='+contact;
    const attachment='/api/record-attachments?'+new URLSearchParams({recordId:contact,fileId:file,versionId:version});
    const result=await request(record,{headers:owner});
    assert.equal(result.status,200);
    assert.equal((await result.json()).data.name,'Fictional rollback contact');
    assert.equal((await request(record+'&workspaceId='+workspace,{headers:other})).status,404);
    const response=await request(attachment,{headers:owner});
    assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.equal((await request(attachment,{headers:other})).status,404);
    runOld(oldEnv,'worker','--once');
    const jobs=await request('/api/background-jobs?recordId='+contact,{headers:owner});
    assert.equal(jobs.status,200);
    const {items}=await jobs.json();
    assert.deepEqual(items.map(({id,status,attempts,receipts})=>({id,status,attempts,receipts})),[{
      id:noteId,status:'succeeded',attempts:1,receipts:[{number:1,startedAt:0,endedAt:1,outcome:'succeeded'}],
    }]);
  }finally{
    if(child.exitCode===null)child.kill();
    await closed;
  }
}

export async function verifyPortableRailwayRollback({env,directory,mock,signIn,command}){
  const target=new URL(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL);
  assert.equal(target.hostname,'127.0.0.1');
  assert.match(target.pathname,/^\/harbor_restore_test$/);
  const targetSql=postgres(target.href,{onnotice:()=>{}});
  try{
    await verifyPortableLegacyFileRecovery({env,directory,target,targetSql,s3Endpoint:process.env.HARBOR_TEST_RESTORE_S3_ENDPOINT,
      hosted:true,rollback:{mock,signIn,command}});
  }finally{await targetSql.end();}
}

export async function verifyPortableRecoveryJourney({env,mock,request,headers,sql,directory,signIn,fixture,restart}){
  const target=new URL(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL);
  assert.equal(target.hostname,'127.0.0.1');
  assert.match(target.pathname,/^\/harbor_restore_test(?:_[a-z0-9]+)?$/);
  assert.notEqual(target.port,new URL(env.DATABASE_URL).port);
  const storage=localFileFixture(process.env.HARBOR_TEST_RESTORE_S3_ENDPOINT);
  assert.ok(storage);
  assert.notEqual(storage.env.HARBOR_S3_ENDPOINT,fixture.env.HARBOR_S3_ENDPOINT);
  const targetSql=postgres(target.href,{onnotice:()=>{}});
  let server,exit;
  try{
    assert.equal((await targetSql`SELECT to_regclass('public.contacts') AS contacts`)[0].contacts,null);
    await fixture.storage.send(new CreateBucketCommand({Bucket:fixture.bucket}));
    await storage.storage.send(new CreateBucketCommand({Bucket:storage.bucket}));
    const root=join(directory,'focused-backups');
    await mkdir(root,{mode:0o700});
    const preflight=config=>JSON.parse(run({...config,HARBOR_PORTABLE_BACKUP_ENABLED:'false'},'doctor','backup',root));
    const unreachable={...env,HARBOR_S3_ENDPOINT:'http://127.0.0.1:1'};
    assert.deepEqual(preflight(unreachable),{profile:'backup',result:'ready_for_file_test',backupEnabled:false,
      checks:{directory:'ok',database:'ok',storage:'no_files_to_check',dumpTool:'ok'},
      nextStep:'Upload a fictional Contact attachment, then run doctor backup again.'});
    assert.deepEqual(await readdir(root),[]);
    assert.equal((await sql`SELECT count(*)::int AS count FROM contact_file_versions`)[0].count,0);
    assert.equal((await fixture.storage.send(new ListObjectsV2Command({Bucket:fixture.bucket}))).KeyCount,0);
    const databaseOnlyRoot=join(directory,'database-only-backups');
    await mkdir(databaseOnlyRoot,{mode:0o700});
    const databaseOnly=JSON.parse(run({...unreachable,HARBOR_PORTABLE_BACKUP_ENABLED:'true'},'backup-tick',databaseOnlyRoot));
    assert.equal(databaseOnly.result,'complete');
    assert.equal(databaseOnly.versions,0);
    const databaseOnlyStatus=JSON.parse(run(unreachable,'backup-status',databaseOnlyRoot));
    assert.equal(databaseOnlyStatus.result,'fresh');
    assert.equal(databaseOnlyStatus.versions,0);
    assert.equal(JSON.parse(run({...unreachable,HARBOR_PORTABLE_BACKUP_ENABLED:'true'},'backup-tick',databaseOnlyRoot)).result,
      'already_complete');
    const [{id:actorId}]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
    await sql`INSERT INTO portable_google_grants (user_id,provider,id,email,refresh_token)
      VALUES (${actorId},'gmail',${randomUUID()},'owner@example.test','fictional encrypted grant')`;
    const attempts=await sql`INSERT INTO portable_google_attempts (user_id,provider,session_hash,state_hash,verifier,expires_at)
      SELECT user_id,'calendar',token_hash,'fixture-state-hash','fictional encrypted verifier',expires_at
      FROM login_sessions WHERE user_id=${actorId} LIMIT 1 RETURNING state_hash`;
    assert.equal(attempts.length,1);
    const pilot=await seedPortablePilot({request,origin:env.HARBOR_LOGIN_ORIGIN,headers,actorId});
    const inboxId=randomUUID(),replyId=randomUUID();
    const [{id:inboxWorkspace}]=await sql`SELECT id FROM private_workspaces WHERE owner_id=${actorId}`;
    await sql`INSERT INTO portable_inbox_conversations (workspace_id,id,mailbox,sender,subject,claimed_by)
      VALUES (${inboxWorkspace},${inboxId},'support@example.test','visitor@example.test','Fictional scanner repair',${actorId})`;
    await sql`INSERT INTO portable_inbox_messages (workspace_id,conversation_id,id,mailbox,direction,state,actor_id,body,internet_id)
      VALUES (${inboxWorkspace},${inboxId},${replyId},'support@example.test','outgoing','sending',${actorId},'Fictional repair instructions','<repair@example.test>')`;
    const articleId=randomUUID();
    async function writeRecord(path,body){
      const r=await request(path,{method:'POST',headers:{...headers,origin:env.HARBOR_LOGIN_ORIGIN,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.ok(r.ok,await r.clone().text());
      return r.json();
    }
    const {record:waitingContact}=await writeRecord('/api/crm',{action:'save',kind:'contacts',
      data:{name:'Fictional lifecycle handoff',lifecycle:'Lead'}});
    const waitingWorkflow=randomUUID(),waitingJob=randomUUID();
    const hookWorkflow=randomUUID(),hookJob=randomUUID(),destination='Fictional recovery receiver';
    env.HARBOR_WEBHOOK_DESTINATIONS=JSON.stringify([{workspaceId:inboxWorkspace,name:destination}]);
    await restart();
    const waitingPath=randomUUID(),secondNote=randomUUID(),gatedHook=randomUUID(),heldPath=randomUUID(),heldSuccessor=randomUUID();
    const secondNoteBody='Confirm the recovered customer handoff.';
    const pathAction={kind:'note',body:'Prepare the recovered customer handoff.',delayMinutes:0,waitForLifecycle:'Customer'};
    await writeRecord('/api/workflows',{action:'save',id:waitingWorkflow,revision:0,definition:{
      name:'Recovery handoff',trigger:'manual_contact',actionKind:'conditional_paths',
      paths:[{id:waitingPath,name:'Lead',mode:'all',conditions:[{field:'lifecycle',operator:'eq',value:'Lead'}],action:pathAction,
        then:[{id:secondNote,action:{kind:'note',body:secondNoteBody,delayMinutes:0}},
          {id:gatedHook,action:{kind:'webhook',destination,delayMinutes:0}}]}],
      otherwise:{id:randomUUID(),name:'Other contact',action:{kind:'note',body:'Review the contact.',delayMinutes:0}}}});
    await writeRecord('/api/workflows',{action:'setEnabled',id:waitingWorkflow,revision:1,enabled:true});
    await writeRecord('/api/workflows',{action:'runContact',id:waitingJob,workflowId:waitingWorkflow,
      workflowRevision:2,contactId:waitingContact.id});
    await writeRecord('/api/workflows',{action:'save',id:hookWorkflow,revision:0,definition:{
      name:'Restore webhook handoff',trigger:'manual_contact',actionKind:'conditional_paths',
      paths:[{id:heldPath,name:'Active handoff',mode:'all',conditions:[{field:'name',operator:'known',value:''}],
        action:{kind:'webhook',destination,delayMinutes:0,waitForLifecycle:'Customer'},
        then:[{id:heldSuccessor,action:{kind:'note',body:'Record the confirmed callback.',delayMinutes:0}}]}],
      otherwise:{id:randomUUID(),name:'Other contact',action:{kind:'note',body:'Review the contact.',delayMinutes:0}}}});
    await writeRecord('/api/workflows',{action:'setEnabled',id:hookWorkflow,revision:1,enabled:true});
    await writeRecord('/api/workflows',{action:'runContact',id:hookJob,workflowId:hookWorkflow,
      workflowRevision:2,contactId:waitingContact.id});
    const ticketRule=randomUUID(),ticketNote='Review the restored repair with its requester.';
    await writeRecord('/api/workflows',{action:'save',id:ticketRule,revision:0,definition:{name:'Repair follow-up',
      trigger:'ticket_status',ticketStatus:'Closed',body:ticketNote,delayMinutes:1440}});
    await writeRecord('/api/workflows',{action:'setEnabled',id:ticketRule,revision:1,enabled:true});
    const {record:sourceTicket}=await writeRecord('/api/tickets',{action:'save',contactId:waitingContact.id,
      data:{name:'Fictional repaired scanner',ticketStatus:'Closed'}});
    const writeCredential=await writeRecord('/api/api-tokens',{name:'Disposable integration',days:30,permissions:{companies:'read_write_archive'}});
    const webhookId=randomUUID();
    await sql`INSERT INTO portable_webhook_subscriptions (workspace_id,id,destination,objects) VALUES
      (${inboxWorkspace},${webhookId},'fictional-restore',ARRAY['companies'])`;
    const companyRule=randomUUID();
    await writeRecord('/api/workflows',{action:'save',id:companyRule,revision:0,definition:{
      name:'Welcome new accounts',trigger:'company_created',actionKind:'task',delayMinutes:0,task:{name:'Prepare a welcome plan'}}});
    await writeRecord('/api/workflows',{action:'setEnabled',id:companyRule,revision:1,enabled:true});
    const integratedCompany=randomUUID(),companyApi='/api/v1/records/companies';
    const credential=(secret,method,body,etag)=>({method,headers:{authorization:'Bearer '+secret,'content-type':'application/json',
      ...(etag?{'if-match':etag}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const inserted=await request(companyApi,credential(writeCredential.token,'POST',{id:integratedCompany,properties:{name:'Fictional restore customer'}}));
    assert.equal(inserted.status,201,await inserted.clone().text());
    assert.equal((await sql`SELECT count(*)::int AS n FROM portable_webhook_deliveries
      WHERE subscription_id=${webhookId} AND record_id=${integratedCompany} AND status='pending'`)[0].n,1);
    const companyHistoryPath='/api/workflows?runCompanyId='+integratedCompany;
    const sourceCompanyHistory=await (await request(companyHistoryPath,{headers})).json();
    assert.equal(sourceCompanyHistory.runs.length,1);
    const [companyReceipt]=sourceCompanyHistory.runs;
    assert.equal(companyReceipt.companyId,integratedCompany);
    assert.ok(companyReceipt.companyTaskId);
    const trackingSiteId=randomUUID(),trackedForm=randomUUID(),trackingOrigin='https://restore.example.test',visitor=randomUUID();
    await writeRecord('/api/web-attribution',{id:trackingSiteId,revision:0,name:'Restored publisher',origin:trackingOrigin,enabled:true});
    await writeRecord('/api/lead-forms',{action:'save',id:trackedForm,revision:0,definition:{title:'Recovery request',captureContacts:false}});
    await writeRecord('/api/lead-forms',{action:'setEnabled',id:trackedForm,revision:1,enabled:true});
    const pageEvent={siteId:trackingSiteId,visitor,eventId:randomUUID(),path:'/demo',source:'partner'};
    const collector='/api/public/journey?siteId='+trackingSiteId;
    const collect={method:'POST',headers:{origin:trackingOrigin,'content-type':'text/plain'},body:JSON.stringify(pageEvent)};
    assert.equal((await request(collector,collect)).status,202);
    const conversion=randomUUID();
    await writeRecord('/api/public/forms/'+trackedForm,{id:conversion,revision:2,payload:{name:'Restore visitor',email:'restore-visitor@example.test'},
      journey:{siteId:trackingSiteId,visitor}});
    const quickReplyId=randomUUID();
    await writeRecord('/api/team-inbox',{action:'save_snippet',id:quickReplyId,revision:0,name:'Repair acknowledgement',body:'We are checking the scanner.'});
    await writeRecord('/api/knowledge-base',{action:'save',id:articleId,revision:0,content:{
      title:'Recover a field handbook',subtitle:'',category:'',tags:[],bodyHtml:'<p>Restart the display.</p>'}});
    const {center}=await writeRecord('/api/knowledge-base?publication=1',{action:'settings',name:'Field help',accent:'#226655',enabled:true,revision:0});
    await writeRecord('/api/knowledge-base?publication=1',{action:'publish',id:articleId,articleRevision:1,revision:0});
    const objectId=randomUUID(),customRecordId=randomUUID(),serialId=randomUUID();
    const customApi='/api/custom-objects';
    await writeRecord(customApi,{action:'define',id:objectId,revision:0,definition:{name:'Equipment',fields:[
      {id:serialId,label:'Serial number',type:'text',required:true,options:[]}
    ]}});
    const equipmentRule=randomUUID();
    await writeRecord('/api/workflows',{action:'save',id:equipmentRule,revision:0,definition:{name:'Equipment check-in',
      trigger:'custom_record_created',objectId,actionKind:'task',delayMinutes:0,task:{name:'Inspect new equipment'}}});
    await writeRecord('/api/workflows',{action:'setEnabled',id:equipmentRule,revision:1,enabled:true});
    await writeRecord(customApi,{action:'save',id:customRecordId,objectId,revision:0,schemaRevision:1,
      name:'Loading dock scanner',values:{[serialId]:'DS-482'}});
    await writeRecord(customApi,{action:'link',id:customRecordId,objectId,revision:1,kind:'companies',target:pilot.records.companies.id});
    const equipmentRunPath='/api/workflows?'+new URLSearchParams({runObjectId:objectId,runCustomRecordId:customRecordId});
    const equipmentRuns=(await (await request(equipmentRunPath,{headers})).json()).runs;
    assert.equal(equipmentRuns.length,1);
    assert.ok(equipmentRuns[0].customTaskId);
    const equipmentImport=await seedEquipmentImport({request,origin:env.HARBOR_LOGIN_ORIGIN,owner:headers,
      rep:await signIn('invitee@example.test'),workspace:inboxWorkspace,objectId,existingId:customRecordId,serialId,
      contactId:pilot.records.contacts.id});
    const landingId=randomUUID();
    const edition={title:'Spring field day',slug:'field-day',description:'',accent:'#126260',blocks:[]};
    const firstEdition=await writeRecord('/api/landing-pages',{action:'save',id:landingId,revision:0,draft:edition});
    await writeRecord('/api/landing-pages',{action:'publish',id:landingId,revision:firstEdition.revision});
    await writeRecord('/api/landing-pages',{action:'save',id:landingId,revision:2,draft:{...edition,title:'Private autumn plans'}});
    const landingPath='/p/'+firstEdition.workspaceId+'/field-day';
    assert.match(await (await request(landingPath)).text(),/Spring field day/);
    const helpPath='/help/'+center.id+'/'+articleId;
    assert.match(await (await request(helpPath)).text(),/Restart the display/);
    const supportPolicy={revision:0,enabled:true,targets:{Urgent:30,High:60,Medium:120,Low:240},
      calendar:{zone:'America/New_York',week:[null,...Array(5).fill({open:540,close:1020}),null],holidays:['2026-12-25']}};
    const ticketPolicyPath='/api/ticket-sla?kind=first-response';
    await writeRecord(ticketPolicyPath,supportPolicy);
    const responseTicket=(await writeRecord('/api/tickets',{action:'save',data:{name:'Fictional support case',ticketPriority:'High'}})).record;
    const finished=(await writeRecord('/api/tickets',{action:'first_response',id:responseTicket.id,expectedRevision:responseTicket.revision,
      channel:'Email',summary:'Shared the display reset steps.'})).record.firstResponse;
    const previous=new URL(pilot.attachment,env.HARBOR_LOGIN_ORIGIN);
    const version=randomUUID(),replacement=Buffer.from('Fictional replacement proposal\n');
    const latest=new URL(previous);
    latest.searchParams.set('versionId',version);
    latest.searchParams.set('expectedVersion',previous.searchParams.get('versionId'));
    assert.equal((await request(latest.pathname+latest.search,{method:'POST',
      headers:{...headers,origin:env.HARBOR_LOGIN_ORIGIN,'x-harbor-file-name':'Pilot proposal.txt'},body:replacement})).status,200);
    latest.searchParams.delete('expectedVersion');
    assert.deepEqual(preflight(env),{profile:'backup',result:'ready',backupEnabled:false,
      checks:{directory:'ok',database:'ok',storage:'ok',dumpTool:'ok'}});
    assert.throws(()=>preflight({...env,HARBOR_S3_BUCKET:'missing-harbor-test-bucket'}),error=>{
      assert.equal(error.status,1);
      const report=JSON.parse(error.stdout);
      assert.equal(report.result,'needs_setup');
      assert.equal(report.checks.storage,'unavailable');
      return true;
    });
    assert.deepEqual(await readdir(root),[]);
    const contactId=pilot.records.contacts.id;
    const accessExport=await request('/api/crm?kind=contacts&export=csv',{headers});
    assert.equal(accessExport.status,200);
    assert.ok((await accessExport.text()).includes(contactId));
    const accessEvidence=await sql`SELECT * FROM portable_record_access_events WHERE action='csv' AND ${contactId}::uuid=ANY(record_ids) ORDER BY id`;
    assert.ok(accessEvidence.length);
    const jobs='/api/background-jobs?recordId='+contactId;
    const note={id:randomUUID(),body:'Test completed Note before backup',scheduledFor:0};
    assert.equal((await request(jobs,{method:'POST',headers:{...headers,origin:env.HARBOR_LOGIN_ORIGIN,
      'content-type':'application/json'},body:JSON.stringify(note)})).status,202);
    run(env,'worker','--once','--notes-only');
    const noteReceipt=async(send,auth)=>{
      const response=await send(jobs,{headers:auth});
      assert.equal(response.status,200);
      return (await response.json()).items.find(job=>job.id===note.id);
    };
    const receipt=await noteReceipt(request,headers);
    assert.equal(receipt.status,'succeeded');
    assert.equal(receipt.attempts,1);

    async function readBranch(send,auth,id){
      const response=await send('/api/workflows?runWorkflowId='+id,{headers:auth});
      assert.equal(response.status,200);
      const {runs,workflows}=await response.json();
      assert.equal(runs.length,1);
      return {enabled:workflows.find(workflow=>workflow.id===id).enabled,run:runs[0]};
    }
    const sourceWaitBranch=await readBranch(request,headers,waitingWorkflow);
    const sourceHeldBranch=await readBranch(request,headers,hookWorkflow);
    assert.deepEqual([sourceWaitBranch.enabled,sourceHeldBranch.enabled],[true,true]);
    assert.deepEqual(sourceWaitBranch.run.pathSteps.map(step=>step.jobId),[waitingJob,null,null]);
    assert.deepEqual(sourceHeldBranch.run.pathSteps.map(step=>step.jobId),[hookJob,null]);

    const {day,result,versions}=JSON.parse(run({...env,HARBOR_PORTABLE_BACKUP_ENABLED:'true'},'backup-tick',root));
    assert.equal(result,'complete');
    assert.equal(versions,2);
    assert.equal(JSON.parse(run(env,'backup-status',root)).versions,2);
    const verified=JSON.parse(run(env,'backup-status',root,'--verify','--day',day));
    assert.equal(verified.result,'verified');
    assert.equal(verified.versions,2);
    assert.ok(Number.isSafeInteger(verified.captureStartedAt));
    assert.ok(verified.completedAt>=verified.captureStartedAt);
    const sourceOrigin=env.HARBOR_LOGIN_ORIGIN;
    const contactPath='/api/crm?kind=contacts&id='+contactId;
    const contact=pilot.records.contacts;
    const updated=await request('/api/crm',{method:'POST',
      headers:{...headers,origin:sourceOrigin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',id:contactId,expectedRevision:contact.revision,
        data:{...contact.data,phone:'202-555-0191'}})});
    assert.equal(updated.status,200);
    const {record:laterContact}=await updated.json();
    assert.equal(laterContact.data.phone,'202-555-0191');
    const laterFile=new URL(latest);
    laterFile.searchParams.set('versionId',randomUUID());
    laterFile.searchParams.set('expectedVersion',version);
    const laterBytes='Fictional attachment edit after backup\n';
    assert.equal((await request(laterFile.pathname+laterFile.search,{method:'POST',
      headers:{...headers,origin:sourceOrigin,'x-harbor-file-name':'Pilot proposal.txt'},body:laterBytes})).status,200);
    laterFile.searchParams.delete('expectedVersion');
    const laterPath=laterFile.pathname+laterFile.search;
    assert.equal(await (await request(laterPath,{headers})).text(),laterBytes);
    await verifyRestoreCommitReplyLoss({...env,...storage.env,DATABASE_URL:target.href},join(root,day),targetSql,
      contactId,process.env.HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT);
    const outageAt=Date.now(),recoveryStart=performance.now();
    assert.ok(outageAt>=verified.completedAt);
    const socket=createServer().listen(0,'127.0.0.1');
    await once(socket,'listening');
    const port=socket.address().port,origin='http://127.0.0.1:'+port;
    await new Promise(resolve=>socket.close(resolve));
    const webEnv={...env,...storage.env,DATABASE_URL:target.href,PORT:String(port),HARBOR_LOGIN_ORIGIN:origin};
    const hostedEndpoint=new URL(process.env.HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT);
    assert.equal(hostedEndpoint.hostname,'127.0.0.1');
    assert.equal(hostedEndpoint.protocol,'https:');
    const restoreDb=new URL(target);
    restoreDb.searchParams.set('sslmode','verify-full');
    const report=run({...webEnv,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_RESTORE_ENABLED:'true',
      HARBOR_S3_ENDPOINT:hostedEndpoint.href,DATABASE_URL:restoreDb.href},'restore',join(root,day),
    '--target',target.pathname.slice(1),storage.bucket);
    assert.equal((await targetSql`SELECT id FROM portable_google_grants`).length,0);
    assert.equal((await targetSql`SELECT state_hash FROM portable_google_attempts`).length,0);
    assert.match(report,/Verified file versions: 2\./);
    server=spawn(process.execPath,['--import',mock,command,'start'],{env:webEnv,cwd,stdio:['ignore','ignore','inherit']});
    exit=once(server,'exit');
    const restored=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(3000),...options});
    let ready=false;
    for(let poll=0;poll<100&&server.exitCode===null&&!ready;poll++){
      const response=await restored('/healthz').catch(()=>null);
      ready=response?.status===200&&await response.text()==='ready';
      if(!ready)await delay(100);
    }
    assert.ok(ready);
    assert.equal((await restored(landingPath)).status,404);
    const [recoveredPage]=await targetSql`SELECT draft,last_published FROM portable_landing_pages WHERE id=${landingId}`;
    assert.equal(recoveredPage.draft.title,'Private autumn plans');
    assert.deepEqual(recoveredPage.last_published,edition);
    assert.equal((await restored(helpPath)).status,404);
    assert.equal(Number((await targetSql`SELECT revision FROM portable_knowledge_versions WHERE article_id=${articleId}`)[0].revision),1);
    assert.equal((await targetSql`SELECT article_id FROM portable_article_publications`).length,0);
    assert.equal((await restored(jobs,{headers})).status,401);
    const owner=await signIn('owner@example.test',restored,origin);
    const other=await signIn('other@example.test',restored,origin);
    assert.equal((await targetSql`SELECT count(*)::int AS n FROM portable_webhook_subscriptions`)[0].n,0);
    assert.equal((await targetSql`SELECT count(*)::int AS n FROM portable_webhook_deliveries`)[0].n,0);
    const companyDetail=companyApi+'/'+integratedCompany;
    assert.equal((await restored(companyDetail,credential(writeCredential.token,'PATCH',{properties:{name:'Copied key'}},inserted.headers.get('etag')))).status,401);
    const freshKey=await restored('/api/api-tokens',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
      body:JSON.stringify({name:'Restored integration',days:30,permissions:{companies:'read_write'}})});
    assert.equal(freshKey.status,201);
    const newSecret=(await freshKey.json()).token;
    const recoveredCompany=await restored(companyDetail,credential(newSecret,'GET'));
    assert.equal((await recoveredCompany.json()).properties.name,'Fictional restore customer');
    const amended=await restored(companyDetail,credential(newSecret,'PATCH',{properties:{name:'Updated on restored instance'}},recoveredCompany.headers.get('etag')));
    assert.equal(amended.status,200,await amended.clone().text());
    assert.equal((await amended.json()).properties.name,'Updated on restored instance');
    const restoredCompanyHistory=await (await restored(companyHistoryPath,{headers:owner})).json();
    assert.equal(restoredCompanyHistory.workflows.find(rule=>rule.id===companyRule).enabled,false);
    assert.deepEqual(restoredCompanyHistory.runs,[companyReceipt]);
    const tasksForCompany=await (await restored('/api/crm?kind=tasks&companyId='+integratedCompany,{headers:owner})).json();
    assert.deepEqual(tasksForCompany.records.map(task=>[task.id,task.data.name,task.companyId]),[
      [companyReceipt.companyTaskId,'Prepare a welcome plan',integratedCompany]]);
    const restoredLibrary=await (await restored('/api/team-inbox?snippets=1',{headers:owner})).json();
    assert.deepEqual(restoredLibrary.items,[{id:quickReplyId,revision:1,name:'Repair acknowledgement',body:'We are checking the scanner.'}]);
    const attributionPath='/api/web-attribution?siteId='+trackingSiteId+'&inquiryId='+conversion;
    const recoveredJourney=await (await restored(attributionPath,{headers:owner})).json();
    assert.equal(recoveredJourney.sites[0].enabled,false);
    assert.deepEqual(recoveredJourney.path.map(step=>step.path),['/demo']);
    assert.equal(recoveredJourney.conversions,1);
    assert.ok(!(await restored(collector,collect)).ok);
    assert.equal((await restored(attributionPath,{headers:other})).status,404);
    const restoredInboxPath='/api/team-inbox?id='+inboxId;
    const inbox=await (await restored(restoredInboxPath,{headers:owner})).json();
    assert.equal(inbox.conversation.claimedBy,actorId);
    assert.equal(inbox.messages[0].id,replyId);
    assert.equal(inbox.messages[0].state,'uncertain');
    assert.equal(inbox.pendingReply.id,replyId);
    assert.equal((await (await restored('/api/team-inbox?status=review',{headers:owner})).json()).items[0].id,inboxId);
    assert.equal((await sql`SELECT state FROM portable_inbox_messages WHERE id=${replyId}`)[0].state,'sending');
    assert.equal((await restored(restoredInboxPath,{headers:other})).status,404);
    const customPath=customApi+'?'+new URLSearchParams({objectId,record:customRecordId});
    const recoveredObject=await (await restored(customPath,{headers:owner})).json();
    assert.equal(recoveredObject.type.definition.fields[0].label,'Serial number');
    assert.equal(recoveredObject.record.data.values[serialId],'DS-482-R');
    await verifyRestoredEquipmentImport({scenario:equipmentImport,request:restored,origin,owner,
      rep:await signIn('invitee@example.test',restored,origin),workspace:inboxWorkspace,serialId,existingId:customRecordId,
      contactId:pilot.records.contacts.id,attachment:pilot.attachment});
    assert.deepEqual(recoveredObject.items.map(row=>row.target),[pilot.records.companies.id]);
    assert.equal((await restored(customPath,{headers:other})).status,404);
    const restoredEquipment=await (await restored(equipmentRunPath,{headers:owner})).json();
    assert.deepEqual(restoredEquipment.runs,equipmentRuns);
    assert.equal(restoredEquipment.workflows.find(w=>w.id===equipmentRule).enabled,false);
    const taskPath='/api/crm?kind=tasks&id='+equipmentRuns[0].customTaskId;
    const equipmentTask=await (await restored(taskPath,{headers:owner})).json();
    assert.equal(equipmentTask.data.name,'Inspect new equipment');
    assert.equal((await restored(taskPath,{headers:other})).status,404);
    const restoredResponse=await (await restored('/api/tickets?id='+responseTicket.id,{headers:owner})).json();
    assert.deepEqual(restoredResponse.firstResponse,finished);
    assert.deepEqual(await (await restored(ticketPolicyPath,{headers:owner})).json(),{...supportPolicy,revision:1});
    assert.deepEqual(await targetSql`SELECT * FROM portable_record_access_events WHERE action='csv' AND ${contactId}::uuid=ANY(record_ids) ORDER BY id`,accessEvidence);
    await assert.rejects(targetSql`DELETE FROM portable_record_access_events`,/append-only/);
    await verifyRestoredPortablePilot({restored,owner,other,pilot});
    const read=await restored(latest.pathname+latest.search,{headers:owner});
    assert.equal(read.status,200);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()),replacement);
    assert.equal((await restored(latest.pathname+latest.search,{headers:other})).status,404);
    assert.equal((await restored(laterPath,{headers:owner})).status,404);
    const sourceContact=await request(contactPath,{headers});
    assert.equal(sourceContact.status,200);
    assert.deepEqual(await sourceContact.json(),laterContact);
    assert.equal(await (await request(laterPath,{headers})).text(),laterBytes);
    run(webEnv,'worker','--once','--notes-only');
    assert.deepEqual(await noteReceipt(restored,owner),receipt);
    const [{count}]=await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${note.id}`;
    assert.equal(count,1);
    const waitHistory='/?view=workflows&runWorkflowId='+waitingWorkflow;
    const historyPage=await restored(waitHistory,{headers:owner});
    assert.equal(historyPage.status,200);
    assert.match((await historyPage.text()).replaceAll('<!-- -->',''),/Waiting for Customer/);
    const changed=await restored('/api/crm',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',id:waitingContact.id,expectedRevision:waitingContact.revision,
        data:{...waitingContact.data,lifecycle:'Customer'}})});
    assert.equal(changed.status,200,await changed.clone().text());
    run(webEnv,'worker','--once','--notes-only');
    run(webEnv,'worker','--once','--notes-only');
    run(webEnv,'worker','--once','--notes-only');
    const recoveredWait=await readBranch(restored,owner,waitingWorkflow);
    assert.equal(recoveredWait.enabled,false);
    assert.deepEqual(recoveredWait.run.pathSteps.map(step=>[step.id,step.status,step.issue]),[
      [waitingPath,'succeeded',null],[secondNote,'succeeded',null],[gatedHook,'skipped','webhook_workflow_changed']]);
    const receivedNotes=await targetSql`SELECT s.position,n.body,j.attempts FROM portable_workflow_path_steps s
      JOIN portable_jobs j ON j.workspace_id=s.workspace_id AND j.id=s.job_id
      JOIN portable_notes n ON n.workspace_id=j.workspace_id AND n.job_id=j.id
      WHERE s.workspace_id=${inboxWorkspace} AND s.run_id=${waitingJob} ORDER BY s.position`;
    assert.deepEqual(Array.from(receivedNotes),[{position:0,body:pathAction.body,attempts:1},{position:1,body:secondNoteBody,attempts:1}]);
    const {run:held,enabled}=await readBranch(restored,owner,hookWorkflow);
    assert.equal(enabled,false);
    assert.deepEqual([held.jobId,held.jobStatus,held.jobIssue,held.attempts,held.webhookDestination],
      [hookJob,'attention','restore_requires_reconciliation',0,destination]);
    assert.deepEqual(held.pathSteps.map(step=>[step.id,step.jobId,step.status,step.issue]),[
      [heldPath,hookJob,'attention','restore_requires_reconciliation'],[heldSuccessor,null,null,null]]);
    const ticketResult=await restored('/api/workflows?runTicketId='+sourceTicket.id,{headers:owner});
    assert.equal(ticketResult.status,200);
    const ticketHistory=await ticketResult.json();
    assert.equal(ticketHistory.workflows.find(w=>w.id===ticketRule).enabled,false);
    assert.equal(ticketHistory.runs.length,1);
    const [restoredRun]=ticketHistory.runs;
    assert.deepEqual([restoredRun.ticketId,restoredRun.ticketName,restoredRun.ticketRevision,restoredRun.ticketContactId,restoredRun.jobStatus],
      [sourceTicket.id,sourceTicket.data.name,1,waitingContact.id,'queued']);
    await targetSql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${inboxWorkspace} AND id=${restoredRun.jobId}`;
    run(webEnv,'worker','--once','--notes-only');
    run(webEnv,'worker','--once','--notes-only');
    const ticketNotes=await targetSql`SELECT n.body,j.contact_id FROM portable_notes n
      JOIN portable_jobs j ON j.workspace_id=n.workspace_id AND j.id=n.job_id
      WHERE n.workspace_id=${inboxWorkspace} AND n.job_id=${restoredRun.jobId} AND j.status='succeeded' AND j.attempts=1`;
    assert.deepEqual(Array.from(ticketNotes),[{body:ticketNote,contact_id:waitingContact.id}]);
    const [sourceTicketJob]=await sql`SELECT status,attempts FROM portable_jobs WHERE workspace_id=${inboxWorkspace} AND id=${restoredRun.jobId}`;
    assert.deepEqual(sourceTicketJob,{status:'queued',attempts:0});
    const [sourceWait]=await sql`SELECT status,attempts,wait_for_lifecycle FROM portable_jobs WHERE id=${waitingJob}`;
    assert.deepEqual(sourceWait,{status:'queued',attempts:0,wait_for_lifecycle:'Customer'});
    assert.deepEqual(await readBranch(request,headers,waitingWorkflow),sourceWaitBranch);
    assert.deepEqual(await readBranch(request,headers,hookWorkflow),sourceHeldBranch);
    return {recoveryPointAgeMs:outageAt-verified.captureStartedAt,recoveryMillis:Math.ceil(performance.now()-recoveryStart)};
  }finally{
    if(server){server.kill();await exit;}
    storage.storage.destroy();
    await targetSql.end();
  }
}

export async function verifyPortableRecovery({env,mock,request,headers,record,otherRecord,sql,directory,signIn,company,otherCompany,deal,otherDeal,sharing}){
  const target=new URL(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL);
  assert.ok(['postgres:','postgresql:'].includes(target.protocol));
  assert.equal(target.hostname,'127.0.0.1');
  assert.equal(target.search,'');
  assert.match(target.pathname,/^\/harbor_restore_test(?:_[a-z0-9]+)?$/);
  assert.notEqual(target.port,new URL(env.DATABASE_URL).port);
  const s3Endpoint=process.env.HARBOR_TEST_RESTORE_S3_ENDPOINT;
  assert.ok(s3Endpoint);
  assert.notEqual(new URL(s3Endpoint).origin,new URL(env.HARBOR_S3_ENDPOINT).origin);
  const fixture=localFileFixture(s3Endpoint);
  const targetSql=postgres(target.href,{onnotice:()=>{}});
  let server,exit;
  try{
    const [existing]=await targetSql`SELECT to_regclass('public.login_identities') AS identities`;
    assert.equal(existing.identities,null,'Restore rehearsal requires a fresh disposable database.');
    await verifyPortableLegacyFileRecovery({env,directory,target,targetSql,s3Endpoint});
    if(process.env.HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT){
      await verifyPortableLegacyFileRecovery({env,directory,target,targetSql,s3Endpoint,hosted:true});
    }
    const socket=createServer().listen(0,'127.0.0.1');
    await once(socket,'listening');
    const port=socket.address().port;
    await new Promise(resolve=>socket.close(resolve));
    const origin='http://127.0.0.1:'+port;
    const targetEnv={...env,...fixture.env,DATABASE_URL:target.href,PORT:String(port),HARBOR_LOGIN_ORIGIN:origin};
    const hostedStorage=process.env.HARBOR_TEST_HOSTED_RESTORE_S3_ENDPOINT;
    const restoreDatabase=new URL(target);
    const restoreArgs=[];
    let restoreEnv=targetEnv;
    if(hostedStorage){
      const proxy=new URL(hostedStorage);
      assert.equal(proxy.hostname,'127.0.0.1');
      assert.equal(proxy.protocol,'https:');
      const sslmode=process.env.HARBOR_TEST_RESTORE_POSTGRES_SSLMODE||'disable';
      assert.ok(['disable','verify-full'].includes(sslmode));
      restoreDatabase.searchParams.set('sslmode',sslmode);
      restoreArgs.push('--target',target.pathname.slice(1),fixture.bucket);
      restoreEnv={...targetEnv,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_RESTORE_ENABLED:'true',
        HARBOR_S3_ENDPOINT:proxy.href,DATABASE_URL:restoreDatabase.href};
    }
    const refuseRestore=(bundle,message)=>assertRefused(restoreEnv,bundle,message,restoreArgs);
    const microsoftId=randomUUID(),microsoftSubject=randomUUID()+':'+randomUUID();
    const samlId=randomUUID(),samlDirectoryId=randomUUID(),samlEmail='saml-recovery@example.test';
    const samlSubject=createHash('sha256').update(JSON.stringify(['urn:fictional:directory','employee-42'])).digest('hex');
    const microsoftEmail='outlook-recovery@example.test',directoryId=randomUUID();
    const mappedTeam=randomUUID(),scimGroupId=randomUUID(),groupExternalId=randomUUID();
    const teamPage=randomUUID(),teamBooking=randomUUID(),hostOffer=randomUUID();
    await sql.begin(async tx=>{
      await tx`INSERT INTO login_identities (id,saml_subject,saml_directory_issuer,directory_authority,email,created_at,updated_at) VALUES (${samlId},${samlSubject},'urn:fictional:directory',${sharing.workspaceId},${samlEmail},0,0)`;
      await tx`INSERT INTO portable_directory_users(id,workspace_id,user_id,saml_issuer,saml_external_id)
        VALUES (${samlDirectoryId},${sharing.workspaceId},${samlId},'urn:fictional:directory','employee-42')`;
      await tx`INSERT INTO portable_workspace_viewers (id,workspace_id,viewer_id,role,view_scope,edit_scope)
        VALUES (${randomUUID()},${sharing.workspaceId},${samlId},'viewer','owned','owned')`;
      await tx`INSERT INTO login_identities (id,microsoft_subject,email,created_at,updated_at)
        VALUES (${microsoftId},${microsoftSubject},${microsoftEmail},0,0)`;
      await tx`INSERT INTO portable_directory_users (id,workspace_id,user_id) VALUES (${directoryId},${sharing.workspaceId},${microsoftId})`;
      await tx`INSERT INTO portable_workspace_teams (workspace_id,id,name,name_key) VALUES
        (${sharing.workspaceId},${mappedTeam},'Fictional recovery team','fictional recovery team')`;
      await tx`INSERT INTO portable_workspace_viewers (id,workspace_id,viewer_id,team_id) VALUES
        (${randomUUID()},${sharing.workspaceId},${microsoftId},${mappedTeam})`;
      await tx`INSERT INTO portable_standard_property_access (workspace_id,kind,id,restricted,visible_team_id,revision)
        VALUES (${sharing.workspaceId},'companies','annualRevenue',true,${mappedTeam},1)`;
      await tx`INSERT INTO portable_directory_groups (workspace_id,team_id,tenant,external_id,group_id,display_name)
        VALUES (${sharing.workspaceId},${mappedTeam},${microsoftSubject.split(':')[0]},${groupExternalId},${scimGroupId},'Fictional recovery group')`;
      await tx`INSERT INTO portable_directory_group_members (workspace_id,user_id,group_id)
        VALUES (${sharing.workspaceId},${microsoftId},${scimGroupId})`;
      await tx`INSERT INTO portable_lead_routing_members
        (workspace_id,user_id,available,country,capacity,time_zone,days,start_minute,end_minute,revision)
        VALUES (${sharing.workspaceId},${microsoftId},true,'',5,'UTC',127,0,1440,1)`;
      await tx`INSERT INTO portable_team_availability (id,workspace_id,user_id,windows,revision)
        VALUES (${hostOffer},${sharing.workspaceId},${microsoftId},'[]',1)`;
      await tx`INSERT INTO portable_team_calendars (id,workspace_id,title,mode,duration,hosts)
        VALUES (${teamPage},${sharing.workspaceId},'Fictional demo','rotation',30,ARRAY[${hostOffer}::uuid])`;
      await tx`INSERT INTO portable_team_bookings (id,workspace_id,page_id,title,email,start_at,end_at)
        VALUES (${teamBooking},${sharing.workspaceId},${teamPage},'Fictional demo','fictional@example.test',60000,1860000)`;
      await tx`INSERT INTO portable_team_booking_hosts (workspace_id,booking_id,user_id)
        VALUES (${sharing.workspaceId},${teamBooking},${microsoftId})`;
      await tx`INSERT INTO portable_google_grants (user_id,provider,id,email,refresh_token)
        VALUES (${microsoftId},'outlook-calendar',${randomUUID()},${microsoftEmail},'fictional encrypted test credential')`;
    });

    const [{owner_id:actorId}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
    const pilot=await seedPortablePilot({request,origin:env.HARBOR_LOGIN_ORIGIN,headers,actorId});
    const base='/api/record-attachments?recordId='+record.id;
    const rows=await sql`SELECT file_id,version_id FROM contact_file_versions WHERE contact_id=${record.id} AND revision IS NOT NULL ORDER BY revision`;
    assert.ok(rows.length>=2,'The rehearsal needs historical and current files.');
    // Other fixtures (e.g. Contact merge) may store files on other Contacts; the backup counts every version.
    const [{n:otherVersions}]=await sql`SELECT count(*)::int AS n FROM contact_file_versions WHERE contact_id<>${record.id} AND revision IS NOT NULL`;
    const files=[];
    for(const row of rows){
      const path=base+'&fileId='+row.file_id+'&versionId='+row.version_id;
      const response=await request(path,{headers});
      assert.equal(response.status,200);
      files.push({path,bytes:Buffer.from(await response.arrayBuffer())});
    }
    const queuedExternal=randomUUID();
    const [ownerScope]=await sql`SELECT id AS workspace_id,owner_id AS actor_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
    await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
      VALUES(${ownerScope.workspace_id},${queuedExternal},${record.id},${ownerScope.actor_id},'external','Restore fence fixture',0,0,0)`;
    const dispatchingExternal=randomUUID();
    await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,
      created_at,status,attempts,lease_token,lease_until)
      VALUES(${ownerScope.workspace_id},${dispatchingExternal},${sharing.gmail.contactId},${ownerScope.actor_id},
        'external','Interrupted dispatch fixture',0,0,0,'dispatching',1,${randomUUID()},${Date.now()+60_000})`;
    await sql`INSERT INTO portable_job_attempts(workspace_id,job_id,number,started_at)
      VALUES(${ownerScope.workspace_id},${dispatchingExternal},1,0)`;
    const beforeJobs=await sql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`;
    const pendingGmail=await sql`SELECT id FROM portable_jobs WHERE kind='gmail' AND status IN ('queued','running','dispatching')`;
    const held=new Set([queuedExternal,dispatchingExternal,...pendingGmail.map(job=>job.id)]);
    const restoredJobs=beforeJobs.map(job=>held.has(job.id)?{...job,status:'attention',issue:'restore_requires_reconciliation'}:job);
    const jobsPath='/api/background-jobs?recordId='+record.id;
    const originalHistory=(await (await request(jobsPath,{headers})).json()).items;
    const beforeNotes=await sql`SELECT workspace_id,job_id,body FROM portable_notes ORDER BY job_id`;
    assert.ok(beforeJobs.some(job=>job.status==='attention'));
    assert.ok(beforeJobs.some(job=>job.status==='succeeded'));
    const backupRoot=join(directory,'scheduled-backups');
    await mkdir(backupRoot,{mode:0o700});
    const storageEndpoint=process.env.HARBOR_TEST_HOSTED_S3_ENDPOINT;
    const backupSsl=process.env.PGSSLROOTCERT&&process.env.NODE_EXTRA_CA_CERTS?'verify-full':'disable';
    const backupEnv={...env,HARBOR_PORTABLE_BACKUP_ENABLED:'true',...(storageEndpoint?{
      HARBOR_PORTABLE_MODE:'hosted',HARBOR_S3_ENDPOINT:storageEndpoint,DATABASE_URL:env.DATABASE_URL+'?sslmode='+backupSsl,
    }:{})};
    const offlineEnv={...env,DATABASE_URL:'',HARBOR_S3_ENDPOINT:''};
    const preflight=env=>run(env,'doctor','backup',backupRoot);
    const preflightFailure=env=>{
      try{preflight(env);assert.fail('Backup preflight unexpectedly passed.');}
      catch(error){
        assert.equal(error.status,1);
        return JSON.parse(error.stdout);
      }
    };
    const backupReadiness=JSON.parse(preflight({...backupEnv,HARBOR_PORTABLE_BACKUP_ENABLED:'false'}));
    assert.deepEqual(backupReadiness,{profile:'backup',result:'ready',backupEnabled:false,
      checks:{directory:'ok',database:'ok',storage:'ok',dumpTool:'ok'}});
    assert.deepEqual(await readdir(backupRoot),[]);
    const backupRole='backup_fixture_'+randomUUID().replaceAll('-','');
    const backupPassword=randomUUID();
    const limitedBackupUrl=new URL(backupEnv.DATABASE_URL);
    limitedBackupUrl.username=backupRole;
    limitedBackupUrl.password=backupPassword;
    const limitedBackup={...backupEnv,DATABASE_URL:limitedBackupUrl.href,HARBOR_PORTABLE_BACKUP_ENABLED:'false'};
    const missingBackupPermissions=async()=>{
      assert.throws(()=>preflight(limitedBackup),error=>{
        assert.equal(error.status,1);
        assert.equal(error.stderr,'');
        for(const value of [backupRole,backupPassword,'portable_ticket_events','login_sessions','__drizzle_migrations_id_seq']){
          assert.ok(!error.stdout.includes(value));
        }
        const report=JSON.parse(error.stdout);
        assert.equal(report.result,'needs_setup');
        assert.equal(report.checks.database,'missing_backup_permissions');
        return true;
      });
      assert.deepEqual(await readdir(backupRoot),[]);
    };
    await sql.unsafe(`CREATE ROLE "${backupRole}" LOGIN PASSWORD '${backupPassword}'`);
    try{
      await sql`GRANT USAGE ON SCHEMA public,drizzle TO ${sql(backupRole)}`;
      await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO ${sql(backupRole)}`;
      await sql`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,drizzle TO ${sql(backupRole)}`;
      await sql`REVOKE SELECT ON public.portable_ticket_events FROM ${sql(backupRole)}`;
      await missingBackupPermissions();
      await sql`GRANT SELECT ON public.portable_ticket_events TO ${sql(backupRole)}`;
      await sql`REVOKE SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM ${sql(backupRole)}`;
      await missingBackupPermissions();
      await sql`GRANT SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO ${sql(backupRole)}`;
      await sql`REVOKE SELECT ON public.login_sessions FROM ${sql(backupRole)}`;
      await missingBackupPermissions();
      await sql`GRANT SELECT ON public.login_sessions TO ${sql(backupRole)}`;
      assert.deepEqual(JSON.parse(preflight(limitedBackup)),backupReadiness);
      assert.deepEqual(await readdir(backupRoot),[]);
    }finally{
      await sql`DROP OWNED BY ${sql(backupRole)}`;
      await sql`DROP ROLE ${sql(backupRole)}`;
    }
    const oldDumpTool=join(directory,'old-backup-client');
    await mkdir(oldDumpTool,{mode:0o700});
    await writeFile(join(oldDumpTool,'pg_dump'),"#!/bin/sh\nprintf 'pg_dump (PostgreSQL) 17.9\\n'\n",{mode:0o700});
    const incompatible=preflightFailure({...backupEnv,PATH:oldDumpTool+':'+backupEnv.PATH});
    assert.deepEqual(incompatible.checks,{directory:'ok',database:'ok',storage:'ok',dumpTool:'older_than_database'});
    assert.deepEqual(await readdir(backupRoot),[]);
    const wrongStorage=preflightFailure({...backupEnv,HARBOR_S3_BUCKET:'missing-harbor-test-bucket'});
    assert.equal(wrongStorage.checks.storage,'unavailable');
    assert.equal(wrongStorage.checks.database,'ok');
    assert.doesNotMatch(JSON.stringify(wrongStorage),/missing-harbor-test-bucket|contact-files\//);
    const preflightSourceMarker=join(backupRoot,sourceMarker);
    const differentSource=randomUUID()+'\n';
    await writeFile(preflightSourceMarker,differentSource,{mode:0o600});
    try{
      assert.equal(preflightFailure(backupEnv).checks.directory,'wrong_source');
      assert.equal(await readFile(preflightSourceMarker,'utf8'),differentSource);
    }finally{await rm(preflightSourceMarker);}
    assert.throws(()=>run({...backupEnv,HARBOR_PORTABLE_BACKUP_ENABLED:'false'},'backup-service',backupRoot),
      error=>/backups require HARBOR_PORTABLE_BACKUP_ENABLED/.test(error.stderr));
    assert.throws(()=>run({...backupEnv,HARBOR_PORTABLE_BACKUP_ENABLED:''},'backup-tick',backupRoot),
      error=>/backups require HARBOR_PORTABLE_BACKUP_ENABLED/.test(error.stderr));
    assert.throws(()=>run(offlineEnv,'backup-status',backupRoot),error=>/No completed scheduled Harbor backup/.test(error.stderr));
    await chmod(backupRoot,0o755);
    try{
      assert.equal(preflightFailure(backupEnv).checks.directory,'invalid_private_directory');
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>/owner-only permissions/.test(error.stderr));
    }finally{await chmod(backupRoot,0o700);}
    const highFloor='9007199254740991';
    const lowSpaceEnv={...backupEnv,HARBOR_BACKUP_MIN_FREE_MIB:highFloor};
    assert.throws(()=>run(backupEnv,'backup-tick',backupRoot,'--min-free-mib','0'),
      error=>error.status===1&&/positive whole number of MiB/.test(error.stderr));
    assert.throws(()=>run(backupEnv,'backup-tick',backupRoot,'--min-free-mib','1','--min-free-mib','2'),
      error=>error.status===1&&/at most once/.test(error.stderr));
    assert.throws(()=>run(lowSpaceEnv,'backup-tick',backupRoot),
      error=>error.status===1&&JSON.parse(error.stderr).issue==='low_free_space');
    assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--min-free-mib',highFloor),
      error=>error.status===1&&JSON.parse(error.stderr).issue==='low_free_space');
    assert.throws(()=>run(lowSpaceEnv,'monitor-status',backupRoot,'--worker-off','--prometheus'),
      error=>error.status===2&&/^harbor_monitor_backup_issue\{issue="low_free_space"\} 1$/m.test(error.stdout));
    assert.throws(()=>run({...backupEnv,HARBOR_S3_BUCKET:'missing-harbor-test-bucket'},'backup-tick',backupRoot),
      error=>{
        const report=JSON.parse(error.stderr);
        assert.equal(report.result,'failed');
        assert.match(report.reason,/Could not read or verify a committed attachment/);
        assert.doesNotMatch(error.stderr,/missing-harbor-test-bucket|contact-files\//);
        return true;
      });
    const [{source_id:sourceId}]=await sql`SELECT source_id FROM public.portable_backup_source`;
    const [{day:failedDay}]=await sql`SELECT to_char(current_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`;
    const firstFailure=failureMarker(failedDay);
    assert.deepEqual((await readdir(backupRoot)).sort(),[firstFailure,sourceMarker]);
    for(const args of [[],['--verify']]){
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,...args),error=>
        error.status===1&&JSON.parse(error.stderr).issue==='capture_failed'&&/first scheduled Harbor backup failed/.test(error.stderr));
    }
    assert.throws(()=>run(backupEnv,'monitor-status',backupRoot,'--worker-off','--prometheus'),error=>
      error.status===2&&/^harbor_monitor_backup_issue\{issue="capture_failed"\} 1$/m.test(error.stdout));
    assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--verify','--day',failedDay),error=>
      error.status===1&&JSON.parse(error.stderr).issue==='backup_missing');
    assert.equal(await readFile(join(backupRoot,sourceMarker),'utf8'),sourceId+'\n');

    const laterFile=randomUUID(),laterVersion=randomUUID();
    // This fixture packs independent test scenarios into one wall-clock minute.
    await sql`DELETE FROM portable_request_budgets WHERE scope='api_write'
      AND subject=(SELECT id FROM login_identities WHERE email='owner@example.test')`;
    const writeTicket=body=>request('/api/tickets',{method:'POST',headers:{
      ...headers,origin:env.HARBOR_LOGIN_ORIGIN,'content-type':'application/json',
    },body:JSON.stringify(body)});
    const ticketName='Fictional recovery ticket '+randomUUID();
    const createdTicket=await writeTicket({action:'save',data:{name:ticketName,tags:['Repair','Warranty']},contactId:record.id,companyId:company.id});
    assert.equal(createdTicket.status,201);
    const {record:{id:ticketId}}=await createdTicket.json();
    const closedTicket=await writeTicket({action:'status',id:ticketId,expectedRevision:1,status:'Closed'});
    assert.equal(closedTicket.status,200);
    const {record:closedRecord}=await closedTicket.json();
    const ticketPath='/api/tickets?id='+ticketId;
    const sourceTicket=await request(ticketPath,{headers});
    assert.equal(sourceTicket.status,200);
    const expectedTicket=await sourceTicket.json();
    assert.deepEqual(expectedTicket,{...closedRecord,inboxConversationId:null});
    assert.deepEqual(expectedTicket.data.tags,['repair','warranty']);
    const sourceOrigin=env.HARBOR_LOGIN_ORIGIN;
    const staffPost=async(path,body)=>{
      const response=await request(path,{method:'POST',headers:{...headers,origin:sourceOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());
      return response.json();
    };
    const helpSettings='/api/knowledge-base?publication=1';
    const {center}=await (await request(helpSettings,{headers})).json();
    const portalCenter=center?.enabled?center:(await staffPost(helpSettings,{action:'settings',enabled:true,
      name:'Recovery help center',accent:'#126060',revision:center?.revision??0})).center;
    const ownerCase='/api/case-portal';
    const publication={ticketId,ticketRevision:expectedTicket.revision,contactId:record.id,expectedRevision:0};
    const subject='Fictional customer-visible repair update';
    await staffPost(ownerCase,{action:'publish',...publication,subject,update:'Your part has arrived.'});
    const invite=await staffPost(ownerCase,{action:'invite',...publication});
    const casesPath='/help/'+portalCenter.id+'/cases';
    const redemption=await request(casesPath,{method:'POST',headers:{origin:sourceOrigin,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({action:'redeem',invite:invite.inviteToken})});
    assert.equal(redemption.status,303);
    const customerCookie=redemption.headers.get('set-cookie').split(';')[0];
    const customerView=await request(casesPath+'?case='+ticketId,{headers:{cookie:customerCookie}});
    assert.equal(customerView.status,200);
    assert.ok((await customerView.text()).includes(subject));
    const ticketHistory=db=>db`SELECT actor_id,revision,previous,data,occurred_at FROM portable_ticket_events
      WHERE workspace_id=${sharing.workspaceId} AND ticket_id=${ticketId} ORDER BY revision`;
    const [ticketOwner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
    const originalTicketHistory=Array.from(await ticketHistory(sql));
    assert.deepEqual(originalTicketHistory.map(event=>[event.actor_id,event.revision,event.data.data.ticketStatus]),
      [[ticketOwner.owner_id,1,'New'],[ticketOwner.owner_id,2,'Closed']]);

    const expectedProperty=await seedCustomPropertyRecovery({request,origin:env.HARBOR_LOGIN_ORIGIN,headers});
    const groupId=randomUUID();
    const saveGroup=(revision,change)=>request('/api/property-groups',{method:'POST',
      headers:{...headers,origin:env.HARBOR_LOGIN_ORIGIN,'content-type':'application/json'},
      body:JSON.stringify({kind:'contacts',revision,change})});
    const group=await saveGroup(0,{action:'create',id:groupId,name:'Fictional recovery property group'});
    assert.equal(group.status,200,await group.clone().text());
    const assigned=await saveGroup(1,{action:'move',group:groupId,fields:['phone','custom:'+expectedProperty.properties[0].id]});
    assert.equal(assigned.status,200,await assigned.clone().text());
    const expectedGroups=await assigned.json();
    assert.equal(expectedGroups.revision,2);
    assert.equal(expectedGroups.assignments.phone,groupId);
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(943157310)`;
      assert.deepEqual(JSON.parse(run(backupEnv,'backup-tick',backupRoot)),{event:'harbor_portable_backup',result:'busy'});
      assert.deepEqual((await readdir(backupRoot)).sort(),[firstFailure,sourceMarker]);
    });
    const captured=await backupDuringWrite(backupEnv,directory,backupRoot,async()=>{
      const duplicate=JSON.parse(run(backupEnv,'backup-tick',backupRoot));
      assert.equal(duplicate.result,'busy');
      const [{exclusiveAvailable}]=await sql`SELECT pg_try_advisory_xact_lock(943157310) AS "exclusiveAvailable"`;
      assert.equal(exclusiveAvailable,false,'The backup holds the shared maintenance lock.');
      assert.match(run(backupEnv,'migrate'),/migrations applied/,'The current ledger can be verified during backup.');
      assert.ok((await readdir(backupRoot)).every(name=>name===sourceMarker||name===firstFailure||name.startsWith('.harbor-staging-')));
      const revoked=await request('/api/workspaces',{method:'POST',headers:{
        ...headers,origin:env.HARBOR_LOGIN_ORIGIN,'content-type':'application/json',
      },body:JSON.stringify({action:'revoke',id:sharing.grantId})});
      assert.equal(revoked.status,200);
      const cancelled=await request('/api/workspaces',{method:'POST',headers:{
        ...headers,origin:env.HARBOR_LOGIN_ORIGIN,'content-type':'application/json',
      },body:JSON.stringify({action:'cancel_invite',id:sharing.invitationId})});
      assert.equal(cancelled.status,200);
      const response=await request(base+'&fileId='+laterFile+'&versionId='+laterVersion,{method:'POST',
        headers:{...headers,origin:env.HARBOR_LOGIN_ORIGIN,'x-harbor-file-name':'After-snapshot.txt'},body:'Added while the snapshot was open'});
      assert.equal(response.status,200);
    });
    const completion=JSON.parse(captured);
    await verifyBackupServiceRetry(backupEnv,directory,sql);
    assert.equal(completion.result,'complete');
    assert.equal(completion.versions,files.length+otherVersions);
    assert.match(completion.day,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual((await readdir(backupRoot)).sort(),[servicePollMarker,sourceMarker,completion.day]);
    assert.equal(JSON.parse(run(backupEnv,'backup-tick',backupRoot)).result,'already_complete');
    assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot)).result,'fresh');
    assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot,'--min-free-mib','1')).result,'fresh');
    assert.equal(JSON.parse(run(backupEnv,'backup-tick',backupRoot,'--min-free-mib',highFloor)).result,'already_complete');
    assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--min-free-mib',highFloor),error=>
      error.status===1&&JSON.parse(error.stderr).issue==='low_free_space');
    assert.throws(()=>run(backupEnv,'monitor-status',backupRoot,'--min-free-mib',highFloor),error=>{
      const report=JSON.parse(error.stdout);
      return error.status===2&&report.backups.result==='attention'&&report.backups.issue==='low_free_space'&&
        report.worker.result!=='unavailable'&&!error.stdout.includes(backupRoot);
    });
    assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--min-free-mib','0'),error=>
      error.status===1&&/positive whole number of MiB/.test(error.stderr));
    const spaceRecovered=spawnSync(process.execPath,[command,'monitor-status',backupRoot,'--worker-off','--min-free-mib','1'],
      {env:lowSpaceEnv,cwd,timeout:20_000,encoding:'utf8'});
    // The rehearsal also seeds jobs that can require attention independently.
    assert.ok([0,2].includes(spaceRecovered.status),spaceRecovered.stderr||spaceRecovered.stdout);
    assert.equal(JSON.parse(spaceRecovered.stdout).backups.result,'fresh',spaceRecovered.stdout);
    const bundle=join(backupRoot,completion.day);
    const manifestPath=join(bundle,'manifest.json');
    const manifestBytes=await readFile(manifestPath);
    const bucket=fixture.bucket,storage=fixture.storage;
    const objectCount=async()=> (await storage.send(new ListObjectsV2Command({Bucket:bucket}))).KeyCount;
    await storage.send(new CreateBucketCommand({Bucket:bucket}));
    const restoreTargetChecks={database:'ok',storage:'ok',restoreTool:'ok',sqlTool:'ok'};
    const savedManifest=manifestPath+'.saved';
    await rename(manifestPath,savedManifest);
    try{
      execFileSync('mkfifo',[manifestPath]);
      const reason='Backup storage did not respond before the routine check deadline.';
      const verifyReason='Backup verification did not finish before its deadline.';
      const archiveTimeout=['--verify-timeout-seconds','2'];
      const verifyOptions=['--verify',...archiveTimeout];
      const report=(childEnv,args)=>execute(process.execPath,[command,...args],{
        env:childEnv,cwd,timeout:15_000,encoding:'utf8',
      });
      const monitorEnv={...env,HARBOR_MONITOR_WEB_ORIGIN:env.HARBOR_LOGIN_ORIGIN};
      const checkMonitorFailure=expected=>error=>{
        assert.equal(error.code,1,'combined monitor exits before the caller timeout');
        const observed=JSON.parse(error.stdout);
        assert.equal(observed.result,'unavailable');
        assert.deepEqual(observed.backups,{result:'unavailable',reason:expected,issue:'check_timed_out'});
        assert.notEqual(observed.worker.result,'unavailable');
        assert.equal(observed.web.result,'ok');
        return true;
      };
      const checkDoctorTimeout=(profile,checks)=>error=>{
        assert.equal(error.code,1,'archive preflight exits before the caller timeout');
        assert.equal(error.stderr,'');
        assert.deepEqual(JSON.parse(error.stdout),{profile,result:'needs_setup',checks:{...checks,archive:'timed_out'}});
        return true;
      };
      await Promise.all([
        assert.rejects(report({PATH:env.PATH},['doctor','bundle',bundle,...archiveTimeout]),
          checkDoctorTimeout('bundle',{restoreTool:'ok'})),
        assert.rejects(report({...restoreEnv,HARBOR_PORTABLE_RESTORE_ENABLED:'false'},
          ['doctor','restore','--bundle',bundle,...archiveTimeout]),checkDoctorTimeout('restore',restoreTargetChecks)),
        assert.rejects(report(offlineEnv,['backup-status',backupRoot]),error=>{
          assert.equal(error.code,1,'standalone backup status exits before the caller timeout');
          assert.deepEqual(JSON.parse(error.stderr),{event:'harbor_portable_backup',result:'failed',reason,issue:'check_timed_out'});
          return true;
        }),
        assert.rejects(report(offlineEnv,['backup-status',backupRoot,...verifyOptions]),error=>{
          assert.equal(error.code,1,'full verification exits before the caller timeout');
          assert.deepEqual(JSON.parse(error.stderr),{event:'harbor_portable_backup',result:'failed',reason:verifyReason,issue:'check_timed_out'});
          return true;
        }),
        assert.rejects(report(monitorEnv,['monitor-status',backupRoot,'--worker-off','--web']),checkMonitorFailure(reason)),
        assert.rejects(report(monitorEnv,['monitor-status',backupRoot,'--worker-off','--web',...verifyOptions]),
          checkMonitorFailure(verifyReason)),
      ]);
    }finally{
      await rm(manifestPath,{force:true});
      await rename(savedManifest,manifestPath);
    }
    assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot,'--verify','--verify-timeout-seconds=10')).result,'verified');
    assert.deepEqual(await readFile(manifestPath),manifestBytes);
    const bundleDoctor=JSON.parse(run({PATH:env.PATH},'doctor','bundle',bundle,'--verify-timeout-seconds','10'));
    assert.equal(bundleDoctor.result,'verified');
    assert.deepEqual(bundleDoctor.checks,{restoreTool:'ok',archive:'ok'});
    const previousManifest=JSON.parse(manifestBytes.toString());
    const historicalRoot=join(directory,'older-recovery-points');
    const historicalDay=new Date(Date.parse(completion.day+'T00:00:00Z')-7*86_400_000).toISOString().slice(0,10);
    const historicalPath=join(historicalRoot,historicalDay);
    await mkdir(historicalRoot,{mode:0o700});
    await cp(bundle,historicalPath,{recursive:true});
    const historicalStart=Date.parse(historicalDay+'T01:00:00Z'),historicalEnd=historicalStart+60_000;
    await writeFile(join(historicalPath,'capture-started-at'),new Date(historicalStart).toISOString()+'\n');
    const historicalManifest=join(historicalPath,'manifest.json');
    const savedHistory={...previousManifest,completedAt:historicalEnd};
    await writeFile(historicalManifest,JSON.stringify(savedHistory));
    await mkdir(join(historicalRoot,completion.day));
    const archiveEnv={...offlineEnv,HARBOR_BACKUP_MIN_FREE_MIB:highFloor};
    const listPoints=()=>JSON.parse(run(archiveEnv,'backup-status',historicalRoot,'--list'));
    assert.deepEqual(listPoints(),{event:'harbor_portable_backup',result:'listed',hasOlder:false,points:[
      {day:completion.day,status:'unavailable',issue:'invalid_bundle'},
      {day:historicalDay,status:'metadata_readable',captureStartedAt:historicalStart,completedAt:historicalEnd,migrationHistory:'ok'},
    ]});
    assert.throws(()=>run(offlineEnv,'backup-status',historicalRoot,'--list','--verify'),
      error=>/Use --list by itself/.test(error.stderr));
    const verifyDay=(day=historicalDay)=>run(archiveEnv,'backup-status',historicalRoot,'--verify','--day',day);
    assert.deepEqual(JSON.parse(verifyDay()),{event:'harbor_portable_backup',result:'verified',day:historicalDay,
      versions:previousManifest.files.length,captureStartedAt:historicalStart,completedAt:historicalEnd,migrationHistory:'ok'});
    const migrationReceipts=savedHistory.migrations;
    const lastReceipt=migrationReceipts.at(-1);
    for(const [expected,changes] of [
      ['migration_required',{migrations:migrationReceipts.slice(0,-1)}],
      ['newer_release_required',{migrations:[...migrationReceipts,{...lastReceipt,at:lastReceipt.at+1}]}],
      ['migration_history_mismatch',{migrations:[{...migrationReceipts[0],sha256:'0'.repeat(64)},...migrationReceipts.slice(1)]}],
      ['unrecorded',{format:'harbor-portable-recovery-v1',sourceId:undefined,migrations:undefined}],
    ]){
      await writeFile(historicalManifest,JSON.stringify({...savedHistory,...changes}));
      const report=JSON.parse(verifyDay());
      assert.equal(report.result,'verified');
      assert.equal(report.migrationHistory,expected);
      assert.equal(listPoints().points[1].migrationHistory,expected);
    }
    await writeFile(historicalManifest,JSON.stringify(savedHistory));
    assert.throws(()=>run(offlineEnv,'backup-status',historicalRoot,'--verify'),
      error=>JSON.parse(error.stderr).issue==='invalid_bundle');
    assert.throws(()=>verifyDay('2020-01-01'),error=>JSON.parse(error.stderr).issue==='backup_missing');
    for(const day of ['../elsewhere','2026-02-30']){
      assert.throws(()=>verifyDay(day),error=>/Supply a UTC date/.test(error.stderr));
    }
    const historicalDump=join(historicalPath,'database.dump'),historicalBytes=await readFile(historicalDump);
    const damagedBytes=Buffer.from(historicalBytes);
    damagedBytes[0]^=1;
    await writeFile(historicalDump,damagedBytes);
    try{assert.throws(()=>verifyDay(),error=>JSON.parse(error.stderr).issue==='integrity_failed');}
    finally{await writeFile(historicalDump,historicalBytes);}

    const failureRoot=join(directory,'failure-preserves-backup');
    const priorDay=new Date(Date.parse(completion.day+'T00:00:00Z')-86_400_000).toISOString().slice(0,10);
    await mkdir(failureRoot,{mode:0o700});
    await cp(bundle,join(failureRoot,priorDay),{recursive:true});
    const legacyManifest=join(failureRoot,priorDay,'manifest.json');
    await writeFile(legacyManifest,JSON.stringify({...previousManifest,sourceId:undefined}));
    assert.equal(JSON.parse(run(offlineEnv,'backup-status',failureRoot,'--verify')).result,'verified');
    assert.throws(()=>run(backupEnv,'backup-tick',failureRoot),error=>/no verified source/.test(error.stderr));
    assert.deepEqual(await readdir(failureRoot),[priorDay]);
    await writeFile(legacyManifest,manifestBytes);
    await cp(join(backupRoot,sourceMarker),join(failureRoot,sourceMarker));
    const lostReplyRoot=join(directory,'lost-reply-backups');
    await mkdir(lostReplyRoot,{mode:0o700});
    await cp(failureRoot,lostReplyRoot,{recursive:true});
    assert.throws(()=>run({...backupEnv,HARBOR_S3_BUCKET:'missing-harbor-test-bucket'},'backup-tick',failureRoot),
      error=>/"result":"failed"/.test(error.stderr));
    const failedRootContents=[failureMarker(completion.day),sourceMarker,priorDay];
    assert.deepEqual((await readdir(failureRoot)).sort(),failedRootContents);
    assert.deepEqual(await readFile(join(failureRoot,priorDay,'manifest.json')),manifestBytes);
    await verifyScheduledBackupReplyLoss(backupEnv,directory,lostReplyRoot,priorDay,completion.day,manifestBytes,sql);
    const capturePath=join(bundle,'capture-started-at');
    const captureBytes=await readFile(capturePath);
    try{
      const stale=Date.now()-31*60*60*1000;
      const capturedAt=Date.parse(captureBytes.toString().trim());
      assert.ok(capturedAt>0&&capturedAt<=previousManifest.completedAt);
      const olderCapture=Date.now()-27*60*60*1000;
      await writeFile(capturePath,new Date(olderCapture).toISOString()+'\n');
      assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot)).result,'fresh');
      assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot,'--max-age-hours','28','--verify')).result,'verified');
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--max-age-hours','26'),
        error=>error.status===1&&/backup is overdue/.test(error.stderr));
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot,'--max-age-hours=26'),error=>{
        const report=JSON.parse(error.stdout);
        return error.status===2&&report.worker.result!=='unavailable'&&report.backups.result==='attention'&&
          report.backups.issue==='backup_stale'&&/backup is overdue/.test(report.backups.reason);
      });
      assert.equal(JSON.parse(run(backupEnv,'backup-tick',backupRoot)).result,'already_complete');
      assert.deepEqual(await readFile(manifestPath),manifestBytes);
      for(const value of ['0','31','1.5','invalid']){
        assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--max-age-hours',value),
          error=>error.status===1&&/whole number of hours from 1 to 30/.test(error.stderr));
      }
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot,'--max-age-hours=24','--max-age-hours=25'),
        error=>error.status===1&&/each backup check option at most once/.test(error.stderr));
      await rm(capturePath);
      assert.equal(JSON.parse(run(offlineEnv,'backup-status',backupRoot)).result,'fresh','Existing bundles remain readable');
      await writeFile(manifestPath,JSON.stringify({...previousManifest,completedAt:stale}));
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot),error=>/backup is overdue/.test(error.stderr));
      await writeFile(manifestPath,manifestBytes);
      await writeFile(capturePath,new Date(stale).toISOString()+'\n');
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot),error=>/backup is overdue/.test(error.stderr),
        'A recent completion cannot hide an old database capture');
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot),error=>{
        const report=JSON.parse(error.stdout);
        return error.status===2&&report.backups.result==='attention'&&/backup is overdue/.test(report.backups.reason);
      });
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&/backup is overdue/.test(error.stderr));
      assert.deepEqual(await readFile(manifestPath),manifestBytes,'a stale capture leaves the dated bundle intact');
      await writeFile(capturePath,captureBytes);
      await writeFile(manifestPath,JSON.stringify({...previousManifest,completedAt:Date.now()+60_000}));
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&/clock is invalid/.test(error.stderr));
      await writeFile(manifestPath,manifestBytes);
      await writeFile(capturePath,new Date(previousManifest.completedAt+1).toISOString()+'\n');
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot),error=>/backup capture time is invalid/.test(error.stderr));
    }finally{
      await writeFile(manifestPath,manifestBytes);
      await writeFile(capturePath,captureBytes);
    }
    assert.match(run(env,'backup',join(directory,'manual-backup')),new RegExp('Verified file versions: '+(files.length+otherVersions+1)+'\\.'));
    assert.equal((await sql`SELECT count(*)::int AS count FROM contact_file_versions WHERE file_id=${laterFile} AND revision IS NOT NULL`)[0].count,1);
    const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
    assert.equal(manifest.files.length,files.length+otherVersions);
    assert.equal(manifest.format,'harbor-portable-recovery-v2');
    assert.equal(manifest.sourceId,sourceId);
    assert.deepEqual(manifest.migrations,Array.from(await sql`SELECT hash AS sha256,created_at::float8 AS at
      FROM drizzle.__drizzle_migrations ORDER BY id`));
    const [originalMigration]=await sql`SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`;
    await sql`UPDATE drizzle.__drizzle_migrations SET hash='fixture-invalid-receipt' WHERE id=${originalMigration.id}`;
    const refusedBackup=join(directory,'refused-incompatible-source');
    try{
      assert.throws(()=>run(env,'backup',refusedBackup),error=>/source database migration history differs/.test(error.stderr));
      await assert.rejects(access(refusedBackup),error=>error.code==='ENOENT');
    }finally{
      await sql`UPDATE drizzle.__drizzle_migrations SET hash=${originalMigration.hash} WHERE id=${originalMigration.id}`;
    }
    const verify=()=>JSON.parse(run(offlineEnv,'backup-status',backupRoot,'--verify'));
    assert.deepEqual(verify(),{event:'harbor_portable_backup',result:'verified',day:completion.day,versions:files.length+otherVersions,
      captureStartedAt:Date.parse((await readFile(join(bundle,'capture-started-at'),'utf8')).trim())});

    await verifyRestoreReplyLoss(restoreEnv,bundle,restoreArgs,targetSql,objectCount);
    if(hostedStorage)await verifyRestoreCommitReplyLoss(targetEnv,bundle,targetSql,record.id,hostedStorage);
    const restoreDoctor=(settings=restoreEnv,expected=0,args=[])=>{
      const result=spawnSync(process.execPath,[command,'doctor','restore',...args],{
        env:{...settings,HARBOR_PORTABLE_RESTORE_ENABLED:'false'},cwd,encoding:'utf8',timeout:15_000,
      });
      assert.equal(result.status,expected,result.stderr||result.stdout);
      assert.equal(result.stderr,'');
      for(const value of [settings.DATABASE_URL,settings.HARBOR_S3_ENDPOINT,settings.HARBOR_S3_BUCKET,settings.HARBOR_S3_SECRET_ACCESS_KEY]){
        if(value)assert.ok(!result.stdout.includes(value));
      }
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(restoreDoctor(),{profile:'restore',result:'ready',checks:restoreTargetChecks});
    const restoreRole='restore_fixture_'+randomUUID().replaceAll('-','');
    const restorePassword=randomUUID();
    const limitedUrl=new URL(restoreEnv.DATABASE_URL);
    limitedUrl.username=restoreRole;
    limitedUrl.password=restorePassword;
    const limitedRestore={...restoreEnv,DATABASE_URL:limitedUrl.href};
    const targetName=decodeURIComponent(limitedUrl.pathname.slice(1));
    await targetSql.unsafe(`CREATE ROLE "${restoreRole}" LOGIN PASSWORD '${restorePassword}'`);
    try{
      await targetSql`GRANT CONNECT ON DATABASE ${targetSql(targetName)} TO ${targetSql(restoreRole)}`;
      const login=postgres(limitedUrl.href,{max:1,connect_timeout:3});
      try{
        const [transaction]=await login`SELECT current_setting('transaction_read_only') AS read_only,
          current_setting('transaction_isolation') AS isolation`;
        assert.deepEqual(transaction,{read_only:'off',isolation:'read committed'});
      }finally{await login.end();}
      assert.deepEqual(restoreDoctor(limitedRestore,1),{profile:'restore',result:'needs_setup',
        checks:{database:'missing_restore_permissions',storage:'ok',restoreTool:'ok',sqlTool:'ok'}});
      assertRefused(limitedRestore,bundle,
        /The restore login needs CREATE and TEMPORARY on the target database and USAGE and CREATE on its public schema\./,restoreArgs);
      assert.equal(await objectCount(),0,'missing target database privileges must prevent copying any saved attachment');
      const [targetObjects]=await targetSql`SELECT to_regclass('public.login_identities') AS identities,
        to_regnamespace('drizzle') AS ledger`;
      assert.deepEqual(targetObjects,{identities:null,ledger:null});

      await targetSql`GRANT CREATE,TEMPORARY ON DATABASE ${targetSql(targetName)} TO ${targetSql(restoreRole)}`;
      assert.equal(restoreDoctor(limitedRestore,1).checks.database,'missing_restore_permissions');
      await targetSql`GRANT USAGE,CREATE ON SCHEMA public TO ${targetSql(restoreRole)}`;
      assert.equal(restoreDoctor(limitedRestore).result,'ready');
      assert.equal(await objectCount(),0,'checking the corrected permissions must leave the bucket empty');
    }finally{
      await targetSql`DROP OWNED BY ${targetSql(restoreRole)}`;
      await targetSql`DROP ROLE ${targetSql(restoreRole)}`;
    }
    const incompatibleRestoreTools=join(directory,'incompatible-restore-tools');
    await mkdir(incompatibleRestoreTools,{mode:0o700});
    await writeFile(join(incompatibleRestoreTools,'pg_restore'),"#!/bin/sh\nprintf 'pg_restore (PostgreSQL) 17.9\\n'\n",{mode:0o700});
    assert.deepEqual(restoreDoctor({...restoreEnv,PATH:incompatibleRestoreTools},1).checks,
      {database:'ok',storage:'ok',restoreTool:'unsupported_version',sqlTool:'unavailable'});
    assert.deepEqual(restoreDoctor(restoreEnv,0,['--bundle',bundle,'--verify-timeout-seconds','10']),
      {profile:'restore',result:'ready',checks:{...restoreTargetChecks,archive:'ok'}});
    const unreadableBundle=join(directory,'unreadable-restore-archive');
    await mkdir(unreadableBundle,{mode:0o700});
    const invalidArchive='Fictional bytes with a valid checksum but no Postgres archive';
    await writeFile(join(unreadableBundle,'database.dump'),invalidArchive,{mode:0o600});
    await writeFile(join(unreadableBundle,'manifest.json'),JSON.stringify({...manifest,
      dumpSha256:createHash('sha256').update(invalidArchive).digest('hex')}),{mode:0o600});
    assert.equal(restoreDoctor(restoreEnv,1,['--bundle',unreadableBundle]).checks.archive,'archive_unreadable');
    await writeFile(join(unreadableBundle,'manifest.json'),'invalid manifest',{mode:0o600});
    assert.equal(restoreDoctor(restoreEnv,1,['--bundle',unreadableBundle]).checks.archive,'manifest_incompatible');
    assert.equal(await objectCount(),0);
    assert.equal((await targetSql`SELECT to_regclass('public.login_identities') AS identities`)[0].identities,null);
    assert.equal(restoreDoctor({...restoreEnv,HARBOR_S3_BUCKET:'absent-recovery-bucket'},1).checks.storage,'unavailable');
    await targetSql`CREATE TABLE public.restore_preflight_fixture (id int)`;
    try{
      assert.equal(restoreDoctor(restoreEnv,1).checks.database,'not_empty');
      assert.equal((await targetSql`SELECT count(*)::int AS count FROM public.restore_preflight_fixture`)[0].count,0);
    }finally{await targetSql`DROP TABLE public.restore_preflight_fixture`;}
    const probeKey='fictional-restore-preflight';
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:probeKey,Body:'fictional'}));
    try{
      assert.equal(restoreDoctor(restoreEnv,1).checks.storage,'not_empty');
      assert.equal(await objectCount(),1);
    }finally{await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:probeKey}));}
    assert.equal(await objectCount(),0);

    const blob=join(bundle,'objects',manifest.files[0].sha256);
    const original=await readFile(blob),corrupt=Buffer.from(original);
    const fastStatus=()=>JSON.parse(run(offlineEnv,'backup-status',backupRoot));
    await rename(blob,blob+'.removed');
    try{
      const missing=/A backup file is missing or unreadable/;
      const preflight=restoreDoctor(restoreEnv,1,['--bundle',bundle]);
      assert.equal(preflight.result,'needs_setup');
      assert.equal(preflight.checks.archive,'bundle_integrity_failed');
      assert.throws(()=>run({PATH:env.PATH},'doctor','bundle',bundle),error=>error.status===1&&error.stderr===''&&
        JSON.parse(error.stdout).checks.archive==='bundle_integrity_failed');
      assert.equal(await objectCount(),0);
      assert.equal((await targetSql`SELECT to_regclass('public.login_identities') AS identities`)[0].identities,null);
      assert.throws(verify,error=>missing.test(error.stderr));
      assert.throws(fastStatus,error=>missing.test(error.stderr));
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),
        error=>error.status===1&&missing.test(error.stderr),'a damaged current-day bundle cannot report already complete');
      assert.deepEqual(await readdir(backupRoot).then(names=>names.sort()),[servicePollMarker,sourceMarker,completion.day]);
      assert.deepEqual(await readFile(manifestPath),manifestBytes);
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot),error=>{
        const report=JSON.parse(error.stdout);
        return error.status===2&&report.worker.result!=='unavailable'&&report.backups.result==='attention'&&
          report.backups.issue==='integrity_failed'&&
          missing.test(report.backups.reason);
      });
    }finally{await rename(blob+'.removed',blob);}
    assert.equal(fastStatus().result,'fresh');
    let recoveredMonitor;
    try{recoveredMonitor=JSON.parse(run(backupEnv,'monitor-status',backupRoot,'--worker-off'));}
    catch(error){
      assert.equal(error.status,2,'an unrelated queue warning can keep the combined monitor in attention');
      recoveredMonitor=JSON.parse(error.stdout);
    }
    assert.deepEqual(recoveredMonitor.backups,{result:'fresh',day:completion.day,versions:manifest.files.length,
      captureStartedAt:verify().captureStartedAt});
    assert.equal(JSON.parse(run(backupEnv,'backup-tick',backupRoot)).result,'already_complete');
    await writeFile(blob,original.subarray(1));
    const wrongSize=/Backup file size does not match its manifest/;
    assert.throws(fastStatus,error=>wrongSize.test(error.stderr));
    assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&wrongSize.test(error.stderr));
    assert.equal((await stat(blob)).size,original.length-1,'the backup tick preserves the incomplete file');
    corrupt[0]^=255;
    await writeFile(blob,corrupt);
    const wrongContent=/Backup file does not match its manifest/;
    assert.throws(fastStatus,error=>error.status===1&&wrongContent.test(error.stderr));
    assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&wrongContent.test(error.stderr));
    assert.deepEqual(await readFile(blob),corrupt,'the repeat backup leaves damaged bytes intact for diagnosis');
    assert.throws(verify,error=>wrongContent.test(error.stderr));
    assert.throws(()=>run(backupEnv,'monitor-status',backupRoot),error=>{
      const report=JSON.parse(error.stdout);
      return error.status===2&&report.worker.result!=='unavailable'&&report.backups.result==='attention'&&
        report.backups.reason==='Backup file does not match its manifest.';
    });
    refuseRestore(bundle,/Backup file does not match its manifest/);
    await writeFile(blob,original);
    const dump=join(bundle,'database.dump');
    const dbBytes=await readFile(dump);
    const dumpSize=join(bundle,'database-dump-size');
    const sizeBytes=await readFile(dumpSize);
    assert.equal(sizeBytes.toString(),dbBytes.length+'\n');
    await rm(dumpSize);
    try{
      assert.equal(verify().result,'verified','Older bundles remain readable without a dump size marker');
    }finally{await writeFile(dumpSize,sizeBytes);}
    await writeFile(dump,'');
    try{
      const incomplete=/The completed backup directory is incomplete/;
      assert.throws(()=>run(offlineEnv,'backup-status',backupRoot),error=>error.status===1&&incomplete.test(error.stderr));
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&incomplete.test(error.stderr));
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot),error=>{
        const report=JSON.parse(error.stdout);
        return error.status===2&&report.worker.result!=='unavailable'&&report.backups.result==='attention'&&
          incomplete.test(report.backups.reason);
      });
      assert.equal((await stat(dump)).size,0,'The backup tick does not overwrite a damaged published bundle.');
    }finally{await writeFile(dump,dbBytes);}
    assert.equal(verify().result,'verified');
    await writeFile(dump,dbBytes.subarray(0,-1));
    try{
      const truncated=/Database dump size does not match the saved backup size/;
      assert.throws(fastStatus,error=>error.status===1&&truncated.test(error.stderr));
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&truncated.test(error.stderr));
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot),error=>{
        const report=JSON.parse(error.stdout);
        return error.status===2&&report.backups.result==='attention'&&truncated.test(report.backups.reason);
      });
      assert.equal((await stat(dump)).size,dbBytes.length-1,'A repeat tick leaves the truncated bundle for inspection.');
    }finally{await writeFile(dump,dbBytes);}
    const changedDump=Buffer.from(dbBytes);
    changedDump[changedDump.length-1]^=255;
    await writeFile(dump,changedDump);
    const wrongDump=/Database dump does not match its manifest/;
    assert.throws(fastStatus,error=>error.status===1&&wrongDump.test(error.stderr));
    assert.throws(verify,error=>wrongDump.test(error.stderr));
    refuseRestore(bundle,wrongDump);
    const largeSize=8*1024*1024+1;
    await truncate(dump,largeSize);
    await writeFile(dumpSize,largeSize+'\n');
    try{
      assert.equal(fastStatus().result,'fresh','The frequent check does not hash a dump over its byte budget');
      assert.throws(verify,error=>wrongDump.test(error.stderr));
    }finally{
      await writeFile(dump,dbBytes);
      await writeFile(dumpSize,sizeBytes);
    }
    assert.equal(fastStatus().result,'fresh');
    assert.equal(verify().result,'verified');
    assert.equal(await objectCount(),0);
    assert.equal((await targetSql`SELECT to_regclass('public.login_identities') AS table`)[0].table,null);

    const mismatch={...manifest,migrations:manifest.migrations.map((receipt,index)=>
      index===0?{...receipt,sha256:'0'.repeat(64)}:receipt)};
    await writeFile(manifestPath,JSON.stringify(mismatch));
    try{
      const incompatible=error=>error.status===1&&JSON.parse(error.stderr).issue==='incompatible_migrations';
      assert.throws(fastStatus,incompatible);
      assert.throws(verify,incompatible);
      assert.throws(()=>run(backupEnv,'backup-tick',backupRoot),error=>error.status===1&&/Backup migration history differs/.test(error.stderr));
      assert.throws(()=>run(backupEnv,'monitor-status',backupRoot,'--prometheus'),error=>error.status===2&&
        /^harbor_monitor_backup_issue\{issue="incompatible_migrations"\} 1$/m.test(error.stdout));
      const dated=JSON.parse(run(offlineEnv,'backup-status',backupRoot,'--verify','--day',completion.day));
      assert.equal(dated.result,'verified');
      assert.equal(dated.migrationHistory,'migration_history_mismatch');
      refuseRestore(bundle,/Backup migration history differs/);
      assert.equal(await objectCount(),0);
      assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
    }finally{await writeFile(manifestPath,manifestBytes);}

    await writeFile(manifestPath,JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,-1)}));
    try{
      refuseRestore(bundle,/Restored migration receipts do not match/);
      assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
      assert.equal(await objectCount(),manifest.files.length);
    }finally{
      await writeFile(manifestPath,manifestBytes);
      for(const version of manifest.files)await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:version.key}));
    }

    const tamper=join(directory,'tampered-migration-restore'),receiptSQL=join(tamper,'receipt.sql');
    await mkdir(tamper,{mode:0o700});
    await writeFile(receiptSQL,"UPDATE drizzle.__drizzle_migrations SET hash='fixture-invalid-receipt' WHERE id=(SELECT min(id) FROM drizzle.__drizzle_migrations);");
    await writeFile(join(tamper,'psql'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
args.splice(-2,0,'--file',${JSON.stringify(receiptSQL)});
const result=spawnSync('psql',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(env.PATH)}}});
process.exit(result.status??1);
`,{mode:0o700});
    assertRefused({...restoreEnv,PATH:tamper+':'+env.PATH},bundle,/Restored migration receipts do not match/,restoreArgs);
    assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
    assert.equal(await objectCount(),manifest.files.length);
    for(const version of manifest.files)await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:version.key}));

    const marker='local-empty-target-guard';
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:marker,Body:'keep'}));
    refuseRestore(bundle,/Restore requires an empty S3 bucket/);
    assert.equal(await objectCount(),1);
    await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:marker}));

    // Every remaining blob matches its digest, but the archive has one additional committed file receipt.
    const incomplete={...manifest,format:'harbor-portable-recovery-v1',migrations:undefined,sourceId:undefined,files:manifest.files.slice(1)};
    await writeFile(manifestPath,JSON.stringify(incomplete));
    try{
      refuseRestore(bundle,/Restored file receipts do not match the backup manifest/);
      assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
      assert.equal(await objectCount(),incomplete.files.length);
    }finally{
      await writeFile(manifestPath,manifestBytes);
      for(const version of incomplete.files)await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:version.key}));
    }

    const expectedDatabase=target.pathname.slice(1);
    const hostedWithoutActivation={...targetEnv,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_RESTORE_ENABLED:'false'};
    assertRefused(hostedWithoutActivation,bundle,/Hosted restore requires HARBOR_PORTABLE_RESTORE_ENABLED/,
      ['--target',expectedDatabase,bucket]);
    const explicitHosted={...restoreEnv,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_RESTORE_ENABLED:'true'};
    assertRefused(explicitHosted,bundle,/Restore target names do not match/,
      ['--target','wrong-database',bucket]);
    assertRefused(explicitHosted,bundle,/Restore target names do not match/,
      ['--target',expectedDatabase,'wrong-bucket']);
    assertRefused({...explicitHosted,HARBOR_S3_ENDPOINT:s3Endpoint},bundle,/Set a valid S3 endpoint/,
      ['--target',expectedDatabase,bucket]);
    assert.equal(await objectCount(),0);

    const split=join(directory,'wrong-postgres-client');
    await mkdir(split,{mode:0o700});
    const source=new URL(env.DATABASE_URL);
    const wrongClientEnv={PGHOST:source.hostname,PGPORT:source.port,PGUSER:decodeURIComponent(source.username),
      PGPASSWORD:decodeURIComponent(source.password),PGSSLMODE:'disable'};
    await writeFile(join(split,'psql'),`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
args[args.indexOf('--dbname')+1]=${JSON.stringify(source.pathname.slice(1))};
const result=spawnSync('psql',args,{stdio:'inherit',env:{...process.env,...${JSON.stringify(wrongClientEnv)},PATH:${JSON.stringify(env.PATH)}}});
process.exit(result.status??1);
`,{mode:0o700});
    assertRefused({...restoreEnv,PATH:split+':'+env.PATH},bundle,/Could not verify that both Postgres clients reached the same restore target/,restoreArgs);
    assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
    assert.deepEqual(await sql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`,beforeJobs);
    assert.equal(await objectCount(),manifest.files.length);
    for(const version of manifest.files)await storage.send(new DeleteObjectCommand({Bucket:bucket,Key:version.key}));

    const recovered=await restoreWithFileFaults({
      env:restoreEnv,directory,bundle,args:restoreArgs,db:targetSql,fixture,s3Endpoint,files:manifest.files,
    },async()=>{
      assert.equal((await targetSql`SELECT to_regclass('public.portable_jobs') AS jobs`)[0].jobs,null);
      assert.throws(()=>run(targetEnv,'worker','--once'),error=>/could not start \(maintenance_in_progress\)/.test(error.stderr));
      refuseRestore(bundle,/Harbor worker, migration or restore is using this database/);
    });
    assert.match(recovered,new RegExp('Verified file versions: '+(files.length+otherVersions)+'\\.'));
    assert.ok(recovered.includes('External jobs held for review: '+held.size+'.'));
    assert.equal(await objectCount(),files.length+otherVersions);
    const [{source_id:restoredSourceId}]=await targetSql`SELECT source_id FROM public.portable_backup_source`;
    assert.ok(restoredSourceId);
    assert.notEqual(restoredSourceId,sourceId);
    const targetBackupEnv={...targetEnv,HARBOR_PORTABLE_BACKUP_ENABLED:'true'};
    for(const wrongRoot of [backupRoot,failureRoot]){
      assert.throws(()=>run(targetBackupEnv,'backup-tick',wrongRoot),error=>{
        assert.doesNotMatch(error.stderr,new RegExp([sourceId,restoredSourceId].join('|')));
        assert.ok(!error.stderr.includes(target.href));
        assert.ok(!error.stderr.includes(wrongRoot));
        return /belongs to a different Harbor database/.test(error.stderr);
      });
    }
    assert.deepEqual((await readdir(failureRoot)).sort(),failedRootContents);
    assert.deepEqual(await readFile(manifestPath),manifestBytes);
    assert.throws(()=>run(targetBackupEnv,'monitor-status',backupRoot,'--verify'),error=>{
      const report=JSON.parse(error.stdout);
      assert.equal(error.status,2);
      assert.notEqual(report.worker.result,'unavailable');
      assert.ok(!error.stdout.includes(target.href)&&!error.stdout.includes(backupRoot));
      return report.backups.result==='attention'&&report.backups.reason==='The private backup root belongs to a different Harbor database.';
    });
    refuseRestore(bundle,/Restore requires an empty Postgres database/);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM login_sessions`)[0].count,0);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_api_tokens`)[0].count,0);
    assert.equal((await targetSql`SELECT status FROM portable_calendar_meetings WHERE id=${sharing.calendarInvites.pendingId}`)[0].status,'attention');
    assert.equal((await targetSql`SELECT status FROM portable_calendar_meetings WHERE id=${sharing.calendarInvites.rejectedId}`)[0].status,'rejected');
    assert.equal((await targetSql`SELECT status FROM portable_calendar_meetings WHERE id=${sharing.calendarInvites.lossId}`)[0].status,'cancel_attention');
    assert.equal((await targetSql`SELECT status FROM portable_calendar_reschedules WHERE id=${sharing.calendarReschedules.appliedId}`)[0].status,'applied');
    const [pendingReschedule]=await targetSql`SELECT status,original_etag FROM portable_calendar_reschedules
      WHERE id=${sharing.calendarReschedules.pendingId}`;
    assert.equal(pendingReschedule.status,'attention');
    assert.equal(pendingReschedule.original_etag,sharing.calendarReschedules.pendingEtag);
    const [fencedReschedule]=await targetSql`SELECT status,original_etag FROM portable_calendar_reschedules
      WHERE id=${sharing.calendarReschedules.fencedId}`;
    assert.equal(fencedReschedule.status,'rejected');
    assert.equal(fencedReschedule.original_etag,sharing.calendarReschedules.fencedEtag);
    const [rescheduledMeeting]=await targetSql`SELECT start_at,reschedule_revision FROM portable_calendar_meetings
      WHERE id=${sharing.calendarReschedules.meetingId}`;
    assert.equal(Number(rescheduledMeeting.start_at),sharing.calendarReschedules.start);
    assert.equal(rescheduledMeeting.reschedule_revision,2);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_request_budgets`)[0].count,0);
    const usedLogins=db=>db`SELECT state_hash,expires_minute FROM portable_login_attempt_uses ORDER BY state_hash`;
    assert.deepEqual(await usedLogins(targetSql),await usedLogins(sql));
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_worker_heartbeat`)[0].count,1);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_worker_heartbeat`)[0].count,0);
    assert.deepEqual(Array.from(await targetSql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`),restoredJobs);
    assert.deepEqual(await targetSql`SELECT workspace_id,job_id,body FROM portable_notes ORDER BY job_id`,beforeNotes);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0].count,
      (await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0].count);

    const restoredWebEnv={...targetEnv,...sharing.neverLog.inbox.env,HARBOR_PORTABLE_MODE:'local'};
    server=spawn(process.execPath,['--import',mock,command,'start'],{env:restoredWebEnv,cwd,stdio:['ignore','ignore','inherit']});
    exit=once(server,'exit');
    const restored=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(3000),...options});
    let ready=false;
    const readinessDeadline=performance.now()+10_000;
    while(!ready&&performance.now()<readinessDeadline){
      assert.equal(server.exitCode,null);
      const response=await restored('/healthz').catch(()=>null);
      const body=await response?.text();
      ready=response?.status===200&&body==='ready';
      if(!ready)await delay(50);
    }
    assert.ok(ready,'Restored web must become ready with its database and private files');
    assert.equal((await restored('/auth/sign-in')).status,200);
    assert.equal((await restored('/api/crm',{headers})).status,401);
    const owner=await signIn('owner@example.test',restored,origin);
    const other=await signIn('other@example.test',restored,origin);
    await sharing.verifyExternalApiRestore({restored,origin,owner,targetSql});
    assert.deepEqual(await (await restored(sharing.associations.path,{headers:owner})).json(),sharing.associations.page);
    assert.equal((await restored(sharing.associations.path,{headers:other})).status,404);
    await verifyRestoredSharedAssociations({request:restored,origin,owner,other,workspaceId:sharing.workspaceId,associations:sharing.associations});
    const outreach='/api/logged-activities?contactId='+record.id;
    assert.deepEqual(await (await restored(outreach,{headers:owner})).json(),sharing.outreach);
    await verifyRestoredRecordActivities({request:restored,origin,owner,other,activities:sharing.recordActivities});
    await verifyRestoredActivityMutations({request:restored,origin,owner,other,cases:sharing.activityMutations});
    await verifyRestoredRecordOwners({request:restored,owner,other,cases:sharing.recordOwners,workspaceId:sharing.workspaceId});
    assert.equal((await restored(outreach+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);
    assert.equal((await targetSql`SELECT actor_id FROM portable_contact_activities
      WHERE id=${sharing.sharedOutreachAuthor.activityId}`)[0].actor_id,sharing.sharedOutreachAuthor.actorId);
    const intakePath='/forms/'+sharing.intakeForm;
    assert.equal((await request(intakePath)).status,200);
    assert.equal((await restored(intakePath)).status,404);
    const forms=await (await restored('/api/lead-forms',{headers:owner})).json();
    const recoveredForm=forms.forms.find(form=>form.id===sharing.intakeForm);
    assert.equal(recoveredForm.enabled,false);
    assert.equal(recoveredForm.definition.embedOrigin,'https://website.example.test');
    const receipts=db=>db`SELECT * FROM portable_lead_inquiries WHERE form_id=${sharing.intakeForm} ORDER BY id`;
    assert.equal((await receipts(sql)).length,30);
    assert.deepEqual(await receipts(targetSql),await receipts(sql));
    const recoveredHandled=await (await restored('/api/lead-forms?formId='+sharing.intakeForm+'&filter=handled',{headers:owner})).json();
    assert.deepEqual(recoveredHandled.results.map(row=>[row.id,row.handled,row.triageRevision]),[[sharing.handledInquiryId,true,1]]);
    assert.equal(recoveredForm.definition.captureContacts,true);
    assert.equal(recoveredForm.definition.showMessageOnContact,true);
    const restoredTimeline=await (await restored(sharing.inquiryTimeline.path,{headers:owner})).json();
    assert.deepEqual(restoredTimeline.items.find(item=>item.id===sharing.inquiryTimeline.preserved.id),sharing.inquiryTimeline.preserved);
    assert.ok(!restoredTimeline.items.some(item=>item.id===sharing.inquiryTimeline.removedId));
    const recoveredInboxForm=forms.forms.find(form=>form.id===sharing.inboxOnlyForm);
    assert.equal(recoveredInboxForm.definition.captureContacts,false);
    const recoveredInbox=await (await restored('/api/lead-forms?formId='+sharing.inboxOnlyForm,{headers:owner})).json();
    assert.deepEqual(recoveredInbox.results.map(row=>row.status).sort(),['created','inbox_only','inbox_only','inbox_only','inbox_only']);
    for(const {id,email} of sharing.intakeCommitReceipts){
      const receipt=recoveredInbox.results.find(row=>row.id===id);
      assert.equal(receipt.status,'inbox_only');
      assert.equal(receipt.payload.email,email);
      assert.equal(receipt.contactId,null);
    }
    const workflowHistory=async(fetch,auth)=>{
      const endpoint='/api/workflows';
      const read=async(path)=>{
        const response=await fetch(path,{headers:auth});
        assert.equal(response.status,200,await response.clone().text());
        return response.json();
      };
      const first=await read(endpoint);
      const runs=[...first.runs];
      let next=first.next;
      for(let page=0;next&&page<10;page++){
        const more=await read(endpoint+'?'+new URLSearchParams(next));
        runs.push(...more.runs);
        next=more.next;
      }
      assert.equal(next,null,'Workflow history fixture exceeded its pagination bound.');
      return {workflows:first.workflows,runs};
    };
    const originalWorkflow=await workflowHistory(request,headers);
    const recoveredWorkflow=await workflowHistory(restored,owner);
    assert.equal(originalWorkflow.workflows.find(item=>item.id===sharing.workflowId).enabled,true);
    assert.equal(recoveredWorkflow.workflows.find(item=>item.id===sharing.workflowId).enabled,false);
    assert.equal(recoveredWorkflow.runs.find(item=>item.jobId===sharing.workflowJobId).jobStatus,'succeeded');
    const dealTask=sharing.dealStageTask;
    const restoredDealTask=recoveredWorkflow.runs.find(item=>item.jobId===dealTask.jobId);
    assert.deepEqual([restoredDealTask.dealId,restoredDealTask.jobKind,restoredDealTask.jobStatus,restoredDealTask.attempts],
      [dealTask.dealId,'task','succeeded',1]);
    const savedDealTask=await restored('/api/crm?kind=tasks&id='+dealTask.jobId,{headers:owner});
    assert.equal(savedDealTask.status,200);
    const savedDealTaskData=await savedDealTask.json();
    assert.equal(savedDealTaskData.contactId,dealTask.contactId);
    assert.deepEqual(savedDealTaskData.data,dealTask.data);
    for(const job of sharing.dealStageBranchJobs){
      const run=recoveredWorkflow.runs.find(item=>item.jobId===job.id);
      assert.deepEqual([run.dealId,run.jobStatus,run.attempts],[job.dealId,'succeeded',1]);
      const notes=await targetSql`SELECT j.contact_id AS "contactId",n.body FROM portable_notes n JOIN portable_jobs j
        ON j.workspace_id=n.workspace_id AND j.id=n.job_id WHERE n.job_id=${job.id}`;
      assert.deepEqual(Array.from(notes),[{contactId:job.contactId,body:job.body}]);
    }
    assert.equal(recoveredWorkflow.workflows.find(item=>item.id===sharing.lifecycleWorkflowId).enabled,false);
    assert.equal(recoveredWorkflow.runs.find(item=>item.jobId===sharing.lifecycleSkippedJobId).jobStatus,'skipped');
    const {id:createdRule,jobIds:createdJobs,branchJobs}=sharing.contactCreatedWorkflow;
    assert.equal(recoveredWorkflow.workflows.find(item=>item.id===createdRule).enabled,false);
    for(const id of createdJobs){
      assert.equal(recoveredWorkflow.runs.find(item=>item.jobId===id).jobStatus,'succeeded');
      assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${id}`)[0].count,1);
    }
    for(const job of branchJobs){
      assert.equal((await targetSql`SELECT body FROM portable_notes WHERE job_id=${job.id}`)[0].body,job.body);
      assert.equal(recoveredWorkflow.runs.find(item=>item.jobId===job.id).attempts,1);
    }
    const ownerBranch=sharing.contactOwnerBranch;
    const restoredOwnerBranch=recoveredWorkflow.workflows.find(item=>item.id===ownerBranch.id);
    assert.equal(restoredOwnerBranch.enabled,false);
    assert.deepEqual(restoredOwnerBranch.definition,ownerBranch.definition);
    for(const job of ownerBranch.branchJobs){
      const notes=await targetSql`SELECT body FROM portable_notes WHERE job_id=${job.id}`;
      assert.deepEqual(Array.from(notes),[{body:job.body}]);
      const run=recoveredWorkflow.runs.find(item=>item.jobId===job.id);
      assert.equal(run.jobStatus,'succeeded');
      assert.equal(run.attempts,1);
    }
    assert.equal(recoveredWorkflow.workflows.find(item=>item.id===sharing.workflowGmail.ruleId).enabled,false);
    assert.equal(recoveredWorkflow.runs.find(item=>item.jobId===sharing.workflowGmail.jobId).jobStatus,'attention');
    assert.deepEqual(recoveredWorkflow.runs,originalWorkflow.runs.map(run=>run.jobId===sharing.workflowGmail.jobId?
      {...run,jobStatus:'attention',jobIssue:'restore_requires_reconciliation'}:run));
    const optOutPath='/api/email/suppressions?query=optout%40example.test';
    const recoveredOptOut=await (await restored(optOutPath,{headers:owner})).json();
    assert.deepEqual(recoveredOptOut.results.find(row=>row.email===sharing.emailOptOut.record.email),sharing.emailOptOut.record);
    const replayOptOut=await restored('/api/email/unsubscribe',{method:'POST',headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({token:sharing.emailOptOut.token})});
    assert.deepEqual(await replayOptOut.json(),{unsubscribed:true});
    assert.deepEqual(await (await restored(optOutPath,{headers:owner})).json(),recoveredOptOut);
    // Shared records and actor receipts survive, but memberships are re-established explicitly.
    const memberTicket=sharing.sharedTicket,memberLead=sharing.sharedLead;
    const ticketQuery='/api/tickets?id='+memberTicket.id;
    const leadQuery='/api/leads?id='+memberLead.id;
    const leadHistoryQuery=leadQuery+'&view=history';
    const dealQuery='/api/crm?kind=deals&id='+memberLead.dealId;
    for(const path of [ticketQuery,leadQuery,leadHistoryQuery,dealQuery]){
      assert.equal((await restored(path,{headers:other})).status,404);
      assert.equal((await restored(path+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);
    }
    const memberTicketResponse=await restored(ticketQuery,{headers:owner});
    assert.equal(memberTicketResponse.status,200);
    const savedTicket=await memberTicketResponse.json();
    assert.deepEqual([savedTicket.revision,savedTicket.data.ticketStatus,savedTicket.closedAt,savedTicket.contactId,savedTicket.companyId],
      [3,'Closed',memberTicket.closedAt,memberTicket.contactId,memberTicket.companyId]);
    const ticketEditors=await targetSql`SELECT actor_id,revision FROM portable_ticket_events
      WHERE workspace_id=${sharing.workspaceId} AND ticket_id=${memberTicket.id} ORDER BY revision`;
    assert.deepEqual(ticketEditors.map(row=>[row.actor_id,row.revision]),[1,2,3].map(revision=>[memberTicket.actorId,revision]));
    assert.equal((await (await restored(leadQuery,{headers:owner})).json()).dealId,memberLead.dealId);
    const replayMemberLead=await restored('/api/leads',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
      body:JSON.stringify(memberLead.conversion)});
    assert.equal(replayMemberLead.status,200);
    assert.deepEqual(await replayMemberLead.json(),{id:memberLead.id,dealId:memberLead.dealId,created:false});
    assert.deepEqual(await (await restored(leadHistoryQuery,{headers:owner})).json(),memberLead.savedHistory);
    const dealEditors=await targetSql`SELECT actor_id FROM deal_events
      WHERE workspace_id=${sharing.workspaceId} AND deal_id=${memberLead.dealId} AND revision=1`;
    assert.deepEqual(dealEditors.map(row=>row.actor_id),[memberLead.actorId]);

    const restoredSharing=await restored('/api/workspaces',{headers:other});
    assert.equal(restoredSharing.status,200);
    assert.deepEqual((await restoredSharing.json()).shared,[]);
    assert.equal((await restored('/api/crm?workspaceId='+sharing.workspaceId,{headers:other})).status,404);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_workspace_viewers`)[0].count,0);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_lead_routing_members`)[0].count,0);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_team_availability`)[0].count,0);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_team_calendars`)[0].count,0);
    const [restoredBooking]=await targetSql`SELECT b.title,h.user_id FROM portable_team_bookings b
      JOIN portable_team_booking_hosts h ON h.workspace_id=b.workspace_id AND h.booking_id=b.id
      WHERE b.workspace_id=${sharing.workspaceId} AND b.id=${teamBooking}`;
    assert.deepEqual({...restoredBooking},{title:'Fictional demo',user_id:microsoftId});
    const [restoredEmployee]=await targetSql`SELECT user_id FROM portable_directory_users WHERE id=${directoryId} AND workspace_id=${sharing.workspaceId}`;
    assert.equal(restoredEmployee.user_id,microsoftId);
    const [restoredTeam]=await targetSql`SELECT name FROM portable_workspace_teams WHERE workspace_id=${sharing.workspaceId} AND id=${mappedTeam}`;
    assert.equal(restoredTeam?.name,'Fictional recovery team');
    const [fieldRule]=await targetSql`SELECT restricted,visible_team_id,revision FROM portable_standard_property_access
      WHERE workspace_id=${sharing.workspaceId} AND kind='companies' AND id='annualRevenue'`;
    assert.deepEqual({...fieldRule},{restricted:true,visible_team_id:mappedTeam,revision:1});
    assert.equal((await targetSql`SELECT count(*)::int AS n FROM portable_directory_groups`)[0].n,0);
    assert.equal((await targetSql`SELECT count(*)::int AS n FROM portable_directory_group_members`)[0].n,0);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_workspace_invites`)[0].count,0);
    const invitee=await signIn('invitee@example.test',restored,origin);
    assert.deepEqual((await (await restored('/api/workspaces',{headers:invitee})).json()).incoming,[]);
    for(const edit of sharing.edits){
      const path='/api/crm?kind='+edit.kind+'&id='+edit.id;
      assert.equal((await (await restored(path,{headers:owner})).json()).data.name,edit.name);
      assert.equal((await restored(path,{headers:other})).status,404);
    }
    await sharing.verifyKnowledge(restored,owner,other);
    await sharing.verifyProducts(restored,owner,other);
    await sharing.verifyLineItems(restored,owner,other);
    await sharing.verifyQuotes(restored,owner,other);
    await sharing.verifyInvoices(restored,owner,other,origin);
    await sharing.verifyTaskQueues(restored,owner,other,sharing.taskRepeats.queue);
    const taskPath='/api/crm?kind=tasks&id='+sharing.task.id;
    assert.deepEqual(await (await restored(taskPath,{headers:owner})).json(),sharing.task);
    assert.equal((await restored(taskPath,{headers:other})).status,404);
    for(const [field,linkedTask] of [['companyId',sharing.companyTask],['dealId',sharing.task]]){
      const query='/api/crm?kind=tasks&'+field+'='+linkedTask[field];
      const expected=field==='companyId'?[sharing.queueExportTask,linkedTask]:[linkedTask];
      expected.sort((a,b)=>a.id.localeCompare(b.id,'en'));
      assert.deepEqual((await (await restored(query,{headers:owner})).json()).records,expected);
      assert.deepEqual((await (await restored(query,{headers:other})).json()).records,[]);
    }
    const taskHistoryPath='/api/crm?kind=tasks&completionHistoryFor='+record.id;
    assert.deepEqual(await (await restored(taskHistoryPath,{headers:owner})).json(),
      {...sharing.taskHistory,items:sharing.taskHistory.items.map(item=>({...item,actorName:null}))});
    assert.equal((await restored(taskHistoryPath,{headers:other})).status,404);

    const taskReceipts=db=>db`SELECT revision,actor_id,previous,data,occurred_at FROM portable_task_events
      WHERE task_id IN (${sharing.task.id},${sharing.companyTask.id}) ORDER BY task_id,revision`;
    assert.deepEqual(await taskReceipts(targetSql),await taskReceipts(sql));
    const contact=(auth,id)=>restored('/api/crm?id='+id,{headers:auth});
    const restoredContact=await (await contact(owner,record.id)).json();
    assert.equal(restoredContact.revision,2);
    assert.equal(restoredContact.data.postalCode,'00501');
    assert.equal(restoredContact.data.leadStatus,'Connected');
    assert.equal(restoredContact.primaryCompanyId,company.id);
    assert.equal(restoredContact.primaryCompanyName,company.data.name);
    assert.equal((await contact(other,record.id)).status,404);
    assert.equal((await contact(owner,otherRecord.id)).status,404);
    const companyPath='/api/crm?kind=companies&id='+company.id;
    assert.deepEqual(await (await restored(companyPath,{headers:owner})).json(),company);
    assert.equal((await restored(companyPath,{headers:other})).status,404);
    assert.deepEqual(await (await restored('/api/crm?kind=companies&id='+otherCompany.id,{headers:other})).json(),otherCompany);
    const companyReceipts=db=>db`SELECT workspace_id,company_id,revision,actor_id,previous,data FROM company_events ORDER BY workspace_id,company_id,revision`;
    assert.deepEqual(await companyReceipts(targetSql),await companyReceipts(sql));
    const propertyPath='/api/crm?'+new URLSearchParams({kind:'companies',history:company.id,field:'city'});
    const sourcePropertyHistory=await (await request(propertyPath,{headers})).json();
    assert.ok(sourcePropertyHistory.items.length>0);
    assert.deepEqual(await (await restored(propertyPath,{headers:owner})).json(),sourcePropertyHistory);
    assert.equal((await restored(propertyPath,{headers:other})).status,404);
    await verifyRestoredSavedViews({request:restored,origin,owner,other,workspaceId:sharing.workspaceId,savedViews:sharing.savedViews,memberView:sharing.memberView});
    await verifyRestoredPortableSegment({request:restored,owner,other,segment:sharing.segment});
    const restoredTicket=await restored(ticketPath,{headers:owner});
    assert.equal(restoredTicket.status,200);
    assert.deepEqual(await restoredTicket.json(),expectedTicket);
    const restoredCase=await restored(ownerCase+'?ticketId='+ticketId,{headers:owner});
    assert.equal(restoredCase.status,200);
    const {center:copiedCenter,publication:copiedPublication,access:copiedAccess}=await restoredCase.json();
    assert.deepEqual([copiedCenter,copiedPublication,copiedAccess],[null,null,null]);
    assert.equal((await targetSql`SELECT 1 FROM portable_case_access LIMIT 1`).length,0);
    assert.equal((await targetSql`SELECT 1 FROM portable_case_publications LIMIT 1`).length,0);
    const copiedLink=await restored(casesPath+'?case='+ticketId,{headers:{cookie:customerCookie}});
    assert.equal(copiedLink.status,404);
    assert.ok(!(await copiedLink.text()).includes(subject));
    assert.deepEqual(Array.from(await ticketHistory(targetSql)),originalTicketHistory);
    assert.equal((await restored(ticketPath,{headers:other})).status,404);
    const foreignTicketList=await restored('/api/tickets?search='+encodeURIComponent(ticketName),{headers:other});
    assert.equal(foreignTicketList.status,200);
    assert.deepEqual(await foreignTicketList.json(),{records:[],next:null});
    await verifyRestoredPortableTicketSla({request:restored,owner,other,fixture:sharing.ticketSla});
    await verifyRestoredPortableReport({request:restored,origin,owner,other,reports:sharing.reports});
    await verifyRestoredPortableDashboard({request:restored,owner,other,dashboard:sharing.dashboard});
    // Give the separate deal and job scenarios their own read budget.
    await targetSql`DELETE FROM portable_request_budgets WHERE scope='api_read'
      AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
    const dealPath='/api/crm?kind=deals&id='+deal.id;
    assert.deepEqual(await (await restored(dealPath,{headers:owner})).json(),deal);
    assert.equal((await restored(dealPath,{headers:other})).status,404);
    assert.deepEqual(await (await restored('/api/crm?kind=deals&id='+otherDeal.id,{headers:other})).json(),otherDeal);
    const linkedDeals='/api/crm?kind=deals&primaryContactId='+record.id;
    assert.ok((await (await restored(linkedDeals,{headers:owner})).json()).records.some(item=>item.id===deal.id));
    assert.deepEqual((await (await restored(linkedDeals,{headers:other})).json()).records,[]);
    const dealReceipts=db=>db`SELECT workspace_id,deal_id,revision,actor_id,previous,data,previous_company_id,company_id,
      previous_primary_contact_id,primary_contact_id,previous_pipeline_id,pipeline_id,previous_stage_id,stage_id FROM deal_events ORDER BY workspace_id,deal_id,revision`;
    assert.deepEqual(await dealReceipts(targetSql),await dealReceipts(sql));
    const pipelines=await (await restored('/api/pipeline',{headers:owner})).json();
    assert.deepEqual(pipelines.pipelines.find(item=>item.id===sharing.pipeline.id),sharing.pipeline);
    await verifyRestoredContactArchiveReads({request:restored,owner,db:targetSql,fixture:sharing.contactArchive});
    await verifyRestoredPortableDealStageProperties({request:restored,origin,owner,other,fixture:sharing.dealStageProperties});
    const pipelineDeal='/api/crm?kind=deals&id='+sharing.pipelineDeal.id;
    assert.deepEqual(await (await restored(pipelineDeal,{headers:owner})).json(),sharing.pipelineDeal);
    await verifyRestoredLead({restored,origin,owner,other,leads:sharing.leads});
    await verifyRestoredCustomProperty({restored,owner,other,expected:expectedProperty,source:sql,target:targetSql,
      workspaceId:sharing.workspaceId});
    const groupsPath='/api/property-groups?kind=contacts';
    assert.deepEqual(await (await restored(groupsPath,{headers:owner})).json(),expectedGroups);
    assert.deepEqual(await (await restored(groupsPath,{headers:other})).json(),
      {kind:'contacts',revision:0,groups:[],assignments:{}});
    await verifyRestoredPortablePilot({restored,owner,other,pilot});
    await verifyRestoredAdditionalImports({restored,origin,owner,other,imports:sharing.additionalImports,source:sql,target:targetSql,workspaceId:sharing.workspaceId});
    assert.equal((await restored(pipelineDeal,{headers:other})).status,404);
    const summary=await restored('/?kind=deals&view=summary&pipelineId='+sharing.pipeline.id+'&closeMonth=2026-12',{headers:owner});
    assert.equal(summary.status,200);
    assert.match((await summary.text()).replaceAll('<!-- -->',''),/<tfoot><tr><th[^>]*>Total<\/th><td>9<\/td><td>91\.35<\/td><td>—<\/td><td>31\.97<\/td>/);
    const linkReceipts=db=>db`SELECT workspace_id,contact_id,revision,previous_primary_company_id,primary_company_id
      FROM contact_events ORDER BY workspace_id,contact_id,revision`;
    assert.deepEqual(await linkReceipts(targetSql),await linkReceipts(sql));
    const fileActors=db=>db`SELECT workspace_id,contact_id,file_id,version_id,actor_id FROM contact_file_versions
      WHERE revision IS NOT NULL AND actor_id IN (SELECT id FROM login_identities WHERE email='other@example.test')
      ORDER BY workspace_id,contact_id,file_id,version_id`;
    assert.equal((await fileActors(sql)).length,2);
    assert.deepEqual(await fileActors(targetSql),await fileActors(sql));
    assert.equal((await restored('/api/record-attachments?recordId='+record.id+'&workspaceId='+sharing.workspaceId,
      {headers:other})).status,404);
    assert.equal((await restored(jobsPath,{headers:other})).status,404);
    assert.equal((await restored(jobsPath+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);
    for(const [identity,rule] of [[owner,sharing.neverLog.owner],[other,sharing.neverLog.other]]){
      const savedRules=await restored('/api/email/never-log',{headers:identity});
      assert.equal(savedRules.status,200);
      assert.deepEqual(await savedRules.json(),{results:[rule],total:1,next:null});
    }
    const receivedLog=sharing.neverLog,receivedTimeline='/api/logged-activities?contactId='+receivedLog.contactId;
    const gmailReceipts=db=>db`SELECT * FROM portable_gmail_log_receipts ORDER BY workspace_id,mailbox,message_id`;
    assert.equal((await gmailReceipts(targetSql)).length,2);
    assert.deepEqual(await gmailReceipts(targetSql),await gmailReceipts(sql));
    assert.equal((await restored(receivedTimeline,{headers:other})).status,404);
    const restoredReceived=await (await restored(receivedTimeline,{headers:owner})).json();
    assert.deepEqual(restoredReceived.items.find(item=>item.id===receivedLog.active.id),receivedLog.active);
    const inboxRequest=(method,input)=>restored('/api/email/inbox',{method,headers:{...owner,origin,'content-type':'application/json'},
      body:JSON.stringify({recordId:receivedLog.contactId,...input})});
    const oldCalls=await readFile(receivedLog.inbox.log,'utf8');
    for(const selection of [receivedLog.selection,receivedLog.secondSelection]){
      assert.equal((await inboxRequest('PUT',{selection})).status,409);
    }
    assert.equal(await readFile(receivedLog.inbox.log,'utf8'),oldCalls);
    const first=await inboxRequest('POST',{subject:'Follow-up'});
    assert.equal(first.status,200,await first.clone().text());
    const firstPage=await first.json();
    const second=await inboxRequest('POST',{subject:'Follow-up',after:firstPage.next});
    assert.equal(second.status,200,await second.clone().text());
    const secondPage=await second.json();
    const priorProviderCalls=await readFile(receivedLog.inbox.log,'utf8');
    for(const [page,id,activityId] of [[firstPage,'valid',receivedLog.active.id],[secondPage,'second',null]]){
      const item=page.items.find(item=>item.id===id);
      assert.equal(item?.logged,true);
      const replay=await inboxRequest('PUT',{selection:item.selection});
      assert.equal(replay.status,200,await replay.clone().text());
      assert.deepEqual(await replay.json(),{logged:true,alreadyLogged:true,activityId});
    }
    assert.equal(await readFile(receivedLog.inbox.log,'utf8'),priorProviderCalls);
    assert.deepEqual(await (await restored(receivedTimeline,{headers:owner})).json(),restoredReceived);
    const templatePath='/api/email/templates?id='+sharing.emailTemplates.template.id;
    const restoredTemplate=await restored(templatePath,{headers:owner});
    assert.equal(restoredTemplate.status,200);
    assert.deepEqual(await restoredTemplate.json(),{template:sharing.emailTemplates.template});
    const restoredPreview=await restored(templatePath+'&contactId='+record.id,{headers:owner});
    assert.equal(restoredPreview.status,200);
    const {template:personalized,missing}=await restoredPreview.json();
    assert.match(personalized.subject,/^Hello /);
    assert.ok(!personalized.subject.includes('{{'));
    assert.deepEqual(missing,[]);
    assert.equal((await restored(templatePath,{headers:other})).status,404);
    assert.equal((await restored('/api/email/templates?id='+sharing.emailTemplates.removed,{headers:owner})).status,404);
    const recoveredMail=await (await restored('/api/background-jobs?recordId='+sharing.gmail.contactId,{headers:owner})).json();
    assert.equal(recoveredMail.items.find(item=>item.id===sharing.gmail.queuedId).issue,'restore_requires_reconciliation');
    assert.equal(recoveredMail.items.find(item=>item.id===sharing.gmail.queuedId).operatorReviewedAt,null);
    assert.equal(recoveredMail.items.find(item=>item.id===sharing.gmail.confirmedId).gmail.providerId,'fictional-reconciled');
    const reviewedMail=recoveredMail.items.find(item=>item.id===sharing.gmail.crashId);
    assert.equal(reviewedMail.status,'attention');
    assert.equal(reviewedMail.operatorReviewedAt,sharing.gmail.crashReviewedAt);
    const archivedSend=sharing.gmail.confirmedActivity;
    const sendTimeline='/api/logged-activities?contactId='+archivedSend.contactId+'&channel=Email';
    const timelineResponse=await restored(sendTimeline,{headers:owner});
    assert.equal(timelineResponse.status,200);
    const timeline=await timelineResponse.json();
    const confirmed=timeline.items.filter(item=>item.scheduledJobId===archivedSend.scheduledJobId);
    assert.deepEqual(confirmed.map(({id,occurredAt,fromScheduledGmail})=>({id,occurredAt,fromScheduledGmail})),[
      {id:archivedSend.id,occurredAt:archivedSend.occurredAt,fromScheduledGmail:true},
    ]);
    assert.ok(timeline.lastContacted>=archivedSend.occurredAt);
    assert.equal(timeline.items.some(item=>[sharing.gmail.queuedId,sharing.gmail.crashId].includes(item.scheduledJobId)),false);
    assert.equal((await restored(sendTimeline,{headers:other})).status,404);
    const restoredQueue=await (await restored('/?view=job-queue',{headers:owner})).text();
    assert.match(restoredQueue,/No worker heartbeat recorded/);
    assert.doesNotMatch(restoredQueue,/Last successful job poll/);
    assert.ok(restoredQueue.includes(sharing.gmail.queuedId));
    const heldSearch='in:sent rfc822msgid:harbor.'+sharing.gmail.queuedId+'@'+sharing.workspaceId+'.harbor.invalid';
    assert.ok(restoredQueue.includes(heldSearch));
    assert.ok(!restoredQueue.includes(sharing.gmail.crashId));
    assert.match(restoredQueue,/Restored external action/);
    assert.equal((await sql`SELECT id FROM portable_google_grants WHERE provider IN ('gmail','calendar')`).length,4);
    assert.equal((await sql`SELECT id FROM portable_google_grants WHERE provider='outlook-calendar' AND user_id=${microsoftId}`).length,1);
    const [restoredSamlRegistration]=await targetSql`SELECT saml_external_id,saml_issuer FROM portable_directory_users WHERE id=${samlDirectoryId} AND user_id=${samlId}`;
    assert.deepEqual({...restoredSamlRegistration},{saml_external_id:'employee-42',saml_issuer:'urn:fictional:directory'});
    assert.equal((await targetSql`SELECT 1 FROM portable_workspace_viewers WHERE viewer_id=${samlId}`).length,0);
    const [restoredSaml]=await targetSql`SELECT saml_subject,google_subject,microsoft_subject,email FROM login_identities WHERE id=${samlId}`;
    assert.deepEqual({...restoredSaml},{saml_subject:samlSubject,google_subject:null,microsoft_subject:null,email:samlEmail});
    const [restoredMicrosoft]=await targetSql`SELECT google_subject,microsoft_subject,email FROM login_identities WHERE id=${microsoftId}`;
    assert.deepEqual({...restoredMicrosoft},{google_subject:null,microsoft_subject:microsoftSubject,email:microsoftEmail});
    assert.equal((await targetSql`SELECT id FROM portable_google_grants`).length,0);
    assert.equal((await targetSql`SELECT state_hash FROM portable_google_attempts`).length,0);
    assert.equal((await targetSql`SELECT id FROM portable_published_availability`).length,0);
    assert.equal((await targetSql`SELECT id FROM portable_guest_booking_requests`).length,0);
    assert.equal((await restored('/availability/'+sharing.availabilityId)).status,404);
    assert.equal((await restored('/api/public/booking-status',{method:'POST',headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({receipt:sharing.guestStatusReceipt})})).status,404);
    const otherQueue=await (await restored('/?view=job-queue',{headers:other})).text();
    assert.ok(!otherQueue.includes(sharing.gmail.queuedId));
    assert.ok(!otherQueue.includes(heldSearch));
    const interrupted=recoveredMail.items.find(item=>item.id===dispatchingExternal);
    assert.equal(interrupted.status,'attention');
    assert.equal(interrupted.receipts[0].outcome,'restore_requires_reconciliation');
    assert.ok(interrupted.receipts[0].endedAt>0);
    const recoveredHistoryResponse=await restored(jobsPath,{headers:owner});
    assert.equal(recoveredHistoryResponse.status,200,await recoveredHistoryResponse.clone().text());
    const recoveredHistory=(await recoveredHistoryResponse.json()).items;
    assert.deepEqual(recoveredHistory.map(job=>[job.id,job.receipts]),originalHistory.map(job=>[job.id,job.receipts]));
    assert.equal(recoveredHistory.find(job=>job.id===queuedExternal).issue,'restore_requires_reconciliation');
    const heldQueue='/?view=job-queue&queue=recovery';
    const heldPage=await restored(heldQueue,{headers:owner});
    assert.equal(heldPage.status,200);
    const heldHtml=await heldPage.text();
    for(const id of [queuedExternal,dispatchingExternal,sharing.gmail.queuedId])assert.ok(heldHtml.includes('<code>'+id+'</code>'));
    for(const id of [sharing.gmail.crashId,sharing.gmail.confirmedId])assert.ok(!heldHtml.includes('<code>'+id+'</code>'));
    assert.ok(!(await (await restored(heldQueue,{headers:other})).text()).includes(queuedExternal));
    const acknowledge=auth=>restored(jobsPath,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'reviewExternal',id:queuedExternal})});
    assert.equal((await acknowledge(other)).status,404);
    assert.equal((await acknowledge(owner)).status,200);
    const reviewed=await (await restored(heldQueue,{headers:owner})).text();
    assert.match(reviewed,/Outcome unconfirmed · reviewed/);
    assert.ok(reviewed.includes('<code>'+queuedExternal+'</code>'));
    assert.ok(!(await (await restored('/?view=job-queue',{headers:owner})).text()).includes('<code>'+queuedExternal+'</code>'));
    // The restore fixture runs independent CRM and file scenarios in the same minute.
    await targetSql`DELETE FROM portable_request_budgets WHERE scope='api_read'
      AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
    assert.equal((await restored(base+'&fileId='+laterFile,{headers:owner})).status,404);
    const fileLibrary=await restored('/?view=files',{headers:owner});
    assert.equal(fileLibrary.status,200);
    const fileLibraryHtml=await fileLibrary.text();
    assert.match(fileLibraryHtml,/Current Café 100% proof\.txt/);
    assert.ok(!fileLibraryHtml.includes(laterFile));
    assert.doesNotMatch(await (await restored('/?view=files',{headers:other})).text(),/Current Café 100% proof\.txt/);
    const recoveredFolders=await restored('/api/file-folders',{headers:owner});
    assert.equal(recoveredFolders.status,200);
    const {folders}=await recoveredFolders.json();
    const restoredFolder=folders.find(folder=>folder.name==='Café proposals');
    assert.ok(restoredFolder);
    assert.equal(restoredFolder.revision,1);
    const nestedFolder=folders.find(folder=>folder.name==='Nested proposals');
    assert.ok(nestedFolder);
    assert.equal(nestedFolder.revision,2);
    const childResponse=await restored('/api/file-folders?parentId='+restoredFolder.id,{headers:owner});
    assert.equal(childResponse.status,200);
    assert.deepEqual(await childResponse.json(),{folders:[nestedFolder],next:null});
    assert.equal((await restored('/api/file-folders?parentId='+restoredFolder.id,{headers:other})).status,404);
    const folderPath='/?view=files&folder='+nestedFolder.id;
    const restoredFolderHtml=await (await restored(folderPath,{headers:owner})).text();
    assert.match(restoredFolderHtml,/Café proposals.*Nested proposals/);
    assert.match(restoredFolderHtml,/Current Café 100% proof\.txt/);
    assert.equal((await restored(folderPath,{headers:other})).status,404);
    assert.doesNotMatch(await (await restored('/?view=files&folder=root',{headers:owner})).text(),/Current Café 100% proof\.txt/);
    for(const file of files){
      const response=await restored(file.path,{headers:owner});
      assert.equal(response.status,200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.bytes);
      assert.equal((await restored(file.path,{headers:other})).status,404);
    }

    assert.deepEqual(Array.from(await targetSql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`),restoredJobs);
    assert.deepEqual(await targetSql`SELECT workspace_id,job_id,body FROM portable_notes ORDER BY job_id`,beforeNotes);
    const retried=db=>db`SELECT operator_retry_at,operator_retry_by FROM portable_jobs WHERE id=${sharing.operatorRetryId}`;
    assert.deepEqual(await retried(targetSql),await retried(sql));
    // The full emulated suite can outlast another fixture's scheduled delay.
    // Hold unrelated jobs during this replay check and put their times back afterwards.
    const replayIds=[sharing.queuedNoteId,sharing.operatorRetryId];
    const otherQueued=await targetSql`SELECT workspace_id,id,available_at FROM portable_jobs
      WHERE status='queued' AND id NOT IN ${targetSql(replayIds)}`;
    try{
      await targetSql`UPDATE portable_jobs SET available_at=8640000000000000
        WHERE status='queued' AND id NOT IN ${targetSql(replayIds)}`;
      await targetSql`UPDATE portable_jobs SET available_at=0 WHERE id IN ${targetSql(replayIds)}`;
      run(targetEnv,'worker','--once');
      run(targetEnv,'worker','--once');
      assert.deepEqual(await sql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`,beforeJobs);
      run(targetEnv,'worker','--once');
    }finally{
      for(const job of otherQueued)await targetSql`UPDATE portable_jobs SET available_at=${job.available_at}
        WHERE workspace_id=${job.workspace_id} AND id=${job.id}`;
    }
    const targetJobs=await targetSql`SELECT id,status,attempts,issue FROM portable_jobs ORDER BY id`;
    assert.deepEqual(Array.from(targetJobs),restoredJobs.map(job=>job.id===sharing.queuedNoteId?
      {...job,status:'succeeded',attempts:1}:job.id===sharing.operatorRetryId?
      {...job,status:'succeeded',attempts:6}:job));
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${sharing.queuedNoteId}`)[0].count,1);
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${sharing.operatorRetryId}`)[0].count,1);
    const [sourceReview]=await sql`SELECT operator_reviewed_at FROM portable_jobs WHERE id=${queuedExternal}`;
    const [targetReview]=await targetSql`SELECT operator_reviewed_at FROM portable_jobs WHERE id=${queuedExternal}`;
    assert.equal(sourceReview.operator_reviewed_at,null);
    assert.ok(targetReview.operator_reviewed_at);
    assert.equal(targetJobs.find(job=>job.id===sharing.cancelledNoteId).issue,'note_cancelled');
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${sharing.cancelledNoteId}`)[0].count,0);
    await verifyRestoredGmailReconciliation({sql:targetSql,env:targetEnv,workspaceId:sharing.workspaceId,id:sharing.gmail.queuedId});
    // Give these independent recovery scenarios a fresh API budget in the disposable database.
    await targetSql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
      AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
    await verifyRestoredManualWorkflow({request:restored,origin,owner,other,targetSql,targetEnv,sourceSql:sql,manual:sharing.manualWorkflow});
    await verifyRestoredManualNoteBatch({request:restored,origin,owner,other,targetSql,batch:sharing.manualNoteBatch});
    await verifyRestoredTaskWorkflow({request:restored,headers:owner,other,sql:targetSql,env:targetEnv,fixture:sharing.taskWorkflow});
    // Restore this Contact only after the point-in-time database comparisons.
    await verifyRestoredPortableContactArchive({restored,origin,owner,other,source:request,sourceOwner:headers,fixture:sharing.archiveOperation});
    await verifyRestoredPortableCompanyArchive({restored,origin,owner,other,source:request,sourceOwner:headers,fixture:sharing.companyArchive});
    await verifyRestoredPortableCompanyMerge({restored,origin,owner,fixture:sharing.companyMerge});
    await verifyRestoredPortableContactMerge({restored,origin,owner,fixture:sharing.contactMerge});
    await verifyRestoredPortableDealArchive({restored,origin,owner,other,source:request,sourceOwner:headers,fixture:sharing.dealArchive});
    await verifyRestoredPortableStaticSegments({request:restored,origin,owner,other,fixture:sharing.staticSegments});
    await verifyRestoredPortableTaskRepeats({request:restored,origin,owner,other,db:targetSql,fixture:sharing.taskRepeats,env:targetEnv});
    await verifyRestoredSegmentWorkflow({request:restored,origin,owner,sql:targetSql,env:targetEnv,fixture:sharing.segmentWorkflow});
    await verifyRestoredPortableFormNotes({request:restored,origin,owner,sql:targetSql,env:targetEnv,fixture:sharing.formNotes});
    await targetSql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
      AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
    await verifyRestoredPilotSharing({restored,origin,owner,other,pilot,workspaceId:sharing.workspaceId,
      previousGrantId:sharing.grantId,runScheduledNote:async(note,readJob)=>{
        const workerEnv={...targetEnv,HARBOR_PORTABLE_GMAIL_ENABLED:'false'};
        async function withNotesWorker(verify){
          const child=spawn(process.execPath,[command,'worker','--notes-only'],{
            env:workerEnv,cwd,stdio:['ignore','pipe','pipe'],
          });
          const closed=once(child,'close');
          let logs='',errors='';
          child.stdout.on('data',chunk=>{logs+=chunk;});
          child.stderr.on('data',chunk=>{errors+=chunk;});
          try{
            for(let poll=0;poll<100&&!logs.includes('\n')&&child.exitCode===null;poll++)await delay(100);
            assert.ok(logs.includes('\n'),errors||'Notes worker did not report readiness');
            assert.equal(JSON.parse(logs).mode,'notes-only');
            await verify();
          }finally{
            child.kill('SIGTERM');
            const result=await Promise.race([closed,delay(6000,undefined,{ref:false})]);
            if(!result){child.kill('SIGKILL');await closed;}
            assert.deepEqual(result,[0,null],errors);
          }
        }
        let completed;
        await withNotesWorker(async()=>{
          // Poll Postgres while waiting so fixture timing does not consume API read limits.
          for(let poll=0;poll<160;poll++){
            const [job]=await targetSql`SELECT status FROM portable_jobs WHERE id=${note.id}`;
            if(job.status==='succeeded')break;
            await delay(100);
          }
          completed=await readJob();
          assert.equal(completed.status,'succeeded');
          assert.equal(completed.attempts,1);
          assert.equal(completed.receipts.length,1);
          assert.equal(completed.receipts[0].outcome,'succeeded');
          assert.ok(completed.receipts[0].startedAt>=note.scheduledFor);
        });
        await withNotesWorker(async()=>assert.deepEqual(await readJob(),completed));
        const written=await targetSql`SELECT n.body,i.email FROM portable_notes n
          JOIN portable_jobs j ON j.workspace_id=n.workspace_id AND j.id=n.job_id
          JOIN login_identities i ON i.id=j.actor_id WHERE n.job_id=${note.id}`;
        assert.deepEqual(Array.from(written),[{body:note.body,email:'other@example.test'}]);
      }});
  }finally{
    if(server){server.kill();await exit;}
    fixture.storage.destroy();
    await targetSql.end();
  }
}
