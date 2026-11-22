import {and,asc,count,desc,eq,exists,gt,isNull,lte,ne,notExists,or,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {leadFormAutomationNote} from '../../lib/portable-lead-forms';
import {ownedRecordScope} from './record-ownership-scope';
import {lockRecordWorkspace} from './private-workspace-store';
import {contactEvents,privateWorkspaces,contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {loginIdentities} from './identity-schema';
import {portableSegmentMatch} from './portable-segment-match';
import {leadFormActivations,leadForms,leadFormNoteSources,leadInquiries} from './lead-form-schema';
import {scheduledGmail} from './scheduled-gmail-schema';
import {emailSuppressions} from './email-suppression-schema';
import {workflowWebhookJobs} from './workflow-schema';
import {portableTasks} from './task-schema';
import {admitNextPathStep} from './workflow-path-step-store';
import {queueNextManualNote,sequenceJobExists} from './manual-workflow-action-store';
import {portableJobs as jobs,portableJobAttempts as attempts,portableNotes as notes,portableWorkerHeartbeat as heartbeat,type JobState} from './job-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Job=typeof jobs.$inferSelect;
export type Claim=Job&{leaseToken:string;workflowWebhook?:typeof workflowWebhookJobs.$inferSelect};
type Scope={workspaceId:string;contactId:string};
type NoteInput={id:string;body:string;scheduledFor:number};
type JobReview={action:'reviewGmail'|'reviewExternal';id:string}|{action:'reviewFailed'|'reviewSuppressedGmail';id:string;attempts:number};
const attemptLimit=5;
const active=sql`${jobs.status} IN ('running','dispatching')`;
const queued=sql`${jobs.status}='queued'`;
export const runnableQueuedJob=sql`${queued} AND ${jobs.waitForLifecycle} IS NULL`;
export const gmailReauthorizationIssue='gmail_reauthorization_required';
export const gmailSuppressedIssue='email_recipient_suppressed';
const unreviewed=isNull(jobs.operatorReviewedAt);
export const jobReviewFilters={
  failed:and(unreviewed,eq(jobs.status,'failed'))!,
  uncertain:and(unreviewed,eq(jobs.status,'attention'))!,
  suppressed_email:and(unreviewed,eq(jobs.status,'skipped'),eq(jobs.kind,'gmail'),eq(jobs.issue,gmailSuppressedIssue))!,
};
export const jobNeedsReview=or(...Object.values(jobReviewFilters))!;
const key=(job:Pick<Job,'id'|'workspaceId'>)=>and(eq(jobs.workspaceId,job.workspaceId),eq(jobs.id,job.id));
const owner=(workspaceId:string,actorId:string)=>and(eq(privateWorkspaces.id,workspaceId),eq(privateWorkspaces.ownerId,actorId));
const databaseTime=sql<number>`floor(extract(epoch from clock_timestamp())*1000)::float8`;
export async function jobClock(db:Db){
  const [row]=await db.select({at:databaseTime}).from(sql`(select 1) as clock`);
  return row.at;
}

const jobOverdueMs=5*60_000;
// Automatic backoff changes eligibility without restarting the overdue clock.
export const jobOverdueAt=(at:SQL)=>sql<boolean>`${runnableQueuedJob} AND
  coalesce(${jobs.operatorRetryAt},${jobs.scheduledFor})<=${at}-${jobOverdueMs}`;
export const heartbeatIntervalMs=15_000;
const heartbeatStaleMs=60_000;
// A full worker can spend 60s on Gmail, plus bounded database checks and heartbeat publication.
const workerPollStaleMs=150_000;
function workerTimestampState(timestamp:number|null,at:number,staleMs:number):'missing'|'invalid'|'stale'|'fresh'{
  if(timestamp===null)return 'missing';
  if(!Number.isSafeInteger(timestamp)||timestamp<0||timestamp>at)return 'invalid';
  return at-timestamp>=staleMs?'stale':'fresh';
}
export const workerHeartbeatState=(timestamp:number|null,at:number)=>workerTimestampState(timestamp,at,heartbeatStaleMs);
export const workerPollState=(timestamp:number|null,at:number)=>workerTimestampState(timestamp,at,workerPollStaleMs);

export async function recordPortableWorkerHeartbeat(db:Db,{queuePollAt,full,gmailConfigured}:{
  queuePollAt:number|null;full:boolean;gmailConfigured:boolean;
}){
  // A limited worker must neither erase nor refresh a poll for a capability it lacks.
  const generalDue=sql`${heartbeat.lastPollAt}<=excluded.last_poll_at-${heartbeatIntervalMs}
    OR ${heartbeat.lastPollAt}>${databaseTime}`;
  const queueDue=sql`excluded.last_queue_poll_at IS NOT NULL AND
    (${heartbeat.lastQueuePollAt} IS NULL OR ${heartbeat.lastQueuePollAt}<=excluded.last_queue_poll_at-${heartbeatIntervalMs}
      OR ${heartbeat.lastQueuePollAt}>${databaseTime})`;
  const gmailDue=sql`excluded.last_gmail_poll_at IS NOT NULL AND
    (${heartbeat.lastGmailPollAt} IS NULL OR ${heartbeat.lastGmailPollAt}<=excluded.last_gmail_poll_at-${heartbeatIntervalMs}
      OR ${heartbeat.lastGmailPollAt}>${databaseTime})`;
  const fullDue=sql`excluded.last_full_poll_at IS NOT NULL AND
    (${heartbeat.lastFullPollAt} IS NULL OR ${heartbeat.lastFullPollAt}<=excluded.last_full_poll_at-${heartbeatIntervalMs}
      OR ${heartbeat.lastFullPollAt}>${databaseTime})`;
  await db.insert(heartbeat).values({id:1,lastPollAt:databaseTime,lastQueuePollAt:queuePollAt,
    lastGmailPollAt:gmailConfigured?queuePollAt:null,lastFullPollAt:full?queuePollAt:null})
    .onConflictDoUpdate({target:heartbeat.id,set:{
      lastPollAt:sql`CASE WHEN ${generalDue} THEN excluded.last_poll_at ELSE ${heartbeat.lastPollAt} END`,
      lastQueuePollAt:sql`CASE WHEN ${queueDue} THEN excluded.last_queue_poll_at ELSE ${heartbeat.lastQueuePollAt} END`,
      lastGmailPollAt:sql`CASE WHEN ${gmailDue} THEN excluded.last_gmail_poll_at ELSE ${heartbeat.lastGmailPollAt} END`,
      lastFullPollAt:sql`CASE WHEN ${fullDue} THEN excluded.last_full_poll_at ELSE ${heartbeat.lastFullPollAt} END`,
    },setWhere:sql`(${generalDue}) OR (${queueDue}) OR (${gmailDue}) OR (${fullDue})`});
}

const pollColumns={queue:sql`beat.last_queue_poll_at`,full:sql`beat.last_full_poll_at`,gmail:sql`beat.last_gmail_poll_at`};
export type WorkerPollCapability=keyof typeof pollColumns;

export async function portableQueueStatus(db:Db,expectWorker:boolean,capability:WorkerPollCapability='queue'){
  const [status]=await db.execute<{
    checked_at:number;
    oldest_due_at:number|null;
    overdue:boolean;
    oldest_expired_lease_at:number|null;
    latest_failure_at:number|null;
    last_heartbeat_at:number|null;
    last_successful_poll_at:number|null;
    failed_needs_review:boolean;
    uncertain_needs_review:boolean;
    suppressed_needs_review:boolean;
  }>(sql`
    WITH clock AS (SELECT (${databaseTime})::bigint AS at)
    SELECT at::float8 AS checked_at,
      beat.last_poll_at::float8 AS last_heartbeat_at,
      ${pollColumns[capability]}::float8 AS last_successful_poll_at,
      (SELECT available_at::float8 FROM ${jobs} WHERE ${runnableQueuedJob} AND available_at<=at
        ORDER BY available_at LIMIT 1) AS oldest_due_at,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobOverdueAt(sql`at`)}) AS overdue,
      (SELECT lease_until::float8 FROM ${jobs} WHERE ${active} AND lease_until<=at
        ORDER BY lease_until LIMIT 1) AS oldest_expired_lease_at,
      (SELECT finished_at::float8 FROM ${jobs} WHERE status IN ('attention','failed') AND status='failed'
        AND operator_reviewed_at IS NULL AND finished_at>=at-3600000 ORDER BY finished_at DESC LIMIT 1) AS latest_failure_at,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobReviewFilters.failed}) AS failed_needs_review,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobReviewFilters.uncertain}) AS uncertain_needs_review,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobReviewFilters.suppressed_email}) AS suppressed_needs_review
    FROM clock LEFT JOIN ${heartbeat} AS beat ON beat.id=1
  `);
  const {checked_at:checkedAt,oldest_due_at:oldestDueAt,overdue,oldest_expired_lease_at:oldestExpiredLeaseAt,
    latest_failure_at:latestFailureAt,last_heartbeat_at:lastHeartbeatAt,last_successful_poll_at:lastSuccessfulPollAt}=status;
  const review={failed:status.failed_needs_review,uncertain:status.uncertain_needs_review,suppressedEmail:status.suppressed_needs_review};
  const needsReview=review.failed||review.uncertain||review.suppressedEmail;
  const workerHeartbeat=workerHeartbeatState(lastHeartbeatAt,checkedAt);
  const queuePoll=workerPollState(lastSuccessfulPollAt,checkedAt);
  const attention=overdue||oldestExpiredLeaseAt!==null||latestFailureAt!==null||needsReview||
    (expectWorker&&(workerHeartbeat!=='fresh'||queuePoll!=='fresh'));
  return {result:attention?'attention':'ok',checkedAt,oldestDueAt,oldestExpiredLeaseAt,latestFailureAt,overdue,needsReview,
    review,workerExpected:expectWorker,workerHeartbeat,queuePoll,lastHeartbeatAt,lastSuccessfulPollAt};
}

export async function portableFullWorkerStatus(db:Db){
  const [status]=await db.execute<{at:number;last_full_poll_at:number|null}>(sql`
    SELECT ${databaseTime} AS at,
      (SELECT last_full_poll_at::float8 FROM ${heartbeat} WHERE id=1) AS last_full_poll_at
  `);
  const workerHeartbeat=workerPollState(status.last_full_poll_at,status.at);
  const expectedWorkerMissing=workerHeartbeat!=='fresh';
  return {result:expectedWorkerMissing?'attention':'ok',workerHeartbeat,expectedWorkerMissing};
}

export async function portableTaskQueueStatus(db:Db){
  const [status]=await db.execute<{at:number;last_full_poll_at:number|null;due:boolean}>(sql`
    WITH clock AS (SELECT (${databaseTime})::bigint AS at)
    SELECT at::float8 AS at,
      (SELECT last_full_poll_at::float8 FROM ${heartbeat} WHERE id=1) AS last_full_poll_at,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${runnableQueuedJob} AND kind='task' AND available_at<=at) AS due
    FROM clock
  `);
  const dueWithoutWorker=status.due&&workerPollState(status.last_full_poll_at,status.at)!=='fresh';
  return {result:dueWithoutWorker?'attention':'ok',dueWithoutWorker};
}

export async function portableGmailQueueStatus(db:Db,expectGmailWorker=false){
  const [status]=await db.execute<{at:number;last_gmail_poll_at:number|null;due:boolean;reconnect_needs_review:boolean}>(sql`
    WITH clock AS (SELECT (${databaseTime})::bigint AS at)
    SELECT at::float8 AS at,
      (SELECT last_gmail_poll_at::float8 FROM ${heartbeat} WHERE id=1) AS last_gmail_poll_at,
      EXISTS (SELECT 1 FROM ${jobs} WHERE ${runnableQueuedJob} AND kind='gmail' AND available_at<=at) AS due,
      EXISTS (SELECT 1 FROM ${jobs} WHERE status='failed' AND kind='gmail'
        AND issue=${gmailReauthorizationIssue} AND operator_reviewed_at IS NULL) AS reconnect_needs_review
    FROM clock
  `);
  const workerHeartbeat=workerPollState(status.last_gmail_poll_at,status.at);
  const dueWithoutWorker=status.due&&workerHeartbeat!=='fresh';
  const expectedWorkerMissing=expectGmailWorker&&workerHeartbeat!=='fresh';
  const reconnectNeedsReview=status.reconnect_needs_review;
  return {result:dueWithoutWorker||expectedWorkerMissing||reconnectNeedsReview?'attention':'ok',dueWithoutWorker,workerHeartbeat,reconnectNeedsReview,
    ...(expectGmailWorker?{expectedWorkerMissing}:{})};
}

async function activeJobContact(tx:Tx,scope:Scope,access?:SQL){
  const [contact]=await tx.select({id:contacts.id}).from(contacts)
    .where(and(eq(contacts.workspaceId,scope.workspaceId),eq(contacts.id,scope.contactId),activeContact,access));
  return !!contact;
}

export async function availableJobSlots(tx:Tx,workspaceId:string){
  const [pending]=await tx.select({count:count()}).from(jobs).where(and(eq(jobs.workspaceId,workspaceId),sql`(${queued} OR ${active})`));
  return Math.max(0,100-pending.count);
}

export async function enqueueNote(db:Db,scope:Scope,actorId:string,input:NoteInput,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    // Serialize admission and claims without blocking the FK checks for other workspace records.
    const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(shared?eq(privateWorkspaces.id,scope.workspaceId):owner(scope.workspaceId,actorId)).for('no key update');
    if(!workspace)return 'missing';
    if(shared){
      if(await lockRecordWorkspace(tx,actorId,false,shared,'scheduledNotes',false,true)!==scope.workspaceId)return 'access';
      const editable=ownedRecordScope(tx,actorId,scope.workspaceId,contacts,'edit','scheduledNotes',shared.grantId);
      if(!await activeJobContact(tx,scope,editable))return 'missing';
    }
    const [existing]=await tx.select().from(jobs).where(key({...scope,id:input.id}));
    if(existing)return existing.kind==='note'&&existing.actorId===actorId&&existing.contactId===scope.contactId&&existing.body===input.body&&
      existing.scheduledFor===input.scheduledFor?'ok':'conflict';
    if(!shared&&!await activeJobContact(tx,scope))return 'missing';
    const at=await jobClock(tx);
    if(input.scheduledFor>at+90*24*60*60*1000)return 'date';
    if(!await availableJobSlots(tx,scope.workspaceId))return 'full';
    await tx.insert(jobs).values({...scope,...input,actorId,authorizedOwnerId:shared?workspace.ownerId:null,kind:'note',availableAt:input.scheduledFor,createdAt:at});
    return 'ok';
  });
}

