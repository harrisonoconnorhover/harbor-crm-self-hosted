import {and,asc,count,desc,eq,inArray,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {suppressedAddress} from '../../lib/email/suppression';
import {workspaceEmailBlocked} from './email-suppression-store';
import {scheduledGmail} from './scheduled-gmail-schema';
import {ApiError} from '../../lib/api-error';
import type {ContactFields} from '../../lib/portable-records';
import {contactEvents} from './contact-schema';
import type {PortableCodeOutput} from '../../lib/portable-workflow-code';
import type {PortableWorkflowAction,PortableWorkflowCursor} from '../../lib/portable-workflows';
import {dealPipelineStages} from './deal-pipeline-schema';
import {dealEvents} from './deal-schema';
import {availableJobSlots,jobClock} from './job-store';
import {portableJobs as jobs,portableTaskJobs} from './job-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {portableSegments as segments} from './portable-segment-schema';
import {segmentScanOverdue} from './portable-segment-scan-status';
import type {ManualNoteActionReceipt} from './manual-workflow-action-store';
import {readManualWorkflowRuns} from './manual-workflow-store';
import {workflowCapacityNeedsReview,workflowCapacitySkipped} from './workflow-capacity-status';
import {dealWorkflows as workflows,dealWorkflowActivations as active,dealWorkflowRuns as runs,segmentWorkflowScans as scans} from './workflow-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type WorkflowEntry={id:string;revision:number}&(
  {kind:'deal';pipelineId:string;stageId:string;primaryContactId:string|null;lifecycle:ContactFields['lifecycle']|null}|
  {kind:'contact_created'|'contact_owner_assigned';lifecycle:ContactFields['lifecycle']}|
  {kind:'contact_lifecycle';lifecycle:ContactFields['lifecycle'];email:ContactFields['email']}
);
const maxWorkflows=20;
const fields={id:workflows.id,definition:workflows.definition,revision:workflows.revision};
const activation=and(eq(active.workspaceId,workflows.workspaceId),eq(active.workflowId,workflows.id));
const target=(workspaceId:string,id:string)=>and(eq(workflows.workspaceId,workspaceId),eq(workflows.id,id));

export async function readPortableWorkflows(db:Db,actorId:string){
  const rows=await db.select({...fields,active:active.workflowId,baseline:scans.baseline,
    waitingForCapacity:scans.waitingForCapacity,scanOverdue:segmentScanOverdue,
    retryingScan:sql<boolean>`${scans.retryAt} IS NOT NULL AND ${scans.waitingForCapacity} IS FALSE`}).from(workflows)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workflows.workspaceId)).leftJoin(active,activation)
    .leftJoin(scans,and(eq(scans.workspaceId,workflows.workspaceId),eq(scans.workflowId,workflows.id)))
    .where(eq(privateWorkspaces.ownerId,actorId)).orderBy(asc(workflows.id)).limit(maxWorkflows);
  return rows.map(({active,baseline,waitingForCapacity,scanOverdue,retryingScan,...row})=>({...row,enabled:!!active,
    baseline:row.definition.trigger==='contact_segment'?baseline??false:undefined,
    waitingForCapacity:row.definition.trigger==='contact_segment'?waitingForCapacity??false:undefined,
    scanOverdue:row.definition.trigger==='contact_segment'?scanOverdue??false:undefined,
    retryingScan:row.definition.trigger==='contact_segment'?retryingScan:undefined}));
}

