import {and,eq,exists,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {initialAccountDefaults,type AccountDefaults,type AccountDefaultsState} from '../../lib/portable-account-defaults';
import {privateWorkspaces as workspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';

export async function readAccountDefaults(db:PostgresJsDatabase,actorId:string,workspaceId?:string):Promise<AccountDefaultsState>{
  const membership=db.select({id:workspaceViewers.id}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,workspaces.id),eq(workspaceViewers.viewerId,actorId)));
  const scope=workspaceId?and(eq(workspaces.id,workspaceId),exists(membership)):eq(workspaces.ownerId,actorId);
  const [row]=await db.select({defaults:workspaces.accountDefaults,revision:workspaces.accountDefaultsRevision})
    .from(workspaces).where(scope).limit(1);
  return row?.defaults?{defaults:row.defaults,revision:row.revision}:{defaults:initialAccountDefaults,revision:0};
}

export function writeAccountDefaults(db:PostgresJsDatabase,actor:PostgresSessionActor,input:AccountDefaults&{revision:number}){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to edit account defaults.');
    const id=await lockRecordWorkspace(tx,actor.userId,true,undefined,undefined,true);
    const {revision,...defaults}=input;
    const [row]=await tx.update(workspaces).set({accountDefaults:defaults,accountDefaultsRevision:sql`${workspaces.accountDefaultsRevision}+1`})
      .where(and(eq(workspaces.id,id!),eq(workspaces.ownerId,actor.userId),eq(workspaces.accountDefaultsRevision,revision)))
      .returning({revision:workspaces.accountDefaultsRevision});
    if(!row)throw new ApiError(409,'Account defaults changed. Reload the page before saving.');
    return {defaults,revision:row.revision};
  });
}
