import {and,eq,exists} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {SharedRecordWriteScope,WorkspacePermission} from '../../lib/portable-workspace-access';
import {privateWorkspaces} from './contact-schema';
import {workspaceViewers} from './workspace-viewer-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export async function lockRecordWorkspace(tx:Transaction,actorId:string,createIfMissing:boolean,shared?:SharedRecordWriteScope,permission?:WorkspacePermission|WorkspacePermission[],serializeJobs=false){
  if(shared){
    const permissions=typeof permission==='string'?[permission]:permission??[];
    const eligible=and(eq(workspaceViewers.workspaceId,shared.workspaceId),eq(workspaceViewers.viewerId,actorId),
      eq(workspaceViewers.id,shared.grantId),eq(workspaceViewers.role,'editor'),
      ...permissions.map(required=>eq(workspaceViewers[required],true)));
    const editor=tx.select({id:workspaceViewers.workspaceId}).from(workspaceViewers).where(eligible);
    if(serializeJobs){
      // Job admission locks the workspace before the grant. The read predicate avoids locking another workspace.
      const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
        .where(and(eq(privateWorkspaces.id,shared.workspaceId),exists(editor))).for('no key update');
      if(!workspace)return undefined;
    }
    // Role changes and revocations take the same row lock before they can commit.
    const [grant]=await editor.for('share');
    return grant?.id;
  }
  if(createIfMissing){
    await tx.insert(privateWorkspaces).values({id:crypto.randomUUID(),ownerId:actorId})
      .onConflictDoNothing({target:privateWorkspaces.ownerId});
  }
  const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,actorId)).for(serializeJobs?'no key update':'share');
  return workspace?.id;
}