export function canRetryInternalJob(job:Pick<Job,'kind'|'status'|'attempts'|'issue'|'operatorRetryAt'>){
  return (job.kind==='note'||job.kind==='task')&&job.status==='failed'&&job.attempts===attemptLimit&&job.operatorRetryAt===null&&
    (job.issue==='processor_error'||job.issue==='lease_expired');
}

export function retryInternalJob(db:Db,scope:Scope,actorId:string,id:string,kind:'note'|'task'){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(workspaceId!==scope.workspaceId||!await activeJobContact(tx,scope))return 'missing';
    const where=key({...scope,id});
    const [job]=await tx.select().from(jobs).where(and(where,eq(jobs.contactId,scope.contactId))).for('update');
    if(!job)return 'missing';
    if(job.kind!==kind||(job.authorizedOwnerId??job.actorId)!==actorId)return 'conflict';
    if(job.operatorRetryAt!==null)return 'already';
    if(!canRetryInternalJob(job)||(await sequenceJobExists(tx,workspaceId,id)).length)return 'conflict';
    const [saved]=kind==='note'
      ?await tx.select({id:notes.jobId}).from(notes).where(and(eq(notes.workspaceId,workspaceId),eq(notes.jobId,id)))
      :await tx.select({id:portableTasks.id}).from(portableTasks)
        .where(and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.id,id)));
    if(saved)return 'conflict';
    if(!await availableJobSlots(tx,workspaceId))return 'full';
    const at=await jobClock(tx);
    await tx.update(jobs).set({status:'queued',issue:null,finishedAt:null,availableAt:at,
      operatorRetryAt:at,operatorRetryBy:actorId,operatorReviewedAt:null,operatorReviewedBy:null}).where(where);
    return 'queued';
  });
}

