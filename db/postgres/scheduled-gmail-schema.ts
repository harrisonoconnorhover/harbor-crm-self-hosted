import {bigint,foreignKey,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {portableJobs} from './job-schema';

export const scheduledGmail=pgTable('portable_scheduled_gmail',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  sender:text('sender').notNull(),
  recipient:text('recipient').notNull(),
  subject:text('subject').notNull(),
  dispatchStartedAt:bigint('dispatch_started_at',{mode:'number'}),
  providerId:text('provider_id'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId]}),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);
