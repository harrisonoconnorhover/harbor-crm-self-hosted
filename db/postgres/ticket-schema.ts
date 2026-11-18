import {sql} from 'drizzle-orm';
import {boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {PortableTicketFields,PortableTicketRecord} from '../../lib/portable-tickets';
import type {CloseSlaTargets} from '../../lib/ticket-sla';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

type TicketSnapshot=Pick<PortableTicketRecord,'data'|'contactId'|'companyId'|'closedAt'>;

export const portableTickets=pgTable('portable_tickets',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  data:jsonb('data').$type<PortableTicketFields>().notNull(),
  contactId:uuid('contact_id'),
  companyId:uuid('company_id'),
  closedAt:timestamp('closed_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_ticket_contact_fk',columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({name:'portable_ticket_company_fk',columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  check('portable_ticket_close_date',sql`(${table.data}->>'ticketStatus' = 'Closed') IS NOT DISTINCT FROM (${table.closedAt} IS NOT NULL)`),
  index('portable_ticket_contact_order').on(table.workspaceId,table.contactId,table.id),
  index('portable_ticket_company_order').on(table.workspaceId,table.companyId,table.id),
  index('portable_ticket_status_order').on(table.workspaceId,sql`(${table.data}->>'ticketStatus')`,table.id),
]);

export const portableTicketEvents=pgTable('portable_ticket_events',{
  workspaceId:uuid('workspace_id').notNull(),
  ticketId:uuid('ticket_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  previous:jsonb('previous').$type<TicketSnapshot>(),
  data:jsonb('data').$type<TicketSnapshot>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.ticketId,table.revision]}),
  foreignKey({name:'portable_ticket_event_ticket_fk',columns:[table.workspaceId,table.ticketId],foreignColumns:[portableTickets.workspaceId,portableTickets.id]}),
]);

export const portableTicketCloseSlaPolicies=pgTable('portable_ticket_close_sla_policies',{
  workspaceId:uuid('workspace_id').primaryKey().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  revision:integer('revision').notNull(),
  enabled:boolean('enabled').notNull(),
  targets:jsonb('targets').$type<CloseSlaTargets>().notNull(),
  warningMinutes:integer('warning_minutes').notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
});

export const portableTicketCloseSlaReceipts=pgTable('portable_ticket_close_sla_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  ticketId:uuid('ticket_id').notNull(),
  policyRevision:integer('policy_revision').notNull(),
  priority:text('priority').notNull(),
  targetMinutes:integer('target_minutes').notNull(),
  warningMinutes:integer('warning_minutes').notNull(),
  startedAt:timestamp('started_at',{withTimezone:true,mode:'string'}).notNull(),
  dueAt:timestamp('due_at',{withTimezone:true,mode:'string'}).notNull(),
  warningAt:timestamp('warning_at',{withTimezone:true,mode:'string'}),
  completedAt:timestamp('completed_at',{withTimezone:true,mode:'string'}),
  appliedAt:timestamp('applied_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.ticketId]}),
  foreignKey({name:'portable_ticket_sla_ticket_fk',columns:[table.workspaceId,table.ticketId],
    foreignColumns:[portableTickets.workspaceId,portableTickets.id]}).onDelete('cascade'),
]);
