import {recordUpdatedKey} from './record-updated-key';
import {recordSearchIndex} from './search-index';
import {isNull,sql,type SQLWrapper} from 'drizzle-orm';
import {boolean,check,doublePrecision,foreignKey,index,integer,jsonb,pgTable,pgView,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import type {PortableTaskFields} from '../../lib/portable-tasks';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {portableTaskQueues} from './task-queue-schema';
import {privateWorkspaces} from './workspace-schema';

type TaskSnapshot={
  fields:PortableTaskFields;
  assigneeId:string|null;
  assigneeLabel:string|null;
  contactId:string|null;
  companyId?:string|null;
  dealId?:string|null;
  completedAt:string|null;
  queueId?:string|null;
};

export const taskRepeatDueAt=(data:SQLWrapper)=>sql<string>`(${data}->>'repeatDueAt')`;
export const pendingTaskRepeat=(data:SQLWrapper,completedAt:SQLWrapper,archivedAt:SQLWrapper)=>sql`
  ${archivedAt} IS NULL AND ${completedAt} IS NULL AND jsonb_typeof(${data}->'repeat') = 'object' AND ${taskRepeatDueAt(data)} IS NOT NULL`;

export const portableTasks=pgTable('portable_tasks',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  data:jsonb('data').$type<PortableTaskFields>().notNull(),
  assigneeId:text('assignee_id').references(()=>loginIdentities.id),
  assigneeLabel:text('assignee_label'),
  contactId:uuid('contact_id'),
  companyId:uuid('company_id'),
  dealId:uuid('deal_id'),
  queueId:uuid('queue_id'),
  completedAt:timestamp('completed_at',{withTimezone:true,mode:'string'}),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  reminderAt:timestamp('reminder_at',{withTimezone:true,mode:'string'}),
  reminderDismissedBy:text('reminder_dismissed_by'),
  repeatRetryRevision:integer('repeat_retry_revision'),
  repeatRetryAt:timestamp('repeat_retry_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('portable_tasks_archived_time_page').on(table.workspaceId,recordUpdatedKey(table.archivedAt),table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_tasks_recent_page').on(table.workspaceId,recordUpdatedKey(table.updatedAt),table.id).where(sql`${table.archivedAt} IS NULL`),
  recordSearchIndex('portable_tasks_search_values',table.data,table.archivedAt),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_task_contact_fk',columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({name:'portable_task_company_fk',columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({name:'portable_task_deal_fk',columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  foreignKey({name:'portable_task_queue_fk',columns:[table.workspaceId,table.queueId],foreignColumns:[portableTaskQueues.workspaceId,portableTaskQueues.id]}),
  index('portable_task_queue_order').on(table.workspaceId,table.queueId,table.id),
  check('portable_task_single_link',sql`num_nonnulls(${table.contactId},${table.companyId},${table.dealId}) <= 1`),
  check('portable_task_assignee_label',sql`(${table.assigneeId} IS NULL) = (${table.assigneeLabel} IS NULL)`),
  check('portable_task_completion',sql`${table.data}->>'status' IS NOT NULL AND
    ((${table.data}->>'status' = 'Completed' AND ${table.completedAt} IS NOT NULL)
      OR (${table.data}->>'status' = 'Not started' AND ${table.completedAt} IS NULL))`),
  index('portable_task_contact_order').on(table.workspaceId,table.contactId,table.id),
  index('portable_task_company_order').on(table.workspaceId,table.companyId,table.id),
  index('portable_task_deal_order').on(table.workspaceId,table.dealId,table.id),
  index('portable_task_archive_order').on(table.workspaceId,table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_task_status_order').on(table.workspaceId,sql`(${table.data}->>'status')`,table.id),
  index('portable_task_reminders_due').on(table.workspaceId,table.assigneeId,table.reminderAt,table.id)
    .where(sql`${table.archivedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.reminderAt} IS NOT NULL`),
  index('portable_task_repeat_due').on(taskRepeatDueAt(table.data),table.workspaceId,table.id)
    .where(pendingTaskRepeat(table.data,table.completedAt,table.archivedAt)),
  index('portable_task_repeat_workspace_due').on(table.workspaceId,taskRepeatDueAt(table.data),table.id)
    .where(pendingTaskRepeat(table.data,table.completedAt,table.archivedAt)),
]);

export const taskOwnership={workspaceId:portableTasks.workspaceId,assigneeId:portableTasks.assigneeId};
export const activeTask=isNull(portableTasks.archivedAt);

type TaskSnapshotSource=Pick<typeof portableTasks.$inferSelect,
  'data'|'assigneeId'|'assigneeLabel'|'contactId'|'companyId'|'dealId'|'completedAt'|'queueId'>;
export const portableTaskSnapshot=({data,assigneeId,assigneeLabel,contactId,companyId,dealId,queueId,completedAt}:TaskSnapshotSource):TaskSnapshot=>({
  fields:data,assigneeId,assigneeLabel,contactId,companyId,dealId,queueId,
  completedAt:completedAt&&new Date(completedAt).toISOString(),
});

export const taskEventContact=(data:SQLWrapper)=>sql<string>`${data}->>'contactId'`;
export const taskEventDeal=(data:SQLWrapper)=>sql<string>`${data}->>'dealId'`;
export const taskCompletedTransition=(data:SQLWrapper,previous:SQLWrapper)=>sql`
  ${data}->'fields'->>'status' = 'Completed' AND
  ${previous}->'fields'->>'status' IS DISTINCT FROM 'Completed'`;

export const portableTaskEvents=pgTable('portable_task_events',{
  workspaceId:uuid('workspace_id').notNull(),
  taskId:uuid('task_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  previous:jsonb('previous').$type<TaskSnapshot>(),
  data:jsonb('data').$type<TaskSnapshot>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.taskId,table.revision]}),
  foreignKey({name:'portable_task_event_task_fk',columns:[table.workspaceId,table.taskId],foreignColumns:[portableTasks.workspaceId,portableTasks.id]}),
  index('portable_task_completion_deal').on(table.workspaceId,sql`(${taskEventDeal(table.data)})`,table.occurredAt,table.taskId,table.revision)
    .where(taskCompletedTransition(table.data,table.previous)),
  index('portable_task_completion_contact').on(table.workspaceId,sql`(${taskEventContact(table.data)})`,table.occurredAt,table.taskId,table.revision)
    .where(taskCompletedTransition(table.data,table.previous)),
]);


