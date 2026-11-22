import {sql,type SQLWrapper} from 'drizzle-orm';
import {check,foreignKey,index,integer,pgTable,primaryKey,text,timestamp,unique,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {textFieldsSearchIndex,wordSearchDocument} from './search-index';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

const time=(name:string)=>timestamp(name,{withTimezone:true,mode:'string'}).notNull().defaultNow();

// A customer message tied with a reply stays visible so an agent can check it.
export const unansweredInboxMessage=(received:SQLWrapper,sent:SQLWrapper)=>
  sql`${received} >= coalesce(${sent}, '-infinity'::timestamptz)`;

export const inboxConversations=pgTable('portable_inbox_conversations',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  mailbox:text('mailbox').notNull(),
  sender:text('sender').notNull(),
  subject:text('subject').notNull(),
  status:text('status',{enum:['open','resolved']}).notNull().default('open'),
  claimedBy:text('claimed_by').references(()=>loginIdentities.id),
  tags:text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  revision:integer('revision').notNull().default(1),
  draftActivityAt:timestamp('draft_activity_at',{withTimezone:true,mode:'string'}),
  draftActivityRevision:integer('draft_activity_revision'),
  lastReceivedAt:timestamp('last_received_at',{withTimezone:true,mode:'string'}),
  lastRepliedAt:timestamp('last_replied_at',{withTimezone:true,mode:'string'}),
  updatedAt:time('updated_at'),
},c=>[
  primaryKey({columns:[c.workspaceId,c.id]}),
  unique('inbox_conversation_mailbox').on(c.workspaceId,c.mailbox,c.id),
  textFieldsSearchIndex('inbox_conversation_text_search',[c.subject,c.sender]),
  index('inbox_conversation_status_page').on(c.workspaceId,c.status,c.updatedAt.desc(),c.id.desc()),
  index('inbox_conversation_unanswered_page').on(c.workspaceId,c.status,c.updatedAt.desc(),c.id.desc())
    .where(unansweredInboxMessage(c.lastReceivedAt,c.lastRepliedAt)),
  index('inbox_conversation_claim_page').on(c.workspaceId,c.status,c.claimedBy,c.updatedAt.desc(),c.id.desc()),
  index('inbox_conversation_tag_keys').using('gin',sql`public.harbor_inbox_tag_keys(${c.tags})`),
  check('inbox_conversation_valid',sql`${c.revision}>0 AND ${c.status} IN ('open','resolved')
    AND length(${c.subject}) <= 1000 AND cardinality(${c.tags})<=20
    AND length(${c.mailbox}) BETWEEN 3 AND 320 AND length(${c.sender}) BETWEEN 3 AND 320`),
]);

export type InboxMessageState='received'|'sending'|'sent'|'uncertain'|'failed'|'handoff'|'note';
export const inboxMessages=pgTable('portable_inbox_messages',{
  workspaceId:uuid('workspace_id').notNull(),
  conversationId:uuid('conversation_id').notNull(),
  id:uuid('id').notNull(),
  mailbox:text('mailbox').notNull(),
  direction:text('direction',{enum:['incoming','outgoing','internal']}).notNull(),
  actorId:text('actor_id').references(()=>loginIdentities.id),
  handoffToId:text('handoff_to_id').references(()=>loginIdentities.id),
  body:text('body').notNull(),
  internetId:text('internet_id'),
  inReplyTo:text('in_reply_to'),
  providerId:text('provider_id'),
  state:text('state').$type<InboxMessageState>().notNull(),
  createdAt:time('created_at'),
},m=>[
  primaryKey({columns:[m.workspaceId,m.id]}),
  foreignKey({name:'inbox_message_conversation',columns:[m.workspaceId,m.mailbox,m.conversationId],
    foreignColumns:[inboxConversations.workspaceId,inboxConversations.mailbox,inboxConversations.id]}),
  index('inbox_message_body_search').using('gin',wordSearchDocument(m.body)),
  uniqueIndex('inbox_incoming_receipt').on(m.workspaceId,m.mailbox,m.providerId).where(sql`${m.direction}='incoming'`),
  index('inbox_thread_reference').on(m.workspaceId,m.mailbox,m.internetId).where(sql`${m.internetId} IS NOT NULL`),
  index('inbox_message_page').on(m.workspaceId,m.conversationId,m.createdAt.desc(),m.id.desc()),
  uniqueIndex('inbox_one_pending_reply').on(m.workspaceId,m.conversationId).where(sql`${m.state} IN ('sending','uncertain')`),
  check('inbox_message_state',sql`(${m.direction}='incoming' AND ${m.state}='received' AND ${m.providerId} IS NOT NULL AND ${m.actorId} IS NULL AND ${m.handoffToId} IS NULL)
    OR (${m.direction}='outgoing' AND ${m.state} IN ('sending','sent','uncertain','failed') AND ${m.actorId} IS NOT NULL AND ${m.internetId} IS NOT NULL AND ${m.handoffToId} IS NULL)
    OR (${m.direction}='internal' AND ${m.actorId} IS NOT NULL AND ${m.providerId} IS NULL AND ${m.internetId} IS NULL
      AND ${m.inReplyTo} IS NULL AND length(${m.body})<=2000 AND (
        (${m.state}='handoff' AND ${m.handoffToId} IS NOT NULL) OR
        (${m.state}='note' AND ${m.handoffToId} IS NULL AND length(btrim(${m.body}))>0)))`),
]);

export const inboxSnippets=pgTable('portable_inbox_snippets',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  body:text('body').notNull(),
  revision:integer('revision').notNull(),
  slot:integer('slot').notNull(),
},s=>[
  primaryKey({columns:[s.workspaceId,s.id]}),
  uniqueIndex('inbox_snippet_name').on(s.workspaceId,sql`lower(${s.name})`),
  unique('inbox_snippet_slot').on(s.workspaceId,s.slot),
  check('inbox_snippet_valid',sql`${s.slot} BETWEEN 1 AND 40 AND ${s.revision}>0 AND ${s.name}=btrim(${s.name})
    AND length(${s.name}) BETWEEN 1 AND 100 AND length(${s.body}) BETWEEN 1 AND 16000 AND length(btrim(${s.body}))>0`),
]);
