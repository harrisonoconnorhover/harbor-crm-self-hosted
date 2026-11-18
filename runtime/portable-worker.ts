import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {beginExternalDispatch,claimPortableJob,finishExternalDispatch,finishNote,jobClock,portableQueueStatus,recoverExpiredJob,
  portableFullWorkerStatus,portableGmailQueueStatus,portableTaskQueueStatus,rejectUnavailableAction,retryUnstartedJob,heartbeatIntervalMs,recordPortableWorkerHeartbeat,
  type WorkerPollCapability} from '../db/postgres/job-store';
import {scanPortableSegmentWorkflow} from '../db/postgres/portable-segment-workflow-store';
import {promotePortableFormNote} from '../db/postgres/lead-form-note-worker-store';
import {portableSegmentScanStatus} from '../db/postgres/portable-segment-scan-status';
import {portableFormNoteStatus,portableInquiryFollowUpStatus} from '../db/postgres/lead-form-note-status';
import {portableCalendarReceiptStatus} from '../db/postgres/portable-meeting-store';
import {advanceOverduePortableTask} from '../db/postgres/task-repeat-store';
import {finishTask} from '../db/postgres/task-job-store';
import {portableTaskRepeatStatus} from '../db/postgres/task-repeat-status';
import {portableWorkflowCapacityStatus} from '../db/postgres/workflow-capacity-status';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableDatabaseUrl,portableMaintenanceLock,portableMode,portableWebAddress} from './portable-config.mjs';
import {portableMigrationHistory,readPortableMigrations} from './portable-migrations.mjs';
import {runPortableGmailJob} from './portable-gmail-worker';
import {portableGmailConfig} from './portable-gmail-config';
import {portableCodeAvailable} from './portable-code-config';
import {portableDb} from './portable-db';
import {readPortableDatabaseStatus} from './portable-database-status';

type Dispatch=(actionId:string)=>Promise<boolean>;
type Deadline=<T>(operation:()=>Promise<T>,milliseconds:number)=>Promise<T>;
const databaseDeadlineMs=5_000;
const internalActionDeadlineMs=10_000;
// The plain Gmail job can make three provider requests, each capped at 15 seconds.
const gmailActionDeadlineMs=60_000;

function workerCapabilities(notesOnly:boolean){
  return {
    scheduledNotes:true,
    scheduledTasks:!notesOnly,
    segmentScans:!notesOnly,
    formNotes:!notesOnly,
    overdueTaskRepeats:!notesOnly&&process.env.HARBOR_PORTABLE_TASK_REPEAT_ENABLED==='true',
    scheduledGmailConfigured:!notesOnly&&!!portableGmailConfig(),
    javascriptActions:!notesOnly&&portableCodeAvailable(),
  };
}

export class PortableWorkerSessionLost extends Error {
  constructor(){
    super('Portable worker stopped after losing its database session.');
    this.name='PortableWorkerSessionLost';
  }
}

const databaseConnectionErrors=new Set([
  'CONNECTION_CLOSED','CONNECTION_ENDED','CONNECTION_DESTROYED','CONNECT_TIMEOUT',
  'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE',
]);
const standardErrorNames=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','AggregateError']);

function describeWorkerError(error:unknown){
  // SQL wrappers include bound values, and provider errors can contain customer data.
  for(let depth=0,cause=error;depth<5&&cause instanceof Error;depth++,cause=cause.cause){
    if(cause instanceof PortableWorkerSessionLost){
      return {errorName:cause.name,errorMessage:cause.message,leaseLost:true};
    }
    if(cause.name==='TimeoutError'){
      return {errorName:'TimeoutError',errorMessage:'Worker operation timed out.',leaseLost:true};
    }
    const code='code' in cause?cause.code:undefined;
    if(typeof code!=='string')continue;
    if(cause.name==='PostgresError'&&/^[0-9A-Z]{5}$/.test(code)){
      return {errorName:'PostgresError',errorMessage:'PostgreSQL error '+code+'.',
        leaseLost:code==='57014'||code.startsWith('08')};
    }
    if(databaseConnectionErrors.has(code)){
      return {errorName:'DatabaseConnectionError',errorMessage:'Database connection error '+code+'.',leaseLost:true};
    }
  }
  const errorName=error instanceof Error&&standardErrorNames.has(error.name)?error.name:'Error';
  return {errorName,errorMessage:'Worker operation failed.',leaseLost:false};
}

