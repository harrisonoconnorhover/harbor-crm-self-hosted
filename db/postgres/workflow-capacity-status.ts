import {and,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {dealWorkflowRuns as runs} from './workflow-schema';

export const workflowCapacitySkipped=sql`${runs.issue}='queue_full'`;
export const workflowCapacityNeedsReview=and(workflowCapacitySkipped,isNull(runs.operatorReviewedAt));

export async function portableWorkflowCapacityStatus(db:PostgresJsDatabase){
  const [row]=await db.execute<{skipped:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${runs} WHERE ${workflowCapacityNeedsReview}) AS skipped
  `);
  return {result:row.skipped?'attention':'ok',capacitySkipped:row.skipped};
}