// A consumed occurrence stays consumed if the predecessor or successor is archived.
export const portableTaskRepeatReceipts=pgTable('portable_task_repeat_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  predecessorId:uuid('predecessor_id').notNull(),
  successorId:uuid('successor_id').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.predecessorId]}),
  unique('portable_task_repeat_successor').on(table.workspaceId,table.successorId),
  check('portable_task_repeat_distinct',sql`${table.predecessorId} <> ${table.successorId}`),
]);

export const portableTaskArchiveReceipts=pgTable('portable_task_archive_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  taskId:uuid('task_id').notNull(),
  action:text('action').$type<'archive'|'restore'>().notNull(),
  revision:integer('revision').notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  nextTaskId:uuid('next_task_id'),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_task_archive_task_fk',columns:[table.workspaceId,table.taskId],foreignColumns:[portableTasks.workspaceId,portableTasks.id]}),
  check('portable_task_archive_action',sql`(${table.action}='archive' AND ${table.archivedAt} IS NOT NULL)
    OR (${table.action}='restore' AND ${table.archivedAt} IS NULL AND ${table.nextTaskId} IS NULL)`),
]);

const taskRepeatMonitorLimit=50;
const due=taskRepeatDueAt(portableTasks.data);
// Grant the monitor SELECT on this view without granting access to Task JSON or receipts.
// The unique-key receipt lookup preserves the due index order up to the result cap.
// Deferred Tasks remain in the backlog until repaired or successfully advanced.
export const portableTaskRepeatMonitor=pgView('portable_task_repeat_monitor',{
  dueCount:integer('due_count').notNull(),
  truncated:boolean('truncated').notNull(),
  oldestDueAgeSeconds:doublePrecision('oldest_due_age_seconds'),
}).as(sql`
  SELECT least(count(*)::integer,${taskRepeatMonitorLimit}) AS due_count,
    count(*)>${taskRepeatMonitorLimit} AS truncated,
    floor(extract(epoch FROM statement_timestamp()-min(candidate.due_at)::timestamptz))::double precision AS oldest_due_age_seconds
  FROM (
    SELECT ${due} AS due_at
    FROM ${portableTasks}
    WHERE ${pendingTaskRepeat(portableTasks.data,portableTasks.completedAt,portableTasks.archivedAt)}
      AND ${due}<=to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND (
        SELECT 1 FROM ${portableTaskRepeatReceipts}
        WHERE ${portableTaskRepeatReceipts.workspaceId}=${portableTasks.workspaceId}
          AND ${portableTaskRepeatReceipts.predecessorId}=${portableTasks.id}
      ) IS NULL
    ORDER BY ${due},${portableTasks.workspaceId},${portableTasks.id}
    LIMIT ${taskRepeatMonitorLimit+1}
  ) candidate
`);
