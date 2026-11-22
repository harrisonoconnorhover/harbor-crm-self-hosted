import {toolLevel} from './member-tool-access';
import {and,eq,exists,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {effectiveMemberToolPolicy,type AuxiliaryTool} from '../../lib/portable-tool-permissions';
import {workspaceViewers as members} from './workspace-viewer-schema';

export async function sharedToolAllowed(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,
  tool:AuxiliaryTool,action:'view'|'edit'|'create'='view'){
  if(!workspaceId)return true;
  const [grant]=await db.select({role:members.role,viewScope:members.viewScope,editScope:members.editScope,toolPolicies:members.toolPolicies})
    .from(members).where(and(eq(members.workspaceId,workspaceId),eq(members.viewerId,actorId))).limit(1);
  if(!grant)return false;
  const policy=effectiveMemberToolPolicy(grant,tool);
  return action==='create'?policy.create:policy[action]!=='none';
}

// Conversations are workspace-wide. An unrelated record tool may still be restricted.
export function sharedInboxReadable(db:PostgresJsDatabase,actorId:string,workspaceId:string){
  return exists(db.select({id:members.id}).from(members).where(and(eq(members.workspaceId,workspaceId),
    eq(members.viewerId,actorId),eq(members.viewScope,'all'),sql`${toolLevel('team-inbox','view')}='all'`)));
}
