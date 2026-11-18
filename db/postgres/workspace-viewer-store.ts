import {and,asc,eq,exists,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {SharedRecordWriteScope,WorkspacePermission,WorkspaceRole} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {workspaceInvites} from './workspace-invite-schema';
import {workspaceHasRoom,workspaceInvitations,workspaceSeatLimit,workspaceSentInvitations} from './workspace-invite-store';

const extraFields={contactFiles:workspaceViewers.contactFiles,scheduledNotes:workspaceViewers.scheduledNotes,
  contactOutreach:workspaceViewers.contactOutreach,recordActivities:workspaceViewers.recordActivities};
type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type GrantChange={role:WorkspaceRole}|{backupAdmin:boolean}|Partial<Record<WorkspacePermission,boolean>>;

function workspaceDirectory(db:PostgresJsDatabase,workspaceId:string){
  return db.select({id:workspaceViewers.id,email:loginIdentities.email,role:workspaceViewers.role,backupAdmin:workspaceViewers.backupAdmin,...extraFields})
    .from(workspaceViewers).innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
    .where(eq(workspaceViewers.workspaceId,workspaceId)).orderBy(asc(loginIdentities.email)).limit(workspaceSeatLimit);
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
  const [viewers,sent]=await Promise.all([workspaceDirectory(tx,scope.workspaceId),workspaceSentInvitations(tx,scope.workspaceId)]);
  return {managed:{...scope,ownerEmail,permissions},owned:null,viewers,sent,incoming:[],shared:[]};
}

export function recordWorkspaceScope(db:PostgresJsDatabase,actorId:string,workspaceId?:string,permission?:WorkspacePermission){
  if(!workspaceId)return eq(privateWorkspaces.ownerId,actorId);
  const grant=db.select({id:workspaceViewers.id}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.viewerId,actorId),
      permission?eq(workspaceViewers[permission],true):undefined));
  return and(eq(privateWorkspaces.id,workspaceId),exists(grant));
}

export async function sharedWorkspaceGrant(db:PostgresJsDatabase,actorId:string,workspaceId:string){
  const [grant]=await db.select({id:workspaceViewers.id,role:workspaceViewers.role,contactFiles:workspaceViewers.contactFiles,scheduledNotes:workspaceViewers.scheduledNotes,contactOutreach:workspaceViewers.contactOutreach,recordActivities:workspaceViewers.recordActivities}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId))).limit(1);
  return grant;
}

export async function readWorkspaceSharing(db:PostgresJsDatabase,actorId:string,email:string,ownerEmails?:string[]){
  const [workspace]=ownerEmails?[]:await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,actorId)).limit(1);
  const [viewers,shared,invitations]=await Promise.all([
    workspace?workspaceDirectory(db,workspace.id):[],
    db.select({id:workspaceViewers.workspaceId,ownerEmail:loginIdentities.email,role:workspaceViewers.role,...extraFields,
      backupAdmin:workspaceViewers.backupAdmin,grantId:workspaceViewers.id}).from(workspaceViewers)
      .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceViewers.workspaceId))
      .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
      .where(and(eq(workspaceViewers.viewerId,actorId),ownerEmails?inArray(loginIdentities.email,ownerEmails):undefined)).orderBy(asc(workspaceViewers.workspaceId)).limit(100),
    workspaceInvitations(db,actorId,email,workspace?.id,ownerEmails),
  ]);
  return {owned:workspace?.id??null,viewers,shared,...invitations};
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
  if(admin&&('backupAdmin' in change||Object.keys(change).some(key=>key in extraFields&&!admin.permissions[key as WorkspacePermission])))return false;
  const promotion='role' in change&&change.role==='editor';
  const [changed]=await db.update(workspaceViewers).set({id:crypto.randomUUID(),...change,
    ...('role' in change&&change.role==='viewer'?{backupAdmin:false}:{})})
    .where(and(ownedGrant(db,ownerId,grantId),
      'backupAdmin' in change&&change.backupAdmin?eq(workspaceViewers.role,'editor'):undefined,
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
