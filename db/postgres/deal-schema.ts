import {recordUpdatedKey} from './record-updated-key';
import {activeListSearchIndex,customIdentifierIndex,recordSearchIndex} from './search-index';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {DealFields} from '../../lib/portable-records';
import {dealPipelineStages} from './deal-pipeline-schema';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {eq,isNull,sql} from 'drizzle-orm';

export const deals=pgTable('deals',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  companyId:uuid('company_id'),
  pipelineId:uuid('pipeline_id'),
  stageId:uuid('stage_id'),
  primaryContactId:uuid('primary_contact_id'),
  data:jsonb('data').$type<DealFields>().notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('deals_archived_time_page').on(table.workspaceId,recordUpdatedKey(table.archivedAt),table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('deals_recent_page').on(table.workspaceId,recordUpdatedKey(table.updatedAt),table.id).where(sql`${table.archivedAt} IS NULL`),
  activeListSearchIndex('deals_list_search',table.archivedAt,sql`${table.data}->>'name'`),
  customIdentifierIndex('deals_custom_identifier',table.data,table.archivedAt),
  recordSearchIndex('deals_search_values',table.data,table.archivedAt),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({columns:[table.workspaceId,table.primaryContactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({columns:[table.workspaceId,table.pipelineId,table.stageId],
    foreignColumns:[dealPipelineStages.workspaceId,dealPipelineStages.pipelineId,dealPipelineStages.id]}),
  check('deals_custom_stage_pair',sql`(${table.pipelineId} IS NULL) = (${table.stageId} IS NULL)`),
  index('deals_workspace_pipeline').on(table.workspaceId,table.pipelineId,table.stageId,table.id),
  index('deals_workspace_company').on(table.workspaceId,table.companyId),
  index('deals_workspace_contact').on(table.workspaceId,table.primaryContactId),
  index('deals_workspace_stage').on(table.workspaceId,sql`(${table.data}->>'stage')`,table.id),
]);

export function dealPipelineScope(pipelineId:string){
  return pipelineId==='default'?isNull(deals.pipelineId):eq(deals.pipelineId,pipelineId);
}

export const dealEvents=pgTable('deal_events',{
  workspaceId:uuid('workspace_id').notNull(),
  dealId:uuid('deal_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  previous:jsonb('previous').$type<DealFields>(),
  previousPipelineId:uuid('previous_pipeline_id'),
  previousStageId:uuid('previous_stage_id'),
  previousCompanyId:uuid('previous_company_id'),
  companyId:uuid('company_id'),
  pipelineId:uuid('pipeline_id'),
  stageId:uuid('stage_id'),
  previousPrimaryContactId:uuid('previous_primary_contact_id'),
  primaryContactId:uuid('primary_contact_id'),
  data:jsonb('data').$type<DealFields>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.dealId,table.revision]}),
  foreignKey({columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  index('deal_events_time').on(table.workspaceId,table.occurredAt),
]);

export const dealArchiveReceipts=pgTable('portable_deal_archive_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  dealId:uuid('deal_id').notNull(),
  action:text('action').$type<'archive'|'restore'>().notNull(),
  revision:integer('revision').notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_deal_archive_receipt_deal_fk',columns:[table.workspaceId,table.dealId],
    foreignColumns:[deals.workspaceId,deals.id]}),
  check('portable_deal_archive_receipt_action',sql`(${table.action}='archive' AND ${table.archivedAt} IS NOT NULL)
    OR (${table.action}='restore' AND ${table.archivedAt} IS NULL)`),
]);