export async function readPortableWorkflowRuns(db:Db,actorId:string,{after,runWorkflowId,runDealId,runIssue}:{
  after?:PortableWorkflowCursor;runWorkflowId?:string;runDealId?:string;runIssue?:'queue_full';
}={}){
  const automatic=db.select({id:runs.id,workflowName:runs.workflowName,manual:sql<boolean>`false`,dealId:runs.dealId,dealRevision:runs.dealRevision,
    contactId:runs.contactId,contactRevision:runs.contactRevision,contactName:sql<string|null>`${contactEvents.data}->>'name'`,
    dealName:sql<string|null>`${dealEvents.data}->>'name'`,createdAt:runs.createdAt,issue:runs.issue,operatorReviewedAt:runs.operatorReviewedAt,jobStatus:jobs.status,
    jobIssue:jobs.issue,attempts:jobs.attempts,jobKind:jobs.kind,scheduledFor:jobs.scheduledFor,jobId:runs.jobId,batchId:sql<string|null>`null`,codeOutput:sql<PortableCodeOutput|null>`null`}).from(runs)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,runs.workspaceId))
    .leftJoin(dealEvents,and(eq(dealEvents.workspaceId,runs.workspaceId),eq(dealEvents.dealId,runs.dealId),eq(dealEvents.revision,runs.dealRevision)))
    .leftJoin(contactEvents,and(eq(contactEvents.workspaceId,runs.workspaceId),eq(contactEvents.contactId,runs.contactId),
      eq(contactEvents.revision,runs.contactRevision)))
    .leftJoin(jobs,and(eq(jobs.workspaceId,runs.workspaceId),eq(jobs.id,runs.jobId)))
    .where(and(eq(privateWorkspaces.ownerId,actorId),runWorkflowId?eq(runs.workflowId,runWorkflowId):undefined,
      runDealId?eq(runs.dealId,runDealId):undefined,
      runIssue==='queue_full'?workflowCapacityNeedsReview:undefined,
      after?sql`(${runs.createdAt},${runs.id}) < (${after.at},${after.id}::uuid)`:undefined))
    .orderBy(desc(runs.createdAt),desc(runs.id)).limit(26);
  const pages=await Promise.all([automatic,runIssue||runDealId?[]:readManualWorkflowRuns(db,actorId,after,runWorkflowId)]);
  const automaticRows=pages[0].map(row=>({...row,sequence:undefined as ManualNoteActionReceipt[]|undefined}));
  const manualRows=pages[1].map(row=>({...row,operatorReviewedAt:null}));
  const rows=[...automaticRows,...manualRows].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:a.id>b.id?-1:0));
  const last=rows[24];
  return {runs:rows.slice(0,25).map(run=>({...run,operatorReviewedAt:run.operatorReviewedAt??undefined,
    codeOutput:run.codeOutput??undefined,batchId:run.batchId??undefined})),next:rows.length>25?{at:last.createdAt,id:last.id}:null};
}

export async function reviewWorkflowCapacitySkip(db:Db,actorId:string,id:string){
  const workspace=db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actorId));
  const [receipt]=await db.update(runs).set({
    operatorReviewedAt:sql`coalesce(${runs.operatorReviewedAt},floor(extract(epoch from statement_timestamp())*1000)::bigint)`,
  }).where(and(inArray(runs.workspaceId,workspace),eq(runs.id,id),workflowCapacitySkipped))
    .returning({id:runs.id,operatorReviewedAt:runs.operatorReviewedAt});
  return receipt;
}

