import {and,asc,eq,exists,gt,inArray} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableManualNoteSequence} from '../../lib/portable-workflows';
import {portableJobs as jobs} from './job-schema';
import {manualWorkflowRunActions as actions} from './workflow-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Job=typeof jobs.$inferSelect;

const laterAction=alias(actions,'later_manual_note_action');
// A single branch Note has a plan receipt but keeps the ordinary Note retry policy.
export const sequenceJobExists=(db:Db,workspaceId:typeof jobs.workspaceId|string,jobId:typeof jobs.id|string)=>
  db.select({id:actions.jobId}).from(actions).where(and(eq(actions.workspaceId,workspaceId),eq(actions.jobId,jobId),
    exists(db.select({id:laterAction.actionId}).from(laterAction).where(and(eq(laterAction.workspaceId,actions.workspaceId),
      eq(laterAction.runId,actions.runId),gt(laterAction.position,0))))));

export async function saveManualNotePlan(tx:Tx,workspaceId:string,runId:string,steps:PortableManualNoteSequence['steps']){
  await tx.insert(actions).values(steps.map(({id:actionId,...step},position)=>({
    workspaceId,runId,position,actionId,...step,plannedJobId:position===0?runId:crypto.randomUUID(),
    jobId:position===0?runId:null,
  })));
}

// Caller holds the successful action's lease and Contact lock. Replacing that job uses no new queue slot.
export async function queueNextManualNote(tx:Tx,job:Job,at:number){
  const [current]=await tx.select({runId:actions.runId,position:actions.position}).from(actions)
    .where(and(eq(actions.workspaceId,job.workspaceId),eq(actions.jobId,job.id)));
  if(!current)return;
  const nextScope=and(eq(actions.workspaceId,job.workspaceId),eq(actions.runId,current.runId),eq(actions.position,current.position+1));
  const [next]=await tx.select().from(actions).where(nextScope);
  if(!next)return;
  if(next.jobId)throw Error('Workflow successor already has a job.');
  const due=at+next.delayMinutes*60_000;
  await tx.insert(jobs).values({workspaceId:job.workspaceId,id:next.plannedJobId,contactId:job.contactId,
    actorId:job.actorId,authorizedOwnerId:job.authorizedOwnerId,kind:'note',body:next.body,
    createdAt:at,scheduledFor:due,availableAt:due});
  await tx.update(actions).set({jobId:next.plannedJobId}).where(nextScope);
}

export function readManualNoteSequenceActions(db:Db,ownerId:string,runIds:string[]){
  return db.select({runId:actions.runId,id:actions.actionId,name:actions.name,delayMinutes:actions.delayMinutes,
    jobId:actions.jobId,status:jobs.status,issue:jobs.issue,attempts:jobs.attempts,scheduledFor:jobs.scheduledFor,
    finishedAt:jobs.finishedAt,
  }).from(actions).innerJoin(workspaces,eq(workspaces.id,actions.workspaceId)).leftJoin(jobs,and(eq(jobs.workspaceId,actions.workspaceId),eq(jobs.id,actions.jobId)))
    .where(and(eq(workspaces.ownerId,ownerId),inArray(actions.runId,runIds))).orderBy(asc(actions.position));
}

export type ManualNoteActionReceipt=Omit<Awaited<ReturnType<typeof readManualNoteSequenceActions>>[number],'runId'>;
