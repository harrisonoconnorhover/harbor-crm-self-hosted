import {bigint,pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

// Keep the receipt after the activity is removed, without retaining its body.
export const portableGmailLogReceipts=pgTable('portable_gmail_log_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  mailbox:text('mailbox').notNull(),
  messageId:text('message_id').notNull(),
  threadId:text('thread_id').notNull(),
  occurredAt:bigint('occurred_at',{mode:'number'}).notNull(),
  contactId:uuid('contact_id').notNull(),
  contactCreatedAt:timestamp('contact_created_at',{withTimezone:true,mode:'string'}).notNull(),
  activityId:uuid('activity_id').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.mailbox,table.messageId]}),
  unique('portable_gmail_log_activity').on(table.workspaceId,table.activityId),
]);
