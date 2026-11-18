import {bigint,check,index,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {privateWorkspaces} from './workspace-schema';
import type {PortableOutreach} from '../../lib/portable-contact-activities';

export const portableActivityCreationReceipts=pgTable('portable_activity_creation_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  namespace:text('namespace').$type<'contact'|'record'>().notNull(),
  id:uuid('id').notNull(),
  fingerprint:text('fingerprint').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.namespace,table.id]}),
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
