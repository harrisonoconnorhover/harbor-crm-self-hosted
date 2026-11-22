import {sql} from 'drizzle-orm';
import {bigint,check,index,pgTable,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';

export const loginIdentities=pgTable('login_identities',{
  id:text('id').primaryKey(),
  googleSubject:text('google_subject'),
  microsoftSubject:text('microsoft_subject'),
  oidcSubject:text('oidc_subject'),
  samlSubject:text('saml_subject'),
  directoryAuthority:uuid('directory_authority'),
  oidcDirectoryIssuer:text('oidc_directory_issuer'),
  samlDirectoryIssuer:text('saml_directory_issuer'),
  email:text('email').notNull(),
  fullName:text('full_name'),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  updatedAt:bigint('updated_at',{mode:'number'}).notNull(),
},table=>[
  uniqueIndex('login_google_subject_unique').on(table.googleSubject),
  uniqueIndex('login_microsoft_subject_unique').on(table.microsoftSubject),
  uniqueIndex('login_oidc_subject_unique').on(table.oidcSubject),
  uniqueIndex('login_saml_subject_unique').on(table.samlSubject),
  check('login_directory_authority_provider',sql`(${table.oidcDirectoryIssuer} IS NULL AND ${table.samlDirectoryIssuer} IS NULL AND (${table.directoryAuthority} IS NULL OR ${table.microsoftSubject} IS NOT NULL))
    OR (${table.oidcDirectoryIssuer} IS NOT NULL AND ${table.samlDirectoryIssuer} IS NULL AND ${table.directoryAuthority} IS NOT NULL AND ${table.oidcSubject} IS NOT NULL)
    OR (${table.oidcDirectoryIssuer} IS NULL AND ${table.samlDirectoryIssuer} IS NOT NULL AND ${table.directoryAuthority} IS NOT NULL AND ${table.samlSubject} IS NOT NULL)`),
  check('login_identity_one_provider',sql`num_nonnulls(${table.googleSubject}, ${table.microsoftSubject}, ${table.samlSubject}, ${table.oidcSubject}) = 1`),
  index('portable_identity_email_lookup').on(table.email),
]);

export const loginSessions=pgTable('login_sessions',{
  tokenHash:text('token_hash').primaryKey(),
  userId:text('user_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  expiresAt:bigint('expires_at',{mode:'number'}).notNull(),
},table=>[index('login_sessions_user').on(table.userId),index('login_sessions_expiry').on(table.expiresAt)]);
