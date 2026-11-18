import {sql} from 'drizzle-orm';
import {bigint,check,index,pgTable,text,uniqueIndex} from 'drizzle-orm/pg-core';

export const loginIdentities=pgTable('login_identities',{
  id:text('id').primaryKey(),
  googleSubject:text('google_subject'),
  microsoftSubject:text('microsoft_subject'),
  email:text('email').notNull(),
  fullName:text('full_name'),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  updatedAt:bigint('updated_at',{mode:'number'}).notNull(),
},table=>[
  uniqueIndex('login_google_subject_unique').on(table.googleSubject),
  uniqueIndex('login_microsoft_subject_unique').on(table.microsoftSubject),
  check('login_identity_one_provider',sql`num_nonnulls(${table.googleSubject}, ${table.microsoftSubject}) = 1`),
  index('portable_identity_email_lookup').on(table.email),
]);

export const loginSessions=pgTable('login_sessions',{
  tokenHash:text('token_hash').primaryKey(),
  userId:text('user_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  expiresAt:bigint('expires_at',{mode:'number'}).notNull(),
},table=>[index('login_sessions_user').on(table.userId),index('login_sessions_expiry').on(table.expiresAt)]);
