import {sql} from 'drizzle-orm';
import {bigint,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {SalesSequenceStep,SalesEnrollmentState,SalesStepState} from '../../lib/portable-sales-sequences';
import {contacts} from './contact-schema';
import {privateWorkspaces} from './workspace-schema';
import {loginIdentities} from './identity-schema';
import {portableJobs} from './job-schema';
import {teamBookings} from './portable-meeting-schema';
import {portableTasks} from './task-schema';

const ms=(name:string)=>bigint(name,{mode:'number'});
export const salesSequences=pgTable('portable_sales_sequences',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),id:uuid('id').notNull(),
  name:text('name').notNull(),revision:integer('revision').notNull(),steps:jsonb('steps').$type<SalesSequenceStep[]>().notNull(),
  createdAt:ms('created_at').notNull(),updatedAt:ms('updated_at').notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),
  check('sales_sequence_valid_steps',sql`${t.revision}>0 AND jsonb_typeof(${t.steps})='array' AND jsonb_array_length(${t.steps}) BETWEEN 1 AND 20`)]);

export const salesEnrollments=pgTable('portable_sales_enrollments',{
  workspaceId:uuid('workspace_id').notNull(),id:uuid('id').notNull(),sequenceId:uuid('sequence_id').notNull(),
  sequenceRevision:integer('sequence_revision').notNull(),sequenceName:text('sequence_name').notNull(),
  contactId:uuid('contact_id').notNull(),contactName:text('contact_name').notNull(),recipient:text('recipient'),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),sender:text('sender').notNull(),
  assigneeId:text('assignee_id').notNull().references(()=>loginIdentities.id),assigneeLabel:text('assignee_label').notNull(),
  state:text('state').$type<SalesEnrollmentState>().notNull(),issue:text('issue'),createdAt:ms('created_at').notNull(),finishedAt:ms('finished_at'),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({name:'sales_enrollment_sequence_fk',columns:[t.workspaceId,t.sequenceId],foreignColumns:[salesSequences.workspaceId,salesSequences.id]}),
  foreignKey({name:'sales_enrollment_contact_fk',columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  uniqueIndex('sales_enrollment_open_contact').on(t.workspaceId,t.contactId,t.sequenceId).where(sql`${t.state} IN ('active','attention')`),
  index('sales_enrollment_state_history').on(t.workspaceId,t.state,t.createdAt,t.id),
  index('sales_enrollment_contact_list').on(t.workspaceId,t.contactId,t.id),
  check('sales_enrollment_state',sql`${t.state} IN ('active','completed','stopped','attention') AND ${t.sequenceRevision}>0`)]);

export const salesSequenceSteps=pgTable('portable_sales_sequence_steps',{
  workspaceId:uuid('workspace_id').notNull(),enrollmentId:uuid('enrollment_id').notNull(),id:uuid('id').notNull(),
  position:integer('position').notNull(),definition:jsonb('definition').$type<SalesSequenceStep>().notNull(),
  state:text('state').$type<SalesStepState>().notNull(),dueAt:ms('due_at'),jobId:uuid('job_id'),taskId:uuid('task_id'),
  finishedAt:ms('finished_at'),issue:text('issue'),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),
  unique('sales_step_order').on(t.workspaceId,t.enrollmentId,t.position),
  foreignKey({name:'sales_step_enrollment_fk',columns:[t.workspaceId,t.enrollmentId],foreignColumns:[salesEnrollments.workspaceId,salesEnrollments.id]}),
  foreignKey({name:'sales_step_job_fk',columns:[t.workspaceId,t.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
  foreignKey({name:'sales_step_task_fk',columns:[t.workspaceId,t.taskId],foreignColumns:[portableTasks.workspaceId,portableTasks.id]}),
  uniqueIndex('sales_step_job').on(t.workspaceId,t.jobId).where(sql`${t.jobId} IS NOT NULL`),
  uniqueIndex('sales_step_task').on(t.workspaceId,t.taskId).where(sql`${t.taskId} IS NOT NULL`),
  index('sales_steps_due').on(t.dueAt,t.workspaceId,t.id).where(sql`${t.state} IN ('ready','queued')`),
  check('sales_step_position',sql`${t.position} BETWEEN 0 AND 19`),
  check('sales_step_state',sql`${t.state} IN ('waiting','ready','queued','completed','stopped','attention') AND num_nonnulls(${t.jobId},${t.taskId})<=1`)]);

export const salesSequenceActivations=pgTable('portable_sales_sequence_activations',{
  workspaceId:uuid('workspace_id').notNull(),enrollmentId:uuid('enrollment_id').notNull(),
  teamBookingId:uuid('team_booking_id'),
},t=>[primaryKey({columns:[t.workspaceId,t.enrollmentId]}),
  foreignKey({name:'sales_activation_booking_fk',columns:[t.workspaceId,t.teamBookingId],foreignColumns:[teamBookings.workspaceId,teamBookings.id]}),
  foreignKey({name:'sales_activation_enrollment_fk',columns:[t.workspaceId,t.enrollmentId],foreignColumns:[salesEnrollments.workspaceId,salesEnrollments.id]})]);
