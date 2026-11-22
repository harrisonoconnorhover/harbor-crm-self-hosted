import {sql} from 'drizzle-orm';
import {bigint,check,index,integer,pgTable,text,uuid} from 'drizzle-orm/pg-core';
import type {PortableExternalRecordKind} from '../../lib/portable-api-tokens';
import {privateWorkspaces} from './workspace-schema';

export const commerceAccessKinds=['products','quotes','invoices'] as const;
export type CommerceAccessKind=typeof commerceAccessKinds[number];
export type RecordAccessKind=PortableExternalRecordKind|CommerceAccessKind|'custom-objects';
export const integrationOperations=['read','create','update','archive'] as const;
export type IntegrationOperation=typeof integrationOperations[number];
export const recordAccessActions=['detail','list','csv','integration','search','report','related','history','document','duplicates','merge_preview','import_preview'] as const;

export const recordAccessEvents=pgTable('portable_record_access_events',{
  id:uuid('id').primaryKey().defaultRandom(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  actorId:text('actor_id').notNull(),
  actorEmail:text('actor_email').notNull(),
  tokenId:uuid('token_id'),
  integrationOperation:text('integration_operation',{enum:integrationOperations}),
  customObjectId:uuid('custom_object_id'),
  fileId:uuid('file_id'),fileVersionId:uuid('file_version_id'),fileRevision:integer('file_revision'),
  kind:text('kind').$type<RecordAccessKind>().notNull(),
  action:text('action',{enum:recordAccessActions}).notNull(),
  recordIds:uuid('record_ids').array().notNull(),
  occurredAt:bigint('occurred_at',{mode:'number'}).notNull().default(sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`),
},t=>[
  check('record_access_kind',sql`((${t.kind} IN ('contacts','companies','deals','tasks','leads','tickets') AND ${t.customObjectId} IS NULL) OR
    (${t.kind} IN ('products','quotes','invoices') AND ${t.customObjectId} IS NULL AND (${t.action} IN ('list','detail','csv') OR (${t.kind} IN ('quotes','invoices') AND ${t.action}='document'))) OR
    (${t.kind}='custom-objects' AND ${t.customObjectId} IS NOT NULL AND ${t.action} IN ('detail','list','search','related','csv')))`),
  check('record_access_action',sql`(${t.action} IN ('detail','list','csv','integration','search','report','related','history') OR (${t.action}='import_preview' AND ${t.kind} IN ('contacts','companies','deals')) OR (${t.action} IN ('duplicates','merge_preview') AND ${t.kind} IN ('contacts','companies')) OR (${t.action}='document' AND ${t.kind} IN ('contacts','quotes','invoices'))) AND ((${t.tokenId} IS NOT NULL) = (${t.action}='integration'))`),
  check('record_access_integration_operation',sql`${t.integrationOperation} IS NULL OR
    (${t.action}='integration' AND ${t.integrationOperation} IN ('read','create','update','archive')
    AND (${t.integrationOperation}='read' OR cardinality(${t.recordIds})=1))`),
  check('record_access_file_version',sql`(CASE WHEN ${t.kind}='contacts' AND ${t.action}='document'
    THEN ${t.fileId} IS NOT NULL AND ${t.fileVersionId} IS NOT NULL AND ${t.fileRevision} IS NOT NULL AND ${t.fileRevision}>0
    ELSE ${t.fileId} IS NULL AND ${t.fileVersionId} IS NULL AND ${t.fileRevision} IS NULL END)`),
  index('record_access_file_time').on(t.workspaceId,t.fileId,t.occurredAt,t.id).where(sql`${t.fileId} IS NOT NULL`),
  check('record_access_count',sql`cardinality(${t.recordIds}) BETWEEN 1 AND 500 AND (${t.action} NOT IN ('detail','document') OR cardinality(${t.recordIds})=1)`),
  index('record_access_workspace_time').on(t.workspaceId,t.occurredAt,t.id),
  index('record_access_workspace_token_time').on(t.workspaceId,t.tokenId,t.occurredAt,t.id).where(sql`${t.tokenId} IS NOT NULL`),
  index('record_access_workspace_email_time').on(t.workspaceId,sql`lower(${t.actorEmail})`,t.occurredAt,t.id),
  index('record_access_record_ids').using('gin',t.recordIds),
]);