export function canCancelJob(job:Pick<Job,'kind'|'status'|'attempts'|'waitForLifecycle'>){
  if(job.kind==='external')return job.status==='queued'&&job.attempts===0&&job.waitForLifecycle!==null;
  return (job.kind==='note'||job.kind==='gmail'||job.kind==='task')&&(job.status==='queued'||job.status==='running');
}

export const uncertainGmailIssues=['external_outcome_unknown','restore_requires_reconciliation'] as const;

export function isUncertainGmail(job:Pick<Job,'kind'|'status'|'issue'>){
  return job.kind==='gmail'&&job.status==='attention'&&
    uncertainGmailIssues.some(issue=>issue===job.issue);
}

export function canReviewGmail(job:Pick<Job,'kind'|'status'|'issue'|'operatorReviewedAt'>){
  return isUncertainGmail(job)&&job.operatorReviewedAt===null;
}

export function isUncertainExternal(job:Pick<Job,'kind'|'status'|'issue'>){
  return job.kind==='external'&&job.status==='attention'&&
    (job.issue==='external_outcome_unknown'||job.issue==='restore_requires_reconciliation');
}

export function canReviewFailed(job:Pick<Job,'status'|'operatorReviewedAt'>){
  return job.status==='failed'&&job.operatorReviewedAt===null;
}

