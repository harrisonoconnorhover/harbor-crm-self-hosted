import {foreignKey,integer,pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';

export const contactFileVersions=pgTable('contact_file_versions',{
  workspaceId:uuid('workspace_id').notNull(),
  contactId:uuid('contact_id').notNull(),
  // The Contact ID in the object key when the file has moved to another Contact by merge.
  storageContactId:uuid('storage_contact_id'),
  fileId:uuid('file_id').notNull(),
  versionId:uuid('version_id').notNull(),
  actorId:text('actor_id').references(()=>loginIdentities.id),
  expectedVersion:uuid('expected_version'),
  revision:integer('revision'),
  name:text('name').notNull(),
  size:integer('size').notNull(),
  sha256:text('sha256').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.contactId,table.fileId,table.versionId]}),
  unique('contact_file_revision').on(table.workspaceId,table.contactId,table.fileId,table.revision),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
]);
