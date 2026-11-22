import {teamAncestors} from '../../lib/portable-workspace-teams';
import {ApiError} from '../../lib/api-error';
import {readDirectoryTeams,teamAssignmentPolicy} from './workspace-team-store';
import {workspaceTeams} from './workspace-team-schema';
import {directoryManagesAddress} from './workspace-directory-access';
import {fullRecordAccess,type MemberRecordAccess,type WorkspaceRole} from '../../lib/portable-workspace-access';
import {maximumWorkspaceSeats,portableWorkspaceSeatLimit} from '../../runtime/portable-config.mjs';
import {and,asc,eq,exists,gt,inArray,lte,ne,notExists,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {workspaceInvites} from './workspace-invite-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {lockRecordWorkspace} from './private-workspace-store';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const activeInvite=gt(workspaceInvites.expiresAt,sql`clock_timestamp()`);

const inviteTeam=and(eq(workspaceTeams.workspaceId,workspaceInvites.workspaceId),eq(workspaceTeams.id,workspaceInvites.teamId));
async function checkInvitationTeam(tx:Transaction,workspaceId:string,teamId:string|null,delegated:boolean,reviewing=false){
  if(!teamId)return;
  const directory=await readDirectoryTeams(tx,workspaceId);
  const problem=await teamAssignmentPolicy(tx,workspaceId,directory).assignmentProblem(null,teamId,delegated);
  if(problem)throw new ApiError(409,reviewing?'Team access changed. Ask the workspace owner to replace this invitation.':problem);
}

export async function workspaceHasRoom(tx:Transaction,workspaceId:string){
  const [row]=await tx.select({used:sql<number>`(
    (SELECT count(*) FROM ${workspaceViewers} WHERE ${workspaceViewers.workspaceId}=${workspaceId}) +
    (SELECT count(*) FROM ${workspaceInvites} WHERE ${workspaceInvites.workspaceId}=${workspaceId} AND ${activeInvite})
  )::int`}).from(privateWorkspaces).where(eq(privateWorkspaces.id,workspaceId));
  return row.used<portableWorkspaceSeatLimit(process.env);
}

function addressedInvitations(db:PostgresJsDatabase,actorId:string,email:string,ownerEmails?:string[],id?:string){
  const recipient=db.select({id:loginIdentities.id}).from(loginIdentities)
    .where(and(eq(loginIdentities.id,actorId),eq(loginIdentities.email,email)));
  const ambiguous=db.select({id:loginIdentities.id}).from(loginIdentities)
    .where(and(eq(loginIdentities.email,email),ne(loginIdentities.id,actorId)));
  return db.select({id:workspaceInvites.id,workspaceId:workspaceInvites.workspaceId,
    teamId:workspaceInvites.teamId,teamName:workspaceTeams.name,ownerEmail:loginIdentities.email,viewScope:workspaceInvites.viewScope,editScope:workspaceInvites.editScope,role:workspaceInvites.role,expiresAt:workspaceInvites.expiresAt}).from(workspaceInvites)
    .leftJoin(workspaceTeams,inviteTeam).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceInvites.workspaceId))
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(workspaceInvites.email,email),activeInvite,exists(recipient),notExists(ambiguous),ne(privateWorkspaces.ownerId,actorId),
      ownerEmails?inArray(loginIdentities.email,ownerEmails):undefined,id?eq(workspaceInvites.id,id):undefined));
}

export async function readWorkspaceInvitation(db:PostgresJsDatabase,actorId:string,email:string,id:string,ownerEmails?:string[]){
  const [invitation]=await addressedInvitations(db,actorId,email,ownerEmails,id).limit(1);
  if(!invitation)return null;
  if(!invitation.teamId)return invitation;
  const teams=await readDirectoryTeams(db,invitation.workspaceId);
  const path=teamAncestors(teams,invitation.teamId).map(team=>team.name).join(' / ');
  return {...invitation,teamName:path||invitation.teamName};
}

export async function workspaceInvitations(db:PostgresJsDatabase,actorId:string,email:string,owned:string|undefined,ownerEmails?:string[]){
  const [sent,incoming]=await Promise.all([
    owned?workspaceSentInvitations(db,owned):[],
    addressedInvitations(db,actorId,email,ownerEmails).orderBy(asc(workspaceInvites.expiresAt),asc(workspaceInvites.id)).limit(100),
  ]);
  return {sent,incoming:incoming.map(({id,ownerEmail,role,expiresAt,viewScope,editScope,teamName})=>({id,ownerEmail,role,expiresAt,viewScope,editScope,...(teamName?{teamName}:{})}))};
}

export function workspaceSentInvitations(db:PostgresJsDatabase,workspaceId:string){
  return db.select({id:workspaceInvites.id,email:workspaceInvites.email,teamId:workspaceInvites.teamId,teamName:workspaceTeams.name,viewScope:workspaceInvites.viewScope,editScope:workspaceInvites.editScope,role:workspaceInvites.role,expiresAt:workspaceInvites.expiresAt}).from(workspaceInvites).leftJoin(workspaceTeams,inviteTeam)
    .where(and(eq(workspaceInvites.workspaceId,workspaceId),activeInvite)).orderBy(asc(workspaceInvites.email)).limit(maximumWorkspaceSeats);
}

