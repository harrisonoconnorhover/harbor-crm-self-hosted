import {canWorkTask} from './workspace-assignee-store';
import {and,asc,desc,eq,exists,gt,isNotNull,isNull,lte,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {reminderPageSize,type TaskReminders} from '../../lib/portable-task-reminders';
import {inactiveSequenceTask} from './sales-sequence-access';
import {portableTasks as tasks} from './task-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';

// An unassigned task belongs to the personal workspace owner. An assigned
// reminder follows its assignee only while they can still edit that workspace.
function recipient(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  if(!workspaceId)return and(eq(workspaces.ownerId,actorId),or(isNull(tasks.assigneeId),eq(tasks.assigneeId,actorId)));
  const grant=db.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(
    eq(workspaceViewers.workspaceId,workspaces.id),eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.role,'editor'),canWorkTask));
  return and(eq(workspaces.id,workspaceId),eq(tasks.assigneeId,actorId),exists(grant));
}
const openReminder=and(isNull(tasks.archivedAt),isNull(tasks.completedAt),isNotNull(tasks.reminderAt),sql`NOT ${inactiveSequenceTask}`);

export async function readTaskReminders(db:PostgresJsDatabase,actorId:string,workspaceId?:string):Promise<TaskReminders>{
  const now=new Date().toISOString();
  const visible=and(openReminder,recipient(db,actorId,workspaceId),sql`${tasks.reminderDismissedBy} IS DISTINCT FROM ${actorId}`);
  const join=eq(tasks.workspaceId,workspaces.id);
  const [due,next]=await Promise.all([
    db.select({id:tasks.id,revision:tasks.revision,name:sql<string>`${tasks.data}->>'name'`,
      dueAt:sql<string>`${tasks.data}->>'dueAt'`,remindAt:tasks.reminderAt}).from(tasks)
      .innerJoin(workspaces,join).where(and(visible,lte(tasks.reminderAt,now)))
      .orderBy(desc(tasks.reminderAt),desc(tasks.id)).limit(reminderPageSize+1),
    db.select({at:tasks.reminderAt}).from(tasks).innerJoin(workspaces,join)
      .where(and(visible,gt(tasks.reminderAt,now))).orderBy(asc(tasks.reminderAt),asc(tasks.id)).limit(1),
  ]);
  return {items:due.slice(0,reminderPageSize).map(row=>({...row,remindAt:new Date(row.remindAt!).toISOString()})),
    more:due.length>reminderPageSize,nextAt:next[0]?.at?new Date(next[0].at).toISOString():null,serverNow:now};
}

export async function dismissTaskReminder(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,id:string,revision:number){
  // Dismiss only this recipient's current task version. Replaying the same
  // dismissal is harmless and does not create a new task revision or event.
  const [saved]=await db.update(tasks).set({reminderDismissedBy:actorId}).from(workspaces)
    .where(and(eq(tasks.workspaceId,workspaces.id),recipient(db,actorId,workspaceId),openReminder,
      eq(tasks.id,id),eq(tasks.revision,revision),lte(tasks.reminderAt,new Date().toISOString())))
    .returning({id:sql<string>`${tasks.id}`});
  return !!saved;
}
