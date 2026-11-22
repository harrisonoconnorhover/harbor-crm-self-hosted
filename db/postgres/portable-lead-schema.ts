import {recordUpdatedKey} from './record-updated-key';
import {activeListSearchIndex,recordSearchIndex} from './search-index';
import {isNull,sql} from 'drizzle-orm';
import {boolean,check,date,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid,varchar} from 'drizzle-orm/pg-core';
import type {RoutingMiss} from '../../lib/portable-lead-routing';
import type {LeadEventData,LeadFields,LeadSnapshot} from '../../lib/portable-leads';
import {companies} from './company-schema';
import {leadForms} from './lead-form-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

import {workspaceViewers} from './workspace-viewer-schema';

export const portableLeads=pgTable('portable_leads',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  companyId:uuid('company_id'),
  contactId:uuid('contact_id'),
  dealId:uuid('deal_id'),
  routingRetryAt:timestamp('routing_retry_at',{withTimezone:true,mode:'string'}),
  routingMiss:jsonb('routing_miss').$type<RoutingMiss>(),
  intakeRegion:varchar('intake_region',{length:100}),
  intakeCountry:varchar('intake_country',{length:100}),
  assigneeId:text('assignee_id').references(()=>loginIdentities.id),
  assigneeLabel:text('assignee_label'),
  data:jsonb('data').$type<LeadFields>().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('portable_leads_archived_time_page').on(table.workspaceId,recordUpdatedKey(table.archivedAt),table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_leads_recent_page').on(table.workspaceId,recordUpdatedKey(table.updatedAt),table.id).where(sql`${table.archivedAt} IS NULL`),
  index('portable_leads_open_assignee').on(table.workspaceId,table.assigneeId)
    .where(sql`${table.archivedAt} IS NULL AND ${table.dealId} IS NULL AND ${table.data}->>'leadStage' NOT IN ('Qualified','Disqualified')`),
  index('portable_leads_open_created').on(table.workspaceId,table.createdAt,table.id)
    .where(sql`${table.archivedAt} IS NULL AND ${table.dealId} IS NULL AND ${table.data}->>'leadStage' NOT IN ('Qualified','Disqualified')`),
  index('portable_leads_workspace_routing_due').on(table.workspaceId,table.routingRetryAt,table.id)
    .where(sql`${table.routingRetryAt} IS NOT NULL AND ${table.archivedAt} IS NULL AND ${table.assigneeId} IS NULL AND ${table.dealId} IS NULL`),
  index('portable_leads_routing_due').on(table.routingRetryAt,table.workspaceId,table.id)
    .where(sql`${table.routingRetryAt} IS NOT NULL AND ${table.archivedAt} IS NULL AND ${table.assigneeId} IS NULL AND ${table.dealId} IS NULL`),
  index('portable_leads_contact_open').on(table.workspaceId,table.contactId).where(sql`${table.archivedAt} IS NULL AND ${table.dealId} IS NULL`),
  index('portable_leads_archive_page').on(table.workspaceId,table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  activeListSearchIndex('portable_leads_list_search',table.archivedAt,sql`${table.data}->>'name'`),
  recordSearchIndex('portable_leads_search_values',table.data),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  check('portable_leads_positive_revision',sql`${table.revision} > 0`),
  check('portable_leads_assignee_label',sql`(${table.assigneeId} IS NULL) = (${table.assigneeLabel} IS NULL)`),
  index('portable_leads_workspace_stage').on(table.workspaceId,sql`(${table.data}->>'leadStage')`,table.id),
  index('portable_leads_workspace_assignee').on(table.workspaceId,table.assigneeId,table.id),
]);

export const leadOwnership={workspaceId:portableLeads.workspaceId,assigneeId:portableLeads.assigneeId};

export const portableLeadEvents=pgTable('portable_lead_events',{
  workspaceId:uuid('workspace_id').notNull(),
  leadId:uuid('lead_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').references(()=>loginIdentities.id),
  intakeFormId:uuid('intake_form_id'),
  capturedNewContact:boolean('captured_new_contact').notNull().default(false),
  automaticRouting:boolean('automatic_routing').notNull().default(false),
  previous:jsonb('previous').$type<LeadSnapshot>(),
  data:jsonb('data').$type<LeadEventData>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.leadId,table.revision]}),
  foreignKey({name:'portable_lead_event_form_fk',columns:[table.workspaceId,table.intakeFormId],foreignColumns:[leadForms.workspaceId,leadForms.id]}),
  check('portable_lead_event_captured_contact',sql`NOT ${table.capturedNewContact} OR (${table.revision}=1 AND ${table.intakeFormId} IS NOT NULL AND ${table.data}->>'contactId' IS NOT NULL AND ${table.data}->>'assigneeId' IS NULL)`),
  check('portable_lead_event_source',sql`num_nonnulls(${table.actorId},${table.intakeFormId}) + ${table.automaticRouting}::integer = 1`),
  foreignKey({name:'portable_lead_event_lead_fk',columns:[table.workspaceId,table.leadId],foreignColumns:[portableLeads.workspaceId,portableLeads.id]}),
]);

// Membership deletion also removes the rule, so a new grant cannot revive an old routing seat.
export const leadRoutingMembers=pgTable('portable_lead_routing_members',{
  workspaceId:uuid('workspace_id').notNull(),userId:text('user_id').notNull(),
  available:boolean('available').notNull(),awayThrough:date('away_through'),country:text('country').notNull(),
  regions:varchar('regions',{length:100}).array().notNull().default(sql`'{}'::varchar[]`),
  additionalCountries:varchar('additional_countries',{length:100}).array().notNull().default(sql`'{}'::varchar[]`),
  capacity:integer('capacity').notNull(),timeZone:text('time_zone').notNull(),
  days:integer('days').notNull(),start:integer('start_minute').notNull(),end:integer('end_minute').notNull(),
  revision:integer('revision').notNull(),lastAssignedAt:timestamp('last_assigned_at',{withTimezone:true,mode:'string'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.userId]}),
  foreignKey({columns:[table.workspaceId,table.userId],foreignColumns:[workspaceViewers.workspaceId,workspaceViewers.viewerId]}).onDelete('cascade'),
  check('portable_routing_regions',sql`cardinality(${table.regions})<=50 AND
    (cardinality(${table.regions})=0 OR (${table.country}<>'' AND cardinality(${table.additionalCountries})=0 AND array_ndims(${table.regions})=1))
    AND array_position(${table.regions},NULL) IS NULL AND array_position(${table.regions},'') IS NULL`),
  check('portable_routing_countries',sql`cardinality(${table.additionalCountries})<=49
    AND (cardinality(${table.additionalCountries})=0 OR (${table.country}<>'' AND array_ndims(${table.additionalCountries})=1))
    AND array_position(${table.additionalCountries},NULL) IS NULL AND array_position(${table.additionalCountries},'') IS NULL`),
  check('portable_routing_limits',sql`${table.capacity} BETWEEN 1 AND 10000 AND ${table.revision}>0
    AND ${table.days} BETWEEN 1 AND 127 AND ${table.start} BETWEEN 0 AND 1439 AND ${table.end} BETWEEN 1 AND 1440 AND ${table.start}<>${table.end}
    AND length(${table.country})<=100 AND length(${table.timeZone}) BETWEEN 1 AND 100`),
]);

export const activeLead=isNull(portableLeads.archivedAt);
