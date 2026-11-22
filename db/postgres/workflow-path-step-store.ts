import {and,eq,sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableConditionalPaths} from '../../lib/portable-workflows';
import {workflowJobBody,workflowPathActions,workflowSchedule} from '../../lib/portable-workflow-paths';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs,portableTaskJobs} from './job-schema';
import {dealWorkflowActivations as active,dealWorkflows as workflows,workflowPathReceipts as paths,
  workflowPathSteps as steps,workflowWebhookJobs as hooks} from './workflow-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Source=Pick<typeof hooks.$inferInsert,'workflowId'|'workflowRevision'|'objectKind'|'recordId'|'recordRevision'>;
type Path=PortableConditionalPaths['otherwise'];

export function plannedPathSteps(workspaceId:string,runId:string,path:Path,source:Source):(typeof steps.$inferInsert)[]{
  if(!path.then?.length)return [];
  return workflowPathActions(path).map(({id:actionId,action},position)=>({
    workspaceId,runId,...source,position,actionId,action,
    plannedJobId:position===0?runId:crypto.randomUUID(),jobId:position===0?runId:null,
  }));
}

const current=alias(steps,'finished_path_step');

// The caller owns the predecessor's live lease. Its effect, completion and the one
// successor all commit together. Each run occupies only one active queue slot.
export async function admitNextPathStep(tx:Tx,job:typeof jobs.$inferSelect,at:number){
  const [next]=await tx.select({step:steps,pathId:paths.pathId,pathName:paths.pathName}).from(current)
    .innerJoin(steps,and(eq(steps.workspaceId,current.workspaceId),eq(steps.runId,current.runId),
      eq(steps.position,sql`${current.position}+1`)))
    .innerJoin(paths,and(eq(paths.workspaceId,current.workspaceId),eq(paths.jobId,current.runId)))
    .where(and(eq(current.workspaceId,job.workspaceId),eq(current.plannedJobId,job.id),eq(current.jobId,job.id)));
  if(!next)return;
  const {step,pathId,pathName}=next;
  if(step.jobId)throw Error('Workflow path successor already has a job.');
  const {action,plannedJobId:id,workspaceId}=step;
  // A stage transition must see this new wait if it commits after admission.
  // Earlier stage entries do not release a step that has only just become active.
  let issue:string|null=null;
  if(action.waitForLifecycle){
    const [contact]=await tx.select({id:contacts.id}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,job.contactId),activeContact)).for('share');
    if(!contact)issue='authority_changed';
  }
  if(action.kind==='webhook'&&!issue){
    const [enabled]=await tx.select({id:active.workflowId}).from(active)
      .innerJoin(workflows,and(eq(workflows.workspaceId,active.workspaceId),eq(workflows.id,active.workflowId)))
      .where(and(eq(active.workspaceId,workspaceId),eq(active.workflowId,step.workflowId),eq(workflows.revision,step.workflowRevision)))
      .for('share',{of:workflows});
    if(!enabled)issue='webhook_workflow_changed';
  }
  await tx.insert(jobs).values({workspaceId,id,contactId:job.contactId,actorId:job.actorId,authorizedOwnerId:job.authorizedOwnerId,
    segmentEntryRevision:job.segmentEntryRevision,segmentCriteria:job.segmentCriteria,createdAt:at,
    kind:action.kind==='webhook'?'external':action.kind,body:workflowJobBody(action),
    ...workflowSchedule(at,action.delayMinutes,issue?undefined:action.waitForLifecycle),
    ...(issue?{status:issue==='authority_changed'?'failed' as const:'skipped' as const,issue,finishedAt:at}:{})});
  await tx.insert(paths).values({workspaceId,jobId:id,pathId,pathName});
  if(action.kind==='task')await tx.insert(portableTaskJobs).values({workspaceId,jobId:id,payload:action.task});
  if(action.kind==='webhook')await tx.insert(hooks).values({workspaceId,jobId:id,pathId,workflowId:step.workflowId,
    workflowRevision:step.workflowRevision,destination:action.destination,objectKind:step.objectKind,
    recordId:step.recordId,recordRevision:step.recordRevision});
  await tx.update(steps).set({jobId:id}).where(and(eq(steps.workspaceId,workspaceId),eq(steps.runId,step.runId),eq(steps.position,step.position)));
}