export const checkPortableQueue=(url:URL,expectWorker=false,capability?:WorkerPollCapability)=>
  readPortableDatabaseStatus(url,client=>portableQueueStatus(drizzle(client),expectWorker,capability));
export const checkPortableFullWorker=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableFullWorkerStatus(drizzle(client)));
export const checkPortableTaskQueue=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableTaskQueueStatus(drizzle(client)));
export const checkPortableGmailQueue=(url:URL,expectGmailWorker=false)=>
  readPortableDatabaseStatus(url,client=>portableGmailQueueStatus(drizzle(client),expectGmailWorker));
export const checkPortableCalendarReceipts=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableCalendarReceiptStatus(drizzle(client)));
export const checkPortableSegmentScans=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableSegmentScanStatus(drizzle(client)));
export const checkPortableInquiryFollowUp=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableInquiryFollowUpStatus(drizzle(client)));
export const checkPortableWorkflowCapacity=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableWorkflowCapacityStatus(drizzle(client)));
export const checkPortableFormNotes=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableFormNoteStatus(drizzle(client)));
export const checkPortableTaskRepeats=(url:URL)=>
  readPortableDatabaseStatus(url,client=>portableTaskRepeatStatus(drizzle(client)));

export async function checkPortableWeb(configuredOrigin:string|undefined,mode:'local'|'hosted',expectedBuild?:string){
  let origin:URL;
  try{
    const parsed=URL.parse(configuredOrigin??'');
    ({origin}=portableWebAddress({HARBOR_LOGIN_ORIGIN:configuredOrigin,PORT:parsed?.port||undefined},mode));
  }catch{return {result:'unavailable',reason:'invalid_origin'};}
  try{
    const response=await fetch(new URL('/healthz',origin),{
      redirect:'manual',signal:AbortSignal.timeout(2500),cache:'no-store',credentials:'omit',
      headers:{accept:'text/plain'},
    });
    const noStore=response.headers.get('cache-control')?.split(',').some(value=>value.trim().toLowerCase()==='no-store');
    const privateReply=!response.headers.has('set-cookie')&&!response.headers.has('location');
    if(response.status===200&&noStore&&(!expectedBuild||privateReply)&&response.headers.get('content-type')?.split(';')[0].trim()==='text/plain'){
      if(await readBoundedRequestText(response,5)==='ready'){
        if(expectedBuild&&response.headers.get('x-harbor-build-fingerprint')!==expectedBuild){
          return {result:'attention',reason:'build_mismatch'};
        }
        return {result:'ok'};
      }
    }else{
      void response.body?.cancel().catch(()=>{});
    }
    return {result:'attention',reason:response.status===503?'not_ready':'unexpected_response'};
  }catch{return {result:'attention',reason:'unreachable'};}
}

