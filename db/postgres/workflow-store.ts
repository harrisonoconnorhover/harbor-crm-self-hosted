import {exists,and,asc,count,desc,eq,inArray,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {suppressedAddress} from '../../lib/email/suppression';
import {workspaceEmailBlocked} from './email-suppression-store';
import {scheduledGmail} from './scheduled-gmail-schema';
import {workflowJobAction,workflowJobBody,workflowSchedule,workflowWebhookEventId,workflowWebhookNames} from '../../lib/portable-workflow-paths';
import {ApiError} from '../../lib/api-error';
import {portableTicketEvents as ticketEvents,portableTickets as tickets} from './ticket-schema';
import type {PortableTicketFields} from '../../lib/portable-tickets';
import type {ContactFields} from '../../lib/portable-records';
import {objectRecords,objectTypes} from './custom-object-schema';
import {sharedCoreRecordScope} from './record-ownership-scope';
import {recordCatalogScope} from './workspace-viewer-store';
import {companies,companyEvents} from './company-schema';
import {activeTask,portableTasks,taskOwnership} from './task-schema';
import {contacts,contactEvents} from './contact-schema';
import type {PortableCodeOutput} from '../../lib/portable-workflow-code';
import {maxPortableWorkflows,type PortableWorkflowAction,type PortableWorkflowCursor} from '../../lib/portable-workflows';
import {dealPipelineStages} from './deal-pipeline-schema';
import {dealEvents} from './deal-schema';
import {plannedPathSteps} from './workflow-path-step-store';
import {availableJobSlots,jobClock} from './job-store';
import {portableJobs as jobs,portableTaskJobs} from './job-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {portableSegments as segments} from './portable-segment-schema';
import {segmentScanOverdue} from './portable-segment-scan-status';
import type {ManualNoteActionReceipt} from './manual-workflow-action-store';
import {readManualWorkflowRuns} from './manual-workflow-store';
import {workflowCapacityNeedsReview,workflowCapacitySkipped} from './workflow-capacity-status';
import {dealWorkflows as workflows,dealWorkflowActivations as active,dealWorkflowRuns as runs,segmentWorkflowScans as scans,workflowPathSteps,workflowPathReceipts as paths,workflowWebhookJobs as hooks} from './workflow-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type WorkflowEntry={id:string;revision:number}&(
  {kind:'ticket_status';ticketStatus:PortableTicketFields['ticketStatus'];properties:Pick<PortableTicketFields,'name'|'ticketPriority'|'ticketSource'|'ticketCategory'|'tags'>;primaryContactId:string|null;lifecycle:null}|
  {kind:'deal';properties:{name:string;amount:number;closeDate:string};pipelineId:string;stageId:string;primaryContactId:string|null;lifecycle:ContactFields['lifecycle']|null}|
  {kind:'contact_created'|'contact_owner_assigned';lifecycle:ContactFields['lifecycle']}|
  {kind:'contact_lifecycle';lifecycle:ContactFields['lifecycle'];email:ContactFields['email']}
);
const fields={id:workflows.id,definition:workflows.definition,revision:workflows.revision};
const activation=and(eq(active.workspaceId,workflows.workspaceId),eq(active.workflowId,workflows.id));
const target=(workspaceId:string,id:string)=>and(eq(workflows.workspaceId,workspaceId),eq(workflows.id,id));

