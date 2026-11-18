import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {LeadFields,LeadSnapshot} from '../../lib/portable-leads';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const portableLeads=pgTable('portable_leads',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  companyId:uuid('company_id'),
  contactId:uuid('contact_id'),
  dealId:uuid('deal_id'),
  assigneeId:text('assignee_id').references(()=>loginIdentities.id),
  assigneeLabel:text('assignee_label'),
  data:jsonb('data').$type<LeadFields>().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  check('portable_leads_positive_revision',sql`${table.revision} > 0`),
  check('portable_leads_assignee_label',sql`(${table.assigneeId} IS NULL) = (${table.assigneeLabel} IS NULL)`),
  index('portable_leads_workspace_stage').on(table.workspaceId,sql`(${table.data}->>'leadStage')`,table.id),
  index('portable_leads_workspace_assignee').on(table.workspaceId,table.assigneeId,table.id),
]);

export const portableLeadEvents=pgTable('portable_lead_events',{
  workspaceId:uuid('workspace_id').notNull(),
  leadId:uuid('lead_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  previous:jsonb('previous').$type<LeadSnapshot>(),
  data:jsonb('data').$type<LeadSnapshot>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.leadId,table.revision]}),
  foreignKey({name:'portable_lead_event_lead_fk',columns:[table.workspaceId,table.leadId],foreignColumns:[portableLeads.workspaceId,portableLeads.id]}),
]);