export async function runPortableJobPass(db:ReturnType<typeof portableDb>,dispatch?:Dispatch,within:Deadline=operation=>operation(),
  signal?:AbortSignal,notesOnly=false,capabilities=workerCapabilities(notesOnly),onPoll?:(at:number)=>void){
  if(signal?.aborted)return false;
  const {recovered,startedAt,job}=await within(async()=>{
    const {recovered,startedAt}=await recoverExpiredJob(db,notesOnly);
    const job=signal?.aborted?null:await claimPortableJob(db,{notesOnly,code:capabilities.javascriptActions,gmail:capabilities.scheduledGmailConfigured});
    return {recovered,startedAt,job};
  },databaseDeadlineMs);
  if(!job){
    if(!signal?.aborted)onPoll?.(startedAt);
    return recovered;
  }
  let failureReported=false,passEnded=false;
  const reportFailure=(error:unknown)=>{
    const {errorName,errorMessage,leaseLost}=describeWorkerError(error);
    if(!failureReported){
      failureReported=true;
      console.error(JSON.stringify({event:'harbor_portable_worker_job_error',phase:'process_claim',
        jobId:job.id,kind:job.kind,attempt:job.attempts,errorName,errorMessage}));
    }
    return leaseLost?'lease_expired':'processor_error';
  };
  try{
    await within(async()=>{
      try{
        if(job.kind==='note'){
          await finishNote(db,job);
        }else if(job.kind==='task'){
          await finishTask(db,job);
        }else if(job.kind==='gmail'){
          await runPortableGmailJob(db,job,signal);
        }else if(job.kind==='code'){
          const {runPortableCodeJob}=await import('./portable-code-worker');
          await runPortableCodeJob(db,job,new URL('./code-sandbox.mjs',import.meta.url));
        }else if(!dispatch){
          await rejectUnavailableAction(db,job);
        }else if(await beginExternalDispatch(db,job)){
          let confirmed=false;
          try{confirmed=await dispatch(job.workspaceId+'/'+job.id);}
          catch(error){reportFailure(error);}
          await finishExternalDispatch(db,job,confirmed);
        }
      }catch(error){
        // A replacement worker recovers expired claims after session loss.
        if(passEnded||signal?.reason instanceof PortableWorkerSessionLost)throw error;
        // This only changes a still-live running claim. Dispatching work is never retried here.
        await retryUnstartedJob(db,job,reportFailure(error));
      }
    },job.kind==='gmail'?gmailActionDeadlineMs:internalActionDeadlineMs);
  }catch(error){
    reportFailure(signal?.reason instanceof PortableWorkerSessionLost?signal.reason:error);
    throw error;
  }finally{passEnded=true;}
  if(onPoll&&!signal?.aborted){
    // Use the job connection after the receipt commits. A heartbeat alone cannot advance progress.
    const completedAt=await within(()=>jobClock(db),databaseDeadlineMs);
    if(!signal?.aborted)onPoll(completedAt);
  }
  return true;
}

