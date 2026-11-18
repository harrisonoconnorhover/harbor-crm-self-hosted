import {jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {RecordImportResult} from '../../lib/portable-contact-import';
import {privateWorkspaces} from './workspace-schema';

// Keep the original table name so existing Contacts request receipts remain valid.
export const contactImportReceipts=pgTable('portable_contact_import_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  requestId:uuid('request_id').notNull(),
  requestHash:text('request_hash').notNull(),
  result:jsonb('result').$type<RecordImportResult>().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[primaryKey({columns:[table.workspaceId,table.requestId]})]);
