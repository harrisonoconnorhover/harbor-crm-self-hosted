import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {portableBackupMaxAgeHours,portableMode,portableDatabaseUrl,portableStorageEndpoint,portableWebAddress} from '../runtime/portable-config.mjs';

const path=file=>fileURLToPath(new URL(file,import.meta.url));

function backupFreeSpace(value=process.env.HARBOR_BACKUP_MIN_FREE_MIB||undefined){
  if(value===undefined)return 0;
  const minFreeMiB=Number(value);
  if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(minFreeMiB)){
    throw Error('Choose a positive whole number of MiB for --min-free-mib or HARBOR_BACKUP_MIN_FREE_MIB.');
  }
  return minFreeMiB;
}

function backupCheckOptions(args,monitor=false){
  const options={verify:{type:'boolean'},'max-age-hours':{type:'string'},'verify-timeout-seconds':{type:'string'},
    'min-free-mib':{type:'string'}};
  if(monitor){
    options['expect-backup-service']={type:'boolean'};
    options['expect-build']={type:'string'};
    options['prometheus-file']={type:'string'};
    for(const flag of ['calendar','web','segments','form-notes','inquiry-follow-up','workflow-capacity','task-repeats','task-queue','gmail-queue','expect-gmail-worker','expect-full-worker','worker-off','prometheus']){
      options[flag]={type:'boolean'};
    }
  }else{
    options.day={type:'string'};
    options.list={type:'boolean'};
  }
  const {values,tokens}=parseArgs({args,options,tokens:true});
  if(new Set(tokens.map(token=>token.name)).size!==tokens.length)throw Error('Supply each backup check option at most once.');
  if(values.list&&tokens.length!==1)throw Error('Use --list by itself to list recovery points.');
  const day=values.day;
  if(day!==undefined){
    const date=new Date(day+'T00:00:00.000Z');
    if(!values.verify||values['max-age-hours']!==undefined||!/^\d{4}-\d{2}-\d{2}$/.test(day)||
      !Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day){
      throw Error('Supply a UTC date (YYYY-MM-DD) with --verify, without --max-age-hours.');
    }
  }
  const raw=values['max-age-hours'];
  const maxAgeHours=raw===undefined?portableBackupMaxAgeHours:Number(raw);
  if(raw!==undefined&&(!/^[1-9][0-9]*$/.test(raw)||maxAgeHours>portableBackupMaxAgeHours)){
    throw Error('Choose a whole number of hours from 1 to '+portableBackupMaxAgeHours+' for --max-age-hours.');
  }
  const rawTimeout=values['verify-timeout-seconds'];
  const verifyTimeout=rawTimeout===undefined?300:Number(rawTimeout);
  if(rawTimeout!==undefined&&(!values.verify||!/^[1-9][0-9]*$/.test(rawTimeout)||verifyTimeout>3600)){
    throw Error('With --verify, choose a whole number of seconds from 1 to 3600 for --verify-timeout-seconds.');
  }
  // Recovery point lookup and verification still work during a low-space incident.
  const floor=values['min-free-mib'];
  const minFreeMiB=values.list||(day&&floor===undefined)?0:backupFreeSpace(floor);
  return {values,maxAgeHours,minFreeMiB,timeoutMs:values.verify?verifyTimeout*1000:8000};
}

function exitAfterFailure(){
  process.exitCode=1;
  // A dead peer may never close its TCP read half after the client ends it.
  setTimeout(()=>process.exit(1),1_000).unref();
}

