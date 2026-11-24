import {allToolViews} from './member-tool-access';
import type {MemberTool,MemberToolPolicy} from '../../lib/portable-tool-permissions';
import {readDirectoryGroupMappings} from './workspace-directory-group-store';
import {directoryGroupMembers,directoryUsers} from './workspace-directory-schema';
import {directoryManagesAddress} from './workspace-directory-access';
import {readOwnedWorkspaceId} from './private-workspace-store';
import {memberTeamPaths,readDirectoryTeams} from './workspace-team-store';
import {and,asc,eq,exists,gt,ilike,inArray,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableWorkspaceSeatLimit} from '../../runtime/portable-config.mjs';
import type {RecordScope,SharedRecordWriteScope,WorkspacePermission,WorkspaceRole} from '../../lib/portable-workspace-access';
import {recordSearchPattern} from './record-search';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceInvites} from './workspace-invite-schema';
import {workspaceHasRoom,workspaceInvitations,workspaceSentInvitations} from './workspace-invite-store';

const extraFields={contactFiles:workspaceViewers.contactFiles,scheduledNotes:workspaceViewers.scheduledNotes,
  contactOutreach:workspaceViewers.contactOutreach,recordActivities:workspaceViewers.recordActivities};
type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type GrantChange={viewScope:RecordScope;editScope:RecordScope}|{role:WorkspaceRole}|{backupAdmin:boolean}|Partial<Record<WorkspacePermission,boolean>>;

function workspaceDirectory(db:PostgresJsDatabase,workspaceId:string){
  return db.select({id:workspaceViewers.id,actorId:workspaceViewers.viewerId,email:loginIdentities.email,teamId:workspaceViewers.teamId,
    directoryTeamManaged:sql<boolean>`${directoryGroupMembers.userId} IS NOT NULL`,
    toolPolicies:workspaceViewers.toolPolicies,viewScope:workspaceViewers.viewScope,editScope:workspaceViewers.editScope,role:workspaceViewers.role,backupAdmin:workspaceViewers.backupAdmin,...extraFields})
    .from(workspaceViewers).innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
    .leftJoin(directoryGroupMembers,and(eq(directoryGroupMembers.workspaceId,workspaceViewers.workspaceId),
      eq(directoryGroupMembers.userId,workspaceViewers.viewerId)))
    .where(eq(workspaceViewers.workspaceId,workspaceId)).orderBy(asc(loginIdentities.email));
}

// Read the roster and its team paths at the same point in time, including when
// another owner session is moving a department or revoking an employee.
export function readOwnerAccessRoster(db:PostgresJsDatabase,ownerId:string,workspaceId:string){
  return db.transaction(async tx=>{
    if(await readOwnedWorkspaceId(tx,ownerId)!==workspaceId)return null;
    const members=await workspaceDirectory(tx,workspaceId);
    const teams=await readDirectoryTeams(tx,workspaceId);
    const provisioned=await tx.select({id:directoryUsers.userId}).from(directoryUsers)
      .innerJoin(workspaceViewers,and(eq(workspaceViewers.workspaceId,directoryUsers.workspaceId),
        eq(workspaceViewers.viewerId,directoryUsers.userId)))
      .where(eq(directoryUsers.workspaceId,workspaceId));
    return {members,teams,directoryUsers:new Set(provisioned.map(row=>row.id))};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

// Check the administrator's own current grant. Match the record writer's lock order so
// a revoke/demotion and a prepared team change always have a defined order.
export async function lockBackupAdministrator(tx:Transaction,actorId:string,scope:SharedRecordWriteScope,ownerEmails?:string[]){
  const eligible=and(eq(workspaceViewers.workspaceId,scope.workspaceId),eq(workspaceViewers.viewerId,actorId),
    eq(workspaceViewers.id,scope.grantId),eq(workspaceViewers.backupAdmin,true),eq(workspaceViewers.role,'editor'));
  const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId,ownerEmail:loginIdentities.email}).from(privateWorkspaces)
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(privateWorkspaces.id,scope.workspaceId),ownerEmails?inArray(loginIdentities.email,ownerEmails):undefined,
      exists(tx.select({id:workspaceViewers.id}).from(workspaceViewers).where(eligible))))
    .for('no key update',{of:privateWorkspaces});
  if(!workspace)return undefined;
  const [permissions]=await tx.select(extraFields).from(workspaceViewers).where(eligible).for('share');
  return permissions?{...workspace,scope,permissions}:undefined;
}
export type BackupAdministration=NonNullable<Awaited<ReturnType<typeof lockBackupAdministrator>>>;

export async function readManagedWorkspaceDirectory(tx:Transaction,admin:BackupAdministration){
  const {scope,permissions,ownerEmail}=admin;
  const [viewers,sent,teams]=await Promise.all([workspaceDirectory(tx,scope.workspaceId),workspaceSentInvitations(tx,scope.workspaceId),readDirectoryTeams(tx,scope.workspaceId)]);
  return {seatLimit:portableWorkspaceSeatLimit(process.env),managed:{...scope,ownerEmail,permissions},owned:null,teams,viewers,sent,incoming:[],shared:[]};
}

