import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {contactEvents} from './contact-schema';
import type {PortableWorkflowDefinition} from '../../lib/portable-workflows';
import {dealEvents} from './deal-schema';
import {portableJobs} from './job-schema';
import {privateWorkspaces} from './workspace-schema';

export const dealWorkflows=pgTable('portable_deal_workflows',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  definition:jsonb('definition').$type<PortableWorkflowDefinition>().notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.id]})]);

export const dealWorkflowActivations=pgTable('portable_workflow_activations',{
  workspaceId:uuid('workspace_id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.workflowId]}),
  foreignKey({columns:[t.workspaceId,t.workflowId],foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
]);

export const dealWorkflowRuns=pgTable('portable_workflow_runs',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  workflowName:text('workflow_name').notNull(),
  dealId:uuid('deal_id'),
  dealRevision:integer('deal_revision'),
  contactId:uuid('contact_id'),
  contactRevision:integer('contact_revision'),
  jobId:uuid('job_id'),
  issue:text('issue').$type<'missing_contact'|'queue_full'|'gmail_unavailable'|'email_address_missing'|'email_recipient_suppressed'>(),
  operatorReviewedAt:bigint('operator_reviewed_at',{mode:'number'}),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  unique('portable_workflow_trigger_receipt').on(t.workspaceId,t.workflowId,t.dealId,t.dealRevision),
  unique('portable_workflow_contact_receipt').on(t.workspaceId,t.workflowId,t.contactId,t.contactRevision),
  check('portable_workflow_run_source',sql`
    (${t.dealId} IS NOT NULL AND ${t.dealRevision} IS NOT NULL AND ${t.contactId} IS NULL AND ${t.contactRevision} IS NULL)
    OR (${t.dealId} IS NULL AND ${t.dealRevision} IS NULL AND ${t.contactId} IS NOT NULL AND ${t.contactRevision} IS NOT NULL)
  `),
  foreignKey({columns:[t.workspaceId,t.workflowId],foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  foreignKey({columns:[t.workspaceId,t.dealId,t.dealRevision],foreignColumns:[dealEvents.workspaceId,dealEvents.dealId,dealEvents.revision]}),
  foreignKey({columns:[t.workspaceId,t.contactId,t.contactRevision],foreignColumns:[contactEvents.workspaceId,contactEvents.contactId,contactEvents.revision]}),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
  index('portable_workflow_runs_by_time').on(t.workspaceId,t.createdAt,t.id),
  index('portable_workflow_capacity_review').on(t.workspaceId,t.createdAt,t.id)
    .where(sql`${t.issue}='queue_full' AND ${t.operatorReviewedAt} IS NULL`),
]);

export const manualWorkflowBatches=pgTable('portable_manual_workflow_batches',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  workflowName:text('workflow_name').notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({name:'portable_manual_workflow_batch_definition_fk',columns:[t.workspaceId,t.workflowId],
    foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
]);

// Manual jobs have a user-selected request ID rather than a CRM trigger revision.
export const manualWorkflowRuns=pgTable('portable_manual_workflow_runs',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  batchId:uuid('batch_id'),
  workflowId:uuid('workflow_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  workflowName:text('workflow_name').notNull(),
  contactId:uuid('contact_id').notNull(),
  contactRevision:integer('contact_revision').notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({name:'portable_manual_workflow_definition_fk',columns:[t.workspaceId,t.workflowId],
    foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  foreignKey({name:'portable_manual_workflow_contact_revision_fk',columns:[t.workspaceId,t.contactId,t.contactRevision],
    foreignColumns:[contactEvents.workspaceId,contactEvents.contactId,contactEvents.revision]}),
  foreignKey({name:'portable_manual_workflow_job_fk',columns:[t.workspaceId,t.id],
    foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
  foreignKey({name:'portable_manual_workflow_run_batch_fk',columns:[t.workspaceId,t.batchId],
    foreignColumns:[manualWorkflowBatches.workspaceId,manualWorkflowBatches.id]}),
  uniqueIndex('portable_manual_workflow_batch_contact').on(t.workspaceId,t.batchId,t.contactId).where(sql`${t.batchId} IS NOT NULL`),
  index('portable_manual_workflow_runs_by_time').on(t.workspaceId,t.createdAt,t.id),
  index('portable_manual_workflow_contact_history').on(t.workspaceId,t.workflowId,t.contactId),
]);


// Only the current action occupies a queue slot. Later actions have a reserved ID but no job row yet.
export const manualWorkflowRunActions=pgTable('portable_manual_workflow_run_actions',{
  workspaceId:uuid('workspace_id').notNull(),
  runId:uuid('run_id').notNull(),
  position:integer('position').notNull(),
  actionId:uuid('action_id').notNull(),
  name:text('name').notNull(),
  body:text('body').notNull(),
  delayMinutes:integer('delay_minutes').notNull(),
  plannedJobId:uuid('planned_job_id').notNull(),
  jobId:uuid('job_id'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.runId,t.position]}),
  unique('portable_manual_action_id').on(t.workspaceId,t.runId,t.actionId),
  unique('portable_manual_action_planned_job').on(t.workspaceId,t.plannedJobId),
  unique('portable_manual_action_job').on(t.workspaceId,t.jobId),
  check('portable_manual_action_bounds',sql`${t.position} BETWEEN 0 AND 4 AND ${t.delayMinutes} BETWEEN 0 AND 43200`),
  check('portable_manual_action_job_matches',sql`${t.jobId} IS NULL OR ${t.jobId}=${t.plannedJobId}`),
  foreignKey({name:'portable_manual_action_run_fk',columns:[t.workspaceId,t.runId],
    foreignColumns:[manualWorkflowRuns.workspaceId,manualWorkflowRuns.id]}),
  foreignKey({name:'portable_manual_action_job_fk',columns:[t.workspaceId,t.jobId],
    foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);

// The existing workflow activation remains the authority to poll. Progress is
// retained separately so a backup can restore it with every activation Off.
export const segmentWorkflowScans=pgTable('portable_segment_workflow_scans',{
  workspaceId:uuid('workspace_id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
  ownerId:text('owner_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  segmentRevision:integer('segment_revision').notNull(),
  epoch:uuid('epoch').notNull(),
  cursor:uuid('cursor'),
  baseline:boolean('baseline').notNull().default(true),
  nextAt:bigint('next_at',{mode:'number'}),
  cycleDueAt:bigint('cycle_due_at',{mode:'number'}),
  retryAt:bigint('retry_at',{mode:'number'}),
  waitingForCapacity:boolean('waiting_for_capacity').notNull().default(false),
},t=>[
  primaryKey({columns:[t.workspaceId,t.workflowId]}),
  foreignKey({name:'portable_segment_scan_workflow_fk',columns:[t.workspaceId,t.workflowId],
    foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  index('portable_segment_scans_due').on(t.nextAt,t.workspaceId,t.workflowId),
  index('portable_segment_scans_cycle_due').on(t.cycleDueAt).where(sql`${t.cycleDueAt} IS NOT NULL`),
]);

export const segmentWorkflowMembers=pgTable('portable_segment_workflow_members',{
  workspaceId:uuid('workspace_id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
  contactId:uuid('contact_id').notNull(),
  epoch:uuid('epoch').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.workflowId,t.contactId]}),
  foreignKey({name:'portable_segment_member_scan_fk',columns:[t.workspaceId,t.workflowId],
    foreignColumns:[segmentWorkflowScans.workspaceId,segmentWorkflowScans.workflowId]}),
]);
