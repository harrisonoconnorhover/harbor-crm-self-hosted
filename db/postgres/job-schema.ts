import {bigint,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {contactEvents,contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';
import type {PortableSegmentDefinition} from '../../lib/portable-segments';
import type {JobKind} from '../../lib/portable-job-labels';
import type {portableWorkflowTaskFields} from '../../lib/portable-workflows';
import type {z} from 'zod';

export type JobState='queued'|'running'|'dispatching'|'succeeded'|'attention'|'failed'|'skipped';
const ms=(name:string)=>bigint(name,{mode:'number'});

export const portableJobs=pgTable('portable_jobs',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  contactId:uuid('contact_id').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  segmentEntryRevision:integer('segment_entry_revision'),
  segmentCriteria:jsonb('segment_criteria').$type<PortableSegmentDefinition['criteria']>(),
  authorizedOwnerId:text('authorized_owner_id').references(()=>loginIdentities.id),
  kind:text('kind').$type<JobKind>().notNull(),
  body:text('body').notNull(),
  scheduledFor:ms('scheduled_for').notNull(),
  availableAt:ms('available_at').notNull(),
  createdAt:ms('created_at').notNull(),
  status:text('status').$type<JobState>().notNull().default('queued'),
  attempts:integer('attempts').notNull().default(0),
  leaseToken:uuid('lease_token'),
  leaseUntil:ms('lease_until'),
  issue:text('issue'),
  finishedAt:ms('finished_at'),
  operatorRetryAt:ms('operator_retry_at'),
  operatorRetryBy:text('operator_retry_by').references(()=>loginIdentities.id),
  operatorReviewedAt:ms('operator_reviewed_at'),
  operatorReviewedBy:text('operator_reviewed_by').references(()=>loginIdentities.id),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({columns:[t.workspaceId,t.contactId,t.segmentEntryRevision],foreignColumns:[contactEvents.workspaceId,contactEvents.contactId,contactEvents.revision]}),
  index('portable_jobs_ready').on(t.workspaceId,t.availableAt,t.id).where(sql`${t.status}='queued'`),
  index('portable_jobs_due_status').on(t.availableAt).where(sql`${t.status}='queued'`),
  index('portable_jobs_attention_status').on(t.status,t.finishedAt).where(sql`${t.status} IN ('attention','failed')`),
  index('portable_jobs_unreviewed').on(t.id).where(sql`${t.status}='attention' AND ${t.operatorReviewedAt} IS NULL`),
  index('portable_jobs_active').on(t.workspaceId,t.leaseUntil).where(sql`${t.status} IN ('running','dispatching')`),
  index('portable_jobs_expiry').on(t.leaseUntil).where(sql`${t.status} IN ('running','dispatching')`),
  index('portable_jobs_workspace_history').on(t.workspaceId,t.createdAt,t.id),
  index('portable_jobs_workspace_issues').on(t.workspaceId,t.createdAt,t.id).where(sql`${t.status} IN ('attention','failed')`),
  index('portable_jobs_workspace_pending').on(t.workspaceId,t.createdAt,t.id).where(sql`${t.status} IN ('queued','running','dispatching')`),
  index('portable_jobs_contact').on(t.workspaceId,t.contactId,t.createdAt,t.id),
  check('portable_job_kind',sql`${t.kind} IN ('note','external','gmail','code','task')`),
  check('portable_job_status',sql`${t.status} IN ('queued','running','dispatching','succeeded','attention','failed','skipped')`),
  check('portable_job_lease',sql`CASE WHEN ${t.status} IN ('running','dispatching') THEN ${t.leaseToken} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL ELSE ${t.leaseToken} IS NULL AND ${t.leaseUntil} IS NULL END`),
]);

export const portableJobAttempts=pgTable('portable_job_attempts',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  number:integer('number').notNull(),
  startedAt:ms('started_at').notNull(),
  endedAt:ms('ended_at'),
  outcome:text('outcome'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId,t.number]}),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);

export const portableNotes=pgTable('portable_notes',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  body:text('body').notNull(),
  createdAt:ms('created_at').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId]}),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);


export const portableTaskJobs=pgTable('portable_task_jobs',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  payload:jsonb('payload').$type<z.output<typeof portableWorkflowTaskFields>>().notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId]}),
  foreignKey({name:'portable_task_job_fk',columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);

export const portableWorkerHeartbeat=pgTable('portable_worker_heartbeat',{
  id:integer('id').primaryKey(),
  lastPollAt:ms('last_poll_at').notNull(),
  lastQueuePollAt:ms('last_queue_poll_at'),
  lastGmailPollAt:ms('last_gmail_poll_at'),
  lastFullPollAt:ms('last_full_poll_at'),
},t=>[check('portable_worker_heartbeat_singleton',sql`${t.id}=1`)]);
