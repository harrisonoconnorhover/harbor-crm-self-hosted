import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableTaskRepeatMonitor} from './task-schema';

export const taskRepeatOverdueSeconds=5*60;

export async function portableTaskRepeatStatus(db:PostgresJsDatabase){
  const [{dueCount,truncated,oldestDueAgeSeconds}]=await db.select().from(portableTaskRepeatMonitor);
  const overdue=oldestDueAgeSeconds!==null&&oldestDueAgeSeconds>=taskRepeatOverdueSeconds;
  return {result:overdue?'attention':'ok',overdue,dueCount,truncated,oldestDueAgeSeconds};
}
