import {and,desc,eq,exists,or,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {JobKind,QueueIssue,QueueView} from '../../lib/portable-job-labels';
import {contacts,privateWorkspaces} from './contact-schema';
import {deals} from './deal-schema';
import {portableTickets as tickets} from './ticket-schema';
import {portableJobs as jobs,portableWorkerHeartbeat as heartbeat} from './job-schema';
import {loginIdentities} from './identity-schema';
import {scheduledGmail} from './scheduled-gmail-schema';
import {sequenceJobExists} from './manual-workflow-action-store';
import {canCancelJob,canRetryInternalJob,canReviewFailed,canReviewGmail,isSuppressedGmail,isUncertainExternal,isUncertainGmail,jobAttemptReceipts,jobNeedsReview,jobOverdueAt,jobReviewFilters,queuedGmailRecipientBlocked,runnableQueuedJob,workerHeartbeatState,workerPollState} from './job-store';
import {gmailSendGraceMs,portableGmailMessageId} from './scheduled-gmail-store';
import {activeTask,pendingTaskRepeat,portableTaskRepeatReceipts as taskReceipts,portableTasks as tasks,taskRepeatDueAt} from './task-schema';
import {taskRepeatOverdueSeconds} from './task-repeat-status';
import {workflowCapacityNeedsReview} from './workflow-capacity-status';
import {dealWorkflowRuns as runs,workflowPathSteps as steps} from './workflow-schema';

export type {QueueView} from '../../lib/portable-job-labels';
type Cursor={at:number;id:string};
type SourceDealWorkflow={dealId:string;dealName:string;dealArchived:boolean;workflowName:string};
type QueueFilters={after?:Cursor;jobId?:string;kind?:JobKind;issue?:QueueIssue;finishedFirst?:boolean;contactId?:string};
type QueueClock={
  at:number;last_poll_at:number|null;last_queue_poll_at:number|null;last_gmail_poll_at:number|null;last_full_poll_at:number|null;
  next_mail_at:number|null;due_note:boolean;due_task:boolean;overdue_repeat:boolean;
  needs_review:boolean;overdue_jobs:boolean;expired_claims:boolean;missed_workflows:boolean;
};
const queryTime=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint`;
const overdue=jobOverdueAt(queryTime);
const expiredClaim=sql<boolean>`${jobs.status} IN ('running','dispatching') AND ${jobs.leaseUntil}<=${queryTime}`;
const viewFilter={
  issues:or(jobNeedsReview,overdue,expiredClaim),
  waiting:sql`${jobs.status}='queued' AND ${jobs.waitForLifecycle} IS NOT NULL`,
  pending:sql`${jobs.status} IN ('queued','running','dispatching')`,
  completed:eq(jobs.status,'succeeded'),
  failed:eq(jobs.status,'failed'),
  skipped:eq(jobs.status,'skipped'),
  recovery:and(eq(jobs.status,'attention'),eq(jobs.issue,'restore_requires_reconciliation')),
  all:undefined,
};
const issueFilter={overdue,expired_claim:expiredClaim,needs_review:jobNeedsReview,...jobReviewFilters};
const pageSize=25;

export async function readOwnerQueue(db:PostgresJsDatabase,ownerId:string,view:QueueView,{after,jobId,kind,issue,finishedFirst,contactId}:QueueFilters={}){
  const sourceJob=sql`coalesce((SELECT ${steps.runId} FROM ${steps}
    WHERE ${steps.workspaceId}=${jobs.workspaceId} AND ${steps.plannedJobId}=${jobs.id} AND ${steps.jobId}=${jobs.id}),${jobs.id})`;
  const byFinish=view==='completed'&&finishedFirst;
  const orderedAt=byFinish?sql`coalesce(${jobs.finishedAt},${jobs.createdAt})`:jobs.createdAt;
  const ownerHasJob=(filter:SQL)=>jobId?sql`FALSE`:sql`
    EXISTS (SELECT 1 FROM ${privateWorkspaces} JOIN ${jobs} ON ${jobs.workspaceId}=${privateWorkspaces.id}
      WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${filter})`;
  const [rows,[clock],[selectedContact]]=await Promise.all([
    db.select({
      id:jobs.id,workspaceId:jobs.workspaceId,contactId:jobs.contactId,contactName:sql<string>`${contacts.data}->>'name'`,
      contactArchived:sql<boolean>`${contacts.archivedAt} IS NOT NULL`,
      kind:jobs.kind,status:jobs.status,attempts:jobs.attempts,issue:jobs.issue,createdAt:jobs.createdAt,
      waitForLifecycle:jobs.waitForLifecycle,scheduledFor:jobs.scheduledFor,availableAt:jobs.availableAt,finishedAt:jobs.finishedAt,
      operatorRetryAt:jobs.operatorRetryAt,operatorReviewedAt:jobs.operatorReviewedAt,actorId:jobs.actorId,authorizedOwnerId:jobs.authorizedOwnerId,
      actorEmail:loginIdentities.email,
      hasCreatedTask:sql<boolean>`CASE WHEN ${jobs.kind}='task' AND ${jobs.status}='succeeded' THEN EXISTS(
        SELECT 1 FROM ${tasks} WHERE ${tasks.workspaceId}=${jobs.workspaceId} AND ${tasks.id}=${jobs.id} AND ${activeTask}
      ) ELSE false END`,
      gmailReceipt:jobId?sql<string|null>`(SELECT ${scheduledGmail.providerId} FROM ${scheduledGmail}
        WHERE ${scheduledGmail.workspaceId}=${jobs.workspaceId} AND ${scheduledGmail.jobId}=${jobs.id}
          AND ${jobs.kind}='gmail' AND ${jobs.status}='succeeded')`:sql<string|null>`NULL`,
      sourceDealWorkflow:jobId?sql<SourceDealWorkflow|null>`(
        SELECT jsonb_build_object('dealId',${deals.id},'dealName',${deals.data}->>'name',
          'dealArchived',${deals.archivedAt} IS NOT NULL,'workflowName',${runs.workflowName})
        FROM ${runs} JOIN ${deals}
          ON ${deals.workspaceId}=${runs.workspaceId} AND ${deals.id}=${runs.dealId}
        WHERE ${runs.workspaceId}=${jobs.workspaceId} AND ${runs.id}=${sourceJob} AND ${runs.jobId}=${runs.id}
      )`:sql<null>`NULL`,
      sourceTicketWorkflow:jobId?sql<{ticketId:string;ticketName:string;archived:boolean;workflowId:string;workflowName:string}|null>`(
        SELECT jsonb_build_object('ticketId',${tickets.id},'ticketName',${tickets.data}->>'name',
          'archived',${tickets.archivedAt} IS NOT NULL,'workflowId',${runs.workflowId},'workflowName',${runs.workflowName})
        FROM ${runs} JOIN ${tickets} ON ${tickets.workspaceId}=${runs.workspaceId} AND ${tickets.id}=${runs.ticketId}
        WHERE ${runs.workspaceId}=${jobs.workspaceId} AND ${runs.id}=${sourceJob} AND ${runs.jobId}=${runs.id}
      )`:sql<null>`NULL`,
      leaseUntil:jobs.leaseUntil,overdue,expiredClaim,receipts:jobAttemptReceipts,sequence:exists(sequenceJobExists(db,jobs.workspaceId,jobs.id)).mapWith(Boolean),
      recipientBlocked:queuedGmailRecipientBlocked,
    }).from(privateWorkspaces).innerJoin(jobs,eq(jobs.workspaceId,privateWorkspaces.id))
      .innerJoin(loginIdentities,eq(loginIdentities.id,jobs.actorId))
      .innerJoin(contacts,and(eq(contacts.workspaceId,jobs.workspaceId),eq(contacts.id,jobs.contactId)))
      .where(and(eq(privateWorkspaces.ownerId,ownerId),viewFilter[view],jobId?eq(jobs.id,jobId):undefined,
        kind?eq(jobs.kind,kind):undefined,issue?issueFilter[issue]:undefined,contactId?eq(jobs.contactId,contactId):undefined,
        after?sql`(${orderedAt},${jobs.id}) < (${after.at},${after.id}::uuid)`:undefined))
      .orderBy(desc(orderedAt),desc(jobs.id)).limit(pageSize+1),
    db.execute<QueueClock>(sql`
      WITH clock AS (SELECT ${queryTime} AS at)
      SELECT at::float8 AS at,
        ${ownerHasJob(jobNeedsReview)} AS needs_review,
        ${ownerHasJob(overdue)} AS overdue_jobs,
        ${ownerHasJob(expiredClaim)} AS expired_claims,
        ${jobId?sql`FALSE`:sql`EXISTS (SELECT 1 FROM ${privateWorkspaces}
          JOIN ${runs} ON ${runs.workspaceId}=${privateWorkspaces.id}
          WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${workflowCapacityNeedsReview})`} AS missed_workflows,
        beat.last_poll_at::float8 AS last_poll_at,
        beat.last_queue_poll_at::float8 AS last_queue_poll_at,
        beat.last_full_poll_at::float8 AS last_full_poll_at,
        beat.last_gmail_poll_at::float8 AS last_gmail_poll_at,
        (SELECT ${jobs.availableAt}::float8 FROM ${privateWorkspaces} JOIN ${jobs} ON ${jobs.workspaceId}=${privateWorkspaces.id}
          WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${runnableQueuedJob} AND ${jobs.kind}='gmail'
          ORDER BY ${jobs.availableAt} LIMIT 1) AS next_mail_at,
        EXISTS (SELECT 1 FROM ${privateWorkspaces} JOIN ${jobs} ON ${jobs.workspaceId}=${privateWorkspaces.id}
          WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${runnableQueuedJob}
            AND ${jobs.kind}='note' AND ${jobs.availableAt}<=at) AS due_note,
        EXISTS (SELECT 1 FROM ${privateWorkspaces} JOIN ${jobs} ON ${jobs.workspaceId}=${privateWorkspaces.id}
          WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${runnableQueuedJob}
            AND ${jobs.kind}='task' AND ${jobs.availableAt}<=at) AS due_task,
        EXISTS (SELECT 1 FROM ${privateWorkspaces} JOIN ${tasks} ON ${tasks.workspaceId}=${privateWorkspaces.id}
          WHERE ${privateWorkspaces.ownerId}=${ownerId} AND ${pendingTaskRepeat(tasks.data,tasks.completedAt,tasks.archivedAt)}
            AND ${taskRepeatDueAt(tasks.data)}<=to_char(
              (statement_timestamp()-${taskRepeatOverdueSeconds}*interval '1 second') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            AND NOT EXISTS(SELECT 1 FROM ${taskReceipts} WHERE ${taskReceipts.workspaceId}=${tasks.workspaceId}
              AND ${taskReceipts.predecessorId}=${tasks.id})) AS overdue_repeat
      FROM clock LEFT JOIN ${heartbeat} AS beat ON beat.id=1`),
    contactId?db.select({id:contacts.id,name:sql<string>`${contacts.data}->>'name'`,archivedAt:contacts.archivedAt})
      .from(privateWorkspaces).innerJoin(contacts,eq(contacts.workspaceId,privateWorkspaces.id))
      .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(contacts.id,contactId))).limit(1):[],
  ]);
  const items=rows.slice(0,pageSize).map(({actorId,authorizedOwnerId,sequence,workspaceId,...job})=>{
    const owned=(authorizedOwnerId??actorId)===ownerId;
    const uncertainGmail=owned&&isUncertainGmail(job);
    const sendDeadline=job.kind==='gmail'&&job.status==='queued'?job.scheduledFor+gmailSendGraceMs:null;
    return {...job,sendDeadline,sendWindowElapsed:sendDeadline!==null&&clock.at>sendDeadline,
      canRetry:owned&&!sequence&&!job.contactArchived&&canRetryInternalJob(job),canCancel:owned&&canCancelJob(job),
      canReview:owned&&(canReviewGmail(job)||canReviewFailed(job)||(isSuppressedGmail(job)||isUncertainExternal(job))&&job.operatorReviewedAt===null),
      gmailSearch:uncertainGmail?'in:sent rfc822msgid:'+portableGmailMessageId({workspaceId,id:job.id}).slice(1,-1):null,
      gmailReconcileCommand:uncertainGmail?'node scripts/portable-web.mjs gmail-reconcile '+workspaceId+' '+job.id:null,
    };
  });
  const last=items.at(-1);
  const workerHeartbeat=workerHeartbeatState(clock.last_poll_at,clock.at);
  const queuePoll=workerPollState(clock.last_queue_poll_at,clock.at);
  const gmailWorkerHeartbeat=workerPollState(clock.last_gmail_poll_at,clock.at);
  const mailWithoutWorker=clock.next_mail_at!==null&&gmailWorkerHeartbeat!=='fresh'
    ?(clock.next_mail_at<=clock.at?'due':'upcoming'):null;
  return {
    items,checkedAt:clock.at,workerHeartbeat,queuePoll,
    contact:selectedContact?{id:selectedContact.id,name:selectedContact.name+(selectedContact.archivedAt?' (archived)':'')}:null,
    attention:{needs_review:clock.needs_review,overdue:clock.overdue_jobs,expired_claim:clock.expired_claims},
    missedWorkflowRuns:clock.missed_workflows,
    dueNoteWithoutWorker:clock.due_note&&(workerHeartbeat!=='fresh'||queuePoll!=='fresh'),
    dueTaskWithoutWorker:clock.due_task&&workerPollState(clock.last_full_poll_at,clock.at)!=='fresh',
    mailWithoutWorker,
    overdueTaskRepeat:clock.overdue_repeat,
    lastHeartbeatAt:clock.last_poll_at,lastSuccessfulPollAt:clock.last_queue_poll_at,
    next:rows.length>pageSize&&last?{at:byFinish?last.finishedAt??last.createdAt:last.createdAt,id:last.id}:null,
  };
}
