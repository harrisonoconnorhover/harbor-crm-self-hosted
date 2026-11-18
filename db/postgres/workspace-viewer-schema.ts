import {boolean,check,index,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {WorkspaceRole} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const workspaceViewers=pgTable('portable_workspace_viewers',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  viewerId:text('viewer_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  id:uuid('id').notNull().unique(),
  contactFiles:boolean('contact_files').notNull().default(false),
  scheduledNotes:boolean('scheduled_notes').notNull().default(false),
  contactOutreach:boolean('contact_outreach').notNull().default(false),
  recordActivities:boolean('record_activities').notNull().default(false),
  backupAdmin:boolean('backup_admin').notNull().default(false),
  role:text('role').$type<WorkspaceRole>().notNull().default('viewer'),
},table=>[
  primaryKey({columns:[table.workspaceId,table.viewerId]}),
  index('portable_workspace_viewer_lookup').on(table.viewerId,table.workspaceId),
  check('portable_workspace_viewer_role',sql`${table.role} IN ('viewer','editor')`),
  check('portable_workspace_backup_editor',sql`NOT ${table.backupAdmin} OR ${table.role}='editor'`),
]);
