import {sql} from 'drizzle-orm';
import type {RecordScope,WorkspaceRole} from '../../lib/portable-workspace-access';
import {boolean,check,foreignKey,index,pgTable,timestamp,unique,uuid,text} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

import {workspaceTeams} from './workspace-team-schema';

export const workspaceInvites=pgTable('portable_workspace_invites',{
  id:uuid('id').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  email:text('email').notNull(),
  teamId:uuid('team_id'),
  delegatedTeam:boolean('delegated_team').notNull().default(false),
  viewScope:text('view_scope').$type<RecordScope>().notNull().default('all'),
  editScope:text('edit_scope').$type<RecordScope>().notNull().default('all'),
  role:text('role').$type<WorkspaceRole>().notNull().default('viewer'),
  expiresAt:timestamp('expires_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  foreignKey({name:'portable_invitation_team',columns:[table.workspaceId,table.teamId],
    foreignColumns:[workspaceTeams.workspaceId,workspaceTeams.id]}).onDelete('cascade'),
  check('portable_invitation_delegated_team',sql`NOT ${table.delegatedTeam} OR ${table.teamId} IS NOT NULL`),
  check('portable_invite_record_scope',sql`${table.viewScope} IN ('owned','team','all') AND ${table.editScope} IN ('owned','team','all')
    AND (${table.viewScope}='all' OR ${table.editScope}='owned' OR ${table.viewScope}=${table.editScope})`),
  check('portable_workspace_invite_role',sql`${table.role} IN ('viewer','editor')`),
  unique('portable_workspace_invite_recipient').on(table.workspaceId,table.email),
  index('portable_workspace_invite_inbox').on(table.email,table.expiresAt,table.id),
]);
