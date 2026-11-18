import {bigint,check,foreignKey,index,integer,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {isNull,sql} from 'drizzle-orm';
import {contacts,privateWorkspaces} from './contact-schema';

export const portableFileFolders=pgTable('portable_file_folders',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  parentId:uuid('parent_id'),
  name:text('name').notNull(),
  nameKey:text('name_key').notNull(),
  revision:integer('revision').notNull().default(0),
  deletedAt:bigint('deleted_at',{mode:'number'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_file_folder_parent_fk',columns:[table.workspaceId,table.parentId],
    foreignColumns:[table.workspaceId,table.id]}),
  check('portable_file_folder_distinct_parent',sql`${table.parentId} <> ${table.id}`),
  index('portable_file_folder_children').on(table.workspaceId,table.parentId,table.id).where(isNull(table.deletedAt)),
  uniqueIndex('portable_file_folder_name').on(table.workspaceId,table.nameKey).where(isNull(table.deletedAt)),
]);

export const portableFileLocations=pgTable('portable_file_locations',{
  workspaceId:uuid('workspace_id').notNull(),
  contactId:uuid('contact_id').notNull(),
  fileId:uuid('file_id').notNull(),
  folderId:uuid('folder_id'),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.contactId,table.fileId]}),
  foreignKey({name:'portable_file_location_contact_fk',columns:[table.workspaceId,table.contactId],
    foreignColumns:[contacts.workspaceId,contacts.id]}).onDelete('cascade'),
  foreignKey({name:'portable_file_location_folder_fk',columns:[table.workspaceId,table.folderId],
    foreignColumns:[portableFileFolders.workspaceId,portableFileFolders.id]}),
  index('portable_file_location_folder').on(table.workspaceId,table.folderId),
]);
