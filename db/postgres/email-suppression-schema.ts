import {pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const emailSuppressions=pgTable('portable_email_suppressions',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  email:text('email').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  recipientOptedOutAt:timestamp('recipient_opted_out_at',{withTimezone:true,mode:'string'}),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  unique('portable_email_suppression_address').on(t.workspaceId,t.email),
]);

export const emailUnsubscribeTokens=pgTable('portable_email_unsubscribe_tokens',{
  tokenHash:text('token_hash').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  ownerId:text('owner_id').notNull().references(()=>loginIdentities.id),
  email:text('email').notNull(),
});