export function isSuppressedGmail(job:Pick<Job,'kind'|'status'|'issue'>){
  return job.kind==='gmail'&&job.status==='skipped'&&job.issue===gmailSuppressedIssue;
}

export function reviewPortableJob(db:Db,contactId:string,actorId:string,review:JobReview){
  return db.transaction(async tx=>{
    const [job]=await tx.select({id:jobs.id,workspaceId:jobs.workspaceId,kind:jobs.kind,status:jobs.status,issue:jobs.issue,
      attempts:jobs.attempts,operatorReviewedAt:jobs.operatorReviewedAt})
      .from(jobs).innerJoin(privateWorkspaces,and(eq(jobs.workspaceId,privateWorkspaces.id),eq(privateWorkspaces.ownerId,actorId)))
      .where(and(eq(jobs.id,review.id),eq(jobs.contactId,contactId),review.action==='reviewFailed'?undefined:eq(jobs.kind,review.action==='reviewExternal'?'external':'gmail'),
        sql`coalesce(${jobs.authorizedOwnerId},${jobs.actorId})=${actorId}`)).for('update',{of:jobs});
    if(!job)return 'missing';
    if(review.action==='reviewSuppressedGmail'){
      if(!isSuppressedGmail(job)||job.attempts!==review.attempts)return 'conflict';
    }
    if(review.action==='reviewFailed'&&(job.status!=='failed'||job.attempts!==review.attempts))return 'conflict';
    if(review.action==='reviewExternal'&&!isUncertainExternal(job))return 'conflict';
    if(job.operatorReviewedAt!==null)return 'already';
    if(review.action==='reviewGmail'&&!canReviewGmail(job))return 'conflict';
    await tx.update(jobs).set({operatorReviewedAt:await jobClock(tx),operatorReviewedBy:actorId}).where(key(job));
    return 'reviewed';
  });
}

