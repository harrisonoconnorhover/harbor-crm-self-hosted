import {sql} from 'drizzle-orm';
import {check,foreignKey,integer,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

export const workspaceTeams=pgTable('portable_workspace_teams',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  nameKey:text('name_key').notNull(),
  parentId:uuid('parent_id'),
  revision:integer('revision').notNull().default(1),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  unique('portable_team_sibling_name').on(table.workspaceId,table.parentId,table.nameKey).nullsNotDistinct(),
  foreignKey({name:'portable_team_parent',columns:[table.workspaceId,table.parentId],foreignColumns:[table.workspaceId,table.id]}),
  check('portable_team_not_own_parent',sql`${table.parentId} IS DISTINCT FROM ${table.id}`),
]);
