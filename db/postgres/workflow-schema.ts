import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {objectRecords} from './custom-object-schema';
import {companyEvents} from './company-schema';
import {portableTasks} from './task-schema';
import {contactEvents} from './contact-schema';
import type {PortableConditionalPaths,PortableWorkflowDefinition} from '../../lib/portable-workflows';
import {dealEvents} from './deal-schema';
import {portableTicketEvents} from './ticket-schema';
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
  customObjectId:uuid('custom_object_id'),
  customRecordId:uuid('custom_record_id'),
  customRecordRevision:integer('custom_record_revision'),
  customRecordName:text('custom_record_name'),
  customObjectName:text('custom_object_name'),
  customTaskId:uuid('custom_task_id'),
  companyId:uuid('company_id'),
  companyRevision:integer('company_revision'),
  companyTaskId:uuid('company_task_id'),
  ticketId:uuid('ticket_id'),
  ticketRevision:integer('ticket_revision'),
  jobId:uuid('job_id'),
  issue:text('issue').$type<'missing_contact'|'queue_full'|'gmail_unavailable'|'email_address_missing'|'email_recipient_suppressed'>(),
  operatorReviewedAt:bigint('operator_reviewed_at',{mode:'number'}),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  unique('portable_workflow_trigger_receipt').on(t.workspaceId,t.workflowId,t.dealId,t.dealRevision),
  unique('portable_workflow_contact_receipt').on(t.workspaceId,t.workflowId,t.contactId,t.contactRevision),
  unique('portable_workflow_ticket_receipt').on(t.workspaceId,t.workflowId,t.ticketId,t.ticketRevision),
  unique('portable_workflow_company_creation_receipt').on(t.workspaceId,t.workflowId,t.companyId),
  uniqueIndex('portable_workflow_custom_event_receipt').on(t.workspaceId,t.workflowId,t.customObjectId,t.customRecordId,sql`coalesce(${t.customRecordRevision},1)`)
    .where(sql`${t.customRecordId} IS NOT NULL`),
  check('portable_workflow_custom_revision',sql`${t.customRecordRevision} IS NULL OR (${t.customRecordId} IS NOT NULL AND ${t.customRecordRevision}>1)`),
  check('portable_workflow_custom_task',sql`
    num_nonnulls(${t.customObjectId},${t.customRecordId},${t.customTaskId},${t.customObjectName},${t.customRecordName}) IN (0,5)
    AND (${t.customRecordId} IS NULL OR (${t.customTaskId}=${t.id} AND ${t.jobId} IS NULL AND ${t.issue} IS NULL
      AND length(${t.customRecordName}) BETWEEN 1 AND 100 AND length(${t.customObjectName}) BETWEEN 1 AND 100))
  `),
  check('portable_workflow_company_task',sql`
    ((${t.companyId} IS NULL) = (${t.companyTaskId} IS NULL))
    AND (${t.companyId} IS NULL OR (${t.companyRevision}=1 AND ${t.jobId} IS NULL AND ${t.issue} IS NULL))
  `),
  check('portable_workflow_run_source',sql`
    num_nonnulls(${t.dealId},${t.contactId},${t.ticketId},${t.companyId},${t.customRecordId}) = 1
    AND ((${t.companyId} IS NULL) = (${t.companyRevision} IS NULL))
    AND ((${t.dealId} IS NULL) = (${t.dealRevision} IS NULL))
    AND ((${t.contactId} IS NULL) = (${t.contactRevision} IS NULL))
    AND ((${t.ticketId} IS NULL) = (${t.ticketRevision} IS NULL))
  `),
  foreignKey({columns:[t.workspaceId,t.workflowId],foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  foreignKey({columns:[t.workspaceId,t.dealId,t.dealRevision],foreignColumns:[dealEvents.workspaceId,dealEvents.dealId,dealEvents.revision]}),
  foreignKey({columns:[t.workspaceId,t.contactId,t.contactRevision],foreignColumns:[contactEvents.workspaceId,contactEvents.contactId,contactEvents.revision]}),
  foreignKey({name:'portable_workflow_custom_record_fk',columns:[t.workspaceId,t.customObjectId,t.customRecordId],foreignColumns:[objectRecords.workspaceId,objectRecords.objectId,objectRecords.id]}),
  foreignKey({name:'portable_workflow_custom_task_fk',columns:[t.workspaceId,t.customTaskId],foreignColumns:[portableTasks.workspaceId,portableTasks.id]}),
  foreignKey({name:'portable_workflow_run_company_revision_fk',columns:[t.workspaceId,t.companyId,t.companyRevision],foreignColumns:[companyEvents.workspaceId,companyEvents.companyId,companyEvents.revision]}),
  foreignKey({name:'portable_workflow_run_company_task_fk',columns:[t.workspaceId,t.companyTaskId],foreignColumns:[portableTasks.workspaceId,portableTasks.id]}),
  foreignKey({name:'portable_workflow_run_ticket_revision_fk',columns:[t.workspaceId,t.ticketId,t.ticketRevision],foreignColumns:[portableTicketEvents.workspaceId,portableTicketEvents.ticketId,portableTicketEvents.revision]}),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
  index('portable_workflow_runs_by_time').on(t.workspaceId,t.createdAt,t.id),
  index('portable_workflow_custom_history').on(t.workspaceId,t.customObjectId,t.customRecordId,t.createdAt,t.id)
    .where(sql`${t.customRecordId} IS NOT NULL`),
  index('portable_workflow_company_history').on(t.workspaceId,t.companyId,t.createdAt,t.id)
    .where(sql`${t.companyId} IS NOT NULL`),
  index('portable_workflow_ticket_history').on(t.workspaceId,t.ticketId,t.createdAt,t.id)
    .where(sql`${t.ticketId} IS NOT NULL`),
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

// The worker processes the chosen job normally. History keeps its original decision after workflow edits.
export const workflowPathReceipts=pgTable('portable_workflow_path_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  pathId:uuid('path_id').notNull(),
  pathName:text('path_name').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId]}),
  foreignKey({name:'portable_workflow_path_job_fk',columns:[t.workspaceId,t.jobId],
    foreignColumns:[portableJobs.workspaceId,portableJobs.id]}).onDelete('cascade'),
  check('portable_workflow_path_name',sql`length(btrim(${t.pathName})) BETWEEN 1 AND 80`),
]);

