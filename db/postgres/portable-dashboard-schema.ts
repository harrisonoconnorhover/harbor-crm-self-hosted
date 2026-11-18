import {sql} from 'drizzle-orm';
import {boolean,check,integer,jsonb,pgTable,primaryKey,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {PortableDashboardDefinition} from '../../lib/portable-dashboards';
import {privateWorkspaces} from './workspace-schema';

export const portableDashboards=pgTable('portable_dashboards',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  definition:jsonb('definition').$type<PortableDashboardDefinition>().notNull(),
  teamVisible:boolean('team_visible').notNull().default(false),
  revision:integer('revision').notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  check('portable_dashboards_positive_revision',sql`${table.revision}>0`),
]);
