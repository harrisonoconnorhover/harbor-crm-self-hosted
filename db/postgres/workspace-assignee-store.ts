import {and,asc,eq,exists} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordOwner} from '../../lib/portable-records';
import {loginIdentities} from './identity-schema';
import {workspaceSeatLimit} from './workspace-invite-store';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const identityColumns={id:loginIdentities.id,email:loginIdentities.email,name:loginIdentities.fullName};
export const assigneeLabel=(member:{name:string|null;email:string})=> (member.name?.trim()||member.email).slice(0,100);

export async function activeWorkspaceAssignee(tx:Transaction,workspaceId:string,id:string){
  const [owner]=await tx.select(identityColumns).from(loginIdentities)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.ownerId,loginIdentities.id))
    .where(and(eq(privateWorkspaces.id,workspaceId),eq(loginIdentities.id,id)));
  if(owner)return owner;
  const [member]=await tx.select(identityColumns).from(loginIdentities)
    .innerJoin(workspaceViewers,eq(workspaceViewers.viewerId,loginIdentities.id))
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,id),
      eq(workspaceViewers.role,'editor'))).for('share');
  return member;
}

export async function resolvePortableRecordOwner(tx:Transaction,workspaceId:string,
  assigneeId:string|null|undefined,current?:PortableRecordOwner):Promise<PortableRecordOwner|undefined|false>{
  if(assigneeId===undefined)return current;
  if(assigneeId===null)return undefined;
  const member=await activeWorkspaceAssignee(tx,workspaceId,assigneeId);
  return member?{userId:member.id,workspaceId,label:assigneeLabel(member)}:false;
}

export async function portableWorkspaceAssignees(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  return db.transaction(async tx=>{
    const requester=tx.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(
      eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.role,'editor')));
    const [owner]=await tx.select({...identityColumns,workspaceId:privateWorkspaces.id}).from(privateWorkspaces)
      .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
      .where(workspaceId?and(eq(privateWorkspaces.id,workspaceId),exists(requester)):eq(privateWorkspaces.ownerId,actorId)).limit(1);
    if(!owner){
      if(workspaceId)return [];
      // The owner can assign their first record to themselves before the workspace exists.
      const [identity]=await tx.select(identityColumns).from(loginIdentities).where(eq(loginIdentities.id,actorId)).limit(1);
      return identity?[{id:identity.id,label:assigneeLabel(identity)}]:[];
    }
    const editors=await tx.select(identityColumns).from(workspaceViewers)
      .innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
      .where(and(eq(workspaceViewers.workspaceId,owner.workspaceId),eq(workspaceViewers.role,'editor')))
      .orderBy(asc(loginIdentities.fullName),asc(loginIdentities.email),asc(loginIdentities.id)).limit(workspaceSeatLimit);
    return [owner,...editors].map(member=>({id:member.id,label:assigneeLabel(member)}));
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