export function cancelPortableJob(db:Db,scope:Scope,actorId:string,id:string,kind:'note'|'gmail'|'task'|'external'){
  return db.transaction(async tx=>{
    const where=key({...scope,id});
    const [match]=await tx.select({job:jobs}).from(jobs)
      .innerJoin(privateWorkspaces,and(eq(privateWorkspaces.id,jobs.workspaceId),eq(privateWorkspaces.ownerId,actorId)))
      .where(and(where,eq(jobs.contactId,scope.contactId),eq(jobs.kind,kind),
        sql`coalesce(${jobs.authorizedOwnerId},${jobs.actorId})=${actorId}`)).for('update',{of:jobs});
    if(!match)return 'missing';
    const {job}=match;
    const issue=kind==='external'?'event_wait_cancelled':kind==='note'?'note_cancelled':kind==='task'?'task_cancelled':'email_cancelled';
    if(job.status==='skipped'&&job.issue===issue)return 'ok';
    if(!canCancelJob(job))return 'conflict';
    const at=await jobClock(tx);
    // An open attempt gets a cancellation receipt. A queued retry keeps its already-closed attempts.
    if(job.status==='running')await closeAttempt(tx,job,at,'skipped',issue);
    else await tx.update(jobs).set({status:'skipped',issue,finishedAt:at}).where(where);
    return 'ok';
  });
}

export const jobAttemptReceipts=sql<{number:number;startedAt:number;endedAt:number|null;outcome:string|null}[]>`coalesce((
    SELECT jsonb_agg(jsonb_build_object('number',${attempts.number},'startedAt',${attempts.startedAt},
      'endedAt',${attempts.endedAt},'outcome',${attempts.outcome}) ORDER BY ${attempts.number})
    FROM ${attempts}
    WHERE ${attempts.workspaceId}=${jobs.workspaceId} AND ${attempts.jobId}=${jobs.id}
  ), '[]'::jsonb)`;