function monitorMetrics(sections){
  const lines=[
    '# HELP harbor_monitor_checked_at_seconds Unix time when the Harbor monitor finished.',
    '# TYPE harbor_monitor_checked_at_seconds gauge',
    'harbor_monitor_checked_at_seconds '+Math.floor(Date.now()/1000),
    '# HELP harbor_monitor_section_status Current status of each enabled Harbor check.',
    '# TYPE harbor_monitor_section_status gauge',
  ];
  for(const [section,{result}] of Object.entries(sections)){
    const current=result==='fresh'||result==='verified'?'ok':result;
    for(const status of ['ok','attention','unavailable']){
      lines.push(`harbor_monitor_section_status{section="${section}",status="${status}"} ${Number(current===status)}`);
    }
  }
  const {issue:backupIssue,captureStartedAt}=sections.backups??{};
  if(Number.isFinite(captureStartedAt)){
    lines.push('# HELP harbor_monitor_backup_capture_started_at_seconds Unix time when the healthy backup capture began.',
      '# TYPE harbor_monitor_backup_capture_started_at_seconds gauge',
      'harbor_monitor_backup_capture_started_at_seconds '+Math.floor(captureStartedAt/1000));
  }
  if(['backup_missing','backup_stale','capture_failed','integrity_failed','invalid_bundle','incompatible_migrations',
    'source_mismatch','source_unverified','invalid_directory','low_free_space','check_timed_out',
    'backup_service_not_reporting','backup_service_poll_failed'].includes(backupIssue)){
    lines.push('# HELP harbor_monitor_backup_issue Current backup issue reported by Harbor.',
      '# TYPE harbor_monitor_backup_issue gauge',
      `harbor_monitor_backup_issue{issue="${backupIssue}"} 1`);
  }
  const webIssue=sections.web?.reason;
  if(['invalid_origin','build_mismatch','not_ready','unexpected_response','unreachable'].includes(webIssue)){
    lines.push('# HELP harbor_monitor_web_issue Current issue reported by the web readiness check.',
      '# TYPE harbor_monitor_web_issue gauge',
      `harbor_monitor_web_issue{issue="${webIssue}"} 1`);
  }
  const segments=sections.segments;
  if(segments&&segments.result!=='unavailable'){
    lines.push('# HELP harbor_monitor_segment_scan_overdue Whether an enabled segment workflow check is overdue.',
      '# TYPE harbor_monitor_segment_scan_overdue gauge',
      'harbor_monitor_segment_scan_overdue '+Number(segments.overdue));
  }
  const taskQueue=sections.taskQueue;
  if(taskQueue&&taskQueue.result!=='unavailable'){
    lines.push('# HELP harbor_monitor_task_worker_missing Whether a due scheduled Task has no recent full worker poll.',
      '# TYPE harbor_monitor_task_worker_missing gauge',
      'harbor_monitor_task_worker_missing '+Number(taskQueue.dueWithoutWorker));
  }
  const fullWorker=sections.fullWorker;
  if(fullWorker&&fullWorker.result!=='unavailable'){
    lines.push('# HELP harbor_monitor_full_worker_missing Whether the expected full worker has no recent valid poll.',
      '# TYPE harbor_monitor_full_worker_missing gauge',
      'harbor_monitor_full_worker_missing '+Number(fullWorker.expectedWorkerMissing));
  }
  const gmailQueue=sections.gmailQueue;
  if(gmailQueue&&gmailQueue.result!=='unavailable'){
    lines.push('# HELP harbor_monitor_gmail_reconnect_required Whether a scheduled Gmail failure needs reconnect review.',
      '# TYPE harbor_monitor_gmail_reconnect_required gauge',
      'harbor_monitor_gmail_reconnect_required '+Number(gmailQueue.reconnectNeedsReview),
      '# HELP harbor_monitor_gmail_worker_missing Whether scheduled Gmail needs a worker poll.',
      '# TYPE harbor_monitor_gmail_worker_missing gauge',
      'harbor_monitor_gmail_worker_missing '+Number(gmailQueue.dueWithoutWorker||gmailQueue.expectedWorkerMissing===true));
  }
  const worker=sections.worker;
  if(worker&&worker.result!=='unavailable'){
    lines.push('# HELP harbor_monitor_worker_issue Current worker issues reported by Harbor.',
      '# TYPE harbor_monitor_worker_issue gauge');
    const issues={
      heartbeat:worker.workerExpected&&worker.workerHeartbeat!=='fresh',
      poll_stalled:worker.workerExpected&&worker.workerHeartbeat==='fresh'&&worker.queuePoll!=='fresh',
      overdue:worker.overdue,
      expired_claim:worker.oldestExpiredLeaseAt!==null,
      needs_review:worker.needsReview,
      failed:worker.review.failed,
      uncertain:worker.review.uncertain,
      suppressed_email:worker.review.suppressedEmail,
    };
    for(const [issue,active] of Object.entries(issues)){
      lines.push(`harbor_monitor_worker_issue{issue="${issue}"} ${Number(active)}`);
    }
  }
  return lines.join('\n');
}

function monitorMetricsFile(value){
  if(value!==undefined&&(!isAbsolute(value)||!value.endsWith('.prom'))){
    throw Error('Supply an absolute .prom path for --prometheus-file.');
  }
  return value;
}

async function publishMonitorMetrics(destination,metrics){
  const staged=join(dirname(destination),'.harbor-monitor-'+randomUUID());
  try{
    const file=await open(staged,'wx',0o644);
    try{
      try{await file.writeFile(metrics+'\n');}
      finally{await file.close();}
      await rename(staged,destination);
    }finally{
      await unlink(staged).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    return true;
  }catch{
    console.error('Could not publish Harbor monitor metrics. Check the collector directory permissions and free space.');
    return false;
  }
}

class BackupStatusTimeout extends Error {
  constructor(verify){
    super(verify?'Backup verification did not finish before its deadline.':
      'Backup storage did not respond before the routine check deadline.');
  }
}

function boundedBackupStatus(directory,maxAgeHours,RecoveryFailure,{verify,timeoutMs,online,minFreeMiB,day,list,expectBackupService}){
  // An in-process deadline cannot release a thread blocked on a mounted file.
  const child=fork(path('./portable-web.mjs'),
    ['_backup-status',directory,String(maxAgeHours),list?'list':verify?'verify':'sample',online?'online':'offline',String(minFreeMiB),day??'',String(!!expectBackupService)],
    {execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      reject(new BackupStatusTimeout(verify));
      child.kill('SIGKILL');
      if(child.connected)child.disconnect();
      child.unref();
    },timeoutMs);
    const fail=()=>{
      clearTimeout(timer);
      reject(Error('Backup status could not be read.'));
    };
    child.once('error',fail);
    child.once('disconnect',fail);
    child.once('message',message=>{
      clearTimeout(timer);
      if(message.status==='ok')resolve(message.value);
      else if(message.status==='attention')reject(new RecoveryFailure(message.reason,message.issue));
      else fail();
      // A completed reply can still leave a half-open Postgres socket behind.
      child.kill('SIGKILL');
      if(child.connected)child.disconnect();
      child.unref();
    });
  });
}

