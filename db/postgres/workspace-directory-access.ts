import {and,eq,gt,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {privateWorkspaces} from './workspace-schema';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {directoryUsers} from './workspace-directory-schema';
import {loginIdentities} from './identity-schema';

export async function directoryManagesAddress(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,email:string){
  const [row]=await db.select({id:directoryUsers.id}).from(directoryUsers)
    .innerJoin(loginIdentities,eq(loginIdentities.id,directoryUsers.userId))
    .where(and(eq(directoryUsers.workspaceId,workspaceId),eq(loginIdentities.email,email))).limit(1);
  return !!row;
}

export async function directoryIdentity(db:Pick<PostgresJsDatabase,'select'>,authority:string,subject:string){
  const [row]=await db.select({email:loginIdentities.email}).from(loginIdentities)
    .where(and(eq(loginIdentities.microsoftSubject,subject),eq(loginIdentities.directoryAuthority,authority))).limit(1);
  return row?.email;
}

function ownerDirectoryQuery(db:PostgresJsDatabase){
  return db.select({id:directoryUsers.id,actorId:directoryUsers.userId,email:loginIdentities.email,displayName:directoryUsers.displayName,oidcIssuer:directoryUsers.oidcIssuer,samlIssuer:directoryUsers.samlIssuer,
    memberId:workspaceViewers.id,role:workspaceViewers.role,backup:workspaceViewers.backupAdmin,team:workspaceTeams.name})
    .from(directoryUsers)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,directoryUsers.workspaceId))
    .innerJoin(loginIdentities,eq(loginIdentities.id,directoryUsers.userId))
    .leftJoin(workspaceViewers,and(eq(workspaceViewers.workspaceId,directoryUsers.workspaceId),eq(workspaceViewers.viewerId,directoryUsers.userId)))
    .leftJoin(workspaceTeams,and(eq(workspaceTeams.workspaceId,directoryUsers.workspaceId),eq(workspaceTeams.id,workspaceViewers.teamId)));
}
function employeeAccess({actorId,displayName,oidcIssuer,samlIssuer,memberId,role,backup,team}:Awaited<ReturnType<typeof ownerDirectoryQuery>>[number]){
  return {actorId,...(displayName?{displayName}:{}),...(memberId?{memberId}:{}),...(backup?{backupAdmin:true}:{}),provider:oidcIssuer?'OpenID Connect':samlIssuer?'Company SSO':'Microsoft Entra ID',role,team};
}
export async function ownedDirectoryEmployees(db:PostgresJsDatabase,ownerId:string,email:string){
  const rows=await ownerDirectoryQuery(db).where(and(eq(privateWorkspaces.ownerId,ownerId),eq(loginIdentities.email,email))).orderBy(directoryUsers.id);
  return rows.map(employeeAccess);
}
export async function ownedDirectoryRoster(db:PostgresJsDatabase,ownerId:string,access:'viewer'|'editor'|'inactive',after?:string,teamId?:string,includeChildren=false){
  const limit=25;
  // Resolve the owner's branch once, including the selected team itself.
  const teamScope=teamId&&includeChildren?sql`${workspaceViewers.teamId} IN (
    WITH RECURSIVE branch(workspace_id,id) AS (
      SELECT t.workspace_id,t.id FROM ${workspaceTeams} t JOIN ${privateWorkspaces} w ON w.id=t.workspace_id
      WHERE w.owner_id=${ownerId} AND t.id=${teamId}
      UNION SELECT t.workspace_id,t.id FROM ${workspaceTeams} t JOIN branch b ON t.workspace_id=b.workspace_id AND t.parent_id=b.id
    ) SELECT id FROM branch)`:
    teamId==='unassigned'?isNull(workspaceViewers.teamId):teamId?eq(workspaceViewers.teamId,teamId):undefined;
  const rows=await ownerDirectoryQuery(db).where(and(eq(privateWorkspaces.ownerId,ownerId),
    access==='inactive'?isNull(workspaceViewers.id):eq(workspaceViewers.role,access),
    teamScope,after?gt(directoryUsers.id,after):undefined)).orderBy(directoryUsers.id).limit(limit+1);
  return {employees:rows.slice(0,limit).map(row=>({id:row.id,email:row.email,...employeeAccess(row)})),
    next:rows.length>limit?rows[limit-1].id:null};
}
