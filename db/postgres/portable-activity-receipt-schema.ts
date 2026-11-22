import {bigint,check,index,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {privateWorkspaces} from './workspace-schema';
import type {PortableOutreach} from '../../lib/portable-contact-activities';

export const portableActivityCreationReceipts=pgTable('portable_activity_creation_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  namespace:text('namespace').$type<'contact'|'record'>().notNull(),
  id:uuid('id').notNull(),
  fingerprint:text('fingerprint').notNull(),
  outlookContactId:uuid('outlook_contact_id'),
  outlookMailbox:text('outlook_mailbox'),
  outlookReceivedAt:bigint('outlook_received_at',{mode:'number'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.namespace,table.id]}),
  index('portable_outlook_contact_received').on(table.workspaceId,table.outlookContactId,table.outlookMailbox,table.outlookReceivedAt)
    .where(sql`${table.outlookReceivedAt} IS NOT NULL`),
  check('portable_outlook_reply_receipt',sql`num_nonnulls(${table.outlookContactId},${table.outlookMailbox},${table.outlookReceivedAt}) = 0 OR
    (${table.namespace}='contact' AND ${table.fingerprint} LIKE 'outlook:%' AND num_nonnulls(${table.outlookContactId},${table.outlookMailbox},${table.outlookReceivedAt}) = 3)`),
  check('portable_activity_receipt_namespace',sql`${table.namespace} IN ('contact','record')`),
]);

export const portableActivityRemovals=pgTable('portable_activity_removals',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  recordKind:text('record_kind').$type<'contacts'|'companies'|'deals'>().notNull(),
  recordId:uuid('record_id').notNull(),
  id:uuid('id').notNull(),
  kind:text('kind').$type<PortableOutreach['kind']>().notNull(),
  removedAt:bigint('removed_at',{mode:'number'}).notNull(),
  removedById:text('removed_by_id').notNull(),
  removedBy:text('removed_by').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.recordKind,table.id]}),
  index('portable_activity_removal_order').on(table.workspaceId,table.recordKind,table.recordId,table.removedAt,table.id),
  check('portable_activity_removal_home',sql`${table.recordKind} IN ('contacts','companies','deals')`),
]);
