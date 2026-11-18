import {bigint,integer,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './contact-schema';

export const portableEmailTemplates=pgTable('portable_email_templates',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  subject:text('subject').notNull(),
  body:text('body').notNull(),
  revision:integer('revision').notNull().default(0),
  deletedAt:bigint('deleted_at',{mode:'number'}),
},table=>[primaryKey({columns:[table.workspaceId,table.id]})]);
