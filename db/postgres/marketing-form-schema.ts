import {sql} from 'drizzle-orm';
import {bigint,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import {leadForms,leadInquiries} from './lead-form-schema';

export const marketingFormRoutes=pgTable('portable_marketing_form_routes',{
  workspaceId:uuid('workspace_id').notNull(),
  formId:uuid('form_id').notNull(),
  routeId:uuid('route_id').notNull(),
  recipients:jsonb('recipients').$type<string[]>().notNull(),
  salesforceTarget:text('salesforce_target'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.formId]}),
  foreignKey({name:'marketing_route_form_fk',columns:[t.workspaceId,t.formId],foreignColumns:[leadForms.workspaceId,leadForms.id]}),
]);

export type FormDeliveryState='pending'|'sending'|'succeeded'|'uncertain'|'failed'|'skipped';

export const marketingFormDeliveries=pgTable('portable_marketing_form_deliveries',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  inquiryId:uuid('inquiry_id').notNull(),
  formId:uuid('form_id').notNull(),
  routeId:uuid('route_id').notNull(),
  kind:text('kind').$type<'email'|'salesforce'>().notNull(),
  destination:text('destination').notNull(),
  state:text('state').$type<FormDeliveryState>().notNull(),
  attempts:integer('attempts').notNull().default(0),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  updatedAt:bigint('updated_at',{mode:'number'}).notNull(),
  nextAt:bigint('next_at',{mode:'number'}),
  issue:text('issue'),
  receipt:text('receipt'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  unique('marketing_form_once').on(t.workspaceId,t.inquiryId,t.kind,t.destination),
  foreignKey({name:'marketing_delivery_source_fk',columns:[t.workspaceId,t.inquiryId],foreignColumns:[leadInquiries.workspaceId,leadInquiries.id]}),
  foreignKey({name:'marketing_delivery_form_fk',columns:[t.workspaceId,t.formId],foreignColumns:[leadForms.workspaceId,leadForms.id]}),
  index('marketing_form_delivery_ready').on(t.workspaceId,t.nextAt,t.id).where(sql`${t.state} IN ('pending','sending')`),
  index('marketing_form_delivery_recent').on(t.workspaceId,t.createdAt,t.id),
  check('marketing_form_delivery_kind',sql`${t.kind} IN ('email','salesforce')`),
  check('marketing_form_delivery_state',sql`${t.state} IN ('pending','sending','succeeded','uncertain','failed','skipped')`),
  check('marketing_form_delivery_due',sql`(${t.nextAt} IS NOT NULL) = (${t.state} IN ('pending','sending'))`),
]);
