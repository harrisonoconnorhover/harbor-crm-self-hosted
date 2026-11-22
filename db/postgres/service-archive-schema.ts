import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {loginIdentities} from './identity-schema';
import {portableLeads} from './portable-lead-schema';
import {portableTickets} from './ticket-schema';

export const serviceArchiveReceipts=pgTable('portable_service_archive_receipts',{
  workspaceId:uuid('workspace_id').notNull(),requestId:uuid('request_id').notNull(),
  leadId:uuid('lead_id'),ticketId:uuid('ticket_id'),
  action:text('action',{enum:['archive','restore']}).notNull(),revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.requestId]}),
  foreignKey({name:'service_archive_lead',columns:[t.workspaceId,t.leadId],foreignColumns:[portableLeads.workspaceId,portableLeads.id]}),
  foreignKey({name:'service_archive_ticket',columns:[t.workspaceId,t.ticketId],foreignColumns:[portableTickets.workspaceId,portableTickets.id]}),
  check('service_archive_valid',sql`num_nonnulls(${t.leadId},${t.ticketId})=1 AND ${t.action} IN ('archive','restore') AND ${t.revision}>1`),
  index('service_archive_lead_history').on(t.workspaceId,t.leadId,t.revision).where(sql`${t.leadId} IS NOT NULL`),
  index('service_archive_ticket_history').on(t.workspaceId,t.ticketId,t.revision).where(sql`${t.ticketId} IS NOT NULL`),
]);
