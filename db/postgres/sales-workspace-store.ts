import {inactiveSequenceTask} from './sales-sequence-access';
import {sharedCoreRecordScope} from './record-ownership-scope';
import {and,eq,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {activeTask,taskOwnership,portableTasks as tasks} from './task-schema';
import {readPortableTasks,taskDateFilter} from './task-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {privateWorkspaces} from './workspace-schema';

export async function readSalesWorkspaceTasks(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,zone:string,now=new Date()){
  const [counts]=await db.select({
    mine:sql<number>`count(*)::int`,
    overdue:sql<number>`(count(*) FILTER (WHERE ${taskDateFilter('overdue',zone,now)}))::int`,
    today:sql<number>`(count(*) FILTER (WHERE ${taskDateFilter('today',zone,now)}))::int`,
    high:sql<number>`(count(*) FILTER (WHERE ${tasks.data}->>'priority'='High'))::int`,
    calls:sql<number>`(count(*) FILTER (WHERE ${tasks.data}->>'taskType'='Call'))::int`,
    linkedin:sql<number>`(count(*) FILTER (WHERE ${tasks.data}->>'taskType'='LinkedIn'))::int`,
    emails:sql<number>`(count(*) FILTER (WHERE ${tasks.data}->>'taskType'='Email'))::int`,
  }).from(tasks).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,tasks.workspaceId))
    .where(and(sharedCoreRecordScope(db,actorId,workspaceId,taskOwnership)??recordWorkspaceScope(db,actorId),activeTask,isNull(tasks.completedAt),eq(tasks.assigneeId,actorId),sql`NOT ${inactiveSequenceTask}`));
  const page=await readPortableTasks(db,actorId,{kind:'tasks',taskView:'mine',workspaceId,limit:5});
  return {counts,preview:page&&'records' in page?page.records:[]};
}
