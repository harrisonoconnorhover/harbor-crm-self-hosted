import {integer,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

export const marketingDesigns=pgTable('portable_marketing_designs',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  subject:text('subject').notNull(),
  project:text('project').notNull(),
  html:text('html').notNull(),
  plainText:text('plain_text').notNull().default(''),
  revision:integer('revision').notNull().default(1),
},table=>[primaryKey({columns:[table.workspaceId,table.id]})]);
