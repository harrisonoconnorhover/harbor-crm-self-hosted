import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import postgres from 'postgres';
import {portableMaintenanceLock} from '../runtime/portable-config.mjs';
import {postgresReplyProxy} from './portable-hosting-fixture.mjs';

const execute=promisify(execFile);
const bundle=new URL('../.harbor/portable-build/worker/worker.mjs',import.meta.url).href;
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;
const workerJobError='harbor_portable_worker_job_error';
const workerJobErrors=stderr=>stderr.split('\n')
  .filter(line=>line.startsWith('{"event":"'+workerJobError+'"')).map(line=>JSON.parse(line));

export async function launchFault(env,program){
  const script=`import * as worker from ${JSON.stringify(bundle)}; ${program}`;
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{env,cwd,stdio:['ignore','pipe','pipe','ipc']});
  const exit=once(child,'exit');
  try{
    return await Promise.race([
      once(child,'message').then(([message])=>message),
      exit.then(([code])=>assert.fail('Fault fixture exited before checkpoint with code '+code)),
      delay(5_000,undefined,{ref:false}).then(()=>assert.fail('Fault fixture did not reach its checkpoint')),
    ]);
  }finally{
    child.kill('SIGKILL');
    await exit;
  }
}

export async function verifyPortableJobs({request,origin,headers,other,record,otherRecord,sql,env,directory}){
  const url=contact=>'/api/background-jobs?recordId='+contact.id;
  const write=(auth,contact,data,site=origin)=>request(url(contact),{
    method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(data),
  });
  const list=(auth,contact)=>request(url(contact),{headers:auth});
  const one=()=>execute(process.execPath,[command,'worker','--once'],{env,cwd,timeout:6_000});
  const queue=async(expectedCode=0,expectWorker=false)=>{
    const result=await execute(process.execPath,[command,'worker-status',...(expectWorker?['--expect-worker']:[])],{env:{
      ...env,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_WORKER_ENABLED:'false',
    },cwd,timeout:6_000}).then(output=>({...output,code:0}),error=>error);
    assert.equal(result.code,expectedCode,result.stderr);
    const summary=JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary).sort(),['checkedAt','event','lastHeartbeatAt','lastSuccessfulPollAt','latestFailureAt','needsReview',
      'oldestDueAt','oldestExpiredLeaseAt','overdue','queuePoll','result','review','workerExpected','workerHeartbeat']);
    assert.equal(summary.workerExpected,expectWorker);
    assert.equal(summary.event,'harbor_portable_queue');
    return summary;
  };
  const checkPoll=async(after,...options)=>{
    const output=await execute(process.execPath,[command,'worker-status','--poll-after',String(after),...options],{
      env,cwd,timeout:6_000,
    }).then(value=>({...value,code:0}),error=>error);
    return {code:output.code,...JSON.parse(output.stdout)};
  };
  const backupRoot=join(directory,'monitor-backups');
  await mkdir(backupRoot,{mode:0o700});
  const monitor=async(expectedCode,options=[],databaseUrl=env.DATABASE_URL,root=backupRoot,webOrigin='',timeout=6_000,preload)=>{
    const result=await execute(process.execPath,[command,'monitor-status',root,...options],{
      env:{...env,DATABASE_URL:databaseUrl,HARBOR_MONITOR_WEB_ORIGIN:webOrigin,
        HARBOR_PORTABLE_BACKUP_ENABLED:'false',HARBOR_PORTABLE_WORKER_ENABLED:'false',
        HARBOR_S3_ENDPOINT:'',HARBOR_S3_ACCESS_KEY_ID:'',HARBOR_S3_SECRET_ACCESS_KEY:'',
        ...(preload?{NODE_OPTIONS:'--import='+preload}:{})},
      cwd,timeout,
    }).then(output=>({...output,code:0}),error=>error);
    assert.equal(result.code,expectedCode,result.signal??result.stderr);
    assert.equal(result.stderr,'');
    assert.ok(!result.stdout.includes(root));
    assert.ok(!result.stdout.includes(env.DATABASE_URL));
    if(webOrigin)assert.ok(!result.stdout.includes(webOrigin));
    const password=URL.parse(databaseUrl)?.password;
    if(password)assert.ok(!result.stdout.includes(password));
    if(options.includes('--prometheus'))return result.stdout;
    const summary=JSON.parse(result.stdout);
    assert.equal(summary.event,'harbor_portable_monitor');
    return summary;
  };
  const beforeBackups=await monitor(2);
  assert.equal(beforeBackups.worker.workerHeartbeat,'missing');
  assert.equal(beforeBackups.worker.queuePoll,'missing');
  assert.equal(beforeBackups.backups.result,'attention');
  assert.equal('calendar' in beforeBackups,false);
  assert.equal('web' in beforeBackups,false);
  assert.equal('formNotes' in beforeBackups,false);
  assert.equal('segments' in beforeBackups,false);
  assert.equal('taskRepeats' in beforeBackups,false);
  assert.equal('gmailQueue' in beforeBackups,false);
  const day=new Date().toISOString().slice(0,10),backup=join(backupRoot,day);
  await mkdir(backup,{mode:0o700});
  const sample='Fictional monitor digest fixture';
  await writeFile(join(backup,'database.dump'),sample);
  const [{source_id:sourceId}]=await sql`SELECT source_id FROM public.portable_backup_source`;
  const [migration]=await sql`SELECT hash AS sha256,created_at::float8 AS at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`;
  const marker=join(backupRoot,'.harbor-backup-source');
  await writeFile(marker,sourceId+'\n');
  const manifest={format:'harbor-portable-recovery-v2',completedAt:Date.now(),files:[],sourceId,migrations:[migration],
    dumpSha256:createHash('sha256').update(sample).digest('hex')};
  await writeFile(join(backup,'manifest.json'),JSON.stringify(manifest));
  const workerOff=await monitor(0,['--verify','--worker-off']);
  assert.equal(workerOff.worker.workerExpected,false);
  assert.equal(workerOff.worker.workerHeartbeat,'missing');
  assert.equal(workerOff.backups.result,'verified');
  assert.equal((await monitor(2)).worker.workerExpected,true);
  const emptyFullWorker=await monitor(2,['--expect-full-worker']);
  assert.equal(emptyFullWorker.worker.oldestDueAt,null);
  assert.deepEqual(emptyFullWorker.fullWorker,{result:'attention',workerHeartbeat:'missing',expectedWorkerMissing:true});
  await assert.rejects(execute(process.execPath,[command,'monitor-status',backupRoot,'--expect-full-worker','--worker-off'],
    {env,cwd,timeout:6_000}),error=>error.code===1&&/Choose --expect-full-worker or --worker-off/.test(error.stderr));
  const collector=join(directory,'monitor-collector');
  await mkdir(collector);
  const metricsFile=join(collector,'harbor.prom');
  const flags=['--prometheus','--prometheus-file',metricsFile,'--verify','--worker-off'];
  const captureMetric='harbor_monitor_backup_capture_started_at_seconds';
  assert.doesNotMatch(await monitor(0,flags),new RegExp(captureMetric));
  const captureStartedAt=manifest.completedAt-120_000;
  await writeFile(join(backup,'capture-started-at'),new Date(captureStartedAt).toISOString()+'\n');
  assert.equal((await monitor(0,['--worker-off'])).backups.captureStartedAt,captureStartedAt);
  const healthyMetrics=await monitor(0,flags);
  assert.equal(await readFile(metricsFile,'utf8'),healthyMetrics);
  assert.ok(healthyMetrics.split('\n').includes(captureMetric+' '+Math.floor(captureStartedAt/1000)));
  assert.match(healthyMetrics,/^harbor_monitor_checked_at_seconds [0-9]+$/m);
  assert.match(healthyMetrics,/^harbor_monitor_section_status\{section="backups",status="ok"\} 1$/m);
  assert.doesNotMatch(healthyMetrics,/section="web"|section="fullWorker"|harbor_monitor_full_worker_missing|harbor_portable_monitor/);
  const workerIssue=(issue,value)=>new RegExp('^harbor_monitor_worker_issue\\{issue="'+issue+'"\\} '+value+'$','m');
  assert.match(healthyMetrics,workerIssue('heartbeat',0));
  assert.match(healthyMetrics,workerIssue('poll_stalled',0));
  const missingWorkerMetrics=await monitor(2,['--prometheus']);
  assert.match(missingWorkerMetrics,workerIssue('heartbeat',1));
  assert.match(missingWorkerMetrics,workerIssue('poll_stalled',0));
  const dump=join(backup,'database.dump');
  await writeFile(dump,'Damaged fictional monitor fixture');
  try{
    const alertMetrics=await monitor(2,flags);
    assert.equal(await readFile(metricsFile,'utf8'),alertMetrics);
    assert.match(alertMetrics,/^harbor_monitor_section_status\{section="backups",status="attention"\} 1$/m);
    assert.match(alertMetrics,/^harbor_monitor_section_status\{section="worker",status="ok"\} 1$/m);
    assert.match(alertMetrics,/^harbor_monitor_backup_issue\{issue="integrity_failed"\} 1$/m);
    assert.doesNotMatch(alertMetrics,/Damaged fictional|manifest/);
    assert.doesNotMatch(alertMetrics,new RegExp(captureMetric));
  }finally{await writeFile(dump,sample);}
  const recoveredMetrics=await monitor(0,flags);
  assert.match(recoveredMetrics,/^harbor_monitor_section_status\{section="backups",status="attention"\} 0$/m);
  assert.match(recoveredMetrics,/^harbor_monitor_section_status\{section="backups",status="ok"\} 1$/m);
  assert.doesNotMatch(recoveredMetrics,/harbor_monitor_backup_issue/);
  assert.ok(recoveredMetrics.split('\n').includes(captureMetric+' '+Math.floor(captureStartedAt/1000)));
  const unavailableMetrics=await monitor(1,flags,'');
  assert.equal(await readFile(metricsFile,'utf8'),unavailableMetrics);
  assert.doesNotMatch(unavailableMetrics,/harbor_monitor_worker_issue/);
  assert.match(unavailableMetrics,/^harbor_monitor_section_status\{section="backups",status="unavailable"\} 1$/m);
  assert.equal((await monitor(0,['--prometheus-file',metricsFile,'--worker-off'])).result,'ok');
  const publishedMetrics=await readFile(metricsFile,'utf8');
  assert.match(publishedMetrics,/^harbor_monitor_section_status\{section="backups",status="ok"\} 1$/m);
  const blockedPath=join(collector,'blocked.prom');
  await mkdir(blockedPath);
  await assert.rejects(execute(process.execPath,[command,'monitor-status',backupRoot,'--worker-off','--prometheus-file',blockedPath],
    {env,cwd,timeout:6_000}),error=>error.code===1&&/Could not publish Harbor monitor metrics/.test(error.stderr));
  assert.deepEqual((await readdir(collector)).sort(),['blocked.prom','harbor.prom']);
  assert.equal(await readFile(metricsFile,'utf8'),publishedMetrics);
  const dbUnavailable=await monitor(1,['--verify'],'');
  assert.deepEqual(dbUnavailable.worker,{result:'unavailable'});
  assert.deepEqual(dbUnavailable.backups,{result:'unavailable'});
  const calendarUnavailable=await monitor(1,['--calendar','--verify'],'');
  assert.deepEqual(calendarUnavailable.calendar,{result:'unavailable'});
  assert.deepEqual(calendarUnavailable.backups,{result:'unavailable'});
  const backupUnavailable=await monitor(1,[],env.DATABASE_URL,join(backupRoot,'missing'));
  assert.equal(backupUnavailable.worker.workerHeartbeat,'missing');
  assert.deepEqual(backupUnavailable.backups,{result:'unavailable'});
  const status=async id=>(await sql`SELECT status,attempts,issue,available_at FROM portable_jobs WHERE id=${id}`)[0];
  const noteCount=async id=>(await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${id}`)[0].count;
  const expire=async id=>sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${id}`;
  const due=async id=>sql`UPDATE portable_jobs SET available_at=0 WHERE id=${id}`;
  const payload=(body,scheduledFor=0)=>({id:randomUUID(),body,scheduledFor});
  async function verifyGmailQueue(databaseUrl){
    const id=randomUUID();
    const [scope]=await sql`SELECT c.workspace_id,w.owner_id FROM contacts c
      JOIN private_workspaces w ON w.id=c.workspace_id WHERE c.id=${record.id}`;
    const [original]=await sql`SELECT last_gmail_poll_at FROM portable_worker_heartbeat WHERE id=1`;
    const future=Date.now()+600_000;
    await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
      VALUES(${scope.workspace_id},${id},${record.id},${scope.owner_id},'gmail','Fictional mail monitor',${future},${future},${Date.now()})`;
    try{
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=NULL WHERE id=1`;
      const check=code=>monitor(code,['--gmail-queue'],databaseUrl);
      assert.deepEqual((await check(0)).gmailQueue,{result:'ok',dueWithoutWorker:false,reconnectNeedsReview:false,workerHeartbeat:'missing'});
      const checkExpected=code=>monitor(code,['--expect-gmail-worker'],databaseUrl);
      const missing=await checkExpected(2);
      assert.equal(missing.worker.workerHeartbeat,'fresh');
      assert.equal(missing.backups.result,'fresh');
      assert.deepEqual(missing.gmailQueue,{result:'attention',dueWithoutWorker:false,reconnectNeedsReview:false,workerHeartbeat:'missing',expectedWorkerMissing:true});
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
      assert.deepEqual((await checkExpected(0)).gmailQueue,
        {result:'ok',dueWithoutWorker:false,reconnectNeedsReview:false,workerHeartbeat:'fresh',expectedWorkerMissing:false});
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=NULL WHERE id=1`;
      const ready=Date.now()-1000;
      await sql`UPDATE portable_jobs SET scheduled_for=${ready},available_at=${ready} WHERE id=${id}`;
      const queued=await status(id);
      assert.equal((await monitor(0,[],databaseUrl)).worker.workerHeartbeat,'fresh');
      const due=await check(2);
      assert.equal(due.worker.overdue,false);
      assert.deepEqual(due.gmailQueue,{result:'attention',dueWithoutWorker:true,reconnectNeedsReview:false,workerHeartbeat:'missing'});
      assert.match(await monitor(2,['--gmail-queue','--prometheus'],databaseUrl),/^harbor_monitor_gmail_worker_missing 1$/m);
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
      assert.deepEqual((await check(0)).gmailQueue,{result:'ok',dueWithoutWorker:false,reconnectNeedsReview:false,workerHeartbeat:'fresh'});
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=0 WHERE id=1`;
      assert.deepEqual((await check(2)).gmailQueue,{result:'attention',dueWithoutWorker:true,reconnectNeedsReview:false,workerHeartbeat:'stale'});
      assert.deepEqual(await status(id),queued);
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
      await sql`UPDATE portable_jobs SET status='failed',issue='gmail_reauthorization_required',
        attempts=1,finished_at=${Date.now()} WHERE id=${id}`;
      const reconnect=await check(2);
      assert.equal(reconnect.worker.workerHeartbeat,'fresh');
      assert.equal(reconnect.backups.result,'fresh');
      assert.deepEqual(reconnect.gmailQueue,
        {result:'attention',dueWithoutWorker:false,reconnectNeedsReview:true,workerHeartbeat:'fresh'});
      const reconnectMetrics=await monitor(2,['--gmail-queue','--prometheus'],databaseUrl);
      assert.match(reconnectMetrics,/^harbor_monitor_gmail_reconnect_required 1$/m);
      assert.ok(!reconnectMetrics.includes(id));
      const action={action:'reviewFailed',id,attempts:1};
      assert.equal((await write(other,record,action)).status,404);
      assert.equal((await check(2)).gmailQueue.reconnectNeedsReview,true);
      assert.equal((await write(headers,record,action)).status,200);
      assert.deepEqual((await check(0)).gmailQueue,
        {result:'ok',dueWithoutWorker:false,reconnectNeedsReview:false,workerHeartbeat:'fresh'});
      assert.match(await monitor(0,['--gmail-queue','--prometheus'],databaseUrl),/^harbor_monitor_gmail_reconnect_required 0$/m);
      assert.equal((await status(id)).status,'failed');
    }finally{
      await sql`DELETE FROM portable_jobs WHERE id=${id}`;
      await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=${original.last_gmail_poll_at} WHERE id=1`;
    }
  }

  const first=payload('Retry-safe contact note');
  const missingDb=new URL(env.DATABASE_URL);
  missingDb.pathname='/harbor_queue_status_missing';
  for(const databaseUrl of ['',missingDb.href]){
    await assert.rejects(execute(process.execPath,[command,'worker-status'],{
      env:{...env,DATABASE_URL:databaseUrl},cwd,timeout:6_000,
    }),error=>error.code===1&&error.stdout===''&&
      error.stderr.trim()==='{"event":"harbor_portable_queue","result":"unavailable"}');
  }
  const empty=await queue();
  assert.equal(empty.result,'ok');
  assert.equal(empty.oldestDueAt,null);
  assert.equal(empty.workerHeartbeat,'missing');
  assert.equal(empty.lastHeartbeatAt,null);
  assert.equal(empty.queuePoll,'missing');
  assert.equal(empty.lastSuccessfulPollAt,null);
  assert.deepEqual(empty.review,{failed:false,uncertain:false,suppressedEmail:false});
  assert.equal((await queue(2,true)).workerHeartbeat,'missing');
  // The lifecycle wait must hold even if the ordinary due timestamp has elapsed.
  const heldNote=payload('Note waiting for a customer');
  assert.equal((await write(headers,record,heldNote)).status,202);
  await sql`UPDATE portable_jobs SET wait_for_lifecycle='Customer' WHERE id=${heldNote.id}`;
  try{
    const held=await queue();
    assert.equal(held.oldestDueAt,null);
    assert.equal(held.overdue,false);
    await one();
    assert.equal((await status(heldNote.id)).attempts,0);
    assert.equal(await noteCount(heldNote.id),0);
    const {items}=await (await list(headers,record)).json();
    assert.equal(items.find(item=>item.id===heldNote.id)?.waitForLifecycle,'Customer');
    assert.equal((await write(headers,record,{action:'cancelNote',id:heldNote.id})).status,200);
    assert.equal((await status(heldNote.id)).status,'skipped');
  }finally{
    await sql`DELETE FROM portable_jobs WHERE id=${heldNote.id}`;
  }
  assert.equal((await queue(2,true)).workerHeartbeat,'missing');

  const futurePoll=Date.now()+86_400_000;
  await sql`INSERT INTO portable_worker_heartbeat (id,last_poll_at,last_queue_poll_at,last_full_poll_at)
    VALUES (1,${futurePoll},${futurePoll},${futurePoll})`;
  const invalid=await monitor(2,['--expect-full-worker']);
  assert.equal(invalid.worker.workerHeartbeat,'invalid');
  assert.deepEqual(invalid.fullWorker,{result:'attention',workerHeartbeat:'invalid',expectedWorkerMissing:true});
  assert.equal(invalid.worker.lastHeartbeatAt,futurePoll);
  assert.equal(invalid.worker.queuePoll,'invalid');
  assert.equal(invalid.worker.lastSuccessfulPollAt,futurePoll);
  assert.equal(invalid.backups.result,'fresh');
  await one();
  assert.equal((await queue(2,true)).workerHeartbeat,'invalid');

  const [{started_at:workerStartedAt}]=await sql`SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS started_at`;
  const idleWorker=spawn(process.execPath,[command,'worker'],{
    env:{...env,HARBOR_PORTABLE_TASK_REPEAT_ENABLED:'false'},cwd,stdio:['ignore','pipe','pipe'],
  });
  const idleExit=once(idleWorker,'close');
  let workerLogs='',workerErrors='';
  idleWorker.stdout.on('data',chunk=>{workerLogs+=chunk;});
  idleWorker.stderr.on('data',chunk=>{workerErrors+=chunk;});
  try{
    let observed;
    for(let poll=0;poll<50&&!observed;poll++){
      [observed]=await sql`SELECT last_poll_at,last_queue_poll_at,last_full_poll_at,
        floor(extract(epoch from clock_timestamp())*1000)::bigint AS observed_at
        FROM portable_worker_heartbeat WHERE last_poll_at<${futurePoll}
          AND last_queue_poll_at<${futurePoll} AND last_full_poll_at<${futurePoll}`;
      if(!observed)await delay(100);
    }
    assert.ok(observed,'The idle worker did not replace the future heartbeat.');
    for(const stamp of [observed.last_poll_at,observed.last_queue_poll_at,observed.last_full_poll_at]){
      assert.ok(stamp!==null&&BigInt(stamp)>=BigInt(workerStartedAt)&&BigInt(stamp)<=BigInt(observed.observed_at),
        'Worker heartbeat did not record a poll inside the startup window.');
    }
    const live=await queue(0,true);
    assert.equal(live.workerHeartbeat,'fresh');
    assert.equal(live.queuePoll,'fresh');
    assert.ok(live.lastSuccessfulPollAt<=live.lastHeartbeatAt);
    const newer=await checkPoll(live.lastSuccessfulPollAt-1);
    assert.equal(newer.code,0);
    assert.equal(newer.newerPoll,true);
    assert.equal(newer.workerExpected,true);
    const previous=await checkPoll(live.lastSuccessfulPollAt+60_000);
    assert.equal(previous.code,2);
    assert.equal(previous.workerHeartbeat,'fresh');
    assert.equal(previous.queuePoll,'fresh');
    assert.equal(previous.newerPoll,false);
    await assert.rejects(execute(process.execPath,[command,'worker-status','--poll-after','invalid'],{
      env,cwd,timeout:6_000,
    }),/Unix millisecond timestamp/);
    const fingerprint=(await readFile(new URL('../.harbor/portable-build/release.sha256',import.meta.url),'utf8')).trim();
    for(let poll=0;poll<25&&!workerLogs.includes('\n');poll++)await delay(100);
    assert.deepEqual(JSON.parse(workerLogs),{event:'harbor_portable_worker_ready',buildFingerprint:fingerprint,
      capabilities:{scheduledNotes:true,scheduledTasks:true,segmentScans:true,formNotes:true,
        overdueTaskRepeats:false,scheduledGmailConfigured:false,javascriptActions:false}});
    assert.equal((await one()).stdout,'');
    const [{exclusiveAvailable}]=await sql`SELECT pg_try_advisory_xact_lock(${portableMaintenanceLock}) AS "exclusiveAvailable"`;
    assert.equal(exclusiveAvailable,false,'The running worker holds the shared maintenance lock.');
    const migrationCheck=await execute(process.execPath,[command,'migrate'],{env,cwd,timeout:6000});
    assert.match(migrationCheck.stdout,/migrations applied/,'The current ledger can be verified while the worker is running.');
    let healthy;
    if(process.env.HARBOR_TEST_MONITOR_ROLE==='true'){
      // Use a unique login, then remove its explicit grants and role even if a check fails.
      const monitorUser='harbor_monitor_test_'+randomBytes(6).toString('hex');
      const monitorPassword=randomBytes(16).toString('hex');
      await sql.unsafe("CREATE ROLE "+monitorUser+" LOGIN PASSWORD '"+monitorPassword+"'");
      try{
        await sql`GRANT SELECT (status, available_at, scheduled_for, wait_for_lifecycle, operator_retry_at, lease_until, finished_at)
          ON public.portable_jobs TO ${sql(monitorUser)}`;
        await sql`GRANT SELECT (id, last_poll_at) ON public.portable_worker_heartbeat TO ${sql(monitorUser)}`;
        const monitorUrl=new URL(env.DATABASE_URL);
        monitorUrl.username=monitorUser;
        monitorUrl.password=monitorPassword;
        assert.deepEqual((await monitor(1,[],monitorUrl.href)).worker,{result:'unavailable'});
        await sql`GRANT SELECT (operator_reviewed_at, kind, issue) ON public.portable_jobs TO ${sql(monitorUser)}`;
        assert.deepEqual((await monitor(1,[],monitorUrl.href)).worker,{result:'unavailable'});
        await sql`GRANT SELECT (last_queue_poll_at) ON public.portable_worker_heartbeat TO ${sql(monitorUser)}`;
        const missingIdentityGrant=await monitor(1,[],monitorUrl.href);
        assert.equal(missingIdentityGrant.worker.result,'ok');
        assert.deepEqual(missingIdentityGrant.backups,{result:'unavailable'});
        await sql`GRANT SELECT (source_id) ON public.portable_backup_source TO ${sql(monitorUser)}`;
        healthy=await monitor(0,['--verify'],monitorUrl.href);
        const missingGmailGrant=await monitor(1,['--gmail-queue'],monitorUrl.href);
        assert.deepEqual(missingGmailGrant.gmailQueue,{result:'unavailable'});
        assert.equal(missingGmailGrant.worker.result,'ok');
        await sql`GRANT SELECT (last_gmail_poll_at) ON public.portable_worker_heartbeat TO ${sql(monitorUser)}`;
        try{await verifyGmailQueue(monitorUrl.href);}
        finally{
          await sql`REVOKE SELECT (last_gmail_poll_at) ON public.portable_worker_heartbeat FROM ${sql(monitorUser)}`;
        }
        const missingSegmentGrant=await monitor(1,['--segments'],monitorUrl.href);
        assert.deepEqual(missingSegmentGrant.segments,{result:'unavailable'});
        assert.equal(missingSegmentGrant.worker.result,'ok');
        await sql`GRANT SELECT (next_at) ON public.portable_segment_workflow_scans TO ${sql(monitorUser)}`;
        assert.deepEqual((await monitor(1,['--segments'],monitorUrl.href)).segments,{result:'unavailable'});
        await sql`GRANT SELECT (cycle_due_at) ON public.portable_segment_workflow_scans TO ${sql(monitorUser)}`;
        try{assert.deepEqual((await monitor(0,['--segments'],monitorUrl.href)).segments,{result:'ok',overdue:false});}
        finally{await sql`REVOKE SELECT (next_at,cycle_due_at) ON public.portable_segment_workflow_scans FROM ${sql(monitorUser)}`;}
        const missingInquiryGrant=await monitor(1,['--inquiry-follow-up'],monitorUrl.href);
        assert.deepEqual(missingInquiryGrant.inquiryFollowUp,{result:'unavailable'});
        assert.equal(missingInquiryGrant.worker.result,'ok');
        await sql`GRANT SELECT (handled,status,received_at) ON public.portable_lead_inquiries TO ${sql(monitorUser)}`;
        try{
          const [{workspace_id:workspaceId}]=await sql`SELECT workspace_id FROM contacts WHERE id=${record.id}`;
          const formId=randomUUID(),inquiryId=randomUUID(),receivedAt=Date.now();
          await sql`INSERT INTO portable_lead_forms (workspace_id,id,revision,definition)
            VALUES (${workspaceId},${formId},1,'{"title":"Monitor fixture"}')`;
          try{
            await sql`INSERT INTO portable_lead_inquiries (workspace_id,id,form_id,received_at,status)
              VALUES (${workspaceId},${inquiryId},${formId},${receivedAt},'inbox_only')`;
            assert.deepEqual((await monitor(0,['--inquiry-follow-up'],monitorUrl.href)).inquiryFollowUp,{result:'ok',overdue:false});
            await sql`UPDATE portable_lead_inquiries SET received_at=${receivedAt-86400000}
              WHERE workspace_id=${workspaceId} AND id=${inquiryId}`;
            assert.deepEqual((await monitor(2,['--inquiry-follow-up'],monitorUrl.href)).inquiryFollowUp,{result:'attention',overdue:true});
            assert.match(await monitor(2,['--inquiry-follow-up','--prometheus'],monitorUrl.href),
              /^harbor_monitor_section_status\{section="inquiryFollowUp",status="attention"\} 1$/m);
            await sql`UPDATE portable_lead_inquiries SET handled=true WHERE workspace_id=${workspaceId} AND id=${inquiryId}`;
            assert.deepEqual((await monitor(0,['--inquiry-follow-up'],monitorUrl.href)).inquiryFollowUp,{result:'ok',overdue:false});
          }finally{
            await sql`DELETE FROM portable_lead_inquiries WHERE workspace_id=${workspaceId} AND id=${inquiryId}`;
            await sql`DELETE FROM portable_lead_forms WHERE id=${formId}`;
          }
        }finally{await sql`REVOKE SELECT (handled,status,received_at) ON public.portable_lead_inquiries FROM ${sql(monitorUser)}`;}
        const missingFormNoteGrant=await monitor(1,['--form-notes'],monitorUrl.href);
        assert.deepEqual(missingFormNoteGrant.formNotes,{result:'unavailable'});
        assert.equal(missingFormNoteGrant.worker.result,'ok');
        await sql`GRANT SELECT (state,next_at,workspace_id,inquiry_id,issue)
          ON public.portable_lead_form_note_sources TO ${sql(monitorUser)}`;
        await sql`GRANT SELECT (workspace_id,id,handled,status) ON public.portable_lead_inquiries TO ${sql(monitorUser)}`;
        try{
          assert.deepEqual((await monitor(0,['--form-notes'],monitorUrl.href)).formNotes,
            {result:'ok',overdue:false,capacitySkipped:false});
        }finally{
          await sql`REVOKE SELECT (workspace_id,id,handled,status) ON public.portable_lead_inquiries FROM ${sql(monitorUser)}`;
          await sql`REVOKE SELECT (state,next_at,workspace_id,inquiry_id,issue)
            ON public.portable_lead_form_note_sources FROM ${sql(monitorUser)}`;
        }
        const missingTaskQueueGrant=await monitor(1,['--task-queue','--expect-full-worker'],monitorUrl.href);
        assert.deepEqual(missingTaskQueueGrant.taskQueue,{result:'unavailable'});
        assert.deepEqual(missingTaskQueueGrant.fullWorker,{result:'unavailable'});
        assert.equal(missingTaskQueueGrant.worker.result,'ok');
        const unavailableFullWorker=await monitor(1,['--expect-full-worker','--prometheus'],monitorUrl.href);
        assert.match(unavailableFullWorker,/^harbor_monitor_section_status\{section="fullWorker",status="unavailable"\} 1$/m);
        assert.doesNotMatch(unavailableFullWorker,/harbor_monitor_full_worker_missing/);
        await sql`GRANT SELECT (last_full_poll_at) ON public.portable_worker_heartbeat TO ${sql(monitorUser)}`;
        try{
          const ready=await monitor(0,['--task-queue','--expect-full-worker'],monitorUrl.href);
          assert.deepEqual(ready.taskQueue,{result:'ok',dueWithoutWorker:false});
          assert.deepEqual(ready.fullWorker,{result:'ok',workerHeartbeat:'fresh',expectedWorkerMissing:false});
          assert.match(await monitor(0,['--expect-full-worker','--prometheus'],monitorUrl.href),/^harbor_monitor_full_worker_missing 0$/m);
        }finally{await sql`REVOKE SELECT (last_full_poll_at) ON public.portable_worker_heartbeat FROM ${sql(monitorUser)}`;}
        const missingTaskRepeatGrant=await monitor(1,['--task-repeats'],monitorUrl.href);
        assert.deepEqual(missingTaskRepeatGrant.taskRepeats,{result:'unavailable'});
        assert.equal(missingTaskRepeatGrant.worker.result,'ok');
        await sql`GRANT SELECT ON public.portable_task_repeat_monitor TO ${sql(monitorUser)}`;
        try{
          assert.deepEqual((await monitor(0,['--task-repeats'],monitorUrl.href)).taskRepeats,{
            result:'ok',overdue:false,dueCount:0,truncated:false,oldestDueAgeSeconds:null,
          });
          const restricted=postgres(monitorUrl.href,{max:1,connect_timeout:3});
          try{
            await assert.rejects(restricted`SELECT data FROM public.portable_tasks`,{code:'42501'});
            await assert.rejects(restricted`SELECT predecessor_id FROM public.portable_task_repeat_receipts`,{code:'42501'});
          }finally{await restricted.end({timeout:3});}
        }finally{await sql`REVOKE SELECT ON public.portable_task_repeat_monitor FROM ${sql(monitorUser)}`;}
        const missingCalendarGrant=await monitor(1,['--calendar'],monitorUrl.href);
        assert.deepEqual(missingCalendarGrant.calendar,{result:'unavailable'});
        assert.equal(missingCalendarGrant.worker.result,'ok');
        assert.equal(missingCalendarGrant.backups.result,'fresh');
        await sql`GRANT SELECT (status, created_at, cancellation_started_at) ON public.portable_calendar_meetings TO ${sql(monitorUser)}`;
        await sql`GRANT SELECT (status, created_at) ON public.portable_calendar_reschedules TO ${sql(monitorUser)}`;
        try{healthy=await monitor(0,['--verify','--calendar'],monitorUrl.href);}
        finally{
          await sql`REVOKE SELECT (status, created_at, cancellation_started_at) ON public.portable_calendar_meetings FROM ${sql(monitorUser)}`;
          await sql`REVOKE SELECT (status, created_at) ON public.portable_calendar_reschedules FROM ${sql(monitorUser)}`;
        }
      }finally{
        await sql`REVOKE SELECT (status, available_at, scheduled_for, wait_for_lifecycle, operator_retry_at, lease_until, finished_at,
          operator_reviewed_at, kind, issue) ON public.portable_jobs FROM ${sql(monitorUser)}`;
        await sql`REVOKE SELECT (id, last_poll_at, last_queue_poll_at) ON public.portable_worker_heartbeat FROM ${sql(monitorUser)}`;
        await sql`REVOKE SELECT (source_id) ON public.portable_backup_source FROM ${sql(monitorUser)}`;
        await sql`DROP ROLE ${sql(monitorUser)}`;
      }
    }else{
      healthy=await monitor(0,['--verify','--calendar']);
      await verifyGmailQueue(env.DATABASE_URL);
    }
    assert.equal(healthy.result,'ok');
    assert.equal(healthy.worker.workerHeartbeat,'fresh');
    assert.equal(healthy.worker.queuePoll,'fresh');
    assert.equal(healthy.backups.result,'verified');
    const segmentId=randomUUID(),workflowId=randomUUID(),workflowName='Fictional stalled segment check';
    const post=(path,data)=>request(path,{method:'POST',
      headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await post('/api/segments',{action:'save',segment:{id:segmentId,revision:0,name:workflowName,
      kind:'contacts',mode:'active',criteria:{groups:[]}}})).status,201);
    try{
      assert.equal((await post('/api/workflows',{action:'save',id:workflowId,revision:0,definition:{name:workflowName,
        trigger:'contact_segment',segmentId,delayMinutes:0,body:'Fictional Note body'}})).status,200);
      assert.equal((await post('/api/workflows',{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
      await sql.begin(async tx=>{
        await tx`SELECT id FROM private_workspaces WHERE id=(SELECT workspace_id
          FROM portable_segment_workflow_scans WHERE workflow_id=${workflowId}) FOR NO KEY UPDATE`;
        await sql`UPDATE portable_segment_workflow_scans SET next_at=${Date.now()-6*60_000} WHERE workflow_id=${workflowId}`;
        const stalledScan=await monitor(2,['--verify','--segments']);
        assert.equal(stalledScan.worker.result,'ok');
        assert.equal(stalledScan.worker.workerHeartbeat,'fresh');
        assert.equal(stalledScan.backups.result,'verified');
        assert.deepEqual(stalledScan.segments,{result:'attention',overdue:true});
        const segmentMetrics=await monitor(2,['--segments','--prometheus']);
        assert.match(segmentMetrics,/^harbor_monitor_segment_scan_overdue 1$/m);
        assert.ok(!segmentMetrics.includes(workflowId));
        assert.ok(!segmentMetrics.includes(workflowName));
        assert.ok(!JSON.stringify(stalledScan).includes(workflowId));
        assert.ok(!JSON.stringify(stalledScan).includes(workflowName));
        assert.match(await (await request('/?view=workflows',{headers})).text(),/List check overdue/);
        assert.doesNotMatch(await (await request('/?view=workflows',{headers:other})).text(),/List check overdue/);
      });
      await one();
      for(let poll=0;poll<30;poll++){
        const [scan]=await sql`SELECT next_at FROM portable_segment_workflow_scans WHERE workflow_id=${workflowId}`;
        if(Number(scan.next_at)>Date.now()-5*60_000)break;
        await delay(50);
      }
      assert.deepEqual((await monitor(0,['--verify','--segments'])).segments,{result:'ok',overdue:false});
      assert.match(await monitor(0,['--segments','--prometheus']),/^harbor_monitor_segment_scan_overdue 0$/m);
      assert.doesNotMatch(await monitor(0,['--prometheus']),/harbor_monitor_segment_scan_overdue/);
      assert.doesNotMatch(await (await request('/?view=workflows',{headers})).text(),/List check overdue/);
    }finally{
      await sql.begin(async tx=>{
        await tx`SELECT id FROM private_workspaces WHERE id=(SELECT workspace_id
          FROM portable_segments WHERE id=${segmentId}) FOR NO KEY UPDATE`;
        await tx`DELETE FROM portable_segment_workflow_members WHERE workflow_id=${workflowId}`;
        await tx`DELETE FROM portable_segment_workflow_scans WHERE workflow_id=${workflowId}`;
        await tx`DELETE FROM portable_workflow_activations WHERE workflow_id=${workflowId}`;
        await tx`DELETE FROM portable_deal_workflows WHERE id=${workflowId}`;
        await tx`DELETE FROM portable_segments WHERE id=${segmentId}`;
      });
    }
    const formId=randomUUID(),inquiryId=randomUUID(),noteId=randomUUID();
    const formBody='Fictional waiting form Note';
    const [scope]=await sql`SELECT c.workspace_id,w.owner_id FROM contacts c
      JOIN private_workspaces w ON w.id=c.workspace_id WHERE c.id=${record.id}`;
    await verifyTaskRepeatMonitor({monitor,sql,scope,request,headers,other});
    const formPayload={name:'Fictional overdue inquiry',email:'overdue-form@example.test'};
    try{
      await sql.begin(async tx=>{
        await tx`SELECT id FROM private_workspaces WHERE id=${scope.workspace_id} FOR NO KEY UPDATE`;
        await tx`INSERT INTO portable_lead_forms(workspace_id,id,revision,definition)
          VALUES(${scope.workspace_id},${formId},1,${sql.json({title:'Fictional waiting form',captureContacts:true,queueWorkflows:true,automationNote:formBody})})`;
        await tx`INSERT INTO portable_lead_form_activations(form_id) VALUES(${formId})`;
        await tx`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,payload,status,contact_id)
          VALUES(${scope.workspace_id},${inquiryId},${formId},${Date.now()},${sql.json(formPayload)},'linked',${record.id})`;
        await tx`INSERT INTO portable_lead_form_note_sources(workspace_id,inquiry_id,form_id,form_revision,contact_id,owner_id,job_id,state,next_at,retry_at)
          VALUES(${scope.workspace_id},${inquiryId},${formId},1,${record.id},${scope.owner_id},${noteId},'waiting',${Date.now()-6*60_000},${Date.now()+60_000})`;
      });
      const waiting=await monitor(2,['--verify','--form-notes']);
      assert.equal(waiting.worker.workerHeartbeat,'fresh');
      assert.equal(waiting.worker.result,'ok');
      assert.equal(waiting.backups.result,'verified');
      assert.deepEqual(waiting.formNotes,{result:'attention',overdue:true,capacitySkipped:false});
      for(const value of [formId,inquiryId,noteId,formBody,formPayload.email])assert.ok(!JSON.stringify(waiting).includes(value));
      const ownerPath='/api/lead-forms?formId='+formId;
      const ownerResponse=await request(ownerPath,{headers});
      assert.equal(ownerResponse.status,200,await ownerResponse.clone().text());
      assert.deepEqual((await ownerResponse.json()).results[0].noteAutomation,{status:'waiting',issue:null,overdue:true});
      assert.equal((await request(ownerPath,{headers:other})).status,404);
      assert.match(await (await request('/?view=forms&formId='+formId,{headers})).text(),/Waiting longer than expected/);
      const off=await post('/api/lead-forms',{action:'setEnabled',id:formId,revision:1,enabled:false});
      assert.equal(off.status,200,await off.clone().text());
      const healthyFormNotes={result:'ok',overdue:false,capacitySkipped:false};
      assert.deepEqual((await monitor(0,['--verify','--form-notes'])).formNotes,healthyFormNotes);
      const [stopped]=await sql`SELECT state,retry_at FROM portable_lead_form_note_sources WHERE inquiry_id=${inquiryId}`;
      assert.deepEqual(stopped,{state:'skipped',retry_at:null});
      // A stored capacity skip predating this release is still actionable.
      await sql`UPDATE portable_lead_form_note_sources SET issue='This workspace has too many pending form Notes.'
        WHERE workspace_id=${scope.workspace_id} AND inquiry_id=${inquiryId}`;
      const capacity=await monitor(2,['--form-notes']);
      assert.deepEqual(capacity.formNotes,{result:'attention',overdue:false,capacitySkipped:true});
      for(const value of [formId,inquiryId,noteId,formBody,formPayload.email])assert.ok(!JSON.stringify(capacity).includes(value));
      assert.match(await monitor(2,['--form-notes','--prometheus']),
        /^harbor_monitor_section_status\{section="formNotes",status="attention"\} 1$/m);
      const handled=await post('/api/lead-forms',{action:'setInquiryHandled',formId,submissionId:inquiryId,handled:true,triageRevision:0});
      assert.equal(handled.status,200,await handled.clone().text());
      assert.deepEqual((await monitor(0,['--form-notes'])).formNotes,healthyFormNotes);
    }finally{
      await sql.begin(async tx=>{
        await tx`SELECT id FROM private_workspaces WHERE id=${scope.workspace_id} FOR NO KEY UPDATE`;
        await tx`DELETE FROM portable_lead_form_note_sources WHERE inquiry_id=${inquiryId}`;
        await tx`DELETE FROM portable_lead_inquiries WHERE id=${inquiryId}`;
        await tx`DELETE FROM portable_lead_form_activations WHERE form_id=${formId}`;
        await tx`DELETE FROM portable_lead_forms WHERE id=${formId}`;
      });
    }
    await writeFile(marker,randomUUID()+'\n');
    try{
      const misplaced=await monitor(2);
      assert.equal(misplaced.worker.result,'ok');
      assert.deepEqual(misplaced.backups,{result:'attention',issue:'source_mismatch',
        reason:'The private backup root belongs to a different Harbor database.'});
      assert.ok(!JSON.stringify(misplaced).includes(sourceId));
    }finally{await writeFile(marker,sourceId+'\n');}
    const web=async(origin,code,reason,expectedBuild)=>{
      const flags=expectedBuild?['--expect-build',expectedBuild]:[];
      const report=await monitor(code,['--verify','--web',...flags],env.DATABASE_URL,backupRoot,origin);
      assert.deepEqual(report.web,reason?{result:code===1?'unavailable':'attention',reason}:{result:'ok'});
      assert.equal(report.worker.result,'ok');
      assert.equal(report.backups.result,'verified');
    };
    await web(origin,0);
    const wrongBuild=(fingerprint[0]==='a'?'b':'a')+fingerprint.slice(1);
    await web(origin,0,undefined,fingerprint);
    await web(origin,0,undefined,'packaged');
    await assert.rejects(execute(process.execPath,[command,'monitor-status',backupRoot,'--expect-build','packaged'],{
      env,cwd,timeout:6_000,
    }),/monitor-status --web/);
    await web(origin,2,'build_mismatch',wrongBuild);
    const wrongBuildMetrics=await monitor(2,['--web','--expect-build',wrongBuild,'--prometheus'],env.DATABASE_URL,backupRoot,origin);
    assert.match(wrongBuildMetrics,/^harbor_monitor_web_issue\{issue="build_mismatch"\} 1$/m);
    assert.ok(!wrongBuildMetrics.includes(wrongBuild));
    const healthyWebMetrics=await monitor(0,['--web','--expect-build',fingerprint,'--prometheus'],env.DATABASE_URL,backupRoot,origin);
    assert.doesNotMatch(healthyWebMetrics,/harbor_monitor_web_issue/);
    const webOnly=async(target,code,expected,flags=[],stderr)=>{
      const result=await execute(process.execPath,[command,'web-status',...flags],{
        env:{HARBOR_PORTABLE_MODE:'local',HARBOR_MONITOR_WEB_ORIGIN:target},cwd,timeout:6_000,
      }).then(output=>({...output,code:0}),error=>error);
      assert.equal(result.code,code,result.stderr);
      if(stderr)assert.match(result.stderr,stderr);
      else assert.equal(result.stderr,'');
      assert.deepEqual(JSON.parse(result.stdout),{event:'harbor_portable_web',...expected});
    };
    await webOnly(origin,0,{result:'ok'},['--expect-build',fingerprint]);
    const webMetricsFile=join(directory,'web-status.prom');
    const webMetricsFlags=['--prometheus-file',webMetricsFile];
    const webCheckStarted=Math.floor(Date.now()/1000);
    await webOnly(origin,2,{result:'attention',reason:'build_mismatch'},['--expect-build',wrongBuild,...webMetricsFlags]);
    const webAttentionMetrics=await readFile(webMetricsFile,'utf8');
    const checkedAt=Number(webAttentionMetrics.match(/^harbor_monitor_checked_at_seconds ([0-9]+)$/m)?.[1]);
    assert.ok(checkedAt>=webCheckStarted&&checkedAt<=Math.floor(Date.now()/1000),'Web metrics should report a fresh check timestamp.');
    assert.match(webAttentionMetrics,/^harbor_monitor_section_status\{section="web",status="attention"\} 1$/m);
    assert.match(webAttentionMetrics,/^harbor_monitor_web_issue\{issue="build_mismatch"\} 1$/m);
    assert.ok(!webAttentionMetrics.includes(wrongBuild));
    await webOnly(origin,0,{result:'ok'},['--expect-build',fingerprint,...webMetricsFlags]);
    const webRecoveredMetrics=await readFile(webMetricsFile,'utf8');
    assert.match(webRecoveredMetrics,/^harbor_monitor_section_status\{section="web",status="ok"\} 1$/m);
    assert.match(webRecoveredMetrics,/^harbor_monitor_section_status\{section="web",status="attention"\} 0$/m);
    assert.doesNotMatch(webRecoveredMetrics,/harbor_monitor_web_issue|section="(?!web")|harbor_monitor_(?:worker|backup)_/);
    await webOnly(origin,1,{result:'ok'},['--prometheus-file',join(directory,'no-collector','web.prom')],
      /Could not publish Harbor monitor metrics/);
    await webOnly('http://private-user:private-password@127.0.0.1:1234',1,{result:'unavailable',reason:'invalid_origin'});
    const independent=await monitor(1,['--web'],'',backupRoot,origin);
    assert.deepEqual(independent.worker,{result:'unavailable'});
    assert.deepEqual(independent.web,{result:'ok'});
    const helperMarker=join(directory,'monitor-backup-helper.pid'),preload=join(directory,'monitor-backup-helper.mjs');
    await writeFile(preload,`
import {writeFileSync} from 'node:fs';
if(process.argv[2]==='_backup-status')writeFileSync(${JSON.stringify(helperMarker)},String(process.pid));
`);
    const monitorProxy=await postgresReplyProxy(env.DATABASE_URL,{holdHalfOpen:true});
    let pendingMonitor,helperPid;
    const helperIsRunning=()=>{
      if(!helperPid)return false;
      try{process.kill(helperPid,0);return true;}
      catch(error){if(error.code==='ESRCH')return false;throw error;}
    };
    try{
      await sql.begin(async tx=>{
        await tx`LOCK TABLE portable_jobs, portable_calendar_meetings, portable_backup_source,
          portable_segment_workflow_scans, portable_lead_form_note_sources, portable_tasks IN ACCESS EXCLUSIVE MODE`;
        pendingMonitor=monitor(1,['--calendar','--verify','--web','--segments','--form-notes','--task-repeats'],monitorProxy.url.href,backupRoot,origin,8_000,preload);
        void pendingMonitor.catch(()=>{});
        let waiting=0;
        for(let poll=0;poll<45&&waiting!==6;poll++){
          [{waiting}]=await tx`SELECT count(DISTINCT relation)::int AS waiting FROM pg_locks WHERE NOT granted
            AND relation IN ('portable_jobs'::regclass,'portable_calendar_meetings'::regclass,
              'portable_backup_source'::regclass,'portable_segment_workflow_scans'::regclass,'portable_lead_form_note_sources'::regclass,
              'portable_tasks'::regclass)`;
          if(waiting!==6)await delay(50);
        }
        assert.equal(waiting,6,'all status readers reached established Postgres sessions');
        monitorProxy.block();
      });
      const report=await pendingMonitor;
      helperPid=Number(await readFile(helperMarker,'utf8'));
      assert.ok(Number.isSafeInteger(helperPid)&&helperPid>0);
      for(let poll=0;poll<20&&helperIsRunning();poll++)await delay(25);
      assert.equal(helperIsRunning(),false,'the backup helper exited after returning its database timeout');
      assert.equal(monitorProxy.stalled.size,6,'each established session lost a Postgres reply');
      assert.equal(monitorProxy.clients.size,6,'the proxy withheld TCP shutdown until fixture cleanup');
      assert.deepEqual(report,{
        event:'harbor_portable_monitor',result:'unavailable',worker:{result:'unavailable'},
        backups:{result:'unavailable'},calendar:{result:'unavailable'},web:{result:'ok'},segments:{result:'unavailable'},formNotes:{result:'unavailable'},
        taskRepeats:{result:'unavailable'},
      });
    }finally{
      if(helperIsRunning())process.kill(helperPid,'SIGKILL');
      await monitorProxy.close();
      await pendingMonitor?.catch(()=>{});
    }
    await web(origin,0);
    await web('http://private-user:private-password@127.0.0.1:1234',1,'invalid_origin');

    let reply='not_ready',advertisedBuild;
    const received=[];
    const probe=createServer((request,response)=>{
      received.push({path:request.url,cookie:request.headers.cookie,authorization:request.headers.authorization});
      if(reply==='slow')return;
      response.setHeader('Content-Type','text/plain; charset=utf-8');
      response.setHeader('Cache-Control',reply==='cached'?'public, max-age=300':'no-store');
      if(advertisedBuild)response.setHeader('X-Harbor-Build-Fingerprint',advertisedBuild);
      if(reply==='redirect'){
        response.statusCode=302;
        response.setHeader('Location','/should-not-follow');
      }else if(reply==='not_ready')response.statusCode=503;
      response.end(reply==='oversized'?'private-fixture-body'.repeat(500):reply==='cached'||reply==='ready'?'ready':'unavailable');
    });
    probe.listen(0,'127.0.0.1');
    await once(probe,'listening');
    const probeOrigin='http://127.0.0.1:'+probe.address().port;
    try{
      await web(probeOrigin,2,'not_ready');
      reply='cached';
      await web(probeOrigin,2,'unexpected_response');
      reply='ready';
      await web(probeOrigin,0);
      await web(probeOrigin,2,'build_mismatch',fingerprint);
      advertisedBuild=wrongBuild;
      await web(probeOrigin,2,'build_mismatch','packaged');
      advertisedBuild=undefined;
      reply='redirect';
      await web(probeOrigin,2,'unexpected_response');
      reply='oversized';
      await web(probeOrigin,2,'unexpected_response');
      reply='slow';
      await web(probeOrigin,2,'unreachable');
      assert.deepEqual(received,Array.from({length:8},()=>({path:'/healthz',cookie:undefined,authorization:undefined})));
    }finally{
      probe.closeAllConnections();
      await new Promise(resolve=>probe.close(resolve));
    }
    await web(probeOrigin,2,'unreachable');
    await webOnly(probeOrigin,2,{result:'attention',reason:'unreachable'});
    assert.deepEqual(healthy.calendar,{result:'ok',uncertainInvitation:false,staleInvitation:false,uncertainCancellation:false,
      staleCancellation:false,uncertainReschedule:false,staleReschedule:false});
    const calendarId=randomUUID();
    await sql`INSERT INTO portable_calendar_meetings(workspace_id,id,contact_id,owner_id,account_id,input,start_at,end_at,created_at,status)
      SELECT w.id,${calendarId},c.id,w.owner_id,'fictional-calendar-account','{}'::jsonb,0,1,0,'attention'
      FROM contacts c JOIN private_workspaces w ON c.workspace_id=w.id WHERE c.id=${record.id}`;
    try{
      const calendarOnly=await monitor(2,['--calendar','--verify']);
      assert.equal(calendarOnly.worker.result,'ok');
      assert.equal(calendarOnly.backups.result,'verified');
      assert.equal(calendarOnly.calendar.uncertainInvitation,true);
    }finally{
      await sql`DELETE FROM portable_calendar_meetings WHERE id=${calendarId}`;
    }
    assert.equal(live.oldestDueAt,null);
    assert.ok(Number.isFinite(live.lastSuccessfulPollAt)&&live.lastSuccessfulPollAt<=live.checkedAt);
    const locks=await sql`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${portableMaintenanceLock}
      AND mode='ShareLock' AND granted`;
    assert.equal(locks.length,1);
    assert.equal((await sql`SELECT pg_terminate_backend(${locks[0].pid}) AS stopped`)[0].stopped,true);
    const exit=await Promise.race([idleExit,delay(5000,undefined,{ref:false})]);
    assert.deepEqual(exit,[1,null]);
    assert.equal(workerLogs.trim().split('\n').length,1);
    assert.match(workerErrors,/stopped after losing its database session/);
    assert.ok(!workerErrors.includes(env.DATABASE_URL));
    assert.match((await execute(process.execPath,[command,'migrate'],{env,cwd,timeout:6000})).stdout,/migrations applied/);
  }finally{
    if(idleWorker.exitCode===null&&idleWorker.signalCode===null)idleWorker.kill('SIGKILL');
    await idleExit;
  }
  // Advance the observation age without slowing the whole suite by a minute.
  await sql`UPDATE portable_worker_heartbeat SET last_poll_at=0,last_queue_poll_at=0`;
  const stopped=await queue(2,true);
  assert.equal(stopped.workerHeartbeat,'stale');
  assert.equal(stopped.lastHeartbeatAt,0);
  assert.equal(stopped.queuePoll,'stale');
  assert.equal(stopped.oldestDueAt,null);
  assert.equal(stopped.lastSuccessfulPollAt,0);
  await sql`UPDATE portable_worker_heartbeat
    SET last_queue_poll_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
  const freshProgressOnly=await checkPoll(0);
  assert.equal(freshProgressOnly.workerHeartbeat,'stale');
  assert.equal(freshProgressOnly.queuePoll,'fresh');
  assert.equal(freshProgressOnly.newerPoll,false);
  assert.equal(freshProgressOnly.code,2);
  await sql`UPDATE portable_worker_heartbeat SET last_poll_at=last_queue_poll_at WHERE id=1`;
  for(const [stamp,state] of [[null,'missing'],[futurePoll,'invalid'],[1,'stale']]){
    await sql`UPDATE portable_worker_heartbeat SET last_queue_poll_at=${stamp} WHERE id=1`;
    const liveWithoutProgress=await checkPoll(0);
    assert.equal(liveWithoutProgress.workerHeartbeat,'fresh');
    assert.equal(liveWithoutProgress.queuePoll,state);
    assert.equal(liveWithoutProgress.lastSuccessfulPollAt,stamp);
    assert.equal(liveWithoutProgress.newerPoll,false);
    assert.equal(liveWithoutProgress.code,2);
    const metrics=await monitor(2,['--prometheus']);
    assert.match(metrics,workerIssue('heartbeat',0));
    assert.match(metrics,workerIssue('poll_stalled',1));
  }
  assert.match(await monitor(0,['--prometheus','--worker-off']),workerIssue('poll_stalled',0));
  // A slow full-worker pass can outlast the liveness window even while the process is healthy.
  const [savedCapabilities]=await sql`SELECT last_full_poll_at,last_gmail_poll_at FROM portable_worker_heartbeat WHERE id=1`;
  try{
    for(const [age,state,code] of [[90_000,'fresh',0],[151_000,'stale',2]]){
      await sql`WITH clock AS (SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at)
        UPDATE portable_worker_heartbeat SET last_poll_at=clock.at,last_queue_poll_at=clock.at-${age},
          last_full_poll_at=clock.at-${age},last_gmail_poll_at=clock.at-${age} FROM clock WHERE id=1`;
      const snapshot=await monitor(code,['--expect-full-worker','--expect-gmail-worker']);
      assert.equal(snapshot.worker.workerHeartbeat,'fresh');
      assert.equal(snapshot.worker.queuePoll,state);
      assert.equal(snapshot.fullWorker.workerHeartbeat,state);
      assert.equal(snapshot.gmailQueue.workerHeartbeat,state);
    }
  }finally{
    await sql`UPDATE portable_worker_heartbeat SET last_full_poll_at=${savedCapabilities.last_full_poll_at},
      last_gmail_poll_at=${savedCapabilities.last_gmail_poll_at} WHERE id=1`;
  }
  await sql`UPDATE portable_worker_heartbeat SET last_poll_at=0,last_queue_poll_at=0 WHERE id=1`;
  await writeFile(join(backup,'capture-started-at'),new Date(Date.now()-31*60*60*1000).toISOString()+'\n');
  const stalled=await monitor(2);
  assert.equal(stalled.result,'attention');
  assert.equal(stalled.worker.workerHeartbeat,'stale');
  assert.equal(stalled.backups.result,'attention');
  assert.match(stalled.backups.reason,/overdue/);
  const staleBackup=await monitor(2,['--worker-off']);
  assert.equal(staleBackup.worker.result,'ok');
  assert.equal(staleBackup.backups.result,'attention');
  assert.equal((await sql`SELECT last_poll_at FROM portable_worker_heartbeat WHERE id=1`)[0].last_poll_at,'0');
  await one();
  assert.equal((await queue()).workerHeartbeat,'stale');

  // Hold COMMIT across the next heartbeat, then let Postgres commit without
  // letting the job connection receive the acknowledgement.
  const lostReply=payload('One Note after a lost database acknowledgement');
  const gate=810683410;
  await sql.unsafe(`CREATE FUNCTION harbor_test_note_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER harbor_test_note_commit_gate AFTER INSERT ON portable_notes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harbor_test_note_commit_gate()`).simple();
  const proxy=await postgresReplyProxy(env.DATABASE_URL);
  const wedged=spawn(process.execPath,[command,'worker','--notes-only'],{env:{...env,DATABASE_URL:proxy.url.href},cwd,
    stdio:['ignore','ignore','pipe']});
  const wedgedExit=once(wedged,'close');
  let wedgedErrors='';
  wedged.stderr.on('data',chunk=>{wedgedErrors+=chunk;});
  try{
    let heartbeat;
    for(let poll=0;poll<50&&!heartbeat;poll++){
      [heartbeat]=await sql`SELECT last_poll_at,last_queue_poll_at FROM portable_worker_heartbeat
        WHERE last_poll_at>0 AND last_queue_poll_at>0`;
      if(!heartbeat)await delay(100);
    }
    assert.ok(heartbeat,'The worker never established a healthy database session.');
    // Start the Note close enough to the 15-second cadence that a heartbeat is due
    // before the ten-second job deadline.
    await delay(Math.max(0,Number(heartbeat.last_poll_at)+11_500-Date.now()));
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${gate}::bigint)`;
      assert.equal((await write(headers,record,lostReply)).status,202);
      let waiting=false;
      for(let poll=0;poll<50&&!waiting;poll++){
        [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND objid=${gate} AND NOT granted) AS waiting`;
        if(!waiting)await delay(100);
      }
      assert.ok(waiting,'The worker never reached the Note commit gate.');
      const [{blocked_at:blockedAt}]=await tx`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS blocked_at`;
      let advanced;
      for(let poll=0;poll<75&&!advanced;poll++){
        [advanced]=await tx`SELECT last_poll_at,last_queue_poll_at FROM portable_worker_heartbeat WHERE last_poll_at>${blockedAt}`;
        if(!advanced)await delay(100);
      }
      assert.ok(advanced,'The worker did not record a heartbeat while Note COMMIT was blocked.');
      assert.ok(advanced.last_queue_poll_at!==null&&Number(advanced.last_queue_poll_at)<blockedAt,
        'A heartbeat during the blocked commit must retain a pre-block successful job poll.');
      const jobPoll=await checkPoll(blockedAt);
      assert.equal(jobPoll.code,2);
      assert.equal(jobPoll.workerHeartbeat,'fresh');
      assert.equal(jobPoll.queuePoll,'fresh');
      assert.equal(jobPoll.lastHeartbeatAt,Number(advanced.last_poll_at));
      assert.equal(jobPoll.lastSuccessfulPollAt,Number(advanced.last_queue_poll_at));
      assert.equal(jobPoll.newerPoll,false);
      [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND objid=${gate} AND NOT granted) AS waiting`;
      assert.ok(waiting,'The Note was no longer blocked when the heartbeat advanced.');
      proxy.block();
    });
    for(let poll=0;poll<50&&!proxy.stalled.size;poll++)await delay(100);
    assert.ok(proxy.stalled.size>0,'The database acknowledgement was not blackholed.');
    assert.equal(await noteCount(lostReply.id),1);
    assert.equal((await status(lostReply.id)).status,'succeeded');
    wedged.kill('SIGTERM');
    assert.deepEqual(await Promise.race([wedgedExit,delay(12_500,undefined,{ref:false})]),[1,null]);
    assert.match(wedgedErrors,/stopped after losing its database session/);
    assert.deepEqual(workerJobErrors(wedgedErrors),[{
      event:workerJobError,phase:'process_claim',jobId:lostReply.id,kind:'note',attempt:1,
      errorName:'PortableWorkerSessionLost',errorMessage:'Portable worker stopped after losing its database session.',
    }]);
    assert.ok(!wedgedErrors.includes(proxy.url.href));
    assert.equal((await sql`SELECT pg_try_advisory_xact_lock(${portableMaintenanceLock}) AS released`)[0].released,true);
  }finally{
    if(wedged.exitCode===null&&wedged.signalCode===null)wedged.kill('SIGKILL');
    await wedgedExit;
    await proxy.close();
    await sql.unsafe('DROP TRIGGER harbor_test_note_commit_gate ON portable_notes; DROP FUNCTION harbor_test_note_commit_gate()').simple();
  }
  await one();
  assert.equal(await noteCount(lostReply.id),1);
  assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${lostReply.id}`),
    [{number:1,outcome:'succeeded'}]);
  await sql.begin(async tx=>{
    await tx`DELETE FROM portable_notes WHERE job_id=${lostReply.id}`;
    await tx`DELETE FROM portable_job_attempts WHERE job_id=${lostReply.id}`;
    await tx`DELETE FROM portable_jobs WHERE id=${lostReply.id}`;
  });

  for(const [sqlState,expectedIssue] of [['P0001','processor_error'],['57014','lease_expired']]){
    const failedWrite=payload('Fictional Note after a rejected write');
    assert.equal((await write(headers,record,failedWrite)).status,202);
    try{
      await sql.unsafe(`CREATE FUNCTION harbor_test_reject_note_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'private-claim-failure-fixture' USING ERRCODE = '${sqlState}'; END $$;
        CREATE TRIGGER harbor_test_reject_note_write BEFORE INSERT ON portable_notes
        FOR EACH ROW WHEN (NEW.job_id='${failedWrite.id}')
        EXECUTE FUNCTION harbor_test_reject_note_write()`).simple();
      try{
        const {stderr}=await one();
        assert.deepEqual(workerJobErrors(stderr),[{
          event:workerJobError,phase:'process_claim',jobId:failedWrite.id,kind:'note',attempt:1,
          errorName:'PostgresError',errorMessage:`PostgreSQL error ${sqlState}.`,
        }]);
        assert.ok(!stderr.includes('private-claim-failure-fixture'));
        assert.ok(!stderr.includes(failedWrite.body));
        assert.equal(await noteCount(failedWrite.id),0);
        const {status:state,attempts,issue}=await status(failedWrite.id);
        assert.deepEqual({state,attempts,issue},{state:'queued',attempts:1,issue:expectedIssue});
      }finally{
        await sql.unsafe('DROP TRIGGER harbor_test_reject_note_write ON portable_notes; DROP FUNCTION harbor_test_reject_note_write()').simple();
      }
      await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${failedWrite.id}`;
      await one();
      assert.equal(await noteCount(failedWrite.id),1);
      assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts
        WHERE job_id=${failedWrite.id} ORDER BY number`),[
        {number:1,outcome:expectedIssue},{number:2,outcome:'succeeded'},
      ]);
    }finally{
      await sql.begin(async tx=>{
        await tx`DELETE FROM portable_notes WHERE job_id=${failedWrite.id}`;
        await tx`DELETE FROM portable_job_attempts WHERE job_id=${failedWrite.id}`;
        await tx`DELETE FROM portable_jobs WHERE id=${failedWrite.id}`;
      });
    }
  }

  const lostSession=payload('Fictional Note whose first processor session was lost');
  assert.equal((await write(headers,record,lostSession)).status,202);
  try{
    assert.equal(await launchFault(env,`
      const db=worker.portableDb(),transaction=db.transaction.bind(db);
      let calls=0;
      db.transaction=(...args)=>{
        // Recovery and claim finish on Postgres before the Note processor loses its session.
        if(++calls===3)throw new worker.PortableWorkerSessionLost();
        return transaction(...args);
      };
      process.send(await worker.runPortableJobPass(db,undefined,undefined,undefined,true));
    `),true);
    const {status:state,attempts,issue}=await status(lostSession.id);
    assert.deepEqual({state,attempts,issue},{state:'queued',attempts:1,issue:'lease_expired'});
    assert.equal(await noteCount(lostSession.id),0);
    assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${lostSession.id}`),
      [{number:1,outcome:'lease_expired'}]);
  }finally{
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_job_attempts WHERE job_id=${lostSession.id}`;
      await tx`DELETE FROM portable_jobs WHERE id=${lostSession.id}`;
    });
  }

  assert.equal((await list({},record)).status,401);
  assert.equal((await list(other,record)).status,404);
  assert.equal((await write(other,record,first)).status,404);
  assert.equal((await write(headers,record,first,'https://outside.example.test')).status,403);
  assert.equal((await write(headers,record,{...first,kind:'external'})).status,400);
  assert.equal((await write(headers,record,first)).status,202);
  assert.equal((await write(headers,record,first)).status,202);
  assert.equal((await write(headers,record,{...first,body:'Different note'})).status,409);
  const future=payload('Future note',Date.now()+600_000);
  assert.equal((await write(headers,record,future)).status,202);
  const overdue=await queue(2);
  assert.equal(overdue.oldestDueAt,0);
  assert.equal(overdue.overdue,true);
  const queuedWhileOff=await monitor(2,['--worker-off']);
  assert.equal(queuedWhileOff.worker.workerExpected,false);
  assert.equal(queuedWhileOff.worker.overdue,true);
  assert.equal(queuedWhileOff.worker.result,'attention');
  assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('overdue',1));
  assert.equal((await status(first.id)).attempts,0);
  const jobPage=async(id,auth=headers)=>{
    const response=await request('/?view=job-queue&jobId='+id,{headers:auth});
    return (await response.text()).replaceAll('<!-- -->','');
  };
  const issuePage=async(issue,auth=headers)=>(await request('/?view=job-queue&queue=issues&jobIssue='+issue,{headers:auth})).text();
  assert.ok((await issuePage('overdue')).includes(first.id));
  assert.ok(!(await issuePage('overdue',other)).includes(first.id));
  assert.ok(!(await issuePage('needs_review')).includes(first.id));
  const waiting=/Waiting since 1970-01-01 00:00 UTC/;
  assert.match(await jobPage(first.id),waiting);
  assert.doesNotMatch(await jobPage(first.id,other),waiting);
  assert.doesNotMatch(await jobPage(future.id),/Waiting since|Claim expired/);

  const claimed=await launchFault(env,`
    const job=await worker.claimPortableJob(worker.portableDb());
    process.send(job);
    setInterval(()=>{},1000);
  `);
  assert.equal(claimed.id,first.id);
  assert.equal(await noteCount(first.id),0);
  await one();
  assert.equal((await status(first.id)).status,'running');
  const running=(await (await list(headers,record)).json()).items.find(job=>job.id===first.id);
  assert.equal(running.finishedAt,null);
  assert.equal(running.receipts.length,1);
  assert.ok(Number.isFinite(running.receipts[0].startedAt));
  assert.deepEqual(running.receipts[0],{number:1,startedAt:running.receipts[0].startedAt,endedAt:null,outcome:null});
  assert.equal((await queue()).oldestDueAt,null);
  await expire(first.id);
  const expired=await queue(2);
  assert.equal(expired.oldestExpiredLeaseAt,0);
  assert.ok((await issuePage('expired_claim')).includes(first.id));
  assert.ok(!(await issuePage('overdue')).includes(first.id));
  assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('expired_claim',1));
  assert.match(await jobPage(first.id),/Claim expired 1970-01-01 00:00 UTC/);
  assert.doesNotMatch(await jobPage(first.id),waiting);
  assert.equal((await status(first.id)).status,'running');
  const stale=await launchFault(env,`
    process.send(await worker.finishNote(worker.portableDb(),${JSON.stringify(claimed)}));
    setInterval(()=>{},1000);
  `);
  assert.equal(stale,false);
  assert.equal(await noteCount(first.id),0);
  await one();
  const retry=await status(first.id);
  assert.equal(retry.status,'queued');
  assert.equal(retry.issue,'lease_expired');
  assert.ok(Number(retry.available_at)>Date.now());
  // Hold this real backoff state while exercising the CLI and authenticated pages.
  await sql`UPDATE portable_jobs SET available_at=${Date.now()+120_000} WHERE id=${first.id}`;
  const delayed=await queue(2);
  assert.equal(delayed.oldestDueAt,null);
  assert.equal(delayed.overdue,true);
  assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('overdue',1));
  assert.ok((await issuePage('overdue')).includes(first.id));
  assert.ok(!(await issuePage('overdue',other)).includes(first.id));
  const retryPage=await jobPage(first.id);
  assert.match(retryPage,waiting);
  assert.match(retryPage,/Next attempt /);
  assert.doesNotMatch(retryPage,/Claim expired/);
  await due(first.id);
  const completed=await launchFault(env,`
    const db=worker.portableDb(),job=await worker.claimPortableJob(db);
    process.send({id:job.id,success:await worker.finishNote(db,job)});
    setInterval(()=>{},1000);
  `);
  assert.deepEqual(completed,{id:first.id,success:true});
  await Promise.all([one(),one()]);
  assert.equal(await noteCount(first.id),1);
  assert.equal((await status(first.id)).attempts,2);
  assert.equal((await status(future.id)).attempts,0);
  assert.equal((await queue()).overdue,false);
  // The earlier stale backup fixture still raises overall attention.
  assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('overdue',0));
  assert.ok(!(await issuePage('overdue')).includes(first.id));
  assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${first.id} ORDER BY number`).map(row=>row.outcome),
    ['lease_expired','succeeded']);

  const quiet=payload('Quiet workspace note',1);
  const noisy=Array.from({length:6},(_,i)=>payload('Noisy workspace note '+i));
  for(const item of noisy)assert.equal((await write(headers,record,item)).status,202);
  assert.equal((await write(other,otherRecord,quiet)).status,202);
  await one();
  assert.equal(await noteCount(quiet.id),1);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes`)[0].count,2);
  const competingClaim=`
    const job=await worker.claimPortableJob(worker.portableDb());
    process.send(job?.id??null);
    setInterval(()=>{},1000);
  `;
  const competing=await Promise.all([launchFault(env,competingClaim),launchFault(env,competingClaim)]);
  assert.equal(competing.filter(Boolean).length,1);
  const interrupted=competing.find(Boolean);
  assert.ok(noisy.some(job=>job.id===interrupted));
  await expire(interrupted);
  await one();
  await due(interrupted);
  for(let i=0;i<noisy.length;i++)await one();
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes`)[0].count,8);

  const [owner]=await sql`SELECT workspace_id,actor_id FROM portable_jobs WHERE id=${first.id}`;
  const oldFailed=randomUUID(),oldFinished=Date.now()-2*3600_000;
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status,issue,attempts,finished_at)
    VALUES(${owner.workspace_id},${oldFailed},${record.id},${owner.actor_id},'note','Fictional old failure',0,0,0,'failed','processor_error',5,${oldFinished})`;
  try{
    const action={action:'reviewFailed',id:oldFailed,attempts:5};
    const warning=await queue(2);
    assert.equal(warning.latestFailureAt,null);
    assert.equal(warning.needsReview,true);
    assert.deepEqual(warning.review,{failed:true,uncertain:false,suppressedEmail:false});
    const failureQueue=await issuePage('failed');
    assert.match(failureQueue,/<option value="failed" selected="">Unreviewed failures<\/option>/);
    assert.ok(failureQueue.includes(oldFailed));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('failed',1));
    assert.ok(!(await issuePage('failed',other)).includes(oldFailed));
    assert.equal((await write(other,record,action)).status,404);
    assert.equal((await write(headers,record,{...action,attempts:4})).status,409);
    const reviews=await Promise.all([write(headers,record,action),write(headers,record,action)]);
    assert.ok(reviews.every(response=>response.status===200));
    const results=await Promise.all(reviews.map(response=>response.json()));
    assert.deepEqual(results.map(item=>item.result).sort(),['already','reviewed']);
    assert.equal((await queue()).needsReview,false);
    const [job]=await sql`SELECT status,issue,attempts,finished_at,operator_reviewed_by FROM portable_jobs WHERE id=${oldFailed}`;
    assert.deepEqual(job,{status:'failed',issue:'processor_error',attempts:5,finished_at:String(oldFinished),operator_reviewed_by:owner.actor_id});
    assert.ok(!(await issuePage('failed')).includes(oldFailed));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('failed',0));
    assert.equal(await noteCount(oldFailed),0);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${owner.workspace_id} AND id=${oldFailed}`;
  }
  const reviewedGmail=randomUUID();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status,issue,finished_at)
    VALUES(${owner.workspace_id},${reviewedGmail},${record.id},${owner.actor_id},'gmail','Fictional uncertain Gmail',0,0,0,'attention','external_outcome_unknown',0)`;
  try{
    assert.deepEqual((await queue(2)).review,{failed:false,uncertain:true,suppressedEmail:false});
    assert.ok((await issuePage('uncertain')).includes(reviewedGmail));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('uncertain',1));
    assert.ok(!(await issuePage('failed')).includes(reviewedGmail));
    assert.ok(!(await issuePage('uncertain',other)).includes(reviewedGmail));
    assert.equal((await write(headers,record,{action:'reviewGmail',id:reviewedGmail})).status,200);
    assert.ok(!(await issuePage('uncertain')).includes(reviewedGmail));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('uncertain',0));
    assert.equal((await queue()).needsReview,false);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${owner.workspace_id} AND id=${reviewedGmail}`;
  }
  const suppressed=randomUUID(),cancelledMail=randomUUID();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status,issue,finished_at)
    VALUES(${owner.workspace_id},${suppressed},${record.id},${owner.actor_id},'gmail','Fictional suppressed email',0,0,0,'skipped','email_recipient_suppressed',0),
    (${owner.workspace_id},${cancelledMail},${record.id},${owner.actor_id},'gmail','Fictional cancelledMail email',0,0,0,'skipped','email_cancelled',0)`;
  try{
    assert.equal((await queue(2)).needsReview,true);
    assert.deepEqual((await monitor(2,['--worker-off'])).worker.review,
      {failed:false,uncertain:false,suppressedEmail:true});
    const action={action:'reviewSuppressedGmail',id:suppressed,attempts:0};
    const skippedQueue=await issuePage('suppressed_email');
    assert.ok(skippedQueue.includes(suppressed));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('suppressed_email',1));
    assert.ok(!skippedQueue.includes(cancelledMail));
    assert.ok(!(await issuePage('suppressed_email',other)).includes(suppressed));
    assert.equal((await write(headers,record,{...action,id:cancelledMail})).status,409);
    assert.equal((await write(headers,record,action)).status,200);
    assert.equal((await queue()).needsReview,false);
    const reviewed=await monitor(2,['--worker-off']);
    assert.ok(!(await issuePage('suppressed_email')).includes(suppressed));
    const skippedPage='/?view=job-queue&queue=skipped&jobKind=gmail';
    const archive=await request(skippedPage,{headers});
    assert.equal(archive.status,200);
    const archived=await archive.text();
    assert.ok(archived.includes(suppressed));
    assert.ok(archived.includes(cancelledMail));
    assert.match(archived,/Recipient is on the do-not-email list/);
    assert.match(archived,/Email cancelled before sending/);
    const otherArchive=await request(skippedPage,{headers:other});
    assert.equal(otherArchive.status,200);
    const otherArchived=await otherArchive.text();
    assert.ok(!otherArchived.includes(suppressed));
    assert.ok(!otherArchived.includes(cancelledMail));
    const notesArchive=await request(skippedPage.replace('jobKind=gmail','jobKind=note'),{headers});
    assert.equal(notesArchive.status,200);
    const notesArchived=await notesArchive.text();
    assert.ok(!notesArchived.includes(suppressed));
    assert.ok(!notesArchived.includes(cancelledMail));
    assert.ok(!notesArchived.includes(future.id));
    assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('suppressed_email',0));
    assert.equal(reviewed.worker.needsReview,false);
    assert.deepEqual(reviewed.worker.review,{failed:false,uncertain:false,suppressedEmail:false});
    assert.equal(reviewed.worker.result,'ok');
    assert.equal(reviewed.backups.result,'attention');
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${owner.workspace_id} AND id IN (${suppressed},${cancelledMail})`;
  }
  const failedDispatch=randomUUID();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    VALUES(${owner.workspace_id},${failedDispatch},${record.id},${owner.actor_id},'external','Fictional failed dispatch',0,0,0)`;
  try{
    const {attempted,lines}=await launchFault(env,`
      const lines=[];
      console.error=message=>lines.push(message);
      const attempted=await worker.runPortableJobPass(worker.portableDb(),async()=>{
        throw new TypeError('private-dispatch-failure-fixture');
      });
      process.send({attempted,lines});
    `);
    assert.equal(attempted,true);
    assert.equal(lines.length,1);
    assert.deepEqual(JSON.parse(lines[0]),{
      event:workerJobError,phase:'process_claim',jobId:failedDispatch,kind:'external',attempt:1,
      errorName:'TypeError',errorMessage:'Worker operation failed.',
    });
    const {status:state,attempts,issue}=await status(failedDispatch);
    assert.deepEqual({state,attempts,issue},{state:'attention',attempts:1,issue:'external_outcome_unknown'});
  }finally{
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_job_attempts WHERE job_id=${failedDispatch}`;
      await tx`DELETE FROM portable_jobs WHERE id=${failedDispatch}`;
    });
  }
  const external=randomUUID();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    VALUES(${owner.workspace_id},${external},${record.id},${owner.actor_id},'external','Fictional external action',0,0,0)`;
  const dispatched=await launchFault(env,`
    await worker.runPortableJobPass(worker.portableDb(),async id=>{
      process.send(id);
      await new Promise(()=>{setInterval(()=>{},1000);});
      return true;
    });
  `);
  assert.equal(dispatched,owner.workspace_id+'/'+external);
  assert.equal((await status(external)).status,'dispatching');
  await expire(external);
  await Promise.all([one(),one()]);
  assert.equal((await status(external)).status,'attention');
  assert.equal((await status(external)).issue,'external_outcome_unknown');
  assert.equal((await status(external)).attempts,1);
  const attention=await queue(2);
  assert.equal(attention.needsReview,true);
  assert.ok((await issuePage('needs_review')).includes(external));
  assert.match(await monitor(2,['--prometheus','--worker-off']),workerIssue('needs_review',1));
  assert.equal(attention.oldestExpiredLeaseAt,null);
  const failedId=randomUUID(),finished=Date.now();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status,finished_at)
    VALUES(${owner.workspace_id},${failedId},${record.id},${owner.actor_id},'note','Failed note fixture',0,0,0,'failed',${finished})`;
  assert.equal((await queue(2)).latestFailureAt,finished);
  await sql`UPDATE portable_jobs SET finished_at=${finished-7200000} WHERE workspace_id=${owner.workspace_id} AND id=${failedId}`;
  assert.equal((await queue(2)).latestFailureAt,null);
  await sql`DELETE FROM portable_jobs WHERE workspace_id=${owner.workspace_id} AND id=${failedId}`;
  const timed=payload('Runs on the worker clock',Date.now()+2_000);
  assert.equal((await write(headers,record,timed)).status,202);
  const clock=spawn(process.execPath,[command,'worker'],{env,cwd,stdio:['ignore','ignore','inherit']});
  const clockExit=once(clock,'exit');
  try{
    await delay(250);
    assert.equal(await noteCount(timed.id),0);
    for(let poll=0;poll<50&&await noteCount(timed.id)===0;poll++)await delay(100);
    assert.equal(await noteCount(timed.id),1);
    assert.equal((await status(timed.id)).attempts,1);
  }finally{
    clock.kill('SIGTERM');
    assert.deepEqual(await clockExit,[0,null]);
  }
  const pending=Array.from({length:99},()=>randomUUID());
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,wait_for_lifecycle)
    SELECT ${owner.workspace_id}, id, ${record.id}, ${owner.actor_id}, 'note', 'Cap fixture', 0, 9999999999999, 0, 'Customer'
    FROM unnest(${pending}::uuid[]) AS id`;
  try{
    assert.equal((await write(headers,record,payload('Over capacity'))).status,429);
    assert.equal((await write(headers,record,future)).status,202);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${owner.workspace_id} AND id=ANY(${pending}::uuid[])`;
  }
  const history=await (await list(headers,record)).json();
  const completedJob=history.items.find(job=>job.id===first.id);
  assert.equal(completedJob.status,'succeeded');
  assert.ok(Number.isFinite(completedJob.completedAt)&&completedJob.completedAt<=completedJob.finishedAt);
  assert.deepEqual(completedJob.receipts.map(({number,outcome})=>[number,outcome]),[[1,'lease_expired'],[2,'succeeded']]);
  assert.ok(completedJob.receipts.every(receipt=>Number.isFinite(receipt.startedAt)&&receipt.endedAt>=receipt.startedAt));
  const uncertain=history.items.find(job=>job.id===external);
  assert.equal(uncertain.status,'attention');
  assert.equal(uncertain.completedAt,null);
  assert.equal(uncertain.receipts[0].outcome,'external_outcome_unknown');
  assert.equal(uncertain.receipts[0].endedAt,uncertain.finishedAt);
  const reviewExternal={action:'reviewExternal',id:external};
  assert.equal((await write(other,record,reviewExternal)).status,404);
  assert.equal((await write(headers,record,{action:'reviewGmail',id:external})).status,404);
  assert.equal((await write(headers,record,{action:'retryNote',id:external})).status,409);
  const detailsPath='/?view=job-queue&jobId='+external;
  assert.match(await (await request(detailsPath,{headers})).text(),/Check the result in the destination system/);
  const acknowledgements=await Promise.all([write(headers,record,reviewExternal),write(headers,record,reviewExternal)]);
  assert.deepEqual(acknowledgements.map(response=>response.status),[200,200]);
  assert.deepEqual((await Promise.all(acknowledgements.map(response=>response.json()))).map(item=>item.result).sort(),['already','reviewed']);
  assert.equal((await queue()).needsReview,false);
  assert.match(await (await request(detailsPath,{headers})).text(),/Outcome unconfirmed · reviewed/);
  await one();
  const reviewedExternal=(await (await list(headers,record)).json()).items.find(job=>job.id===external);
  assert.equal(reviewedExternal.status,'attention');
  assert.ok(reviewedExternal.operatorReviewedAt);
  assert.deepEqual(reviewedExternal.receipts,uncertain.receipts);
  assert.deepEqual(history.items.find(job=>job.id===future.id).receipts,[]);
  const cancel=(id,auth=headers,site=origin)=>write(auth,record,{action:'cancelNote',id},site);
  assert.equal((await cancel(future.id,other)).status,404);
  assert.equal((await cancel(future.id,headers,'https://outside.example.test')).status,403);
  assert.equal((await cancel(first.id)).status,409);
  assert.equal((await cancel(future.id)).status,200);
  assert.equal((await cancel(future.id)).status,200);
  assert.equal((await status(future.id)).issue,'note_cancelled');

  const stoppedNote=payload('Owner cancels a claimed Note');
  assert.equal((await write(headers,record,stoppedNote)).status,202);
  const stoppedClaim=await launchFault(env,`
    process.send(await worker.claimPortableJob(worker.portableDb()));
    setInterval(()=>{},1000);
  `);
  assert.equal(stoppedClaim.id,stoppedNote.id);
  assert.equal((await cancel(stoppedNote.id)).status,200);
  const stoppedFinish=await launchFault(env,`
    process.send(await worker.finishNote(worker.portableDb(),${JSON.stringify(stoppedClaim)}));
    setInterval(()=>{},1000);
  `);
  assert.equal(stoppedFinish,false);
  await one();
  const cancelled=(await (await list(headers,record)).json()).items.find(job=>job.id===stoppedNote.id);
  assert.equal(cancelled.status,'skipped');
  assert.equal(cancelled.issue,'note_cancelled');
  assert.equal(cancelled.receipts[0].outcome,'note_cancelled');
  assert.equal(cancelled.receipts[0].endedAt,cancelled.finishedAt);
  assert.equal(await noteCount(stoppedNote.id),0);
  assert.equal(await noteCount(future.id),0);

  // Signal the worker while expiry recovery is active, before a fresh claim.
  const expiring=payload('Interrupted before stop'),dueAfterStop=payload('Waiting for the replacement worker');
  assert.equal((await write(headers,record,expiring)).status,202);
  const expiringClaim=await launchFault(env,`
    process.send(await worker.claimPortableJob(worker.portableDb()));
    setInterval(()=>{},1000);
  `);
  assert.equal(expiringClaim.id,expiring.id);
  await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${expiring.id}`;
  assert.equal((await write(headers,record,dueAfterStop)).status,202);
  const stopGate=810683411;
  await sql.unsafe(`CREATE FUNCTION harbor_test_job_stop_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${stopGate}); RETURN NEW; END $$;
    CREATE TRIGGER harbor_test_job_stop_gate BEFORE UPDATE ON portable_jobs
    FOR EACH ROW WHEN (OLD.id='${expiring.id}' AND OLD.status='running')
    EXECUTE FUNCTION harbor_test_job_stop_gate()`).simple();
  let stopping,stoppedExit;
  try{
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${stopGate}::bigint)`;
      stopping=spawn(process.execPath,['--input-type=module','--eval',`
        import {runPortableWorker} from ${JSON.stringify(bundle)};
        process.once('SIGTERM',()=>process.send('signal received'));
        await runPortableWorker(false);
        process.disconnect();
      `],{env,cwd,stdio:['ignore','ignore','inherit','ipc']});
      stoppedExit=once(stopping,'close');
      // The worker cannot pass expiry recovery until this transaction releases the gate.
      let waiting=false;
      for(let poll=0;poll<30&&!waiting;poll++){
        [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND objid=${stopGate} AND NOT granted) AS waiting`;
        if(!waiting)await delay(100);
      }
      assert.ok(waiting,'Worker did not reach expiry recovery.');
      const acknowledged=once(stopping,'message',{signal:AbortSignal.timeout(1000)});
      stopping.kill('SIGTERM');
      const [message]=await acknowledged;
      assert.equal(message,'signal received');
    });
    assert.deepEqual(await Promise.race([stoppedExit,delay(6000,undefined,{ref:false})]),[0,null]);
    assert.equal((await status(expiring.id)).issue,'lease_expired');
    assert.equal((await status(dueAfterStop.id)).status,'queued');
    assert.equal((await status(dueAfterStop.id)).attempts,0);
    assert.equal(await noteCount(dueAfterStop.id),0);
    await one();
    assert.equal(await noteCount(dueAfterStop.id),1);
    assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${dueAfterStop.id}`),
      [{number:1,outcome:'succeeded'}]);
  }finally{
    if(stopping&&stopping.exitCode===null&&stopping.signalCode===null)stopping.kill('SIGKILL');
    await stoppedExit;
    await sql.unsafe('DROP TRIGGER harbor_test_job_stop_gate ON portable_jobs; DROP FUNCTION harbor_test_job_stop_gate()').simple();
    await sql.begin(async tx=>{
      const ids=[expiring.id,dueAfterStop.id];
      await tx`DELETE FROM portable_notes WHERE job_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_job_attempts WHERE job_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_jobs WHERE id=ANY(${ids}::uuid[])`;
    });
  }

  const restrictedNote=payload('Note-only worker restart');
  const [queuedTask,expiredMail]=[randomUUID(),randomUUID()];
  const [teammate]=await sql`SELECT workspace_id,actor_id FROM portable_jobs WHERE id=${quiet.id}`;
  try{
    assert.equal((await write(headers,record,restrictedNote)).status,202);
    await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status,lease_token,lease_until)
      VALUES(${teammate.workspace_id},${queuedTask},${otherRecord.id},${teammate.actor_id},'task','Held Task',0,0,0,'queued',NULL,NULL),
        (${owner.workspace_id},${expiredMail},${record.id},${owner.actor_id},'gmail','Held mail',0,0,0,'dispatching',${randomUUID()},0)`;
    const originalMail=await status(expiredMail);
    // An expired lease still fences its own workspace. Run the trial Note in the other workspace.
    const trialNote=payload('Restricted worker trial Note');
    const fingerprint=(await readFile(new URL('../.harbor/portable-build/release.sha256',import.meta.url),'utf8')).trim();
    async function withTrialWorker(verify){
      const worker=spawn(process.execPath,[command,'worker','--notes-only'],{
        env:{...env,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_WORKER_ENABLED:'true',HARBOR_PORTABLE_TASK_REPEAT_ENABLED:'true',
          HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_GMAIL_OWNER:'owner@example.test',HARBOR_LOGIN_ORIGIN:'https://harbor.example.test',
          HARBOR_PORTABLE_GMAIL_CLIENT_ID:'fixture-client',HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'fixture-secret',
          HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'fixture-refresh'},cwd,stdio:['ignore','pipe','pipe'],
      });
      const closed=once(worker,'close');
      let logs='',errors='';
      worker.stdout.on('data',chunk=>{logs+=chunk;});
      worker.stderr.on('data',chunk=>{errors+=chunk;});
      try{
        for(let poll=0;poll<60&&!logs.includes('\n')&&worker.exitCode===null;poll++)await delay(100);
        assert.ok(logs.includes('\n'),errors||'Notes-only worker did not report readiness.');
        assert.deepEqual(JSON.parse(logs),{event:'harbor_portable_worker_ready',buildFingerprint:fingerprint,mode:'notes-only',
          capabilities:{scheduledNotes:true,scheduledTasks:false,segmentScans:false,formNotes:false,
            overdueTaskRepeats:false,scheduledGmailConfigured:false,javascriptActions:false}});
        await verify();
      }finally{
        worker.kill('SIGTERM');
        const result=await Promise.race([closed,delay(6000,undefined,{ref:false})]);
        if(!result){worker.kill('SIGKILL');await closed;}
        assert.deepEqual(result,[0,null],errors);
      }
    }
    const [previousPoll]=await sql`SELECT last_poll_at,last_queue_poll_at,last_full_poll_at,last_gmail_poll_at
      FROM portable_worker_heartbeat WHERE id=1`;
    const pendingTasks='/?view=job-queue&queue=pending&jobKind=task';
    const taskQueue=async auth=>(await request(pendingTasks,{headers:auth})).text();
    const taskWarning=/Scheduled Tasks are due/;
    try{
      // Leave both capability polls fresh while letting the Notes-only worker advance the shared poll.
      const [{baseline}]=await sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8-20000 AS baseline`;
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=${baseline},last_queue_poll_at=${baseline},
        last_full_poll_at=${baseline},last_gmail_poll_at=${baseline-1} WHERE id=1`;
      await withTrialWorker(async()=>{
        const sharedPoll=await checkPoll(baseline);
        assert.equal(sharedPoll.newerPoll,true);
        assert.ok(sharedPoll.lastSuccessfulPollAt>baseline);
        for(const [capability,previous] of [['full',baseline],['gmail',baseline-1]]){
          const option='--expect-'+capability+'-worker';
          const unchanged=await checkPoll(previous,option);
          assert.equal(unchanged.code,2);
          assert.equal(unchanged.pollCapability,capability);
          assert.equal(unchanged.queuePoll,'fresh');
          assert.equal(unchanged.lastSuccessfulPollAt,previous);
          assert.equal(unchanged.newerPoll,false);
          assert.equal((await checkPoll(previous-1,option)).newerPoll,true);
        }
        await sql`UPDATE portable_worker_heartbeat SET last_full_poll_at=0 WHERE id=1`;
        assert.match(await taskQueue(other),/Worker reporting/);
        assert.match(await taskQueue(other),taskWarning);
        const waiting=await monitor(2,['--task-queue','--expect-full-worker']);
        assert.equal(waiting.worker.workerHeartbeat,'fresh');
        assert.deepEqual(waiting.taskQueue,{result:'attention',dueWithoutWorker:true});
        assert.deepEqual(waiting.fullWorker,{result:'attention',workerHeartbeat:'stale',expectedWorkerMissing:true});
        const waitingMetrics=await monitor(2,['--task-queue','--expect-full-worker','--prometheus']);
        assert.match(waitingMetrics,/^harbor_monitor_task_worker_missing 1$/m);
        assert.match(waitingMetrics,/^harbor_monitor_full_worker_missing 1$/m);
        assert.doesNotMatch(await taskQueue(headers),taskWarning);
        await sql`UPDATE portable_worker_heartbeat SET last_full_poll_at=
          floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
        assert.doesNotMatch(await taskQueue(other),taskWarning);
        assert.match(await monitor(2,['--task-queue','--prometheus']),/^harbor_monitor_task_worker_missing 0$/m);
        await sql`UPDATE portable_worker_heartbeat SET last_full_poll_at=0 WHERE id=1`;
        trialNote.scheduledFor=Date.now()+2_000;
        assert.equal((await write(other,otherRecord,trialNote)).status,202);
        assert.equal(await noteCount(trialNote.id),0);
        for(let poll=0;poll<60&&await noteCount(trialNote.id)===0;poll++)await delay(100);
        assert.equal(await noteCount(trialNote.id),1);
      });
      const receipt=()=>sql`SELECT number,started_at,ended_at,outcome FROM portable_job_attempts WHERE job_id=${trialNote.id}`;
      const completed=await receipt();
      assert.equal(completed.length,1);
      assert.equal(completed[0].outcome,'succeeded');
      assert.ok(Number(completed[0].started_at)>=trialNote.scheduledFor);
      assert.ok(Number(completed[0].ended_at)>=Number(completed[0].started_at));
      await withTrialWorker(async()=>{
        assert.equal(await noteCount(trialNote.id),1);
        assert.deepEqual(await receipt(),completed);
      });
      assert.equal((await status(trialNote.id)).attempts,1);
      assert.equal((await status(restrictedNote.id)).attempts,0);
      assert.equal((await status(queuedTask)).attempts,0);
      assert.equal((await sql`SELECT last_full_poll_at FROM portable_worker_heartbeat WHERE id=1`)[0].last_full_poll_at,'0');
      assert.deepEqual(await status(expiredMail),originalMail);
    }finally{
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=${previousPoll.last_poll_at},
        last_queue_poll_at=${previousPoll.last_queue_poll_at},last_full_poll_at=${previousPoll.last_full_poll_at},
        last_gmail_poll_at=${previousPoll.last_gmail_poll_at} WHERE id=1`;
      await sql`DELETE FROM portable_notes WHERE job_id=${trialNote.id}`;
      await sql`DELETE FROM portable_job_attempts WHERE job_id=${trialNote.id}`;
      await sql`DELETE FROM portable_jobs WHERE id=${trialNote.id}`;
    }
  }finally{
    await sql`DELETE FROM portable_jobs WHERE id IN (${queuedTask},${expiredMail},${restrictedNote.id})`;
  }

  const otherHistory=await (await list(other,otherRecord)).json();
  assert.deepEqual(otherHistory.items.map(job=>job.id),[quiet.id]);
  assert.deepEqual(otherHistory.items[0].receipts.map(receipt=>receipt.outcome),['succeeded']);
}


