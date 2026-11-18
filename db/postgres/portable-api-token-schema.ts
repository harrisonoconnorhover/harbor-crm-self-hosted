import {bigint,index,jsonb,pgTable,text,uuid} from 'drizzle-orm/pg-core';
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
