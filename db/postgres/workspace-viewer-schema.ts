import {boolean,check,foreignKey,index,jsonb,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {RecordScope,WorkspaceRole} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

import type {ToolPolicies} from '../../lib/portable-tool-permissions';
import {workspaceTeams} from './workspace-team-schema';

export const workspaceViewers=pgTable('portable_workspace_viewers',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  viewerId:text('viewer_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  id:uuid('id').notNull().unique(),
  toolPolicies:jsonb('tool_policies').$type<ToolPolicies>().notNull().default({}),
  viewScope:text('view_scope').$type<RecordScope>().notNull().default('all'),
  editScope:text('edit_scope').$type<RecordScope>().notNull().default('all'),
  teamId:uuid('team_id'),
  contactFiles:boolean('contact_files').notNull().default(false),
  scheduledNotes:boolean('scheduled_notes').notNull().default(false),
  contactOutreach:boolean('contact_outreach').notNull().default(false),
  recordActivities:boolean('record_activities').notNull().default(false),
  backupAdmin:boolean('backup_admin').notNull().default(false),
  role:text('role').$type<WorkspaceRole>().notNull().default('viewer'),
},table=>[
  foreignKey({name:'portable_viewer_team',columns:[table.workspaceId,table.teamId],foreignColumns:[workspaceTeams.workspaceId,workspaceTeams.id]}),
  primaryKey({columns:[table.workspaceId,table.viewerId]}),
  index('portable_workspace_viewer_lookup').on(table.viewerId,table.workspaceId),
  check('portable_viewer_tool_policy_keys',sql`jsonb_typeof(${table.toolPolicies})='object'
    AND (${table.toolPolicies} - ARRAY['contacts','companies','deals','tasks','leads','tickets','custom-objects','segments','team-inbox','knowledge','snippets','reports','dashboards','forecast','goals','meetings','files','recycle-bin','calls','duplicates','sales-workspace'])='{}'::jsonb`),
  check('portable_member_record_scope',sql`${table.viewScope} IN ('owned','team','all')
    AND ${table.editScope} IN ('owned','team','all')
    AND (${table.viewScope}='all' OR ${table.editScope}='owned' OR ${table.viewScope}=${table.editScope})
    AND (NOT ${table.backupAdmin} OR ${table.editScope}='all')`),
  check('portable_workspace_viewer_role',sql`${table.role} IN ('viewer','editor')`),
  check('portable_workspace_backup_editor',sql`NOT ${table.backupAdmin} OR ${table.role}='editor'`),
]);
