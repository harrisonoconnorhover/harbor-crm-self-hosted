import {and,asc,eq,lte,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {nextTaskOccurrence} from '../../lib/task-repeat';
import {taskReminderInstant} from '../../lib/portable-task-reminders';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {pendingTaskRepeat,portableTaskEvents,portableTaskRepeatReceipts,portableTaskSnapshot,portableTasks,taskRepeatDueAt} from './task-schema';
import {activeWorkspaceAssignee,assigneeLabel} from './workspace-assignee-store';
import {privateWorkspaces} from './workspace-schema';

type TaskTransaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type RepeatSource=Pick<typeof portableTasks.$inferSelect,'id'|'data'|'assigneeId'|'contactId'|'companyId'|'dealId'|'queueId'>;

// Call under the workspace and Task locks. The receipt, successor and history
// are one database transaction, including when a user completes the Task.
export async function advanceTaskOccurrence(tx:TaskTransaction,workspaceId:string,actorId:string,source:RepeatSource,now:string){
  const [prior]=await tx.select({id:portableTaskRepeatReceipts.successorId}).from(portableTaskRepeatReceipts).where(and(
    eq(portableTaskRepeatReceipts.workspaceId,workspaceId),eq(portableTaskRepeatReceipts.predecessorId,source.id)));
  if(prior)return prior.id;
  const data={...nextTaskOccurrence(source.data,now),status:'Not started' as const};
  const assignee=source.assigneeId?await activeWorkspaceAssignee(tx,workspaceId,source.assigneeId,{tool:'tasks'}):undefined;
  const successor={workspaceId,id:crypto.randomUUID(),revision:1,data,reminderAt:taskReminderInstant(data),assigneeId:assignee?.id??null,
    assigneeLabel:assignee?assigneeLabel(assignee):null,contactId:source.contactId,companyId:source.companyId,
    dealId:source.dealId,queueId:source.queueId,completedAt:null,createdAt:now,updatedAt:now};
  await tx.insert(portableTaskRepeatReceipts).values({workspaceId,predecessorId:source.id,successorId:successor.id,actorId,createdAt:now});
  await tx.insert(portableTasks).values(successor);
  await tx.insert(portableTaskEvents).values({workspaceId,taskId:successor.id,revision:1,actorId,data:portableTaskSnapshot(successor),occurredAt:now});
  return successor.id;
}

export async function advanceOverduePortableTask(db:PostgresJsDatabase){
  const outcome=await db.transaction(async tx=>{
    const receipt=tx.select({present:sql`1`}).from(portableTaskRepeatReceipts).where(and(
      eq(portableTaskRepeatReceipts.workspaceId,portableTasks.workspaceId),
      eq(portableTaskRepeatReceipts.predecessorId,portableTasks.id)));
    const due=taskRepeatDueAt(portableTasks.data);
    const pending=and(pendingTaskRepeat(portableTasks.data,portableTasks.completedAt,portableTasks.archivedAt),sql`(${receipt}) IS NULL`,sql`
      (${portableTasks.repeatRetryRevision} IS DISTINCT FROM ${portableTasks.revision}
        OR ${portableTasks.repeatRetryAt} IS NULL OR ${portableTasks.repeatRetryAt} <= statement_timestamp())`);
    const at=sql<string>`to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const readyAt=sql<string>`CASE WHEN ${portableTasks.repeatRetryRevision} = ${portableTasks.revision}
      THEN greatest(${due}, to_char(${portableTasks.repeatRetryAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ELSE ${due} END`;
    const eligible=tx.select({id:portableTasks.id}).from(portableTasks)
      .where(and(eq(portableTasks.workspaceId,privateWorkspaces.id),pending,lte(due,at)))
      .orderBy(asc(due),asc(portableTasks.id)).limit(1);
    // Task service order is separate from the ordinary job queue. Probe
    // within each workspace and acquire its lock before any Task lock.
    const [candidate]=await tx.select({workspaceId:privateWorkspaces.id,ownerId:privateWorkspaces.ownerId,at})
      .from(privateWorkspaces).where(sql`(${eligible}) IS NOT NULL`)
      .orderBy(sql`${privateWorkspaces.lastTaskRepeatAt} ASC NULLS FIRST`,asc(privateWorkspaces.id))
      .limit(1).for('no key update',{skipLocked:true});
    if(!candidate)return;
    const {workspaceId,ownerId,at:now}=candidate;
    // Recheck eligibility and receipts after locking the workspace because
    // a concurrent write can make the initial probe stale.
    const dueInWorkspace=and(eq(portableTasks.workspaceId,workspaceId),pending,lte(due,now));
    const head=tx.$with('repeat_head').as(tx.select({id:portableTasks.id,due:due.as('due'),readyAt:readyAt.as('ready_at')})
      .from(portableTasks).where(dueInWorkspace).orderBy(asc(due),asc(portableTasks.id)).limit(1));
    // The indexed head wins unless a retry pushed its ready time back.
    // In that case sort only candidate IDs that could beat that head.
    const firstReady=tx.select({id:portableTasks.id}).from(portableTasks)
      .where(and(dueInWorkspace,lte(due,head.readyAt))).orderBy(asc(readyAt),asc(portableTasks.id)).limit(1);
    const [source]=await tx.with(head).select().from(portableTasks).where(and(dueInWorkspace,sql`
      ${portableTasks.id} = (SELECT CASE WHEN ${head.readyAt} > ${head.due} THEN (${firstReady}) ELSE ${head.id} END FROM ${head})`
    )).for('update');
    if(!source)return;
    // Keep the fairness turn and retry deadline if the occurrence savepoint rolls back.
    let result:{successor:string}|{failure:unknown};
    try{
      const successor=await tx.transaction(async occurrence=>{
        // Leave time to save the cooldown before the worker's five-second database deadline.
        await occurrence.execute(sql`SET LOCAL statement_timeout = '3s'`);
        const contact=await resolvePortableContactLink(occurrence,workspaceId,source.contactId,undefined);
        return advanceTaskOccurrence(occurrence,workspaceId,ownerId,{...source,contactId:contact?.visibleId??null},now);
      });
      result={successor};
    }catch(error){
      await tx.update(portableTasks).set({repeatRetryRevision:source.revision,repeatRetryAt:sql`clock_timestamp() + interval '15 minutes'`})
        .where(and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.id,source.id)));
      result={failure:error};
    }
    await tx.update(privateWorkspaces).set({lastTaskRepeatAt:sql`clock_timestamp()`}).where(eq(privateWorkspaces.id,workspaceId));
    return result;
  });
  if(outcome&&'failure' in outcome)throw outcome.failure;
  return outcome?.successor;
}
