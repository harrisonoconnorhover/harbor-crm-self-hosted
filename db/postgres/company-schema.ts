import {recordUpdatedKey} from './record-updated-key';
import {activeListSearchIndex,customIdentifierIndex,recordSearchIndex} from './search-index';
import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import type {CompanyFields} from '../../lib/portable-records';
import {privateWorkspaces} from './workspace-schema';
import {loginIdentities} from './identity-schema';

export const companies=pgTable('companies',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  data:jsonb('data').$type<CompanyFields>().notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  // Set once when this Company is merged into another; it then stays archived.
  mergedIntoId:uuid('merged_into_id'),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('companies_archived_time_page').on(table.workspaceId,recordUpdatedKey(table.archivedAt),table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('companies_recent_page').on(table.workspaceId,recordUpdatedKey(table.updatedAt),table.id).where(sql`${table.archivedAt} IS NULL`),
  index('companies_active_domain').on(table.workspaceId,sql`lower(${table.data}->>'domain')`).where(sql`${table.archivedAt} IS NULL`),
  activeListSearchIndex('companies_list_search',table.archivedAt,sql`${table.data}->>'name'`,sql`${table.data}->>'domain'`),
  customIdentifierIndex('companies_custom_identifier',table.data,table.archivedAt),
  recordSearchIndex('companies_search_values',table.data,table.archivedAt),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'companies_merged_into_fk',columns:[table.workspaceId,table.mergedIntoId],foreignColumns:[table.workspaceId,table.id]}),
  check('companies_merged_archived',sql`${table.mergedIntoId} IS NULL OR (${table.archivedAt} IS NOT NULL AND ${table.mergedIntoId}<>${table.id})`),
]);

export const companyEvents=pgTable('company_events',{
  workspaceId:uuid('workspace_id').notNull(),
  companyId:uuid('company_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  previous:jsonb('previous').$type<CompanyFields>(),
  data:jsonb('data').$type<CompanyFields>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.companyId,table.revision]}),
  foreignKey({columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  index('company_events_time').on(table.workspaceId,table.occurredAt),
]);

export const companyArchiveReceipts=pgTable('portable_company_archive_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  companyId:uuid('company_id').notNull(),
  action:text('action').$type<'archive'|'restore'>().notNull(),
  revision:integer('revision').notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_company_archive_receipt_company_fk',columns:[table.workspaceId,table.companyId],
    foreignColumns:[companies.workspaceId,companies.id]}),
  check('portable_company_archive_receipt_action',sql`(${table.action}='archive' AND ${table.archivedAt} IS NOT NULL)
    OR (${table.action}='restore' AND ${table.archivedAt} IS NULL)`),
]);

// One receipt per merge request. A lost-response retry replays it; the
// secondary's last data is kept here because it no longer has a live record.
export const companyMergeReceipts=pgTable('portable_company_merge_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  primaryId:uuid('primary_id').notNull(),
  secondaryId:uuid('secondary_id').notNull(),
  primaryRevision:integer('primary_revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  secondaryData:jsonb('secondary_data').$type<CompanyFields>().notNull(),
  moved:jsonb('moved').$type<Record<string,number>>().notNull(),
  mergedAt:timestamp('merged_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_company_merge_primary_fk',columns:[table.workspaceId,table.primaryId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({name:'portable_company_merge_secondary_fk',columns:[table.workspaceId,table.secondaryId],foreignColumns:[companies.workspaceId,companies.id]}),
  unique('portable_company_merge_secondary').on(table.workspaceId,table.secondaryId),
  check('portable_company_merge_pair',sql`${table.primaryId}<>${table.secondaryId}`),
]);
