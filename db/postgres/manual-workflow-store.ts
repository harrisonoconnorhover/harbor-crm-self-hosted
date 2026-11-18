import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableManualWorkflowRun,PortableWorkflowCursor} from '../../lib/portable-workflows';
import {portableCodeJobs} from './code-job-schema';
import {contactEvents,contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs,portableTaskJobs} from './job-schema';
import {availableJobSlots,jobClock} from './job-store';
import {readManualNoteSequenceActions,saveManualNotePlan,type ManualNoteActionReceipt} from './manual-workflow-action-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {dealWorkflowActivations as active,dealWorkflowRuns as automaticRuns,dealWorkflows as workflows,manualWorkflowRunActions as actions,manualWorkflowRuns as runs} from './workflow-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
export const manualRunFields={id:runs.id,workflowId:runs.workflowId,workflowRevision:runs.workflowRevision,workflowName:runs.workflowName,
  contactId:runs.contactId,contactRevision:runs.contactRevision,createdAt:runs.createdAt};
export const manualRunReceipt=(row:Pick<typeof runs.$inferSelect,keyof typeof manualRunFields>)=>({...row,jobId:row.id});

export async function activeManualWorkflow(tx:Tx,workspaceId:string,input:{workflowId:string;workflowRevision:number}){
  const [workflow]=await tx.select({revision:workflows.revision,definition:workflows.definition,enabled:active.workflowId})
    .from(workflows).leftJoin(active,and(eq(active.workspaceId,workflows.workspaceId),eq(active.workflowId,workflows.id)))
    .where(and(eq(workflows.workspaceId,workspaceId),eq(workflows.id,input.workflowId)));
  if(!workflow)throw new ApiError(404,'Workflow not found.');
  if(workflow.definition.trigger!=='manual_contact'||!workflow.enabled||workflow.revision!==input.workflowRevision){
    throw new ApiError(409,'Choose an enabled, current manual Contact workflow.');
  }
  return {...workflow,definition:workflow.definition};
}

// Both admissions hold the workspace lock before checking contact, queue or ID state.
export async function manualRunTargets(tx:Tx,workspaceId:string,workflowId:string,contactIds:string[],runIds:string[],includeData=false){
  const targets=await tx.select({id:contacts.id,revision:contacts.revision,...(includeData?{data:contacts.data}:{})})
    .from(contacts).where(and(eq(contacts.workspaceId,workspaceId),inArray(contacts.id,contactIds),activeContact));
  if(targets.length!==contactIds.length)throw new ApiError(404,contactIds.length===1?'Contact not found.':'One or more contacts are unavailable.');
  const [pending]=await tx.select({id:runs.id}).from(runs)
    .leftJoin(actions,and(eq(actions.workspaceId,runs.workspaceId),eq(actions.runId,runs.id)))
    .innerJoin(jobs,and(eq(jobs.workspaceId,runs.workspaceId),eq(jobs.id,sql`coalesce(${actions.jobId},${runs.id})`)))
    .where(and(eq(runs.workspaceId,workspaceId),eq(runs.workflowId,workflowId),inArray(runs.contactId,contactIds),
      inArray(jobs.status,['queued','running']))).limit(1);
  if(pending)throw new ApiError(409,contactIds.length===1?'This contact already has a pending run for this workflow.':
    'One of these contacts already has a pending run for this workflow.');
  if(await availableJobSlots(tx,workspaceId)<contactIds.length)
    throw new ApiError(409,contactIds.length===1?'The workspace job queue is full. Try again after jobs finish.':
      'The workspace job queue has too few open slots. Try again after jobs finish.');
  const [automaticCollision]=await tx.select({id:automaticRuns.id}).from(automaticRuns)
    .where(and(eq(automaticRuns.workspaceId,workspaceId),inArray(automaticRuns.id,runIds))).limit(1);
  if(automaticCollision)throw new ApiError(409,contactIds.length===1?'This run ID is already in use.':'A run ID is already in use.');
  return targets;
}