// Only the configured destination name is stored with an enrollment. Receivers and secrets belong to the worker.
export const workflowWebhookJobs=pgTable('portable_workflow_webhook_jobs',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  workflowId:uuid('workflow_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  pathId:uuid('path_id').notNull(),
  destination:text('destination').notNull(),
  objectKind:text('object_kind').$type<'contacts'|'deals'|'tickets'>().notNull(),
  recordId:uuid('record_id').notNull(),
  recordRevision:integer('record_revision').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.jobId]}),
  foreignKey({name:'workflow_webhook_job_fk',columns:[t.workspaceId,t.jobId],foreignColumns:[workflowPathReceipts.workspaceId,workflowPathReceipts.jobId]}).onDelete('cascade'),
  foreignKey({name:'workflow_webhook_definition_fk',columns:[t.workspaceId,t.workflowId],foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  check('workflow_webhook_record',sql`${t.objectKind} IN ('contacts','deals','tickets') AND ${t.recordRevision}>0 AND ${t.workflowRevision}>0`),
  check('workflow_webhook_destination',sql`length(btrim(${t.destination})) BETWEEN 1 AND 80`),
]);


// Only the winning path is captured. A job ID is attached when the preceding step succeeds.
export const workflowPathSteps=pgTable('portable_workflow_path_steps',{
  workspaceId:uuid('workspace_id').notNull(),
  runId:uuid('run_id').notNull(),
  position:integer('position').notNull(),
  actionId:uuid('action_id').notNull(),
  plannedJobId:uuid('planned_job_id').notNull(),
  jobId:uuid('job_id'),
  action:jsonb('action').$type<PortableConditionalPaths['otherwise']['action']>().notNull(),
  workflowId:uuid('workflow_id').notNull(),
  workflowRevision:integer('workflow_revision').notNull(),
  objectKind:text('object_kind').$type<'contacts'|'deals'|'tickets'>().notNull(),
  recordId:uuid('record_id').notNull(),
  recordRevision:integer('record_revision').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.runId,t.position]}),
  unique('portable_path_step_action').on(t.workspaceId,t.runId,t.actionId),
  unique('portable_path_step_planned_job').on(t.workspaceId,t.plannedJobId),
  foreignKey({name:'portable_path_step_root',columns:[t.workspaceId,t.runId],foreignColumns:[workflowPathReceipts.workspaceId,workflowPathReceipts.jobId]}),
  foreignKey({name:'portable_path_step_job',columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
  foreignKey({name:'portable_path_step_workflow',columns:[t.workspaceId,t.workflowId],foreignColumns:[dealWorkflows.workspaceId,dealWorkflows.id]}),
  check('portable_path_step_identity',sql`${t.position} BETWEEN 0 AND 4
    AND (${t.jobId} IS NULL OR ${t.jobId}=${t.plannedJobId})
    AND (${t.position}>0 OR (${t.jobId} IS NOT NULL AND ${t.jobId}=${t.runId}))`),
  check('portable_path_step_action_shape',sql`jsonb_typeof(${t.action})='object' AND ${t.action} ? 'kind'
    AND (${t.action}->>'kind') IS NOT NULL AND ${t.action}->>'kind' IN ('note','task','webhook')`),
  check('portable_path_step_source',sql`${t.workflowRevision}>0 AND ${t.recordRevision}>0 AND ${t.objectKind} IN ('contacts','deals','tickets')`),
]);