export const queuedGmailRecipientBlocked=sql<boolean>`CASE WHEN ${jobs.kind}='gmail' AND ${jobs.status}='queued' THEN EXISTS(
    SELECT 1 FROM ${scheduledGmail} JOIN ${emailSuppressions}
      ON ${emailSuppressions.workspaceId}=${scheduledGmail.workspaceId} AND ${emailSuppressions.email}=${scheduledGmail.recipient}
    WHERE ${scheduledGmail.workspaceId}=${jobs.workspaceId} AND ${scheduledGmail.jobId}=${jobs.id}
  ) ELSE false END`;

export async function contactJobHistory(db:Db,scope:Scope,after?:{at:number;id:string},notesOnly=false){
  const nextPage=after?sql`(${jobs.createdAt},${jobs.id}) < (${after.at},${after.id}::uuid)`:undefined;
  const rows=await db.select({id:jobs.id,body:jobs.body,actorEmail:loginIdentities.email,kind:jobs.kind,status:jobs.status,attempts:jobs.attempts,issue:jobs.issue,
    waitForLifecycle:jobs.waitForLifecycle,scheduledFor:jobs.scheduledFor,availableAt:jobs.availableAt,createdAt:jobs.createdAt,finishedAt:jobs.finishedAt,operatorReviewedAt:jobs.operatorReviewedAt,
    completedAt:notes.createdAt,receipts:jobAttemptReceipts,recipientBlocked:queuedGmailRecipientBlocked,gmail:{sender:scheduledGmail.sender,recipient:scheduledGmail.recipient,
      subject:scheduledGmail.subject,providerId:scheduledGmail.providerId}})
    .from(jobs).innerJoin(loginIdentities,eq(loginIdentities.id,jobs.actorId))
    .leftJoin(notes,and(eq(notes.workspaceId,jobs.workspaceId),eq(notes.jobId,jobs.id)))
    .leftJoin(scheduledGmail,and(eq(scheduledGmail.workspaceId,jobs.workspaceId),eq(scheduledGmail.jobId,jobs.id)))
    .where(and(eq(jobs.workspaceId,scope.workspaceId),eq(jobs.contactId,scope.contactId),notesOnly?eq(jobs.kind,'note'):undefined,nextPage))
    .orderBy(desc(jobs.createdAt),desc(jobs.id)).limit(26);
  const items=rows.slice(0,25),last=items.at(-1);
  return {items,next:rows.length>25&&last?{at:last.createdAt,id:last.id}:null};
}

export async function claimPortableJob(db:Db,{leaseMs,code=false,gmail=false,webhooks=false,notesOnly=false}:{leaseMs?:number;code?:boolean;gmail?:boolean;webhooks?:boolean;notesOnly?:boolean}={}):Promise<Claim|null>{
  return db.transaction(async tx=>{
    const at=await jobClock(tx);
    // An incapable worker must leave these jobs available for a configured worker.
    const sequenceDisabled=gmail&&process.env.HARBOR_SEQUENCE_WORKER_ENABLED!=='true';
    const workflowWebhook=tx.select({id:workflowWebhookJobs.jobId}).from(workflowWebhookJobs)
      .where(and(eq(workflowWebhookJobs.workspaceId,jobs.workspaceId),eq(workflowWebhookJobs.jobId,jobs.id)));
    const due=and(runnableQueuedJob,lte(jobs.availableAt,at),sequenceDisabled?sql`(${jobs.kind}<>'gmail' OR NOT EXISTS (
      SELECT 1 FROM portable_sales_sequence_steps st WHERE st.workspace_id=${jobs.workspaceId} AND st.job_id=${jobs.id}))`:undefined,notesOnly?eq(jobs.kind,'note'):undefined,
      webhooks||notesOnly?undefined:or(ne(jobs.kind,'external'),notExists(workflowWebhook)),
      code?undefined:ne(jobs.kind,'code'),gmail?undefined:ne(jobs.kind,'gmail'));
    const eligible=tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.workspaceId,privateWorkspaces.id),due));
    const busy=tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.workspaceId,privateWorkspaces.id),active));
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(and(exists(eligible),notExists(busy)))
      .orderBy(sql`${privateWorkspaces.lastJobClaimAt} ASC NULLS FIRST`,asc(privateWorkspaces.id)).limit(1).for('update',{skipLocked:true});
    if(!workspace)return null;
    // Recheck in a new statement after locking the workspace. Concurrent claims can change the first snapshot.
    const scope=eq(jobs.workspaceId,workspace.id);
    const [busyNow]=await tx.select({id:jobs.id}).from(jobs).where(and(scope,active)).limit(1);
    if(busyNow)return null;
    const [candidate]=await tx.select().from(jobs).where(and(scope,due))
      .orderBy(asc(jobs.availableAt),asc(jobs.id)).limit(1).for('update',{skipLocked:true});
    if(!candidate)return null;
    const leaseToken=crypto.randomUUID(),number=candidate.attempts+1;
    // Gmail refresh and mailbox verification can take 15s each before authorization is rechecked.
    const claimLeaseMs=leaseMs??(candidate.kind==='gmail'?45_000:30_000);
    const [job]=await tx.update(jobs).set({status:'running',attempts:number,leaseToken,leaseUntil:at+claimLeaseMs})
      .where(key(candidate)).returning();
    await tx.update(privateWorkspaces).set({lastJobClaimAt:at}).where(eq(privateWorkspaces.id,workspace.id));
    await tx.insert(attempts).values({workspaceId:workspace.id,jobId:job.id,number,startedAt:at});
    if(webhooks&&job.kind==='external'){
      const [workflowWebhook]=await tx.select().from(workflowWebhookJobs)
        .where(and(eq(workflowWebhookJobs.workspaceId,job.workspaceId),eq(workflowWebhookJobs.jobId,job.id)));
      if(workflowWebhook)return {...job,leaseToken,workflowWebhook};
    }
    return {...job,leaseToken};
  });
}