function readableWorkspace(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,requiresAllRecords:boolean,permission?:WorkspacePermission){
  if(!workspaceId)return eq(privateWorkspaces.ownerId,actorId);
  const grant=db.select({id:workspaceViewers.id}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.viewerId,actorId),
      requiresAllRecords?allToolViews:undefined,permission?eq(workspaceViewers[permission],true):undefined));
  return and(eq(privateWorkspaces.id,workspaceId),exists(grant));
}

export function recordWorkspaceScope(db:PostgresJsDatabase,actorId:string,workspaceId?:string,permission?:WorkspacePermission){
  return readableWorkspace(db,actorId,workspaceId,true,permission);
}

// Field definitions, pipeline settings and shared view definitions contain no result rows or counts.
export function recordCatalogScope(db:PostgresJsDatabase,actorId:string,workspaceId?:string,permission?:WorkspacePermission){
  return readableWorkspace(db,actorId,workspaceId,false,permission);
}

export async function sharedWorkspaceGrant(db:PostgresJsDatabase,actorId:string,workspaceId:string,coreRecords=false){
  const [grant]=await db.select({id:workspaceViewers.id,toolPolicies:workspaceViewers.toolPolicies,viewScope:workspaceViewers.viewScope,editScope:workspaceViewers.editScope,role:workspaceViewers.role,contactFiles:workspaceViewers.contactFiles,scheduledNotes:workspaceViewers.scheduledNotes,contactOutreach:workspaceViewers.contactOutreach,recordActivities:workspaceViewers.recordActivities}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId),coreRecords?undefined:allToolViews)).limit(1);
  return grant;
}

export async function readOwnRecordPermissions(db:PostgresJsDatabase,actorId:string,workspaceId:string){
  const [member]=await db.select({role:workspaceViewers.role,backupAdmin:workspaceViewers.backupAdmin,team:workspaceTeams.name,teamPaths:memberTeamPaths,
    viewScope:workspaceViewers.viewScope,editScope:workspaceViewers.editScope,toolPolicies:workspaceViewers.toolPolicies})
    .from(workspaceViewers).leftJoin(workspaceTeams,and(eq(workspaceTeams.workspaceId,workspaceViewers.workspaceId),
      eq(workspaceTeams.id,workspaceViewers.teamId)))
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId))).limit(1);
  return member;
}

export async function joinedWorkspacePage(db:PostgresJsDatabase,actorId:string,ownerEmails?:string[],
  options:{q?:string;after?:string;current?:string}={},limit=25){
  const source=()=>db.select({id:workspaceViewers.workspaceId,ownerEmail:loginIdentities.email,role:workspaceViewers.role,...extraFields,
    meetingsVisible:sql<boolean>`${workspaceViewers.role}='editor' AND coalesce(${workspaceViewers.toolPolicies}->'meetings'->>'view','all')<>'none'`,backupAdmin:workspaceViewers.backupAdmin,grantId:workspaceViewers.id}).from(workspaceViewers)
    .innerJoin(privateWorkspaces,eq(workspaceViewers.workspaceId,privateWorkspaces.id))
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId));
  const scope=and(eq(workspaceViewers.viewerId,actorId),ownerEmails?inArray(loginIdentities.email,ownerEmails):undefined);
  const pattern=recordSearchPattern(options.q);
  const [current]=options.current?await source().where(and(scope,eq(workspaceViewers.workspaceId,options.current))).limit(1):[];
  if(options.current&&!current)return null;
  const rows=await source().where(and(scope,current?ne(workspaceViewers.workspaceId,current.id):undefined,
    options.after?gt(workspaceViewers.workspaceId,options.after):undefined,pattern?ilike(loginIdentities.email,pattern):undefined))
    .orderBy(asc(workspaceViewers.workspaceId)).limit(limit+1);
  return {current,items:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null};
}

export async function readWorkspaceSharing(db:PostgresJsDatabase,actorId:string,email:string,ownerEmails?:string[],directoryTenant?:string,directoryIssuer?:string,oidcIssuer?:string){
  const [workspace]=ownerEmails?[]:await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,actorId)).limit(1);
  const [viewers,shared,invitations,teams,mappings,samlMappings,oidcMappings]=await Promise.all([
    workspace?workspaceDirectory(db,workspace.id):[],
    joinedWorkspacePage(db,actorId,ownerEmails,{},100),
    workspaceInvitations(db,actorId,email,workspace?.id,ownerEmails),
    workspace?readDirectoryTeams(db,workspace.id):[],
    workspace&&directoryTenant?readDirectoryGroupMappings(db,workspace.id,{tenant:directoryTenant}):undefined,
    workspace&&directoryIssuer?readDirectoryGroupMappings(db,workspace.id,{protocol:'saml',issuer:directoryIssuer}):undefined,
    workspace&&oidcIssuer?readDirectoryGroupMappings(db,workspace.id,{protocol:'oidc',issuer:oidcIssuer}):undefined,
  ]);
  return {seatLimit:portableWorkspaceSeatLimit(process.env),owned:workspace?.id??null,teams,viewers,shared:shared!.items,sharedNext:shared!.next,...invitations,
    ...(mappings?{directoryGroupMappings:mappings.map(({groupKey,...row})=>({...row,externalId:groupKey}))}:{}),
    ...(oidcMappings?{oidcGroupMappings:oidcMappings.map(({groupKey,...row})=>({...row,groupName:groupKey}))}:{}),
    ...(samlMappings?{samlGroupMappings:samlMappings.map(({groupKey,...row})=>({...row,groupName:groupKey}))}:{})};
}