export async function readPortableWorkflows(db:Db,actorId:string){
  const rows=await db.select({...fields,customObjectName:sql<string|null>`${objectTypes.definition}->>'name'`,active:active.workflowId,baseline:scans.baseline,
    waitingForCapacity:scans.waitingForCapacity,scanOverdue:segmentScanOverdue,
    retryingScan:sql<boolean>`${scans.retryAt} IS NOT NULL AND ${scans.waitingForCapacity} IS FALSE`}).from(workflows)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workflows.workspaceId)).leftJoin(active,activation)
    .leftJoin(scans,and(eq(scans.workspaceId,workflows.workspaceId),eq(scans.workflowId,workflows.id)))
    .leftJoin(objectTypes,and(eq(objectTypes.workspaceId,workflows.workspaceId),
      eq(objectTypes.id,sql`CASE WHEN ${workflows.definition}->>'trigger' IN ('custom_record_created','custom_record_owner_assigned')
        THEN (${workflows.definition}->>'objectId')::uuid END`)))
    .where(eq(privateWorkspaces.ownerId,actorId)).orderBy(asc(workflows.id)).limit(maxPortableWorkflows);
  return rows.map(({active,baseline,waitingForCapacity,scanOverdue,retryingScan,customObjectName,...row})=>({...row,customObjectName:customObjectName??undefined,enabled:!!active,
    baseline:row.definition.trigger==='contact_segment'?baseline??false:undefined,
    waitingForCapacity:row.definition.trigger==='contact_segment'?waitingForCapacity??false:undefined,
    scanOverdue:row.definition.trigger==='contact_segment'?scanOverdue??false:undefined,
    retryingScan:row.definition.trigger==='contact_segment'?retryingScan:undefined}));
}

async function readPathSteps(db:Db,ownerId:string,runIds:string[]){
  const query=db.select({runId:workflowPathSteps.runId,id:workflowPathSteps.actionId,position:workflowPathSteps.position,action:workflowPathSteps.action,jobId:workflowPathSteps.jobId,
    status:jobs.status,issue:jobs.issue,attempts:jobs.attempts,jobKind:jobs.kind,scheduledFor:jobs.scheduledFor,
    waitForLifecycle:jobs.waitForLifecycle,finishedAt:jobs.finishedAt}).from(workflowPathSteps)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workflowPathSteps.workspaceId))
    .leftJoin(jobs,and(eq(jobs.workspaceId,workflowPathSteps.workspaceId),eq(jobs.id,workflowPathSteps.jobId)))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),inArray(workflowPathSteps.runId,runIds))).orderBy(asc(workflowPathSteps.position));
  const rows=runIds.length?await query:[];
  const byRun=new Map<string,Array<Omit<typeof rows[number],'runId'|'action'>&{
    kind:typeof rows[number]['action']['kind'];name:string;destination?:string;
  }>>();
  for(const {runId,action,...row} of rows){
    const list=byRun.get(runId)??[];
    list.push({...row,kind:action.kind,name:action.kind==='note'?'Create a Note':action.kind==='task'?action.task.name:action.destination,
      destination:action.kind==='webhook'?action.destination:undefined});
    byRun.set(runId,list);
  }
  return byRun;
}