export async function lockClaim(tx:Tx,claim:Claim,status:JobState){
  const [job]=await tx.select().from(jobs).where(and(key(claim),eq(jobs.leaseToken,claim.leaseToken),
    eq(jobs.status,status))).for('update');
  if(!job||job.leaseUntil===null||job.leaseUntil<=await jobClock(tx))return undefined;
  return job;
}

export async function closeAttempt(tx:Tx,job:Job,at:number,status:JobState,issue:string|null,availableAt=job.availableAt){
  await tx.update(jobs).set({status,issue,availableAt,finishedAt:status==='queued'?null:at,leaseUntil:null,leaseToken:null}).where(key(job));
  await tx.update(attempts).set({endedAt:at,outcome:issue??status})
    .where(and(eq(attempts.workspaceId,job.workspaceId),eq(attempts.jobId,job.id),eq(attempts.number,job.attempts)));
  if(status==='succeeded'&&(job.kind==='note'||job.kind==='task'||job.kind==='external'))await admitNextPathStep(tx,job,at);
}

async function deferAttempt(tx:Tx,job:Job,at:number,issue:string){
  const delay=Math.min(60_000,2_000*2**(job.attempts-1)+Math.floor(Math.random()*500));
  await closeAttempt(tx,job,at,job.attempts>=attemptLimit?'failed':'queued',issue,at+delay);
}

export async function recoverExpiredJob(db:Db,notesOnly=false){
  return db.transaction(async tx=>{
    const at=await jobClock(tx);
    const [job]=await tx.select().from(jobs).where(and(active,lte(jobs.leaseUntil,at),notesOnly?eq(jobs.kind,'note'):undefined))
      .orderBy(asc(jobs.leaseUntil)).limit(1).for('update',{skipLocked:true});
    if(!job)return {recovered:false,startedAt:at};
    if(job.status==='dispatching')await closeAttempt(tx,job,at,'attention','external_outcome_unknown');
    else await deferAttempt(tx,job,at,'lease_expired');
    return {recovered:true,startedAt:at};
  });
}

export async function segmentEntrySuperseded(tx:Tx,job:Job,currentRevision:number){
  if(job.segmentEntryRevision===null||currentRevision<=job.segmentEntryRevision)return false;
  const [superseded]=await tx.select({revision:contactEvents.revision}).from(contactEvents).where(and(
    eq(contactEvents.workspaceId,job.workspaceId),eq(contactEvents.contactId,job.contactId),
    gt(contactEvents.revision,job.segmentEntryRevision),
    job.segmentCriteria?sql`NOT coalesce(${portableSegmentMatch(contactEvents.data,job.segmentCriteria)},false)`:
      sql`(${contactEvents.previous}->>'lifecycle') IS DISTINCT FROM (${contactEvents.data}->>'lifecycle')`)).limit(1);
  return !!superseded;
}

