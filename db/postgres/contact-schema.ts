import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import type {ContactFields} from '../../lib/portable-records';
import {sql} from 'drizzle-orm';
import {leadForms} from './lead-form-schema';
import {loginIdentities} from './identity-schema';
import {companies} from './company-schema';
import {privateWorkspaces} from './workspace-schema';
export {privateWorkspaces} from './workspace-schema';

export const contacts=pgTable('contacts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  primaryCompanyId:uuid('primary_company_id'),
  data:jsonb('data').$type<ContactFields>().notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  // Set once when this Contact is merged into another; it then stays archived.
  mergedIntoId:uuid('merged_into_id'),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'contacts_merged_into_fk',columns:[table.workspaceId,table.mergedIntoId],foreignColumns:[table.workspaceId,table.id]}),
  check('contacts_merged_archived',sql`${table.mergedIntoId} IS NULL OR (${table.archivedAt} IS NOT NULL AND ${table.mergedIntoId}<>${table.id})`),
  foreignKey({name:'contacts_primary_company_fk',columns:[table.workspaceId,table.primaryCompanyId],foreignColumns:[companies.workspaceId,companies.id]}),
  index('contacts_workspace_email').on(table.workspaceId,sql`lower(${table.data}->>'email')`),
  index('contacts_primary_company').on(table.workspaceId,table.primaryCompanyId),
]);

export const contactEvents=pgTable('contact_events',{
  workspaceId:uuid('workspace_id').notNull(),
  contactId:uuid('contact_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').references(()=>loginIdentities.id),
  intakeFormId:uuid('intake_form_id'),
  previous:jsonb('previous').$type<ContactFields>(),
  previousPrimaryCompanyId:uuid('previous_primary_company_id'),
  primaryCompanyId:uuid('primary_company_id'),
  data:jsonb('data').$type<ContactFields>().notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.contactId,table.revision]}),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({columns:[table.workspaceId,table.intakeFormId],foreignColumns:[leadForms.workspaceId,leadForms.id]}),
  check('contact_event_attribution',sql`(${table.actorId} IS NULL) <> (${table.intakeFormId} IS NULL)`),
  index('contact_events_time').on(table.workspaceId,table.occurredAt),
]);

export const contactArchiveReceipts=pgTable('portable_contact_archive_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  contactId:uuid('contact_id').notNull(),
  action:text('action').$type<'archive'|'restore'>().notNull(),
  revision:integer('revision').notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_contact_archive_receipt_contact_fk',columns:[table.workspaceId,table.contactId],
    foreignColumns:[contacts.workspaceId,contacts.id]}),
  check('portable_contact_archive_receipt_action',sql`(${table.action}='archive' AND ${table.archivedAt} IS NOT NULL)
    OR (${table.action}='restore' AND ${table.archivedAt} IS NULL)`),
]);

// One receipt per merge request; the secondary's last fields and company stay here.
export const contactMergeReceipts=pgTable('portable_contact_merge_receipts',{
  workspaceId:uuid('workspace_id').notNull(),
  requestId:uuid('request_id').notNull(),
  primaryId:uuid('primary_id').notNull(),
  secondaryId:uuid('secondary_id').notNull(),
  primaryRevision:integer('primary_revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  secondaryData:jsonb('secondary_data').$type<ContactFields>().notNull(),
  secondaryCompanyId:uuid('secondary_company_id'),
  moved:jsonb('moved').$type<Record<string,number>>().notNull(),
  mergedAt:timestamp('merged_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  foreignKey({name:'portable_contact_merge_primary_fk',columns:[table.workspaceId,table.primaryId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  foreignKey({name:'portable_contact_merge_secondary_fk',columns:[table.workspaceId,table.secondaryId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  unique('portable_contact_merge_secondary').on(table.workspaceId,table.secondaryId),
  check('portable_contact_merge_pair',sql`${table.primaryId}<>${table.secondaryId}`),
]);
