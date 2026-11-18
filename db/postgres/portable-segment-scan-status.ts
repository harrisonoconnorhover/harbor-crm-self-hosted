import {sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {segmentWorkflowScans as scans} from './workflow-schema';

const overdueMs=5*60_000;
const cutoff=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint-${overdueMs}`;
// Off workflows clear both fields. The next page may be due later than the full scan.
export const segmentScanOverdue=sql<boolean>`(${scans.nextAt}<=${cutoff} OR ${scans.cycleDueAt}<=${cutoff})`;

export async function portableSegmentScanStatus(db:PostgresJsDatabase){
  const [status]=await db.execute<{overdue:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${scans} WHERE ${segmentScanOverdue}) AS overdue
  `);
  return {result:status.overdue?'attention':'ok',overdue:status.overdue};
}
