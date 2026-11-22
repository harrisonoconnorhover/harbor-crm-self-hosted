import {and,asc,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {portableManualBatchLimit,type PortableManualWorkflowBatch} from '../../lib/portable-workflows';
import {contactEvents} from './contact-schema';
import {portableJobs as jobs} from './job-schema';
import {jobClock} from './job-store';
import {activeManualWorkflow,manualRunFields,manualRunReceipt,manualRunTargets} from './manual-workflow-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {manualWorkflowBatches as batches,manualWorkflowRuns as runs} from './workflow-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
const batchFields={id:batches.id,workflowId:batches.workflowId,workflowRevision:batches.workflowRevision,
  workflowName:batches.workflowName,createdAt:batches.createdAt};
const batchRuns=(workspaceId:string,batchId:string)=>and(eq(runs.workspaceId,workspaceId),eq(runs.batchId,batchId));

async function stableNoteRunId(workspaceId:string,batchId:string,contactId:string){
  const source=new TextEncoder().encode(['harbor.manual.note.batch.v1',workspaceId,batchId,contactId].join('/'));
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',source)).subarray(0,16);
  // UUIDv8 carries the namespaced hash in the existing UUID job columns.
  bytes[6]=(bytes[6]&0x0f)|0x80;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export function admitManualNoteBatch(db:Db,actorId:string,input:PortableManualWorkflowBatch){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workflow not found.');
    const [prior]=await tx.select(batchFields).from(batches).where(and(eq(batches.workspaceId,workspaceId),eq(batches.id,input.id)));
    if(prior){
      const saved=await tx.select(manualRunFields).from(runs).where(batchRuns(workspaceId,input.id))
        .orderBy(asc(runs.contactId)).limit(portableManualBatchLimit);
      if(prior.workflowId!==input.workflowId||prior.workflowRevision!==input.workflowRevision||
        saved.length!==input.contactIds.length||saved.some((run,index)=>run.contactId!==input.contactIds[index])){
        throw new ApiError(409,'This batch ID was already used with different details.');
      }
      return {batch:{...prior,runs:saved.map(manualRunReceipt)},created:false};
    }

    const {definition,revision}=await activeManualWorkflow(tx,workspaceId,input);
    if((definition.actionKind!==undefined&&definition.actionKind!=='note')||definition.delayMinutes!==0)
      throw new ApiError(409,'Choose an immediate manual Contact Note workflow for a batch.');
    const ids=await Promise.all(input.contactIds.map(contactId=>stableNoteRunId(workspaceId,input.id,contactId)));
    const targets=await manualRunTargets(tx,workspaceId,input.workflowId,input.contactIds,ids);
    const byId=new Map(targets.map(target=>[target.id,target.revision]));
    const at=await jobClock(tx);
    const [batch]=await tx.insert(batches).values({workspaceId,id:input.id,workflowId:input.workflowId,
      workflowRevision:revision,workflowName:definition.name,createdAt:at}).returning(batchFields);
    const inserted=await tx.insert(jobs).values(input.contactIds.map((contactId,index)=>({
      workspaceId,id:ids[index],contactId,actorId,authorizedOwnerId:actorId,kind:'note' as const,
      body:definition.body,scheduledFor:at,availableAt:at,createdAt:at,
    }))).onConflictDoNothing().returning({id:jobs.id});
    if(inserted.length!==input.contactIds.length)throw new ApiError(409,'A run ID is already in use.');
    const saved=await tx.insert(runs).values(input.contactIds.map((contactId,index)=>({
      workspaceId,id:ids[index],batchId:input.id,workflowId:input.workflowId,workflowRevision:revision,
      workflowName:definition.name,contactId,contactRevision:byId.get(contactId)!,createdAt:at,
    }))).returning(manualRunFields);
    const children=saved.sort((a,b)=>a.contactId<b.contactId?-1:a.contactId>b.contactId?1:0);
    return {batch:{...batch,runs:children.map(manualRunReceipt)},created:true};
  });
}

export function readManualNoteBatch(db:Db,actorId:string,batchId:string){
  return db.transaction(async tx=>{
    const [receipt]=await tx.select({...batchFields,workspaceId:batches.workspaceId}).from(batches)
      .innerJoin(workspaces,eq(workspaces.id,batches.workspaceId))
      .where(and(eq(workspaces.ownerId,actorId),eq(batches.id,batchId))).limit(1);
    if(!receipt)return null;
    const {workspaceId,...batch}=receipt;
    const children=await tx.select({...manualRunFields,status:jobs.status,issue:jobs.issue,attempts:jobs.attempts,
      contactName:sql<string>`${contactEvents.data}->>'name'`})
      .from(runs).innerJoin(jobs,and(eq(jobs.workspaceId,runs.workspaceId),eq(jobs.id,runs.id)))
      .innerJoin(contactEvents,and(eq(contactEvents.workspaceId,runs.workspaceId),eq(contactEvents.contactId,runs.contactId),
        eq(contactEvents.revision,runs.contactRevision)))
      .where(batchRuns(workspaceId,batchId)).orderBy(asc(runs.contactId)).limit(portableManualBatchLimit);
    return {...batch,runs:children.map(run=>({...run,jobId:run.id}))};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