// Call under the workspace lock used by form edits, inquiry changes and Contact archive.
export async function authorizedLeadFormNote(tx:Tx,source:typeof leadFormNoteSources.$inferSelect){
  if(!source.contactId)return null;
  const [form]=await tx.select({definition:leadForms.definition}).from(leadForms)
    .innerJoin(leadFormActivations,eq(leadFormActivations.formId,leadForms.id))
    .innerJoin(privateWorkspaces,owner(source.workspaceId,source.ownerId))
    .innerJoin(leadInquiries,and(eq(leadInquiries.workspaceId,leadForms.workspaceId),
      eq(leadInquiries.formId,leadForms.id),eq(leadInquiries.id,source.inquiryId),
      eq(leadInquiries.contactId,source.contactId),sql`${leadInquiries.status} IN ('created','linked')`))
    .innerJoin(contacts,and(eq(contacts.workspaceId,leadForms.workspaceId),eq(contacts.id,source.contactId),activeContact))
    .where(and(eq(leadForms.workspaceId,source.workspaceId),eq(leadForms.id,source.formId),
      eq(leadForms.revision,source.formRevision))).limit(1);
  const body=form&&leadFormAutomationNote(form.definition);
  return body?{contactId:source.contactId,body}:null;
}

export async function finishNote(db:Db,claim:Claim){
  return db.transaction(async tx=>{
    const formScope=and(eq(leadFormNoteSources.workspaceId,claim.workspaceId),eq(leadFormNoteSources.jobId,claim.id));
    const [formSource]=await tx.select({id:leadFormNoteSources.inquiryId}).from(leadFormNoteSources).where(formScope).limit(1);
    // Form admission, edits and removals take the workspace lock before touching jobs.
    if(formSource)await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,claim.workspaceId)).for('no key update');
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='note')return false;
    if(formSource){
      const [source]=await tx.select().from(leadFormNoteSources).where(formScope).limit(1);
      const target=source?.state==='queued'?await authorizedLeadFormNote(tx,source):null;
      if(!target||target.contactId!==job.contactId||target.body!==job.body||source?.ownerId!==job.actorId){
        await closeAttempt(tx,job,await jobClock(tx),'skipped','form_automation_changed');
        return false;
      }
    }
    // Admission commits an internal Note for the workspace. Recheck its authorized owner and contact.
    const contact=tx.select({id:contacts.id,revision:contacts.revision}).from(contacts)
      .innerJoin(privateWorkspaces,owner(job.workspaceId,job.authorizedOwnerId??job.actorId))
      .where(and(eq(contacts.workspaceId,job.workspaceId),eq(contacts.id,job.contactId),activeContact));
    // Hold the Contact row through completion so archive and lifecycle changes cannot cross the check.
    const [current]=await contact.for('share',{of:contacts});
    if(!current){
      await closeAttempt(tx,job,await jobClock(tx),'failed','authority_changed');
      return false;
    }
    if(await segmentEntrySuperseded(tx,job,current.revision)){
      await closeAttempt(tx,job,await jobClock(tx),'skipped','segment_left');
      return false;
    }
    const at=await jobClock(tx);
    await tx.insert(notes).values({workspaceId:job.workspaceId,jobId:job.id,body:job.body,createdAt:at});
    await closeAttempt(tx,job,at,'succeeded',null);
    await queueNextManualNote(tx,job,at);
    return true;
  });
}

export async function retryUnstartedJob(db:Db,claim:Claim,issue:'processor_error'|'lease_expired'='processor_error'){
  await db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(job)await deferAttempt(tx,job,await jobClock(tx),issue);
  });
}

export async function beginExternalDispatch(db:Db,claim:Claim){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='external')return false;
    if(!await activeJobContact(tx,job)){
      await closeAttempt(tx,job,await jobClock(tx),'failed','authority_changed');
      return false;
    }
    await tx.update(jobs).set({status:'dispatching'}).where(key(job));
    return true;
  });
}

export async function finishExternalDispatch(db:Db,claim:Claim,confirmed:boolean){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'dispatching');
    if(!job)return false;
    await closeAttempt(tx,job,await jobClock(tx),confirmed?'succeeded':'attention',confirmed?null:'external_outcome_unknown');
    return true;
  });
}

export async function rejectUnavailableAction(db:Db,claim:Claim){
  await db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(job)await closeAttempt(tx,job,await jobClock(tx),'failed','external_adapter_unavailable');
  });
}
