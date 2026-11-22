import {boolean,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {MarketingFields,SalesforceAudienceMapping} from '../../lib/marketing-audience';
import {privateWorkspaces} from './workspace-schema';

export const marketingAudienceSync=pgTable('portable_marketing_audience_sync',{
  workspaceId:uuid('workspace_id').primaryKey().references(()=>privateWorkspaces.id),
  generation:uuid('generation').notNull(),
  sourceKey:text('source_key').notNull(),
  state:text('state').notNull().$type<'syncing'|'failed'|'ready'>(),
  mapping:jsonb('mapping').notNull().$type<SalesforceAudienceMapping>(),
  startedAt:timestamp('started_at',{withTimezone:true,mode:'string'}).notNull(),
  progressedAt:timestamp('progressed_at',{withTimezone:true,mode:'string'}).notNull(),
  completedAt:timestamp('completed_at',{withTimezone:true,mode:'string'}),
  contactCount:integer('contact_count').notNull().default(0),
  accountCount:integer('account_count').notNull().default(0),
  relatedCount:integer('related_count').notNull().default(0),
});

// One row per provider ID. A complete pass removes rows from older generations.
// Access to all three mirrors goes through the workspace's fresh, completed generation.
export const marketingAudienceContacts=pgTable('portable_marketing_audience_contacts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:text('id').notNull(),
  generation:uuid('generation').notNull(),
  email:text('email'),
  accountId:text('account_id'),
  eligible:boolean('eligible').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  index('portable_marketing_audience_email').on(t.workspaceId,t.email),
]);

export const marketingAudienceAccounts=pgTable('portable_marketing_audience_accounts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:text('id').notNull(),
  generation:uuid('generation').notNull(),
  fields:jsonb('fields').notNull().$type<MarketingFields>(),
},t=>[primaryKey({columns:[t.workspaceId,t.id]})]);

export const marketingAudienceRelated=pgTable('portable_marketing_audience_related',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:text('id').notNull(),
  generation:uuid('generation').notNull(),
  accountId:text('account_id'),
  fields:jsonb('fields').notNull().$type<MarketingFields>(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  index('portable_marketing_audience_related_account').on(t.workspaceId,t.accountId),
]);
