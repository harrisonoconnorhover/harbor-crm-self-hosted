import {sql} from 'drizzle-orm';
import {bigint,check,index,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

export const portableApiTokens=pgTable('portable_api_tokens',{
  id:uuid('id').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  issuerId:text('issuer_id').notNull(),
  name:text('name').notNull(),
  prefix:text('prefix').notNull(),
  tokenHash:text('token_hash').unique().notNull(),
  scopes:jsonb('scopes').$type<string[]>().notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  expiresAt:bigint('expires_at',{mode:'number'}).notNull(),
  revokedAt:bigint('revoked_at',{mode:'number'}),
},t=>[index('portable_api_token_workspace_list').on(t.workspaceId,t.createdAt,t.id)]);

export const recordDeletions=pgTable('portable_record_deletions',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  objectKind:text('object_kind').notNull(),
  recordId:uuid('record_id').notNull(),
  deletedAt:timestamp('deleted_at',{precision:3}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.objectKind,t.recordId]}),
  check('portable_record_deletion_kind',sql`${t.objectKind} IN ('contacts','companies','deals','tasks','leads','tickets')`),
  index('portable_record_deletion_window').on(t.workspaceId,t.objectKind,t.deletedAt,t.recordId),
]);
