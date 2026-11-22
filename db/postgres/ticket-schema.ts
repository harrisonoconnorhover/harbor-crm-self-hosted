import {recordUpdatedKey} from './record-updated-key';
import {activeListSearchIndex,recordSearchIndex} from './search-index';
import {isNull,sql} from 'drizzle-orm';
import type {WorkingCalendar} from '../../lib/first-response';
import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {PortableTicketFields,PortableTicketRecord} from '../../lib/portable-tickets';
import type {CloseSlaTargets} from '../../lib/ticket-sla';
import {knowledgeArticles} from './knowledge-schema';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {inboxConversations,inboxMessages} from './team-inbox-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

type TicketSnapshot=Pick<PortableTicketRecord,'data'|'contactId'|'companyId'|'closedAt'|'assigneeId'|'assigneeLabel'>;

export const portableTickets=pgTable('portable_tickets',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  data:jsonb('data').$type<PortableTicketFields>().notNull(),
  contactId:uuid('contact_id'),
  companyId:uuid('company_id'),
  assigneeId:text('assignee_id').references(()=>loginIdentities.id),
  assigneeLabel:text('assignee_label'),
  closedAt:timestamp('closed_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  check('portable_tickets_assignee_label',sql`(${table.assigneeId} IS NULL) = (${table.assigneeLabel} IS NULL)`),
  index('portable_tickets_workspace_assignee').on(table.workspaceId,table.assigneeId,table.id).where(sql`${table.archivedAt} IS NULL AND ${table.assigneeId} IS NOT NULL`),
  index('portable_tickets_archived_time_page').on(table.workspaceId,recordUpdatedKey(table.archivedAt),table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_tickets_recent_page').on(table.workspaceId,recordUpdatedKey(table.updatedAt),table.id).where(sql`${table.archivedAt} IS NULL`),
  index('portable_tickets_archive_page').on(table.workspaceId,table.id).where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_ticket_tags').using('gin',sql`(${table.data}->'tags') jsonb_path_ops`).where(sql`${table.archivedAt} IS NULL`),
  check('portable_ticket_tags_shape',sql`NOT (${table.data} ? 'tags') OR CASE WHEN jsonb_typeof(${table.data}->'tags') = 'array'
    THEN jsonb_array_length(${table.data}->'tags') <= 10 AND NOT jsonb_path_exists(${table.data}->'tags', '$[*] ? (@.type() != "string")')
    ELSE false END`),
  activeListSearchIndex('portable_tickets_list_search',table.archivedAt,sql`${table.data}->>'name'`,sql`${table.data}->>'description'`),
  recordSearchIndex('portable_tickets_search_values',table.data),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_ticket_contact_fk',columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({name:'portable_ticket_company_fk',columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  check('portable_ticket_close_date',sql`(${table.data}->>'ticketStatus' = 'Closed') IS NOT DISTINCT FROM (${table.closedAt} IS NOT NULL)`),
  index('portable_ticket_contact_order').on(table.workspaceId,table.contactId,table.id),
  index('portable_ticket_company_order').on(table.workspaceId,table.companyId,table.id),
  index('portable_ticket_status_order').on(table.workspaceId,sql`(${table.data}->>'ticketStatus')`,table.id),
]);
export const ticketOwnership={workspaceId:portableTickets.workspaceId,assigneeId:portableTickets.assigneeId};


export const inboxTicketLinks=pgTable('portable_inbox_ticket_links',{
  workspaceId:uuid('workspace_id').notNull(),
  conversationId:uuid('conversation_id').notNull(),
  ticketId:uuid('ticket_id').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.conversationId]}),
  uniqueIndex('portable_inbox_ticket_by_ticket').on(t.workspaceId,t.ticketId),
  foreignKey({name:'inbox_ticket_conversation_fk',columns:[t.workspaceId,t.conversationId],
    foreignColumns:[inboxConversations.workspaceId,inboxConversations.id]}).onDelete('cascade'),
  foreignKey({name:'inbox_ticket_record_fk',columns:[t.workspaceId,t.ticketId],
    foreignColumns:[portableTickets.workspaceId,portableTickets.id]}).onDelete('cascade'),
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

export const responsePolicies=pgTable('portable_ticket_response_policies',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),revision:integer('revision').notNull(),
  enabled:boolean('enabled').notNull(),targets:jsonb('targets').$type<CloseSlaTargets>().notNull(),
  calendar:jsonb('calendar').$type<WorkingCalendar>().notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.revision]}),check('portable_response_policy_version',sql`${t.revision}>0`)]);

