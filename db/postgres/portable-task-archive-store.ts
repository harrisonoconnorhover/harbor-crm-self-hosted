import {and,asc,eq,gt,isNotNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableArchiveInput,PortableArchiveReceipt,PortableArchivedRecord} from '../../lib/portable-contact-archive';
import {lockRecordWorkspace} from './private-workspace-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {archiveAccessError,archivedByLabel,archiveWorkspaceScope} from './portable-archive-scope';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {resolvePortableDealLink} from './portable-related-deal-link';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {advanceTaskOccurrence} from './task-repeat-store';
import {portableTaskArchiveReceipts as receipts,portableTaskEvents,portableTaskSnapshot,portableTasks} from './task-schema';
import {privateWorkspaces} from './workspace-schema';

const pageSize=25;
const iso=(value:string|null)=>value===null?null:new Date(value).toISOString();

export async function readPortableTaskArchive(db:PostgresJsDatabase,actorId:string,after?:string,shared?:SharedRecordWriteScope){
  const rows=await db.select({id:portableTasks.id,name:sql<string>`${portableTasks.data}->>'name'`,
    revision:portableTasks.revision,archivedAt:portableTasks.archivedAt,
    archivedBy:archivedByLabel(portableTaskEvents,portableTaskEvents.taskId,portableTasks.id,portableTasks.workspaceId,portableTasks.revision)})
    .from(portableTasks).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,portableTasks.workspaceId))
    .where(and(archiveWorkspaceScope(db,actorId,shared),isNotNull(portableTasks.archivedAt),after?gt(portableTasks.id,after):undefined))
    .orderBy(asc(portableTasks.id)).limit(pageSize+1);
  const records:PortableArchivedRecord[]=rows.slice(0,pageSize).map(row=>({...row,archivedAt:iso(row.archivedAt)!}));
  return {records,next:rows.length>pageSize?records.at(-1)!.id:null};
}

export function changePortableTaskArchive(db:PostgresJsDatabase,actorId:string,input:PortableArchiveInput,shared?:SharedRecordWriteScope):Promise<PortableArchiveReceipt>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)throw shared?new ApiError(403,archiveAccessError):new ApiError(404,'Task not found in your workspace.');
    const {id,requestId,expectedRevision,action}=input;
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.taskId!==id||previous.action!==action||previous.revision!==expectedRevision+1){
        throw new ApiError(409,'That request ID was used for a different Task change.');
      }
      return {id,action,revision:previous.revision,archivedAt:iso(previous.archivedAt),nextTaskId:previous.nextTaskId??undefined};
    }
    const scope=and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.id,id));
    const [task]=await tx.select().from(portableTasks).where(scope).for('update');
    if(!task)throw new ApiError(404,'Task not found in your workspace.');
    if(task.revision!==expectedRevision||Boolean(task.archivedAt)!==(action==='restore')){
      throw new ApiError(409,'This Task changed. Refresh before trying again.');
    }
    const now=new Date().toISOString(),archivedAt=action==='archive'?now:null,revision=expectedRevision+1;
    let nextTaskId:string|undefined;
    if(archivedAt&&task.data.repeat&&task.data.dueDate){
      const contact=await resolvePortableContactLink(tx,workspaceId,task.contactId,undefined);
      const company=await resolvePortableCompanyLink(tx,workspaceId,task.companyId,undefined);
      const deal=await resolvePortableDealLink(tx,workspaceId,task.dealId,undefined);
      nextTaskId=await advanceTaskOccurrence(tx,workspaceId,actorId,{...task,contactId:contact?.visibleId??null,
        companyId:company?.visibleId??null,dealId:deal?.visibleId??null},now);
    }
    await tx.update(portableTasks).set({archivedAt,revision,updatedAt:now}).where(scope);
    const snapshot=portableTaskSnapshot(task);
    await tx.insert(portableTaskEvents).values({workspaceId,taskId:id,revision,actorId,previous:snapshot,data:snapshot,occurredAt:now});
    await tx.insert(receipts).values({workspaceId,requestId,taskId:id,action,revision,archivedAt,nextTaskId});
    return {id,action,revision,archivedAt,nextTaskId};
  });
}