export function managePortableWorkflow(db:Db,actorId:string,input:PortableWorkflowAction,gmailAvailable=false,codeAvailable=false){
  return db.transaction(async tx=>{
    const creating=input.action==='save'&&input.revision===0;
    const workspaceId=await lockRecordWorkspace(tx,actorId,creating,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workflow not found.');
    const where=target(workspaceId,input.id);
    const [current]=await tx.select(fields).from(workflows).where(where);
    if(creating&&current){
      const [same]=await tx.select({value:sql<boolean>`${workflows.definition}=${JSON.stringify(input.definition)}::jsonb`})
        .from(workflows).where(where);
      if(same.value)return;
      throw new ApiError(409,'This workflow ID is already in use.');
    }
    if(!creating&&(!current||current.revision!==input.revision))
      throw new ApiError(current?409:404,current?'Workflow changed. Reload before saving.':'Workflow not found.');
    if(input.action==='save'){
      if(input.definition.actionKind==='code'&&!codeAvailable)throw new ApiError(403,'JavaScript actions are unavailable in this deployment.');
      if(current){
        const gmail=current.definition.actionKind==='gmail'||input.definition.actionKind==='gmail';
        const changesManualTrigger=(current.definition.trigger==='manual_contact')!==(input.definition.trigger==='manual_contact');
        const changesSegmentTrigger=(current.definition.trigger==='contact_segment')!==(input.definition.trigger==='contact_segment');
        if(gmail||changesManualTrigger||changesSegmentTrigger){
          const [enabled]=await tx.select({id:active.workflowId}).from(active)
            .where(and(eq(active.workspaceId,workspaceId),eq(active.workflowId,input.id)));
          if(enabled)throw new ApiError(409,gmail?'Turn off this workflow before editing its email action.':
            changesManualTrigger?'Turn off this workflow before changing between manual and automatic runs.':
              'Turn off this workflow before changing this trigger.');
        }
      }
      if(input.definition.trigger==='contact_segment'){
        const [segment]=await tx.select({id:segments.id}).from(segments)
          .where(and(eq(segments.workspaceId,workspaceId),eq(segments.id,input.definition.segmentId),eq(segments.mode,'active')));
        if(!segment)throw new ApiError(404,'Active Contact segment not found in this workspace.');
      }
      if((!input.definition.trigger||input.definition.trigger==='deal_stage')&&input.definition.pipelineId!=='default'){
        const {pipelineId,stageId}=input.definition;
        const [stage]=await tx.select({id:dealPipelineStages.id}).from(dealPipelineStages).where(and(
          eq(dealPipelineStages.workspaceId,workspaceId),eq(dealPipelineStages.pipelineId,pipelineId),eq(dealPipelineStages.id,stageId)));
        if(!stage)throw new ApiError(404,'Stage not found in this workspace and pipeline.');
      }
      if(creating){
        const [total]=await tx.select({count:count()}).from(workflows).where(eq(workflows.workspaceId,workspaceId));
        if(total.count>=maxWorkflows)throw new ApiError(409,'This workspace already has 20 workflows.');
        await tx.insert(workflows).values({workspaceId,id:input.id,revision:1,definition:input.definition});
      }else await tx.update(workflows).set({revision:input.revision+1,definition:input.definition}).where(where);
    }else{
      const definition=current?.definition;
      if(input.enabled&&definition?.actionKind==='code'&&!codeAvailable)
        throw new ApiError(403,'JavaScript actions are unavailable in this deployment.');
      if(input.enabled&&definition?.actionKind==='gmail'){
        if(!gmailAvailable)throw new ApiError(403,'Workflow Gmail is unavailable for this account.');
        const [competing]=await tx.select({id:workflows.id}).from(workflows).innerJoin(active,activation)
          .where(and(eq(workflows.workspaceId,workspaceId),ne(workflows.id,input.id),
            sql`${workflows.definition}->>'actionKind'='gmail'`,
            sql`${workflows.definition}->>'lifecycle'=${definition.lifecycle}`)).limit(1);
        if(competing)throw new ApiError(409,'A Gmail workflow is already on for this lifecycle stage.');
      }
      await tx.update(workflows).set({revision:input.revision+1}).where(where);
      if(input.enabled)await tx.insert(active).values({workspaceId,workflowId:input.id}).onConflictDoNothing();
      else await tx.delete(active).where(and(eq(active.workspaceId,workspaceId),eq(active.workflowId,input.id)));
      if(definition?.trigger==='contact_segment'){
        if(!input.enabled){
          await tx.update(scans).set({nextAt:null,cycleDueAt:null,retryAt:null}).where(and(eq(scans.workspaceId,workspaceId),eq(scans.workflowId,input.id)));
          return;
        }
        const [segment]=await tx.select({revision:segments.revision}).from(segments)
          .where(and(eq(segments.workspaceId,workspaceId),eq(segments.id,definition.segmentId),eq(segments.mode,'active')));
        if(!segment)throw new ApiError(404,'Active Contact segment not found in this workspace.');
        const progress={ownerId:actorId,workflowRevision:input.revision+1,segmentRevision:segment.revision,
          epoch:crypto.randomUUID(),cursor:null,baseline:true,nextAt:await jobClock(tx),cycleDueAt:null,retryAt:null,waitingForCapacity:false};
        await tx.insert(scans).values({workspaceId,workflowId:input.id,...progress})
          .onConflictDoUpdate({target:[scans.workspaceId,scans.workflowId],set:progress});
      }
    }
  });
}

// Called inside the record transaction with the workspace admission lock held.
export async function captureWorkflowEntry(tx:Tx,workspaceId:string,actorId:string,entry:WorkflowEntry,gmailSender?:string){
  const contact=entry.kind!=='deal';
  const trigger=contact?and(sql`${workflows.definition}->>'trigger'=${entry.kind}`,
    entry.kind==='contact_lifecycle'?sql`${workflows.definition}->>'lifecycle'=${entry.lifecycle}`:undefined):and(
    sql`${workflows.definition}->>'pipelineId'=${entry.pipelineId}`,sql`${workflows.definition}->>'stageId'=${entry.stageId}`);
  const matched=await tx.select(fields).from(workflows).innerJoin(active,activation).where(and(
    eq(workflows.workspaceId,workspaceId),trigger)).orderBy(asc(workflows.id)).limit(maxWorkflows);
  if(!matched.length)return;
  const at=await jobClock(tx);
  const contactId=contact?entry.id:entry.primaryContactId;
  const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.id,workspaceId));
  const sender=actorId===workspace.ownerId?gmailSender:undefined;
  const recipient=entry.kind==='contact_lifecycle'?suppressedAddress.safeParse(entry.email).data:undefined;
  let slots=contactId?await availableJobSlots(tx,workspaceId):0;
  const queued:(typeof jobs.$inferInsert)[]=[],messages:(typeof scheduledGmail.$inferInsert)[]=[];
  const tasks:(typeof portableTaskJobs.$inferInsert)[]=[];
  const receipts:(typeof runs.$inferInsert)[]=[];
  for(const {id:workflowId,revision,definition} of matched){
    if(definition.trigger==='manual_contact'||definition.trigger==='contact_segment')continue;
    const id=crypto.randomUUID(),gmail=entry.kind==='contact_lifecycle'&&definition.actionKind==='gmail';
    let issue:typeof runs.$inferInsert['issue']=!contactId?'missing_contact':slots===0?'queue_full':null;
    if(gmail&&!issue){
      if(!sender)issue='gmail_unavailable';
      else if(!recipient)issue='email_address_missing';
      else if(await workspaceEmailBlocked(tx,workspaceId,recipient))issue='email_recipient_suppressed';
    }
    if(contactId&&!issue){
      const action=definition.actionKind==='note_branch'
        ?(entry.lifecycle===definition.lifecycle?definition.match:definition.otherwise)
        :definition;
      const due=at+action.delayMinutes*60_000;
      queued.push({workspaceId,id,contactId,actorId,authorizedOwnerId:workspace.ownerId,
        kind:'task' in action?'task':gmail?'gmail':'note',
        segmentEntryRevision:entry.kind==='contact_lifecycle'?entry.revision:null,
        body:'task' in action?action.task.name:action.body,scheduledFor:due,availableAt:due,createdAt:at});
      if('task' in action)tasks.push({workspaceId,jobId:id,payload:action.task});
      if(gmail&&sender&&recipient)messages.push({workspaceId,jobId:id,sender,recipient,subject:definition.subject});
      slots--;
    }
    const source=contact?{contactId:entry.id,contactRevision:entry.revision}:{dealId:entry.id,dealRevision:entry.revision};
    receipts.push({id,workspaceId,workflowId,workflowRevision:revision,workflowName:definition.name,...source,
      jobId:issue?null:id,issue,createdAt:at});
  }
  if(queued.length)await tx.insert(jobs).values(queued);
  if(messages.length)await tx.insert(scheduledGmail).values(messages);
  if(tasks.length)await tx.insert(portableTaskJobs).values(tasks);
  await tx.insert(runs).values(receipts);
}