export async function readPortableWorkflowRuns(db:Db,actorId:string,{after,runWorkflowId,runDealId,runTicketId,runCompanyId,runObjectId,runCustomRecordId,runIssue}:{
  after?:PortableWorkflowCursor;runWorkflowId?:string;runDealId?:string;runTicketId?:string;runCompanyId?:string;runObjectId?:string;runCustomRecordId?:string;runIssue?:'queue_full';
}={}){
  const automatic=db.select({workspaceId:runs.workspaceId,id:runs.id,workflowName:runs.workflowName,manual:sql<boolean>`false`,dealId:runs.dealId,dealRevision:runs.dealRevision,
    contactId:runs.contactId,contactRevision:runs.contactRevision,contactName:sql<string|null>`${contactEvents.data}->>'name'`,
    customObjectId:runs.customObjectId,customObjectName:runs.customObjectName,customRecordId:runs.customRecordId,
    customRecordRevision:runs.customRecordRevision,customRecordName:runs.customRecordName,customTaskId:runs.customTaskId,customRecordArchived:sql<boolean>`${objectRecords.archivedAt} IS NOT NULL`,
    companyId:runs.companyId,companyRevision:runs.companyRevision,companyTaskId:runs.companyTaskId,
    companyName:sql<string|null>`${companyEvents.data}->>'name'`,
    companyArchived:sql<boolean>`${companies.archivedAt} IS NOT NULL`,directTaskArchived:sql<boolean>`${portableTasks.archivedAt} IS NOT NULL`,
    ticketArchived:sql<boolean>`${tickets.archivedAt} IS NOT NULL`,ticketId:runs.ticketId,ticketRevision:runs.ticketRevision,ticketContactId:jobs.contactId,ticketName:sql<string|null>`${ticketEvents.data}->'data'->>'name'`,
    dealName:sql<string|null>`${dealEvents.data}->>'name'`,createdAt:runs.createdAt,issue:runs.issue,operatorReviewedAt:runs.operatorReviewedAt,jobStatus:jobs.status,
    jobIssue:jobs.issue,attempts:jobs.attempts,jobKind:jobs.kind,scheduledFor:jobs.scheduledFor,waitForLifecycle:jobs.waitForLifecycle,jobId:runs.jobId,pathId:paths.pathId,pathName:paths.pathName,webhookDestination:hooks.destination,batchId:sql<string|null>`null`,codeOutput:sql<PortableCodeOutput|null>`null`}).from(runs)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,runs.workspaceId))
    .leftJoin(dealEvents,and(eq(dealEvents.workspaceId,runs.workspaceId),eq(dealEvents.dealId,runs.dealId),eq(dealEvents.revision,runs.dealRevision)))
    .leftJoin(companyEvents,and(eq(companyEvents.workspaceId,runs.workspaceId),eq(companyEvents.companyId,runs.companyId),eq(companyEvents.revision,runs.companyRevision)))
    .leftJoin(objectRecords,and(eq(objectRecords.workspaceId,runs.workspaceId),eq(objectRecords.objectId,runs.customObjectId),eq(objectRecords.id,runs.customRecordId)))
    .leftJoin(companies,and(eq(companies.workspaceId,runs.workspaceId),eq(companies.id,runs.companyId)))
    .leftJoin(portableTasks,and(eq(portableTasks.workspaceId,runs.workspaceId),eq(portableTasks.id,sql`coalesce(${runs.companyTaskId},${runs.customTaskId})`)))
    .leftJoin(tickets,and(eq(tickets.workspaceId,runs.workspaceId),eq(tickets.id,runs.ticketId)))
    .leftJoin(ticketEvents,and(eq(ticketEvents.workspaceId,runs.workspaceId),eq(ticketEvents.ticketId,runs.ticketId),eq(ticketEvents.revision,runs.ticketRevision)))
    .leftJoin(contactEvents,and(eq(contactEvents.workspaceId,runs.workspaceId),eq(contactEvents.contactId,runs.contactId),
      eq(contactEvents.revision,runs.contactRevision)))
    .leftJoin(jobs,and(eq(jobs.workspaceId,runs.workspaceId),eq(jobs.id,runs.jobId)))
    .leftJoin(paths,and(eq(paths.workspaceId,jobs.workspaceId),eq(paths.jobId,jobs.id)))
    .leftJoin(hooks,and(eq(hooks.workspaceId,jobs.workspaceId),eq(hooks.jobId,jobs.id)))
    .where(and(eq(privateWorkspaces.ownerId,actorId),runWorkflowId?eq(runs.workflowId,runWorkflowId):undefined,
      runDealId?eq(runs.dealId,runDealId):undefined,runTicketId?eq(runs.ticketId,runTicketId):undefined,
      runObjectId?eq(runs.customObjectId,runObjectId):undefined,runCustomRecordId?eq(runs.customRecordId,runCustomRecordId):undefined,
      runCompanyId?eq(runs.companyId,runCompanyId):undefined,
      runIssue==='queue_full'?workflowCapacityNeedsReview:undefined,
      after?sql`(${runs.createdAt},${runs.id}) < (${after.at},${after.id}::uuid)`:undefined))
    .orderBy(desc(runs.createdAt),desc(runs.id)).limit(26);
  const pages=await Promise.all([automatic,runIssue||runDealId||runTicketId||runCompanyId||runCustomRecordId?[]:readManualWorkflowRuns(db,actorId,after,runWorkflowId)]);
  const automaticRows=pages[0].map(row=>({...row,sequence:undefined as ManualNoteActionReceipt[]|undefined}));
  const manualRows=pages[1].map(row=>({...row,operatorReviewedAt:null,customObjectId:null,customRecordId:null,customObjectName:null,customRecordRevision:null,customRecordName:null,customTaskId:null,customRecordArchived:false,companyId:null,companyRevision:null,companyTaskId:null,companyName:null,companyArchived:false,directTaskArchived:false,ticketArchived:false,ticketId:null,ticketRevision:null,ticketContactId:null,ticketName:null}));
  const rows=[...automaticRows,...manualRows].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:a.id>b.id?-1:0));
  const last=rows[24];
  const page=rows.slice(0,25);
  const actions=await readPathSteps(db,actorId,page.filter(row=>row.pathId).map(row=>row.id));
  return {runs:page.map(({workspaceId,directTaskArchived,...original})=>{
    const pathSteps=actions.get(original.id);
    const latest=pathSteps?.findLast(step=>step.jobId);
    const run=latest?{...original,jobId:latest.jobId,jobKind:latest.jobKind,jobStatus:latest.status,jobIssue:latest.issue,
      attempts:latest.attempts,scheduledFor:latest.scheduledFor,waitForLifecycle:latest.waitForLifecycle,webhookDestination:latest.destination}:original;
    return {...run,pathSteps,
    customObjectId:run.customObjectId??undefined,customRecordId:run.customRecordId??undefined,customObjectName:run.customObjectName??undefined,
    customRecordRevision:run.customRecordId?(run.customRecordRevision??1):undefined,customRecordName:run.customRecordName??undefined,customTaskId:run.customTaskId??undefined,customRecordArchived:run.customRecordArchived||undefined,
    customTaskArchived:Boolean(run.customTaskId&&directTaskArchived)||undefined,
    companyId:run.companyId??undefined,companyRevision:run.companyRevision??undefined,companyTaskId:run.companyTaskId??undefined,
    companyName:run.companyName??undefined,companyArchived:run.companyArchived||undefined,companyTaskArchived:Boolean(run.companyTaskId&&directTaskArchived)||undefined,
    ticketArchived:run.ticketArchived||undefined,ticketContactId:run.ticketId?run.ticketContactId??undefined:undefined,ticketId:run.ticketId??undefined,ticketRevision:run.ticketRevision??undefined,ticketName:run.ticketName??undefined,
    webhookEventId:run.webhookDestination&&run.jobId?workflowWebhookEventId(workspaceId,run.jobId):undefined,webhookDestination:run.webhookDestination??undefined,pathId:run.pathId??undefined,pathName:run.pathName??undefined,operatorReviewedAt:run.operatorReviewedAt??undefined,
    codeOutput:run.codeOutput??undefined,batchId:run.batchId??undefined};}),next:rows.length>25?{at:last.createdAt,id:last.id}:null};
}

