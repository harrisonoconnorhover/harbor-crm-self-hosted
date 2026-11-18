import {bigint,boolean,pgTable,primaryKey,text} from 'drizzle-orm/pg-core';
import {loginIdentities,loginSessions} from './identity-schema';

export type PortableGoogleProvider='gmail'|'calendar';

export type OutlookProvider='outlook-mail'|'outlook-calendar';
export type PersonalConnectionProvider=PortableGoogleProvider|OutlookProvider;

// The original SQL tables already key each private grant and attempt by provider.
export const portableGoogleAttempts=pgTable('portable_google_attempts',{
  userId:text('user_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  provider:text('provider').$type<PersonalConnectionProvider>().notNull(),
  sessionHash:text('session_hash').notNull().references(()=>loginSessions.tokenHash,{onDelete:'cascade'}),
  stateHash:text('state_hash').notNull(),
  verifier:text('verifier').notNull(),
  expiresAt:bigint('expires_at',{mode:'number'}).notNull(),
  claimed:boolean('claimed').notNull().default(false),
},table=>[primaryKey({columns:[table.userId,table.provider]})]);

export const portableGoogleGrants=pgTable('portable_google_grants',{
  userId:text('user_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  provider:text('provider').$type<PersonalConnectionProvider>().notNull(),
  id:text('id').notNull(),
  email:text('email').notNull(),
  refreshToken:text('refresh_token').notNull(),
  needsReconnect:boolean('needs_reconnect').notNull().default(false),
},table=>[primaryKey({columns:[table.userId,table.provider]})]);
