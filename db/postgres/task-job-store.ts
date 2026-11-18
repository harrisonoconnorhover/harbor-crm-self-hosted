import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableWorkflowTaskFields} from '../../lib/portable-workflows';
import {contacts,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableTaskJobs} from './job-schema';
import {closeAttempt,jobClock,lockClaim,segmentEntrySuperseded,type Claim} from './job-store';
import {portableTasks,portableTaskEvents,portableTaskSnapshot} from './task-schema';
import {activeWorkspaceAssignee,assigneeLabel} from './workspace-assignee-store';

export function finishTask(db:PostgresJsDatabase,claim:Claim){
  return db.transaction(async tx=>{
    // Match Task edits and admissions: workspace first, then the job and Contact.
    const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,claim.workspaceId)).for('no key update');
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='task')return false;
    const [contact]=await tx.select({revision:contacts.revision}).from(contacts)
      .where(and(eq(contacts.workspaceId,job.workspaceId),eq(contacts.id,job.contactId),activeContact)).for('share');
    const at=await jobClock(tx);
    if(!contact||workspace?.ownerId!==(job.authorizedOwnerId??job.actorId)){
      await closeAttempt(tx,job,at,'failed','authority_changed');
      return false;
    }
    if(await segmentEntrySuperseded(tx,job,contact.revision)){
      await closeAttempt(tx,job,at,'skipped','segment_left');
      return false;
    }
    const [saved]=await tx.select({payload:portableTaskJobs.payload}).from(portableTaskJobs)
      .where(and(eq(portableTaskJobs.workspaceId,job.workspaceId),eq(portableTaskJobs.jobId,job.id)));
    const fields=portableWorkflowTaskFields.parse(saved?.payload);
    const assignee=await activeWorkspaceAssignee(tx,job.workspaceId,workspace.ownerId);
    if(!assignee)throw Error('Task owner is unavailable.');
    const now=new Date(at).toISOString();
    const task={workspaceId:job.workspaceId,id:job.id,revision:1,
      data:{...fields,dueDate:fields.dueDate??'',status:'Not started' as const},
      assigneeId:assignee.id,assigneeLabel:assigneeLabel(assignee),contactId:job.contactId,
      companyId:null,dealId:null,queueId:null,completedAt:null,createdAt:now,updatedAt:now};
    // The job ID is the stable Task ID. A lost commit reply leaves both durable.
    await tx.insert(portableTasks).values(task);
    await tx.insert(portableTaskEvents).values({workspaceId:job.workspaceId,taskId:task.id,revision:1,
      actorId:job.actorId,previous:null,data:portableTaskSnapshot(task),occurredAt:now});
    await closeAttempt(tx,job,at,'succeeded',null);
    return true;
  });
}