// Check both endpoints of the link within the same workspace.
export async function readCustomTaskSource(db:Db,actorId:string,taskId:string,workspaceId?:string){
  const [source]=await db.select({objectId:objectRecords.objectId,recordId:objectRecords.id,archivedAt:objectRecords.archivedAt})
    .from(runs).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,runs.workspaceId))
    .innerJoin(objectRecords,and(eq(objectRecords.workspaceId,runs.workspaceId),eq(objectRecords.objectId,runs.customObjectId),eq(objectRecords.id,runs.customRecordId)))
    .innerJoin(portableTasks,and(eq(portableTasks.workspaceId,runs.workspaceId),eq(portableTasks.id,runs.customTaskId),activeTask))
    .where(and(recordCatalogScope(db,actorId,workspaceId),eq(runs.id,taskId),
      sharedCoreRecordScope(db,actorId,workspaceId,objectRecords),sharedCoreRecordScope(db,actorId,workspaceId,taskOwnership))).limit(1);
  return source;
}

export async function reviewWorkflowCapacitySkip(db:Db,actorId:string,id:string){
  const workspace=db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actorId));
  const [receipt]=await db.update(runs).set({
    operatorReviewedAt:sql`coalesce(${runs.operatorReviewedAt},floor(extract(epoch from statement_timestamp())*1000)::bigint)`,
  }).where(and(inArray(runs.workspaceId,workspace),eq(runs.id,id),workflowCapacitySkipped))
    .returning({id:runs.id,operatorReviewedAt:runs.operatorReviewedAt});
  return receipt;
}

