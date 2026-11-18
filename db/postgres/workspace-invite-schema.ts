import {sql} from 'drizzle-orm';
import type {WorkspaceRole} from '../../lib/portable-workspace-access';
import {check,index,pgTable,timestamp,unique,uuid,text} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

export const workspaceInvites=pgTable('portable_workspace_invites',{
  id:uuid('id').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  email:text('email').notNull(),
  role:text('role').$type<WorkspaceRole>().notNull().default('viewer'),
  expiresAt:timestamp('expires_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  check('portable_workspace_invite_role',sql`${table.role} IN ('viewer','editor')`),
  unique('portable_workspace_invite_recipient').on(table.workspaceId,table.email),
  index('portable_workspace_invite_inbox').on(table.email,table.expiresAt,table.id),
]);