export const responseReceipts=pgTable('portable_ticket_first_responses',{
  workspaceId:uuid('workspace_id').notNull(),ticketId:uuid('ticket_id').notNull(),policyRevision:integer('policy_revision').notNull(),
  targetMinutes:integer('target_minutes').notNull(),startedAt:timestamp('started_at',{withTimezone:true,mode:'string'}).notNull(),
  dueAt:timestamp('due_at',{withTimezone:true,mode:'string'}).notNull(),respondedAt:timestamp('responded_at',{withTimezone:true,mode:'string'}),
  inboxReplyId:uuid('inbox_reply_id'),
  workingMs:bigint('working_ms',{mode:'number'}),channel:text('channel'),summary:text('summary'),
  actorId:text('actor_id').references(()=>loginIdentities.id),
},t=>[primaryKey({columns:[t.workspaceId,t.ticketId]}),
  foreignKey({name:'portable_response_inbox_reply_fk',columns:[t.workspaceId,t.inboxReplyId],foreignColumns:[inboxMessages.workspaceId,inboxMessages.id]}),
  uniqueIndex('portable_response_inbox_reply').on(t.workspaceId,t.inboxReplyId).where(sql`${t.inboxReplyId} IS NOT NULL`),
  check('portable_response_inbox_email',sql`${t.inboxReplyId} IS NULL OR (${t.respondedAt} IS NOT NULL AND ${t.channel}='Email')`),
  foreignKey({name:'portable_response_ticket_fk',columns:[t.workspaceId,t.ticketId],foreignColumns:[portableTickets.workspaceId,portableTickets.id]}).onDelete('cascade'),
  foreignKey({name:'portable_response_policy_fk',columns:[t.workspaceId,t.policyRevision],foreignColumns:[responsePolicies.workspaceId,responsePolicies.revision]}),
  check('portable_response_due',sql`${t.dueAt}>${t.startedAt} AND ${t.targetMinutes}>0`),
  check('portable_response_completion',sql`num_nonnulls(${t.respondedAt},${t.workingMs},${t.channel},${t.summary},${t.actorId}) IN (0,5)
    AND (${t.respondedAt} IS NULL OR (${t.respondedAt}>=${t.startedAt} AND ${t.workingMs}>=0 AND ${t.channel} IN ('Email','Phone','Chat')
    AND length(trim(${t.summary})) BETWEEN 1 AND 1000))`),
  index('portable_first_response_due').on(t.workspaceId,t.dueAt,t.ticketId).where(sql`${t.respondedAt} IS NULL`),
]);

export const activeTicket=isNull(portableTickets.archivedAt);

// Customer access is separate from staff identities and is scoped to an exact contact.
export const customerCaseAccess=pgTable('portable_case_access',{
  workspaceId:uuid('workspace_id').notNull(),contactId:uuid('contact_id').notNull(),
  revision:integer('revision').notNull(),kind:text('kind').$type<'invited'|'active'|'revoked'>().notNull(),
  tokenHash:text('token_hash'),expiresAt:bigint('expires_at',{mode:'number'}),
},t=>[
  primaryKey({columns:[t.workspaceId,t.contactId]}),
  foreignKey({name:'portable_case_access_contact_fk',columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}).onDelete('cascade'),
  uniqueIndex('portable_case_access_hash').on(t.tokenHash).where(sql`${t.tokenHash} IS NOT NULL`),
  check('portable_case_access_credential',sql`${t.revision}>0 AND (
    (${t.kind}='revoked' AND ${t.tokenHash} IS NULL AND ${t.expiresAt} IS NULL) OR
    (${t.kind} IN ('invited','active') AND ${t.tokenHash} IS NOT NULL AND ${t.tokenHash} ~ '^[A-Za-z0-9_-]{43}$'
      AND ${t.expiresAt} IS NOT NULL AND ${t.expiresAt}>0))`),
]);

export const customerCasePublications=pgTable('portable_case_publications',{
  workspaceId:uuid('workspace_id').notNull(),ticketId:uuid('ticket_id').notNull(),
  contactId:uuid('contact_id'),revision:integer('revision').notNull(),
  subject:text('subject'),update:text('customer_update'),articleId:uuid('article_id'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.ticketId]}),
  foreignKey({name:'portable_case_article_fk',columns:[t.workspaceId,t.articleId],foreignColumns:[knowledgeArticles.workspaceId,knowledgeArticles.id]}),
  foreignKey({name:'portable_case_ticket_fk',columns:[t.workspaceId,t.ticketId],foreignColumns:[portableTickets.workspaceId,portableTickets.id]}).onDelete('cascade'),
  foreignKey({name:'portable_case_publication_contact_fk',columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  index('portable_case_publication_list').on(t.workspaceId,t.contactId,t.ticketId).where(sql`${t.contactId} IS NOT NULL`),
  check('portable_case_publication_content',sql`${t.revision}>0 AND (
    (${t.contactId} IS NULL AND ${t.subject} IS NULL AND ${t.update} IS NULL) OR
    (${t.contactId} IS NOT NULL AND ${t.subject} IS NOT NULL AND char_length(trim(${t.subject})) BETWEEN 1 AND 200
      AND ${t.update} IS NOT NULL AND char_length(${t.update})<=4000))`),
]);