export async function prepareWorkspaceInvitation(db:PostgresJsDatabase,actorId:string,email:string,role:WorkspaceRole,access:MemberRecordAccess=fullRecordAccess,teamId:string|null=null,delegated=false){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw Error('Could not open the workspace.');
    if(await directoryManagesAddress(tx,workspaceId,email))return 'directory_managed';
    const [member]=await tx.select({id:workspaceViewers.id}).from(workspaceViewers)
      .innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
      .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(loginIdentities.email,email))).limit(1);
    if(member)return 'already_shared';
    await checkInvitationTeam(tx,workspaceId,teamId,delegated);
    const scope=eq(workspaceInvites.workspaceId,workspaceId);
    const [existing]=await tx.select({teamId:workspaceInvites.teamId,viewScope:workspaceInvites.viewScope,editScope:workspaceInvites.editScope,role:workspaceInvites.role}).from(workspaceInvites)
      .where(and(scope,eq(workspaceInvites.email,email),activeInvite));
    if(existing)return existing.teamId===teamId&&existing.role===role&&existing.viewScope===access.viewScope&&existing.editScope===access.editScope?'ok':'role_conflict';
    if(!await workspaceHasRoom(tx,workspaceId))return 'full';
    await tx.delete(workspaceInvites).where(and(scope,lte(workspaceInvites.expiresAt,sql`clock_timestamp()`)));
    await tx.insert(workspaceInvites).values({id:crypto.randomUUID(),workspaceId,email,role,...access,teamId,delegatedTeam:!!teamId&&delegated,
      expiresAt:sql`clock_timestamp()+interval '7 days'`});
    return 'ok';
  });
}

export async function changeWorkspaceInvitationRole(db:PostgresJsDatabase,actorId:string,id:string,role:WorkspaceRole,delegated=false){
  return db.transaction(async tx=>{
    // Share the workspace lock with invitation preparation and acceptance.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId)return false;
    const pending=and(eq(workspaceInvites.workspaceId,workspaceId),eq(workspaceInvites.id,id),activeInvite);
    const [invitation]=await tx.select({teamId:workspaceInvites.teamId,viewScope:workspaceInvites.viewScope,editScope:workspaceInvites.editScope,role:workspaceInvites.role}).from(workspaceInvites).where(pending).for('update');
    if(!invitation)return false;
    if(invitation.role===role)return true;
    await checkInvitationTeam(tx,workspaceId,invitation.teamId,delegated);
    // Update the same reservation so its recipient and deadline stay bound to the new link.
    const [updated]=await tx.update(workspaceInvites).set({id:crypto.randomUUID(),role,delegatedTeam:!!invitation.teamId&&delegated}).where(pending)
      .returning({id:workspaceInvites.id});
    return Boolean(updated);
  });
}

export async function respondToWorkspaceInvitation(db:PostgresJsDatabase,actorId:string,email:string,id:string,
  action:'accept_invite'|'decline_invite',ownerEmails?:string[]){
  return db.transaction(async tx=>{
    const addressed=and(eq(workspaceInvites.id,id),eq(workspaceInvites.email,email),activeInvite);
    const [candidate]=await tx.select({workspaceId:workspaceInvites.workspaceId}).from(workspaceInvites).where(addressed);
    if(!candidate)return false;
    const [workspace]=await tx.select({id:privateWorkspaces.id,ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,candidate.workspaceId)).for('update');
    if(!workspace||workspace.ownerId===actorId)return false;
    if(ownerEmails){
      const [owner]=await tx.select({id:loginIdentities.id}).from(loginIdentities)
        .where(and(eq(loginIdentities.id,workspace.ownerId),inArray(loginIdentities.email,ownerEmails)));
      if(!owner)return false;
    }
    const accounts=await tx.select({id:loginIdentities.id}).from(loginIdentities)
      .where(eq(loginIdentities.email,email)).limit(2).for('share');
    if(accounts.length!==1||accounts[0].id!==actorId)return false;
    // Recheck the pending link after locking the workspace. Acceptance converts its reservation to a grant.
    const [invitation]=await tx.delete(workspaceInvites).where(addressed).returning({teamId:workspaceInvites.teamId,delegatedTeam:workspaceInvites.delegatedTeam,viewScope:workspaceInvites.viewScope,editScope:workspaceInvites.editScope,role:workspaceInvites.role});
    if(!invitation)return false;
    if(action==='accept_invite'){
      const {delegatedTeam,...grant}=invitation;
      if(delegatedTeam)await checkInvitationTeam(tx,workspace.id,grant.teamId,true,true);
      await tx.insert(workspaceViewers).values({workspaceId:workspace.id,viewerId:actorId,...grant,id:crypto.randomUUID()})
        .onConflictDoNothing({target:[workspaceViewers.workspaceId,workspaceViewers.viewerId]});
    }
    return true;
  });
}

export async function cancelWorkspaceInvitation(db:PostgresJsDatabase,actorId:string,id:string){
  const owned=db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,workspaceInvites.workspaceId),eq(privateWorkspaces.ownerId,actorId)));
  const [removed]=await db.delete(workspaceInvites).where(and(eq(workspaceInvites.id,id),exists(owned)))
    .returning({id:workspaceInvites.id});
  return !!removed;
}
