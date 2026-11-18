import {sql} from 'drizzle-orm';
import {check,integer,jsonb,pgTable,primaryKey,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {PortableReportDefinition} from '../../lib/portable-reports';
import {privateWorkspaces} from './workspace-schema';

export const portableReports=pgTable('portable_reports',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  definition:jsonb('definition').$type<PortableReportDefinition>().notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  check('portable_reports_positive_revision',sql`${table.revision} > 0`),
]);