export function admitManualWorkflowRun(db:Db,actorId:string,input:PortableManualWorkflowRun,codeAvailable=false){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workflow not found.');
    const [prior]=await tx.select({...manualRunFields,batchId:runs.batchId}).from(runs)
      .where(and(eq(runs.workspaceId,workspaceId),eq(runs.id,input.id)));
    if(prior){
      const {batchId,...previous}=prior;
      if(batchId||prior.workflowId!==input.workflowId||prior.workflowRevision!==input.workflowRevision||prior.contactId!==input.contactId){
        throw new ApiError(409,'This run ID was already used with different details.');
      }
      return {run:manualRunReceipt(previous),created:false};
    }
    const workflow=await activeManualWorkflow(tx,workspaceId,input);
    const definition=workflow.definition;
    const code=definition.actionKind==='code';
    if(code&&!codeAvailable)throw new ApiError(403,'JavaScript actions are unavailable in this deployment.');
    const branch=definition.actionKind==='note_branch';
    const [contact]=await manualRunTargets(tx,workspaceId,input.workflowId,[input.contactId],[input.id],code||branch);
    const matches=branch&&contact.data?.lifecycle===definition.lifecycle;
    const first=branch?(matches?definition.match:definition.otherwise):
      definition.actionKind==='note_sequence'?definition.steps[0]:definition;
    const at=await jobClock(tx),due=at+first.delayMinutes*60_000;
    const [job]=await tx.insert(jobs).values({
      workspaceId,id:input.id,contactId:input.contactId,actorId,authorizedOwnerId:actorId,kind:code?'code':definition.actionKind==='task'?'task':'note',
      body:definition.actionKind==='task'?definition.task.name:'body' in first?first.body:'JavaScript action',scheduledFor:due,availableAt:due,createdAt:at,
    }).onConflictDoNothing().returning({id:jobs.id});
    if(!job)throw new ApiError(409,'This run ID is already in use.');
    if(definition.actionKind==='task')await tx.insert(portableTaskJobs).values({workspaceId,jobId:job.id,payload:definition.task});
    if(code){
      const inputFields=Object.fromEntries(definition.inputs.map(({name,field})=>[name,contact.data?.[field]??'']));
      await tx.insert(portableCodeJobs).values({workspaceId,jobId:job.id,payload:{code:definition.code,
        inputFields,outputs:definition.outputs}});
    }
    const [saved]=await tx.insert(runs).values({workspaceId,id:input.id,workflowId:input.workflowId,
      workflowRevision:workflow.revision,workflowName:workflow.definition.name,contactId:input.contactId,
      contactRevision:contact.revision,createdAt:at}).returning(manualRunFields);
    if(definition.actionKind==='note_sequence')await saveManualNotePlan(tx,workspaceId,saved.id,definition.steps);
    if(branch){
      const note=matches?definition.match:definition.otherwise;
      await saveManualNotePlan(tx,workspaceId,saved.id,[{...note,id:input.id,name:matches?'Lifecycle matches':'Otherwise'}]);
    }
    return {run:manualRunReceipt(saved),created:true};
  });
}

export async function readManualWorkflowRuns(db:Db,actorId:string,after?:PortableWorkflowCursor,runWorkflowId?:string){
  const rows=await db.select({id:runs.id,workflowName:runs.workflowName,manual:sql<boolean>`true`,
    dealId:sql<null>`null`,dealRevision:sql<null>`null`,dealName:sql<null>`null`,
    contactId:runs.contactId,contactRevision:runs.contactRevision,contactName:sql<string|null>`${contactEvents.data}->>'name'`,
    createdAt:runs.createdAt,issue:sql<null>`null`,jobStatus:jobs.status,jobIssue:jobs.issue,
    attempts:jobs.attempts,jobKind:jobs.kind,scheduledFor:jobs.scheduledFor,jobId:jobs.id,codeOutput:portableCodeJobs.result,batchId:runs.batchId,
  }).from(runs).innerJoin(workspaces,eq(workspaces.id,runs.workspaceId))
    .innerJoin(contactEvents,and(eq(contactEvents.workspaceId,runs.workspaceId),eq(contactEvents.contactId,runs.contactId),
      eq(contactEvents.revision,runs.contactRevision)))
    .innerJoin(jobs,and(eq(jobs.workspaceId,runs.workspaceId),eq(jobs.id,runs.id)))
    .leftJoin(portableCodeJobs,and(eq(portableCodeJobs.workspaceId,jobs.workspaceId),eq(portableCodeJobs.jobId,jobs.id)))
    .where(and(eq(workspaces.ownerId,actorId),runWorkflowId?eq(runs.workflowId,runWorkflowId):undefined,
      after?sql`(${runs.createdAt},${runs.id}) < (${after.at},${after.id}::uuid)`:undefined))
    .orderBy(desc(runs.createdAt),desc(runs.id)).limit(26);
  if(!rows.length)return [];
  const byRun=new Map<string,ManualNoteActionReceipt[]>();
  const actionRows=await readManualNoteSequenceActions(db,actorId,rows.map(row=>row.id));
  for(const {runId,...action} of actionRows){
    const steps=byRun.get(runId)??[];
    steps.push(action);
    byRun.set(runId,steps);
  }
  return rows.map(row=>{
    const sequence=byRun.get(row.id);
    const latest=sequence?.findLast(action=>action.jobId!==null);
    if(!latest?.jobId)return {...row,sequence:undefined};
    return {...row,jobId:latest.jobId,jobStatus:latest.status,jobIssue:latest.issue,scheduledFor:latest.scheduledFor,attempts:latest.attempts,sequence};
  });
}