export async function runPortableWorker(once:boolean,onFirstPoll?:(capabilities:ReturnType<typeof workerCapabilities>)=>void,notesOnly=false){
  const stop=new AbortController();
  const interrupt=()=>stop.abort();
  const url=portableDatabaseUrl(process.env,portableMode(process.env));
  const capabilities=workerCapabilities(notesOnly);
  let closing=false,connectionLost=false;
  const loseConnection=()=>{
    connectionLost=true;
    stop.abort(new PortableWorkerSessionLost());
  };
  const client=postgres(url.href,{max:1,connect_timeout:3,idle_timeout:0,max_lifetime:0,onclose(){
    if(closing)return;
    loseConnection();
    void client.end({timeout:0}).catch(()=>{});
  }});
  const within:Deadline=async(operation,milliseconds)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      // A server-side query timeout cannot deliver a reply over a blackholed socket.
      const deadline=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          loseConnection();
          reject(new PortableWorkerSessionLost());
        },milliseconds);
      });
      return await Promise.race([operation(),deadline]);
    }finally{clearTimeout(timer);}
  };
  process.once('SIGTERM',interrupt);
  process.once('SIGINT',interrupt);
  let heartbeat:Promise<void>|undefined;
  let reportFirstPoll=onFirstPoll;
  try{
    const migrations=readPortableMigrations(fileURLToPath(new URL('../../../db/postgres/migrations',import.meta.url)));
    const state=await within(async()=>{
      try{
        const [{locked}]=await client`SELECT pg_try_advisory_lock_shared(${portableMaintenanceLock}) AS locked`;
        return locked?(await portableMigrationHistory(client,migrations)).status:'maintenance_in_progress';
      }catch{return 'unavailable';}
    },databaseDeadlineMs);
    if(connectionLost)throw new PortableWorkerSessionLost();
    if(state!=='ok')throw Error('Portable worker could not start ('+state+'). Check doctor worker and database maintenance.');
    const db=drizzle(client);
    let completedPollAt:number|null=null;
    const firstPass=Promise.withResolvers<void>();
    const recordPoll=(at:number)=>{
      completedPollAt=at;
      firstPass.resolve();
    };
    if(!once)heartbeat=(async()=>{
      await Promise.race([firstPass.promise,delay(1_000,undefined,{signal:stop.signal}).catch(()=>{})]);
      while(!stop.signal.aborted){
        const queuePollAt:number|null=completedPollAt;
        completedPollAt=null;
        try{
          // Health gets its own bounded connection. Capability timestamps still report job polling.
          await readPortableDatabaseStatus(url,health=>recordPortableWorkerHeartbeat(drizzle(health),{
            queuePollAt,full:capabilities.scheduledTasks,gmailConfigured:capabilities.scheduledGmailConfigured,
          }));
          if(queuePollAt!==null&&!stop.signal.aborted){
            reportFirstPoll?.(capabilities);
            reportFirstPoll=undefined;
          }
        }catch(error){
          completedPollAt??=queuePollAt;
          if(!stop.signal.aborted){
            const {errorName,errorMessage}=describeWorkerError(error);
            console.error(JSON.stringify({event:'harbor_portable_worker_heartbeat_failed',errorName,errorMessage}));
          }
        }
        await delay(heartbeatIntervalMs,undefined,{signal:stop.signal}).catch(()=>{});
      }
    })();
    while(!stop.signal.aborted){
      try{
        if(capabilities.segmentScans){
          // A full or failed segment scan never takes the ordinary job pass.
          try{
            const scan=await within(()=>scanPortableSegmentWorkflow(db),databaseDeadlineMs);
            if(scan==='retry')console.error('Portable segment workflow scan failed. Retry scheduled.');
          }
          catch{if(!connectionLost)console.error('Portable segment workflow scan unavailable.');}
          if(stop.signal.aborted)break;
          try{
            const form=await within(()=>promotePortableFormNote(db),databaseDeadlineMs);
            if(form==='retry')console.error('Portable form Note promotion failed. Retry scheduled.');
          }catch{if(!connectionLost)console.error('Portable form Note promotion unavailable.');}
          if(stop.signal.aborted)break;
          if(capabilities.overdueTaskRepeats){
            try{await within(()=>advanceOverduePortableTask(db),databaseDeadlineMs);}
            catch{if(!connectionLost)console.error('Portable overdue Task repeat unavailable.');}
          }
        }
        if(stop.signal.aborted)break;
        await runPortableJobPass(db,undefined,within,stop.signal,notesOnly,capabilities,once?undefined:recordPoll);
      }catch{
        if(once&&!connectionLost)throw Error('Portable worker could not reach its job store.');
        if(!connectionLost)console.error('Portable worker job store unavailable.');
      }
      if(once)break;
      if(!stop.signal.aborted)await delay(1_000,undefined,{signal:stop.signal}).catch(()=>{});
    }
    if(connectionLost)throw new PortableWorkerSessionLost();
  }finally{
    closing=true;
    stop.abort();
    process.removeListener('SIGTERM',interrupt);
    process.removeListener('SIGINT',interrupt);
    await Promise.all([client.end({timeout:connectionLost?0:5}),heartbeat]);
  }
}

export {claimPortableJob,finishNote,finishTask,portableDb};
export {reconcilePortableGmail} from './portable-gmail-worker';