async function verifyTaskRepeatMonitor({monitor,sql,scope,request,headers,other}){
  const options=['--verify','--task-repeats'];
  const {workspace_id:workspaceId,owner_id:ownerId}=scope;
  const ids=[];
  const now=Date.now();
  const name='Fictional monitored Task repeat';
  async function seed(specs){
    const rows=specs.map(({offset,completed=false,repeating=true,archived=false})=>{
      const id=randomUUID();
      ids.push(id);
      return {id,workspace_id:workspaceId,revision:1,created_at:new Date(now),updated_at:new Date(now),
        completed_at:completed?new Date(now):null,archived_at:archived?new Date(now):null,
        data:sql.json({name,status:completed?'Completed':'Not started',
          ...(repeating?{repeat:{every:1,unit:'months',timeZone:'UTC'}}:{}),repeatDueAt:new Date(now+offset).toISOString()})};
    });
    await sql`INSERT INTO portable_tasks ${sql(rows)}`;
  }
  const queue=async(auth,view='issues')=>{
    const response=await request('/?view=job-queue&queue='+view,{headers:auth});
    assert.equal(response.status,200);
    return response.text();
  };
  const warning=/Repeating tasks are overdue/;
  try{
    assert.deepEqual((await monitor(0,options)).taskRepeats,{
      result:'ok',overdue:false,dueCount:0,truncated:false,oldestDueAgeSeconds:null,
    });
    const farPast=-24*60*60_000;
    await seed([{offset:farPast},{offset:60*60_000},{offset:farPast,completed:true},
      {offset:farPast,repeating:false},{offset:-30_000},{offset:farPast,archived:true}]);
    await sql`INSERT INTO portable_task_repeat_receipts(workspace_id,predecessor_id,successor_id,actor_id,created_at)
      VALUES(${workspaceId},${ids[0]},${ids[1]},${ownerId},statement_timestamp())`;
    const fresh=(await monitor(0,options)).taskRepeats;
    assert.deepEqual(fresh,{result:'ok',overdue:false,dueCount:1,truncated:false,oldestDueAgeSeconds:fresh.oldestDueAgeSeconds});
    assert.ok(fresh.oldestDueAgeSeconds>=30&&fresh.oldestDueAgeSeconds<300);
    assert.doesNotMatch(await queue(headers),warning);
    await seed([{offset:-6*60_000}]);
    const aged=(await monitor(2,options)).taskRepeats;
    assert.deepEqual(aged,{result:'attention',overdue:true,dueCount:2,truncated:false,oldestDueAgeSeconds:aged.oldestDueAgeSeconds});
    assert.ok(aged.oldestDueAgeSeconds>=360&&aged.oldestDueAgeSeconds<24*60*60,'the consumed occurrence does not age the backlog');
    const ownerQueue=await queue(headers);
    assert.match(ownerQueue,warning);
    assert.match(ownerQueue,/Worker reporting/);
    assert.match(ownerQueue,/href="\/\?kind=tasks">Open Tasks<\/a>/);
    assert.ok(!ownerQueue.includes(name));
    assert.match(await queue(headers,'pending'),warning);
    assert.doesNotMatch(await queue(other),warning);
    await seed(Array.from({length:50},()=>({offset:-30_000})));
    const readTasks=()=>sql`SELECT id,revision,data,completed_at FROM portable_tasks WHERE id=ANY(${ids}::uuid[]) ORDER BY id`;
    const before=await readTasks();
    const report=await monitor(2,options);
    const capped=report.taskRepeats;
    assert.deepEqual(capped,{result:'attention',overdue:true,dueCount:50,truncated:true,oldestDueAgeSeconds:capped.oldestDueAgeSeconds});
    assert.ok(capped.oldestDueAgeSeconds>=aged.oldestDueAgeSeconds);
    assert.ok(!JSON.stringify(report).includes(name));
    for(const id of ids)assert.ok(!JSON.stringify(report).includes(id));
    assert.deepEqual(await readTasks(),before);
    const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_task_repeat_receipts WHERE predecessor_id=ANY(${ids}::uuid[])`;
    assert.equal(count,1,'status reads never consume occurrences');
    assert.equal('taskRepeats' in await monitor(0,['--verify']),false);
  }finally{
    if(ids.length){
      await sql`DELETE FROM portable_task_repeat_receipts WHERE predecessor_id=ANY(${ids}::uuid[])`;
      await sql`DELETE FROM portable_tasks WHERE id=ANY(${ids}::uuid[])`;
    }
  }
  assert.doesNotMatch(await queue(headers),warning);
}

export async function verifyPortableSharedNotes({request,origin,headers,other,record,otherRecord,sql,env,sharing}){
  const own='/api/background-jobs?recordId='+record.id;
  const shared=own+'&workspaceId='+sharing.workspaceId;
  const list=async(path,auth)=>request(path,{headers:auth});
  const write=(path,auth,data)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(data)});
  const post=(grantId,data)=>write(shared+'&grantId='+grantId,other,data);
  const one=()=>execute(process.execPath,[command,'worker','--once'],{env,cwd,timeout:6_000});
  const note={id:randomUUID(),body:'Shared editor Note',scheduledFor:0};
  async function change(action,fields){
    const response=await write('/api/workspaces',headers,{action,id:sharing.grantId,...fields});
    assert.equal(response.status,200);
    sharing.grantId=(await response.json()).viewers[0].id;
  }
  assert.equal((await list(shared,{})).status,401);
  assert.equal((await list(shared,other)).status,404);
  assert.equal((await post(sharing.grantId,note)).status,404);
  const withoutNotes=sharing.grantId;
  assert.equal((await write('/api/workspaces',other,{action:'scheduled_notes',id:withoutNotes,enabled:true})).status,404);
  await change('scheduled_notes',{enabled:true});
  assert.equal((await post(withoutNotes,note)).status,403);
  assert.equal((await write(shared,other,note)).status,403);
  assert.equal((await write(shared+'&grantId='+sharing.grantId,other,{...note,kind:'external'})).status,400);
  const wrongContact=shared.replace(record.id,otherRecord.id);
  assert.equal((await list(wrongContact,other)).status,404);
  assert.equal((await write(wrongContact+'&grantId='+sharing.grantId,other,note)).status,404);

  await change('role',{role:'viewer'});
  const visible=await list(shared,other);
  assert.equal(visible.status,200);
  assert.equal(visible.headers.get('cache-control'),'private, no-store');
  const {items}=await visible.json();
  assert.ok(items.some(job=>job.kind==='note'));
  assert.ok(items.every(job=>job.kind==='note'));
  assert.ok((await (await list(own,headers)).json()).items.some(job=>job.kind==='external'));
  assert.equal((await post(sharing.grantId,note)).status,403);
  await change('role',{role:'editor'});
  assert.equal((await post(sharing.grantId,note)).status,202);
  assert.equal((await post(sharing.grantId,note)).status,202);
  assert.equal((await write(own,headers,note)).status,409);

  const denied={...note,id:randomUUID()};
  let racingRequest;
  await sql.begin(async tx=>{
    await tx`UPDATE portable_workspace_viewers SET scheduled_notes=false WHERE id=${sharing.grantId}`;
    racingRequest=post(sharing.grantId,denied);
    let waiting=false;
    for(let i=0;i<80&&!waiting;i++){
      const [row]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%portable_workspace_viewers%' AND query LIKE '%for share%') AS waiting`;
      waiting=row.waiting;
      if(!waiting)await delay(25);
    }
    assert.ok(waiting,'Note admission should wait for the sharing change');
  });
  assert.equal((await racingRequest).status,403);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE id=${denied.id}`)[0].count,0);
  assert.equal((await list(shared,other)).status,404);
  await one();
  await one();
  const [completed]=await sql`SELECT j.status,j.attempts,a.email AS author,o.email AS owner
    FROM portable_jobs j JOIN login_identities a ON a.id=j.actor_id
    JOIN login_identities o ON o.id=j.authorized_owner_id WHERE j.id=${note.id}`;
  assert.deepEqual({...completed},{status:'succeeded',attempts:1,author:'other@example.test',owner:'owner@example.test'});
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${note.id}`)[0].count,1);

  await change('scheduled_notes',{enabled:true});
  const future={...note,id:randomUUID(),body:'Shared Note recovered on target',scheduledFor:Date.now()+600_000};
  assert.equal((await post(sharing.grantId,future)).status,202);
  sharing.queuedNoteId=future.id;
  const toCancel={...future,id:randomUUID(),body:'Accepted editor Note later cancelled by owner'};
  assert.equal((await post(sharing.grantId,toCancel)).status,202);
  const cancel={action:'cancelNote',id:toCancel.id};
  assert.equal((await post(sharing.grantId,cancel)).status,403);
  assert.equal((await write(own,headers,cancel)).status,200);
  sharing.cancelledNoteId=toCancel.id;
}
