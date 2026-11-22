import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {formNoteCapacityIssue} from '../../lib/portable-lead-forms';
import {leadFormNoteSources as sources,leadInquiries as inquiries} from './lead-form-schema';

const overdueMs=5*60_000;
// A retry changes retry_at, never the original time when the Note became ready.
export const formNoteOverdue=sql<boolean>`${sources.state}='waiting' AND ${sources.nextAt}<=
  floor(extract(epoch from statement_timestamp())*1000)::bigint-${overdueMs}`;

export const openInquiry=sql<boolean>`NOT ${inquiries.handled} AND ${inquiries.status} <> 'removed'`;
export const openFormNoteCapacitySkip=and(openInquiry,eq(sources.state,'skipped'),eq(sources.issue,formNoteCapacityIssue));

export async function portableFormNoteStatus(db:PostgresJsDatabase){
  const [status]=await db.execute<{overdue:boolean;capacity_skipped:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${sources} WHERE ${formNoteOverdue}) AS overdue,
      EXISTS (SELECT 1 FROM ${sources} JOIN ${inquiries}
        ON ${sources.workspaceId}=${inquiries.workspaceId} AND ${sources.inquiryId}=${inquiries.id}
        WHERE ${openFormNoteCapacitySkip}) AS capacity_skipped
  `);
  return {result:status.overdue||status.capacity_skipped?'attention':'ok',overdue:status.overdue,capacitySkipped:status.capacity_skipped};
}

export const inquiryFollowUpOverdue=and(openInquiry,sql`${inquiries.receivedAt}<=
  floor(extract(epoch from statement_timestamp())*1000)::bigint-${24*60*60_000}`);

export async function portableInquiryFollowUpStatus(db:PostgresJsDatabase){
  const [status]=await db.execute<{overdue:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${inquiries} WHERE ${inquiryFollowUpOverdue}) AS overdue
  `);
  return {result:status.overdue?'attention':'ok',overdue:status.overdue};
}