export function managePortableWorkflow(db:Db,actorId:string,input:PortableWorkflowAction,gmailAvailable=false,codeAvailable=false,destinationsFor:(workspaceId:string)=>string[]=()=>[]){
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
    const hookNames=workflowWebhookNames(input.action==='save'?input.definition:input.enabled?current?.definition:undefined);
    if(hookNames.length){
      const allowed=destinationsFor(workspaceId);
      if(hookNames.some(name=>!allowed.includes(name)))throw new ApiError(400,'Choose a webhook destination configured for this workspace.');
    }
    if(input.action==='save'){
      if(input.definition.actionKind==='code'&&!codeAvailable)throw new ApiError(403,'JavaScript actions are unavailable in this deployment.');
      if(current){
        const gmail=current.definition.actionKind==='gmail'||input.definition.actionKind==='gmail';
        const changesManualTrigger=(current.definition.trigger==='manual_contact')!==(input.definition.trigger==='manual_contact');
        const changesSegmentTrigger=(current.definition.trigger==='contact_segment')!==(input.definition.trigger==='contact_segment');
        const webhook=hookNames.length>0||workflowWebhookNames(current.definition).length>0;
        if(gmail||webhook||changesManualTrigger||changesSegmentTrigger){
          const [enabled]=await tx.select({id:active.workflowId}).from(active)
            .where(and(eq(active.workspaceId,workspaceId),eq(active.workflowId,input.id)));
          if(enabled)throw new ApiError(409,webhook?'Turn off this workflow before editing its webhook action.':gmail?'Turn off this workflow before editing its email action.':
            changesManualTrigger?'Turn off this workflow before changing between manual and automatic runs.':
              'Turn off this workflow before changing this trigger.');
        }
      }
      if('objectId' in input.definition){
        const [type]=await tx.select({id:objectTypes.id}).from(objectTypes)
          .where(and(eq(objectTypes.workspaceId,workspaceId),eq(objectTypes.id,input.definition.objectId)));
        if(!type)throw new ApiError(404,'Custom object unavailable in this workspace.');
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
        if(total.count>=maxPortableWorkflows)throw new ApiError(409,'This workspace already has 20 workflows.');
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
      else {
        await tx.delete(active).where(and(eq(active.workspaceId,workspaceId),eq(active.workflowId,input.id)));
        if(workflowWebhookNames(definition).length){
          const receipt=tx.select({id:hooks.jobId}).from(hooks).where(and(eq(hooks.workspaceId,workspaceId),
            eq(hooks.workflowId,input.id),eq(hooks.jobId,jobs.id)));
          await tx.update(jobs).set({status:'skipped',issue:'workflow_disabled',waitForLifecycle:null,finishedAt:await jobClock(tx)})
            .where(and(eq(jobs.workspaceId,workspaceId),eq(jobs.status,'queued'),eq(jobs.kind,'external'),exists(receipt)));
        }
      }
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
  const trigger=entry.kind==='deal'?and(
    sql`${workflows.definition}->>'pipelineId'=${entry.pipelineId}`,sql`${workflows.definition}->>'stageId'=${entry.stageId}`):and(
    sql`${workflows.definition}->>'trigger'=${entry.kind}`,
    entry.kind==='ticket_status'?sql`${workflows.definition}->>'ticketStatus'=${entry.ticketStatus}`:undefined,
    entry.kind==='contact_lifecycle'?sql`${workflows.definition}->>'lifecycle'=${entry.lifecycle}`:undefined);
  const matched=await tx.select(fields).from(workflows).innerJoin(active,activation).where(and(
    eq(workflows.workspaceId,workspaceId),trigger)).orderBy(asc(workflows.id)).limit(maxPortableWorkflows);
  if(!matched.length)return;
  const at=await jobClock(tx);
  const contactId='primaryContactId' in entry?entry.primaryContactId:entry.id;
  const source=entry.kind==='deal'?{dealId:entry.id,dealRevision:entry.revision}:
    entry.kind==='ticket_status'?{ticketId:entry.id,ticketRevision:entry.revision}:{contactId:entry.id,contactRevision:entry.revision};
  const objectKind=entry.kind==='deal'?'deals':entry.kind==='ticket_status'?'tickets':'contacts';
  const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.id,workspaceId));
  const sender=actorId===workspace.ownerId?gmailSender:undefined;
  const recipient=entry.kind==='contact_lifecycle'?suppressedAddress.safeParse(entry.email).data:undefined;
  let slots=contactId?await availableJobSlots(tx,workspaceId):0;
  const queued:(typeof jobs.$inferInsert)[]=[],messages:(typeof scheduledGmail.$inferInsert)[]=[];
  const tasks:(typeof portableTaskJobs.$inferInsert)[]=[];
  const [branchContact]=contactId&&slots&&matched.some(row=>row.definition.actionKind==='conditional_paths')?
    await tx.select({data:contacts.data}).from(contacts).where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contactId))).for('share'):[];
  const sourceFields=entry.kind==='deal'?{dealName:entry.properties.name,dealAmount:String(entry.properties.amount),dealCloseDate:entry.properties.closeDate}:
    entry.kind==='ticket_status'?{ticketName:entry.properties.name,ticketPriority:entry.properties.ticketPriority,
      ticketSource:entry.properties.ticketSource,ticketCategory:entry.properties.ticketCategory,ticketTags:entry.properties.tags}:{};
  const conditionValues=branchContact?{...branchContact.data,...sourceFields}:undefined;
  const steps:(typeof workflowPathSteps.$inferInsert)[]=[];
  const choices:(typeof paths.$inferInsert)[]=[];
  const webhooks:(typeof hooks.$inferInsert)[]=[];
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
      const {action,path}=workflowJobAction(definition,entry.lifecycle,conditionValues);
      if(path){
        choices.push({workspaceId,jobId:id,pathId:path.id,pathName:path.name});
        steps.push(...plannedPathSteps(workspaceId,id,path,{workflowId,workflowRevision:revision,objectKind,
          recordId:entry.id,recordRevision:entry.revision}));
      }
      if(path?.action.kind==='webhook')webhooks.push({workspaceId,jobId:id,workflowId,workflowRevision:revision,pathId:path.id,
        destination:path.action.destination,objectKind,recordId:entry.id,recordRevision:entry.revision});
      queued.push({workspaceId,id,contactId,actorId,authorizedOwnerId:workspace.ownerId,
        kind:'destination' in action?'external':'task' in action?'task':gmail?'gmail':'note',
        segmentEntryRevision:entry.kind==='contact_lifecycle'?entry.revision:null,
        body:workflowJobBody(action),...workflowSchedule(at,action.delayMinutes,path?.action.waitForLifecycle),createdAt:at});
      if('task' in action)tasks.push({workspaceId,jobId:id,payload:action.task});
      if(gmail&&sender&&recipient)messages.push({workspaceId,jobId:id,sender,recipient,subject:definition.subject});
      slots--;
    }
    receipts.push({id,workspaceId,workflowId,workflowRevision:revision,workflowName:definition.name,...source,
      jobId:issue?null:id,issue,createdAt:at});
  }
  if(queued.length)await tx.insert(jobs).values(queued);
  if(choices.length)await tx.insert(paths).values(choices);
  if(steps.length)await tx.insert(workflowPathSteps).values(steps);
  if(webhooks.length)await tx.insert(hooks).values(webhooks);
  if(messages.length)await tx.insert(scheduledGmail).values(messages);
  if(tasks.length)await tx.insert(portableTaskJobs).values(tasks);
  await tx.insert(runs).values(receipts);
}
