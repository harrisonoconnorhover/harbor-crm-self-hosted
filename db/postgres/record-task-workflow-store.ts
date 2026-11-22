import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordOwner} from '../../lib/portable-records';
import {loginIdentities} from './identity-schema';
import {portableTaskEvents,portableTasks,portableTaskSnapshot} from './task-schema';
import {dealWorkflowActivations as active,dealWorkflowRuns as runs,dealWorkflows as workflows} from './workflow-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {assigneeLabel,canWorkTask} from './workspace-assignee-store';
import {privateWorkspaces} from './workspace-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

type TaskSourceRecord={id:string;recordOwner?:PortableRecordOwner};
type TaskSource=
  | {trigger:'company_created';records:TaskSourceRecord[]}
  | {trigger:'custom_record_created'|'custom_record_owner_assigned';recordRevision:number;objectId:string;objectName:string;record:TaskSourceRecord;recordName:string};

// The caller has saved the source and holds the same workspace lock used by activation.
export async function captureRecordWorkflowTasks(tx:Transaction,workspaceId:string,actorId:string,source:TaskSource,occurredAt:string){
  const matches=await tx.select({id:workflows.id,revision:workflows.revision,definition:workflows.definition,
    ownerId:loginIdentities.id,name:loginIdentities.fullName,email:loginIdentities.email}).from(workflows)
    .innerJoin(active,and(eq(active.workspaceId,workflows.workspaceId),eq(active.workflowId,workflows.id)))
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workflows.workspaceId))
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(workflows.workspaceId,workspaceId),sql`${workflows.definition}->>'trigger'=${source.trigger}`,
      'objectId' in source?sql`${workflows.definition}->>'objectId'=${source.objectId}`:undefined))
    .orderBy(asc(workflows.id));

  // Each Task gets a stable receipt. A Company CSV supplies at most 500 records per workflow.
  const sources=source.trigger==='company_created'?source.records:[source.record];
  const ownerIds=matches.some(row=>'taskAssignee' in row.definition&&row.definition.taskAssignee==='record_owner')
    ?[...new Set(sources.flatMap(record=>record.recordOwner?[record.recordOwner.userId]:[]))]:[];
  const eligible=ownerIds.length?await tx.select({id:workspaceViewers.viewerId}).from(workspaceViewers).where(and(
    eq(workspaceViewers.workspaceId,workspaceId),inArray(workspaceViewers.viewerId,ownerIds),eq(workspaceViewers.role,'editor'),canWorkTask
  )).for('share'):[];
  const eligibleIds=new Set(eligible.map(row=>row.id));
  for(const {id,revision,definition,ownerId,name,email} of matches){
    if(definition.trigger!==source.trigger||definition.actionKind!=='task'||definition.delayMinutes!==0){
      throw Error('Invalid record task workflow.');
    }
    const data={...definition.task,dueDate:definition.task.dueDate??'',status:'Not started' as const};
    const label=assigneeLabel({name,email});
    const tasks=sources.map(record=>{
      const assignee=definition.taskAssignee==='record_owner'&&record.recordOwner&&eligibleIds.has(record.recordOwner.userId)?record.recordOwner:undefined;
      return {workspaceId,id:crypto.randomUUID(),revision:1,data,assigneeId:assignee?.userId??ownerId,assigneeLabel:assignee?.label??label,
        contactId:null,companyId:source.trigger==='company_created'?record.id:null,dealId:null,queueId:null,
        completedAt:null,createdAt:occurredAt,updatedAt:occurredAt};
    });
    await tx.insert(portableTasks).values(tasks);
    await tx.insert(portableTaskEvents).values(tasks.map(task=>({workspaceId,taskId:task.id,revision:1,
      actorId,previous:null,data:portableTaskSnapshot(task),occurredAt})));
    await tx.insert(runs).values(tasks.map(task=>({workspaceId,id:task.id,workflowId:id,workflowRevision:revision,
      workflowName:definition.name,createdAt:Date.parse(occurredAt),...(source.trigger==='company_created'
        ?{companyId:task.companyId,companyRevision:1,companyTaskId:task.id}
        :{customObjectId:source.objectId,customRecordId:source.record.id,customRecordName:source.recordName,customRecordRevision:source.recordRevision===1?null:source.recordRevision,
          customObjectName:source.objectName,customTaskId:task.id})})));
  }
}