export async function grantWorkspaceView(db:PostgresJsDatabase,actorId:string,email:string){
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.ownerId,actorId)).for('update');
    if(!workspace)return 'no_workspace';
    const accounts=await tx.select({id:loginIdentities.id}).from(loginIdentities)
      .where(eq(loginIdentities.email,email)).limit(2).for('share');
    if(accounts.length!==1||accounts[0].id===actorId)return 'no_account';
    const scope=eq(workspaceViewers.workspaceId,workspace.id),viewerId=accounts[0].id;
    if(await directoryManagesAddress(tx,workspace.id,email))return 'directory_managed';
    const [existing]=await tx.select({id:workspaceViewers.id}).from(workspaceViewers)
      .where(and(scope,eq(workspaceViewers.viewerId,viewerId)));
    if(existing)return 'ok';
    const [invitation]=await tx.select({id:workspaceInvites.id}).from(workspaceInvites).where(and(
      eq(workspaceInvites.workspaceId,workspace.id),eq(workspaceInvites.email,email),
      gt(workspaceInvites.expiresAt,sql`clock_timestamp()`)));
    if(invitation)return 'pending';
    if(!await workspaceHasRoom(tx,workspace.id))return 'full';
    await tx.insert(workspaceViewers).values({workspaceId:workspace.id,viewerId,id:crypto.randomUUID()});
    return 'ok';
  });
}

function ownedGrant(db:PostgresJsDatabase,actorId:string,grantId:string){
  const owned=db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,workspaceViewers.workspaceId),eq(privateWorkspaces.ownerId,actorId)));
  return and(eq(workspaceViewers.id,grantId),exists(owned));
}

export async function changeWorkspaceGrant(db:PostgresJsDatabase,ownerId:string,grantId:string,change:GrantChange,admin?:BackupAdministration){
  if(admin&&('viewScope' in change||'backupAdmin' in change||Object.keys(change).some(key=>key in extraFields&&!admin.permissions[key as WorkspacePermission])))return false;
  const promotion='role' in change&&change.role==='editor';
  const [changed]=await db.update(workspaceViewers).set({id:crypto.randomUUID(),...change,
    ...('role' in change&&change.role==='viewer'?{backupAdmin:false}:{})})
    .where(and(ownedGrant(db,ownerId,grantId),
      'backupAdmin' in change&&change.backupAdmin?and(eq(workspaceViewers.role,'editor'),eq(workspaceViewers.editScope,'all')):undefined,
      'editScope' in change&&change.editScope!=='all'?eq(workspaceViewers.backupAdmin,false):undefined,
      admin?eq(workspaceViewers.backupAdmin,false):undefined,
      ...(admin&&promotion?Object.entries(extraFields).filter(([key])=>!admin.permissions[key as WorkspacePermission])
        .map(([,column])=>eq(column,false)):[]))).returning({id:workspaceViewers.id});
  return !!changed;
}

export async function revokeWorkspaceView(db:PostgresJsDatabase,ownerId:string,grantId:string,admin?:BackupAdministration){
  const [removed]=await db.delete(workspaceViewers).where(and(ownedGrant(db,ownerId,grantId),admin?eq(workspaceViewers.backupAdmin,false):undefined))
    .returning({id:workspaceViewers.id});
  return !!removed;
}

export async function changeMemberToolPolicies(tx:Transaction,ownerId:string,ids:string[],tool:MemberTool,policy:MemberToolPolicy){
  const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,ownerId)).for('no key update');
  if(!workspace)return false;
  const selected=and(eq(workspaceViewers.workspaceId,workspace.id),inArray(workspaceViewers.id,ids));
  const current=await tx.select({id:workspaceViewers.id}).from(workspaceViewers).where(selected)
    .orderBy(asc(workspaceViewers.id)).for('update');
  if(current.length!==ids.length)return false;
  await tx.update(workspaceViewers).set({id:sql`gen_random_uuid()`,
    toolPolicies:sql`jsonb_set(${workspaceViewers.toolPolicies},ARRAY[${tool}::text],${JSON.stringify(policy)}::jsonb)`}).where(selected);
  return true;
}
