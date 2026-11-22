import {sql} from 'drizzle-orm';
import {bigint,boolean,check,index,integer,jsonb,pgTable,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {AccountDefaults} from '../../lib/portable-account-defaults';
import {loginIdentities} from './identity-schema';

export const privateWorkspaces=pgTable('private_workspaces',{
  id:uuid('id').primaryKey(),
  accountDefaults:jsonb('account_defaults').$type<AccountDefaults>(),
  accountDefaultsRevision:integer('account_defaults_revision').notNull().default(0),
  ownerId:text('owner_id').notNull().unique().references(()=>loginIdentities.id),
  balanceLeadsByCapacity:boolean('balance_leads_by_capacity').default(false).notNull(),
  roundRobinLeads:boolean('round_robin_leads').default(false).notNull(),
  fiscalStartMonth:integer('fiscal_start_month').default(1).notNull(),
  lastSalesSequenceAt:bigint('last_sales_sequence_at',{mode:'number'}),
  lastJobClaimAt:bigint('last_job_claim_at',{mode:'number'}),
  lastLeadRoutingAt:timestamp('last_lead_routing_at',{withTimezone:true,mode:'string'}),
  lastTaskRepeatAt:timestamp('last_task_repeat_at',{withTimezone:true,mode:'string'}),
  lastFormNotePromotionAt:timestamp('last_form_note_promotion_at',{withTimezone:true,mode:'string'}),
},table=>[
  check('workspace_defaults_consistent',sql`(${table.accountDefaults} IS NULL AND ${table.accountDefaultsRevision}=0)
    OR (${table.accountDefaultsRevision}>0 AND ${table.accountDefaults} IS NOT NULL AND jsonb_typeof(${table.accountDefaults})='object'
      AND ${table.accountDefaults} ?& ARRAY['name','timeZone','currency','language','dateFormat','numberFormat']
      AND jsonb_typeof(${table.accountDefaults}->'name')='string' AND length(btrim(${table.accountDefaults}->>'name')) BETWEEN 1 AND 100
      AND jsonb_typeof(${table.accountDefaults}->'timeZone')='string' AND length(${table.accountDefaults}->>'timeZone') BETWEEN 1 AND 100
      AND coalesce(${table.accountDefaults}->>'currency' ~ '^[A-Z]{3}$',false)
      AND coalesce(${table.accountDefaults}->>'language' IN ('en','de','es','fr','it','ja','pt'),false)
      AND coalesce(${table.accountDefaults}->>'dateFormat' IN ('language','mdy','dmy','ymd'),false)
      AND coalesce(${table.accountDefaults}->>'numberFormat' IN ('language','en-US','de-DE','fr-FR'),false))`),
  check('workspace_lead_distribution',sql`NOT (${table.roundRobinLeads} AND ${table.balanceLeadsByCapacity})`),
  check('workspace_fiscal_start_month',sql`${table.fiscalStartMonth} BETWEEN 1 AND 12`),
  index('private_workspace_lead_routing_order').on(table.lastLeadRoutingAt.asc().nullsFirst(),table.id),
  index('private_workspace_task_repeat_order').on(table.lastTaskRepeatAt.asc().nullsFirst(),table.id),
  index('private_workspace_form_note_order').on(table.lastFormNotePromotionAt.asc().nullsFirst(),table.id),
]);