function archiveVerificationTimeout(value='900'){
  const seconds=Number(value);
  if(!/^[1-9][0-9]*$/.test(value)||seconds>3600){
    throw Error('Choose a whole number of seconds from 1 to 3600 for --verify-timeout-seconds.');
  }
  return seconds*1000;
}

function stopArchiveReader(pid){
  if(pid===undefined)return;
  // The isolated group can also contain pg_restore, which may be reading the same mount.
  try{process.kill(-pid,'SIGKILL');}
  catch(error){if(error.code!=='ESRCH')throw error;}
}

function boundedArchiveDoctor(profile,directory,timeoutMs){
  const child=fork(path('./portable-web.mjs'),['_doctor-archive',profile,directory],
    {detached:true,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  return new Promise(resolve=>{
    let settled=false;
    const failure=archive=>({profile,result:'needs_setup',checks:{restoreTool:'ok',archive}});
    const finish=report=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      stopArchiveReader(child.pid);
      if(child.connected)child.disconnect();
      child.unref();
      resolve(report);
    };
    const timer=setTimeout(()=>finish(failure('timed_out')),timeoutMs);
    const unavailable=()=>finish(failure('unavailable'));
    child.once('error',unavailable);
    child.once('disconnect',unavailable);
    child.once('message',finish);
  });
}

function expectedWebBuild(value,includeWeb){
  if(value!==undefined&&(!includeWeb||!/^[a-f0-9]{64}$/.test(value))){
    throw Error('Supply a 64-character release fingerprint with --expect-build on web-status or monitor-status --web.');
  }
  return value;
}

async function packagedBuildFingerprint(){
  try{
    const value=(await readFile(path('../.harbor/portable-build/release.sha256'),'utf8')).trim();
    if(/^[a-f0-9]{64}$/.test(value))return value;
  }catch{}
  throw Error('Could not read the packaged Harbor build fingerprint.');
}

const [command,...extra]=process.argv.slice(2);
const mode=['doctor','_doctor-archive','release-info','google-grant'].includes(command)?null:portableMode(process.env);
const url=['_backup-status','backup-status','backup-service','worker-status','monitor-status','web-status',
  'gmail-reconcile','doctor','_doctor-archive','release-info','google-grant'].includes(command)?null:portableDatabaseUrl(process.env,mode);
if(command==='google-grant'){
  const [provider,destination]=extra;
  if(extra.length!==2||!['gmail','calendar'].includes(provider)||!isAbsolute(destination)){
    throw Error('Use google-grant gmail or google-grant calendar followed by an absolute new grant file path.');
  }
  const {preparePortableGoogleGrant,GoogleGrantPreparationError}=await import('../.harbor/portable-build/worker/google-grant.mjs');
  try{
    await preparePortableGoogleGrant(provider,destination);
    console.log('Grant verified and saved in the private file.');
  }catch(error){
    console.error(error instanceof GoogleGrantPreparationError?error.message:'The local Google grant could not be completed.');
    process.exitCode=1;
  }
}else if(command==='release-info'&&!extra.length){
  try{
    const {readPortableMigrations}=await import('../runtime/portable-migrations.mjs');
    const buildFingerprint=await packagedBuildFingerprint();
    const migrations=readPortableMigrations(path('../db/postgres/migrations'));
    const ledgerSha256=createHash('sha256').update(JSON.stringify(migrations.map(entry=>[entry.folderMillis,entry.hash]))).digest('hex');
    console.log(JSON.stringify({event:'harbor_portable_release',buildFingerprint,migrations:{count:migrations.length,ledgerSha256}}));
  }catch{
    throw Error('Could not read the packaged Harbor release fingerprint or migrations.');
  }
}else if(command==='_backup-status'&&process.send){
  const [directory,maxAge,depth,online,minFree,day,expectBackupService]=extra;
  const abandon=()=>process.kill(process.pid,'SIGKILL');
  process.once('disconnect',abandon);
  const {RecoveryFailure,portableBackupStatus,listPortableRecoveryPoints}=await import('../.harbor/portable-build/worker/recovery.mjs');
  let message;
  try{
    const database=online==='online'?()=>portableDatabaseUrl(process.env,mode):undefined;
    message={status:'ok',value:depth==='list'?await listPortableRecoveryPoints(directory):
      await portableBackupStatus(directory,depth==='verify',database,Number(maxAge),Number(minFree),day||undefined,expectBackupService==='true')};
  }catch(error){
    message=error instanceof RecoveryFailure?{status:'attention',reason:error.message,issue:error.issue}:{status:'unavailable'};
  }
  process.removeListener('disconnect',abandon);
  if(process.connected)process.send(message);
}else if(command==='_doctor-archive'&&process.send){
  const [profile,directory]=extra;
  process.once('disconnect',()=>stopArchiveReader(process.pid));
  const {portableRestoreArchiveStatus,portableBundleArchiveReport}=await import('../.harbor/portable-build/worker/recovery.mjs');
  const report=profile==='bundle'?await portableBundleArchiveReport(directory):
    {checks:{archive:await portableRestoreArchiveStatus(directory)}};
  if(process.connected)process.send(report);
}else if(command==='doctor'&&extra[0]==='bundle'){
  const [,directory,...args]=extra;
  if(!directory||!isAbsolute(directory))throw Error('Supply one absolute private bundle path.');
  const {values,tokens}=parseArgs({args,options:{'verify-timeout-seconds':{type:'string'}},tokens:true});
  if(tokens.length>1)throw Error('Supply --verify-timeout-seconds at most once.');
  const timeoutMs=archiveVerificationTimeout(values['verify-timeout-seconds']);
  const {checkPostgresTool}=await import('../.harbor/portable-build/worker/recovery.mjs');
  const restoreTool=await checkPostgresTool('pg_restore');
  const report=restoreTool==='ok'?await boundedArchiveDoctor('bundle',directory,timeoutMs):
    {profile:'bundle',result:'needs_setup',checks:{restoreTool,archive:'restore_tool_unavailable'}};
  console.log(JSON.stringify(report,null,2));
  if(report.result!=='verified')exitAfterFailure();
}else if(command==='doctor'&&extra[0]==='restore'){
  const {values,tokens}=parseArgs({args:extra.slice(1),options:{bundle:{type:'string'},'verify-timeout-seconds':{type:'string'}},tokens:true});
  const directory=values.bundle;
  if(new Set(tokens.map(token=>token.name)).size!==tokens.length||directory!==undefined&&!isAbsolute(directory)){
    throw Error('Supply one absolute private bundle path with --bundle and at most one --verify-timeout-seconds option.');
  }
  if(directory===undefined&&values['verify-timeout-seconds']!==undefined)throw Error('Use --verify-timeout-seconds with --bundle.');
  const timeoutMs=archiveVerificationTimeout(values['verify-timeout-seconds']);
  const {portableRestorePreflight}=await import('../.harbor/portable-build/worker/recovery.mjs');
  const restoreMode=portableMode(process.env);
  const checkArchive=directory?async()=>(await boundedArchiveDoctor('restore',directory,timeoutMs)).checks.archive:undefined;
  const report=await portableRestorePreflight(()=>portableDatabaseUrl(process.env,restoreMode),checkArchive);
  console.log(JSON.stringify(report,null,2));
  if(report.result!=='ready')exitAfterFailure();
}else if(command==='doctor'&&extra[0]==='backup'){
  if(extra.length!==2)throw Error('Supply one absolute private backup directory.');
  const {portableBackupPreflight}=await import('../.harbor/portable-build/worker/recovery.mjs');
  const backupMode=portableMode(process.env);
  const deadline=setTimeout(()=>{
    process.stdout.write(JSON.stringify({profile:'backup',result:'needs_setup',checks:{preflight:'timed_out'}})+'\n',()=>process.exit(1));
  },25_000);
  try{
    const report=await portableBackupPreflight(extra[1],()=>portableDatabaseUrl(process.env,backupMode),backupMode);
    console.log(JSON.stringify(report,null,2));
    if(report.result!=='ready'&&report.result!=='ready_for_file_test')exitAfterFailure();
  }finally{clearTimeout(deadline);}
}else if(command==='doctor'){
  const [profile,...options]=extra;
  if(!['web','worker'].includes(profile)){
    throw Error('Choose doctor web, doctor worker, doctor backup <backup directory>, doctor bundle <backup bundle>, or doctor restore.');
  }
  const {values}=parseArgs({args:options,options:profile==='web'?
    {'before-google':{type:'boolean'},'check-google':{type:'boolean'},'check-calendar':{type:'boolean'},'check-inbox':{type:'boolean'},
      'check-file-privacy':{type:'string'},'check-workspace-access':{type:'boolean'}}:
    {'check-gmail':{type:'boolean'},'expect-web-origin':{type:'string'},'check-tasks':{type:'boolean'},'check-segments':{type:'boolean'}}});
  if(values['expect-web-origin']!==undefined&&!values['check-gmail']){
    throw Error('Use --expect-web-origin with doctor worker --check-gmail.');
  }
  const privateFile=values['check-file-privacy'];
  const uuid='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
  const fileKey=new RegExp('^contact-files(?:/'+uuid+'){4}$','i');
  if(privateFile!==undefined&&(!fileKey.test(privateFile)||privateFile.trim()!==privateFile)){
    throw Error('Provide the storage key of a nonempty fictional Contact attachment.');
  }
  const {portableDoctor}=await import('../.harbor/portable-build/worker/health.mjs');
  const report=await portableDoctor(profile,{beforeGoogle:values['before-google'],checkGoogle:values['check-google'],checkGmail:values['check-gmail'],
    checkCalendar:values['check-calendar'],checkTasks:values['check-tasks'],checkSegments:values['check-segments'],
    checkInbox:values['check-inbox'],checkWorkspaceAccess:values['check-workspace-access'],privateFile,expectedWebOrigin:values['expect-web-origin']});
  console.log(JSON.stringify(report,null,2));
  if(report.result!=='ready'&&report.result!=='ready_for_google_setup')exitAfterFailure();
}else if(command==='backup-service'||command==='backup-tick'||command==='backup-status'){
  const [directory,...options]=extra,statusOnly=command==='backup-status';
  if(!directory||directory.startsWith('--'))throw Error('Supply one private backup directory.');
  const statusOptions=statusOnly?backupCheckOptions(options):undefined;
  const captureOptions=statusOnly?undefined:parseArgs({args:options,options:{'min-free-mib':{type:'string'}},tokens:true});
  if(captureOptions&&captureOptions.tokens.length>1)throw Error('Supply --min-free-mib at most once.');
  const minFreeMiB=statusOptions?.minFreeMiB??backupFreeSpace(captureOptions?.values['min-free-mib']);
  if(command!=='backup-status'&&process.env.HARBOR_PORTABLE_BACKUP_ENABLED!=='true'){
    throw Error('Scheduled Harbor backups require HARBOR_PORTABLE_BACKUP_ENABLED=true.');
  }
  const {RecoveryFailure,runPortableBackupTick,recordBackupServicePoll}=await import('../.harbor/portable-build/worker/recovery.mjs');
  async function checkBackup(){
    try{
      const result=statusOptions?
        await boundedBackupStatus(directory,statusOptions.maxAgeHours,RecoveryFailure,{
          verify:statusOptions.values.verify,day:statusOptions.values.day,list:statusOptions.values.list,timeoutMs:statusOptions.timeoutMs,minFreeMiB,
        }):
        await runPortableBackupTick(url??portableDatabaseUrl(process.env,mode),directory,minFreeMiB);
      if(command==='backup-service'&&result.result!=='busy')await recordBackupServicePoll(directory,'succeeded');
      console.log(JSON.stringify({event:'harbor_portable_backup',...result}));
      return result.result;
    }catch(error){
      const timedOut=error instanceof BackupStatusTimeout;
      const reason=error instanceof RecoveryFailure||timedOut?error.message:'Check the backup destination and storage connectivity.';
      const issue=error instanceof RecoveryFailure?error.issue:timedOut?'check_timed_out':undefined;
      if(command==='backup-service'){
        try{await recordBackupServicePoll(directory,'failed');}
        catch{
          console.error(JSON.stringify({event:'harbor_portable_backup_poll_marker_failed',
            reason:'Could not save the failed backup service poll. Check the backup volume.'}));
        }
      }
      console.error(JSON.stringify({event:'harbor_portable_backup',result:'failed',reason,issue}));
      return 'failed';
    }
  }
  if(command==='backup-service'){
    const stop=new AbortController(),interrupt=()=>stop.abort();
    process.once('SIGTERM',interrupt);
    process.once('SIGINT',interrupt);
    try{
      while(!stop.signal.aborted){
        const result=await checkBackup();
        const interval=result==='failed'||result==='busy'?5*60_000:60*60_000;
        await delay(interval,undefined,{signal:stop.signal}).catch(error=>{
          if(!stop.signal.aborted)throw error;
        });
      }
    }finally{
      process.removeListener('SIGTERM',interrupt);
      process.removeListener('SIGINT',interrupt);
    }
  }else if(await checkBackup()==='failed'){
    process.exitCode=1;
  }
}else if(command==='backup'||command==='restore'){
  if(mode==='hosted'){
    const restoring=command==='restore';
    if(restoring&&process.env.HARBOR_PORTABLE_RESTORE_ENABLED!=='true'){
      throw Error('Hosted restore requires HARBOR_PORTABLE_RESTORE_ENABLED=true.');
    }
    const [directory,option,database,bucket]=extra;
    const scope=restoring?'--target':'--source';
    if(extra.length!==4||!directory||option!==scope||!database||!bucket){
      throw Error('Hosted '+command+' requires a backup directory and '+scope+' <database name> <bucket name>.');
    }
    let databaseName;
    try{databaseName=decodeURIComponent(url.pathname.slice(1));}catch{}
    if(database!==databaseName||bucket!==process.env.HARBOR_S3_BUCKET){
      throw Error((restoring?'Restore target':'Backup source')+' names do not match the configured database and bucket.');
    }
    portableStorageEndpoint(process.env,mode);
    if(!restoring&&!isAbsolute(directory))throw Error('Use an absolute private backup path for hosted capture.');
  }else if(extra.length!==1||!extra[0]){
    throw Error('Local backup and restore take one backup directory.');
  }
  const {RecoveryFailure,runPortableRecovery}=await import('../.harbor/portable-build/worker/recovery.mjs');
  try{
    const {versions,held}=await runPortableRecovery(command,url,extra[0],mode);
    console.log(command+' complete. Verified file versions: '+versions+'.');
    if(held)console.log('External jobs held for review: '+held+'.');
  }catch(error){
    // Fixed recovery messages can be shown. Provider errors and file paths may contain credentials or private names.
    throw Error(error instanceof RecoveryFailure?error.message:'Portable '+command+' failed. Check the backup path and storage configuration.');
  }
}else if(command==='worker-status'){
  const {values,tokens}=parseArgs({args:extra,options:{'expect-worker':{type:'boolean'},'expect-full-worker':{type:'boolean'},
    'expect-gmail-worker':{type:'boolean'},'poll-after':{type:'string'}},tokens:true});
  if(new Set(tokens.map(token=>token.name)).size!==tokens.length)throw Error('Supply each worker status option at most once.');
  const expectations={'expect-worker':'queue','expect-full-worker':'full','expect-gmail-worker':'gmail'};
  const selected=Object.keys(expectations).filter(option=>values[option]);
  if(selected.length>1)throw Error('Choose one worker expectation.');
  const capability=expectations[selected[0]]??'queue';
  const after=values['poll-after'];
  const pollAfter=after===undefined?undefined:Number(after);
  if(after!==undefined&&(!/^\d+$/.test(after)||!Number.isSafeInteger(pollAfter))){
    throw Error('Supply a Unix millisecond timestamp with --poll-after.');
  }
  try{
    const {checkPortableQueue}=await import('../.harbor/portable-build/worker/worker.mjs');
    const status=await checkPortableQueue(portableDatabaseUrl(process.env,mode),selected.length>0||pollAfter!==undefined,capability);
    const newerPoll=pollAfter===undefined?undefined:
      status.workerHeartbeat==='fresh'&&status.queuePoll==='fresh'&&status.lastSuccessfulPollAt>pollAfter;
    const result=newerPoll===false?'attention':status.result;
    console.log(JSON.stringify({event:'harbor_portable_queue',...status,result,
      ...(capability==='queue'?{}:{pollCapability:capability}),
      ...(pollAfter===undefined?{}:{pollAfter,newerPoll})}));
    if(result==='attention')process.exitCode=2;
  }catch{
    console.error(JSON.stringify({event:'harbor_portable_queue',result:'unavailable'}));
    exitAfterFailure();
  }
}else if(command==='web-status'){
  const {values,tokens}=parseArgs({args:extra,options:{'expect-build':{type:'string'},'prometheus-file':{type:'string'}},tokens:true});
  if(new Set(tokens.map(token=>token.name)).size!==tokens.length)throw Error('Supply each web status option at most once.');
  const metricsFile=monitorMetricsFile(values['prometheus-file']);
  const expectedBuild=expectedWebBuild(values['expect-build'],true);
  const {checkPortableWeb}=await import('../.harbor/portable-build/worker/worker.mjs');
  const status=await checkPortableWeb(process.env.HARBOR_MONITOR_WEB_ORIGIN,mode,expectedBuild);
  const published=metricsFile===undefined||await publishMonitorMetrics(metricsFile,monitorMetrics({web:status}));
  console.log(JSON.stringify({event:'harbor_portable_web',...status}));
  if(!published||status.result==='unavailable')process.exitCode=1;
  else if(status.result==='attention')process.exitCode=2;
}else if(command==='monitor-status'){
  const [directory,...options]=extra;
  if(!directory)throw Error('Supply one private backup directory.');
  const {values,maxAgeHours,minFreeMiB,timeoutMs}=backupCheckOptions(options,true);
  const metricsFile=monitorMetricsFile(values['prometheus-file']);
  const {verify,calendar:includeCalendar,web:includeWeb,segments:includeSegments,'form-notes':includeFormNotes,'inquiry-follow-up':includeInquiryFollowUp,'workflow-capacity':includeWorkflowCapacity,
    'task-repeats':includeTaskRepeats,'task-queue':includeTaskQueue,'gmail-queue':includeGmailQueue,'expect-gmail-worker':expectGmailWorker,
    'expect-full-worker':expectFullWorker,'worker-off':workerOff}=values;
  if(expectGmailWorker&&workerOff)throw Error('Choose --expect-gmail-worker or --worker-off.');
  if(expectFullWorker&&workerOff)throw Error('Choose --expect-full-worker or --worker-off.');
  const requestedBuild=values['expect-build'];
  const expectedBuild=includeWeb&&requestedBuild==='packaged'?await packagedBuildFingerprint():expectedWebBuild(requestedBuild,includeWeb);
  const [{checkPortableQueue,checkPortableCalendarReceipts,checkPortableWeb,checkPortableSegmentScans,checkPortableFormNotes,checkPortableInquiryFollowUp,checkPortableWorkflowCapacity,checkPortableTaskRepeats,checkPortableGmailQueue,checkPortableTaskQueue,checkPortableFullWorker},{RecoveryFailure}]=await Promise.all([
    import('../.harbor/portable-build/worker/worker.mjs'),import('../.harbor/portable-build/worker/recovery.mjs'),
  ]);
  const database=()=>portableDatabaseUrl(process.env,mode);
  const [queue,backup,calendarStatus,webStatus,segmentStatus,formNoteStatus,taskRepeatStatus,gmailQueueStatus,inquiryStatus,taskQueueStatus,fullWorkerStatus,workflowCapacityStatus]=await Promise.allSettled([
    Promise.resolve().then(()=>checkPortableQueue(database(),!workerOff)),
    boundedBackupStatus(directory,maxAgeHours,RecoveryFailure,{verify,timeoutMs,online:true,minFreeMiB,
      expectBackupService:values['expect-backup-service']}),
    includeCalendar?Promise.resolve().then(()=>checkPortableCalendarReceipts(database())):undefined,
    includeWeb?checkPortableWeb(process.env.HARBOR_MONITOR_WEB_ORIGIN,mode,expectedBuild):undefined,
    includeSegments?Promise.resolve().then(()=>checkPortableSegmentScans(database())):undefined,
    includeFormNotes?Promise.resolve().then(()=>checkPortableFormNotes(database())):undefined,
    includeTaskRepeats?Promise.resolve().then(()=>checkPortableTaskRepeats(database())):undefined,
    includeGmailQueue||expectGmailWorker?Promise.resolve().then(()=>checkPortableGmailQueue(database(),expectGmailWorker)):undefined,
    includeInquiryFollowUp?Promise.resolve().then(()=>checkPortableInquiryFollowUp(database())):undefined,
    includeTaskQueue?Promise.resolve().then(()=>checkPortableTaskQueue(database())):undefined,
    expectFullWorker?Promise.resolve().then(()=>checkPortableFullWorker(database())):undefined,
    includeWorkflowCapacity?Promise.resolve().then(()=>checkPortableWorkflowCapacity(database())):undefined,
  ]);
  const worker=queue.status==='fulfilled'?queue.value:{result:'unavailable'};
  const backups=backup.status==='fulfilled'?backup.value:
    backup.reason instanceof RecoveryFailure?{result:'attention',reason:backup.reason.message,issue:backup.reason.issue}:
    backup.reason instanceof BackupStatusTimeout?{result:'unavailable',reason:backup.reason.message,issue:'check_timed_out'}:{result:'unavailable'};
  const calendar=calendarStatus.status==='fulfilled'?calendarStatus.value:{result:'unavailable'};
  const web=webStatus.status==='fulfilled'?webStatus.value:{result:'unavailable'};
  const segments=segmentStatus.status==='fulfilled'?segmentStatus.value:{result:'unavailable'};
  const formNotes=formNoteStatus.status==='fulfilled'?formNoteStatus.value:{result:'unavailable'};
  const taskRepeats=taskRepeatStatus.status==='fulfilled'?taskRepeatStatus.value:{result:'unavailable'};
  const gmailQueue=gmailQueueStatus.status==='fulfilled'?gmailQueueStatus.value:{result:'unavailable'};
  const taskQueue=taskQueueStatus.status==='fulfilled'?taskQueueStatus.value:{result:'unavailable'};
  const inquiryFollowUp=inquiryStatus.status==='fulfilled'?inquiryStatus.value:{result:'unavailable'};
  const fullWorker=fullWorkerStatus.status==='fulfilled'?fullWorkerStatus.value:{result:'unavailable'};
  const workflowCapacity=workflowCapacityStatus.status==='fulfilled'?workflowCapacityStatus.value:{result:'unavailable'};
  const sections={worker,backups,...(workflowCapacity?{workflowCapacity}:{}),...(calendar?{calendar}:{}),...(web?{web}:{}),...(segments?{segments}:{}),...(formNotes?{formNotes}:{}),
    ...(inquiryFollowUp?{inquiryFollowUp}:{}),...(taskRepeats?{taskRepeats}:{}),...(taskQueue?{taskQueue}:{}),...(gmailQueue?{gmailQueue}:{}),...(fullWorker?{fullWorker}:{})};
  const unavailable=Object.values(sections).some(section=>section.result==='unavailable');
  const attention=Object.values(sections).some(section=>section.result==='attention');
  const result=unavailable?'unavailable':attention?'attention':'ok';
  let publishFailed=false;
  if(values.prometheus||metricsFile!==undefined){
    const metrics=monitorMetrics(sections);
    if(values.prometheus)console.log(metrics);
    if(metricsFile!==undefined)publishFailed=!await publishMonitorMetrics(metricsFile,metrics);
  }
  if(!values.prometheus)console.log(JSON.stringify({event:'harbor_portable_monitor',result,...sections}));
  if(unavailable||publishFailed)exitAfterFailure();
  else if(attention)process.exitCode=2;
}else if(command==='gmail-reconcile'&&extra.length===2){
  try{
    portableDatabaseUrl(process.env,mode);
    const {reconcilePortableGmail}=await import('../.harbor/portable-build/worker/worker.mjs');
    const result=await reconcilePortableGmail(extra[0],extra[1]);
    console.log(JSON.stringify({event:'harbor_portable_gmail_reconciliation',result}));
    if(result!=='confirmed')process.exitCode=result==='unconfirmed'?2:1;
  }catch{
    console.error(JSON.stringify({event:'harbor_portable_gmail_reconciliation',result:'unavailable'}));
    process.exitCode=1;
  }
}else if(!['migrate','start','worker'].includes(command)||(extra.length&&command!=='worker')){
  throw Error('Expected release-info, doctor web [--before-google] [--check-google] [--check-calendar] [--check-inbox] [--check-file-privacy KEY] [--check-workspace-access], doctor worker [--check-gmail [--expect-web-origin ORIGIN]] [--check-tasks] [--check-segments], doctor restore [--bundle DIRECTORY], migrate, start, worker [--once] [--notes-only], worker-status [--expect-worker | --expect-full-worker | --expect-gmail-worker] [--poll-after UNIX_MS], web-status [--expect-build FINGERPRINT] [--prometheus-file /ABSOLUTE/FILE.prom], backup <backup directory> [--source DATABASE BUCKET], backup-service <backup directory>, monitor-status <backup directory> [--verify [--verify-timeout-seconds N]] [--calendar] [--web [--expect-build FINGERPRINT|packaged]] [--segments] [--form-notes] [--inquiry-follow-up] [--workflow-capacity] [--task-repeats] [--task-queue] [--expect-full-worker] [--gmail-queue] [--worker-off], or gmail-reconcile <workspace ID> <job ID>.');
}else if(command==='migrate'){
  const {default:postgres}=await import('postgres');
  const {applyPortableMigrations,readPortableMigrations}=await import('../runtime/portable-migrations.mjs');
  const client=postgres(url.href,{max:1,connect_timeout:5,onnotice:()=>{}});
  let status;
  try{status=await applyPortableMigrations(client,readPortableMigrations(path('../db/postgres/migrations')));}
  catch{throw Error('Could not apply portable Harbor Postgres migrations. Check the database and migration files.');}
  finally{await client.end({timeout:3});}
  const issues={
    maintenance_in_progress:'A Harbor worker, migration or restore holds the database lock. Stop workers before an upgrade and retry.',
    migration_history_mismatch:'Harbor migration history differs from this release. Check the release and database before retrying.',
    newer_release_required:'This database requires a newer Harbor release.',
    unsupported_database_version:'Use PostgreSQL 18 or newer for portable Harbor.',
    unsupported_database_encoding:'Use a UTF-8 PostgreSQL database for portable Harbor.',
  };
  if(status!=='ok')throw Error(issues[status]??'Could not confirm the Harbor migration history.');
  console.log('Portable Harbor Postgres migrations applied.');
}else if(command==='worker'){
  const {values,tokens}=parseArgs({args:extra,options:{once:{type:'boolean'},'notes-only':{type:'boolean'}},tokens:true});
  if(new Set(tokens.map(token=>token.name)).size!==tokens.length)throw Error('Supply each worker option at most once.');
  const once=values.once===true,notesOnly=values['notes-only']===true;
  if(mode==='hosted'&&process.env.HARBOR_PORTABLE_WORKER_ENABLED!=='true'){
    throw Error('Hosted Harbor worker activation requires HARBOR_PORTABLE_WORKER_ENABLED=true.');
  }
  const {PortableWorkerSessionLost,runPortableWorker}=await import('../.harbor/portable-build/worker/worker.mjs');
  const buildFingerprint=once?null:await packagedBuildFingerprint();
  const reportReady=buildFingerprint?capabilities=>console.log(JSON.stringify({
    event:'harbor_portable_worker_ready',buildFingerprint,...(notesOnly?{mode:'notes-only'}:{}),capabilities,
  })):undefined;
  try{await runPortableWorker(once,reportReady,notesOnly);}
  catch(error){
    if(!(error instanceof PortableWorkerSessionLost))throw error;
    console.error(error.message);
    exitAfterFailure();
  }
}else{
  const {origin,port,host}=portableWebAddress(process.env,mode);
  process.env.VINEXT_TRUST_PROXY=mode==='hosted'?'1':'0';
  process.env.VINEXT_TRUSTED_HOSTS=mode==='hosted'?origin.host:'';
  if(mode==='hosted'){
    portableStorageEndpoint(process.env,mode);
    const {validateHostedWebStorage}=await import('../.harbor/portable-build/worker/health.mjs');
    validateHostedWebStorage();
  }
  const {startProdServer}=await import('../.harbor/portable-build/worker/prod-server.mjs');
  await startProdServer({port,host,outDir:path('../.harbor/portable-build'),rscEntryPath:path('../runtime/portable-web.mjs')});
}
