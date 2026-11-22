import {sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';

type Exit='sequence_reply_logged'|'sequence_outlook_reply_logged'|'sequence_meeting_booked';
type Enrollment={teamBookingId:string|null;workspaceId:string;contactId:string;actorId:string;sender:string;recipient:string|null;createdAt:number};
type PredicateFields={ [Field in keyof Enrollment]:SQL };

// Both the worker's due-work query and its last check before sending use the same receipts.
function exitReason(e:PredicateFields){
  return sql`CASE
    WHEN EXISTS (SELECT FROM portable_gmail_log_receipts r
      WHERE r.workspace_id=${e.workspaceId} AND r.contact_id=${e.contactId}
        AND r.mailbox=${e.sender} AND r.occurred_at>${e.createdAt}) THEN 'sequence_reply_logged'
    WHEN EXISTS (SELECT FROM portable_activity_creation_receipts r
      WHERE r.workspace_id=${e.workspaceId} AND r.outlook_contact_id=${e.contactId}
        AND r.outlook_mailbox=${e.sender} AND r.outlook_received_at>${e.createdAt}) THEN 'sequence_outlook_reply_logged'
    WHEN ${e.teamBookingId}::uuid IS NOT NULL OR EXISTS (SELECT FROM portable_calendar_meetings m
      WHERE m.workspace_id=${e.workspaceId} AND m.contact_id=${e.contactId} AND m.owner_id=${e.actorId}
        AND m.status='scheduled' AND m.input->>'recipient'=${e.recipient} AND m.created_at>${e.createdAt})
      THEN 'sequence_meeting_booked'
    END`;
}

export const salesSequenceExitCandidate=exitReason({teamBookingId:sql`a.team_booking_id`,workspaceId:sql`e.workspace_id`,contactId:sql`e.contact_id`,
  actorId:sql`e.actor_id`,sender:sql`e.sender`,recipient:sql`e.recipient`,createdAt:sql`e.created_at`});

export async function salesSequenceExitSignal(tx:PostgresJsDatabase,e:Enrollment){
  const reason=exitReason({teamBookingId:sql`${e.teamBookingId}`,workspaceId:sql`${e.workspaceId}`,contactId:sql`${e.contactId}`,actorId:sql`${e.actorId}`,
    sender:sql`${e.sender}`,recipient:sql`${e.recipient}`,createdAt:sql`${e.createdAt}`});
  const [row]=await tx.execute<{reason:Exit|null}>(sql`SELECT ${reason} AS reason`);
  return row.reason;
}
