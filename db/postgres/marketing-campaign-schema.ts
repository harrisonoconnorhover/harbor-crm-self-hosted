import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {privateWorkspaces} from './workspace-schema';
import type {MarketingAudienceFilter} from '../../lib/marketing-audience';

export const marketingCampaigns=pgTable('portable_marketing_campaigns',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  filter:jsonb('filter').$type<MarketingAudienceFilter>().notNull(),
  sourceKey:text('source_key').notNull(),
  designId:uuid('design_id').notNull(),
  designRevision:integer('design_revision').notNull(),
  subject:text('subject').notNull(),html:text('html').notNull(),plainText:text('plain_text').notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  sendAfter:bigint('send_after',{mode:'number'}),
  paused:boolean('paused').notNull().default(false),
  audienceSize:integer('audience_size').notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),index('portable_marketing_campaign_order').on(t.workspaceId,t.createdAt)]);

export const marketingRecipients=pgTable('portable_marketing_recipients',{
  id:uuid('id').primaryKey().defaultRandom(),
  workspaceId:uuid('workspace_id').notNull(),campaignId:uuid('campaign_id').notNull(),email:text('email').notNull(),
  state:text('state').notNull().default('queued'),attempts:integer('attempts').notNull().default(0),
  dueAt:bigint('due_at',{mode:'number'}).notNull().default(0),
  providerId:text('provider_id'),lastIssue:text('last_issue'),
},t=>[foreignKey({name:'marketing_recipient_campaign_fk',columns:[t.workspaceId,t.campaignId],foreignColumns:[marketingCampaigns.workspaceId,marketingCampaigns.id]}),
  unique('portable_marketing_once_per_recipient').on(t.workspaceId,t.campaignId,t.email),
  index('portable_marketing_ready').on(t.workspaceId,t.dueAt,t.id).where(sql`${t.state} IN ('queued','retry','sending')`),
  index('portable_marketing_campaign_state').on(t.workspaceId,t.campaignId,t.state),
  check('portable_marketing_recipient_state',sql`${t.state} IN ('queued','sending','accepted','delivered','retry','uncertain','failed','skipped','suppressed','bounced','complained')`),
]);

// A restored campaign keeps its receipts but requires a new explicit sending decision.
export const marketingCampaignActivations=pgTable('portable_marketing_campaign_activations',{
  workspaceId:uuid('workspace_id').notNull(),campaignId:uuid('campaign_id').notNull(),
},t=>[primaryKey({name:'marketing_campaign_activation_pk',columns:[t.workspaceId,t.campaignId]}),
  foreignKey({name:'marketing_campaign_activation_fk',columns:[t.workspaceId,t.campaignId],foreignColumns:[marketingCampaigns.workspaceId,marketingCampaigns.id]})]);

// Form notifications and campaigns share this instance's single Resend connection.
export const marketingMailCooldown=pgTable('portable_marketing_mail_cooldown',{
  provider:text('provider').primaryKey(),
  until:bigint('until_ms',{mode:'number'}).notNull(),
},t=>[check('portable_marketing_mail_cooldown_provider',sql`${t.provider}='resend'`)]);
