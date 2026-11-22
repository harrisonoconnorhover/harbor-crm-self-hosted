import {sql} from 'drizzle-orm';
import {guestBookingStatus,guestBookingStatusRoute,guestStatusRetention,type GuestStatusLocator} from '../lib/calendar/guest-booking-status';
import {guestInvitationId} from '../lib/calendar/guest-invitation';
import {portableLoginConfig as loginConfig} from './portable-login-config';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {portableRateLimit} from './portable-rate-limit';

async function readPortableGuestBookingStatus(location:GuestStatusLocator){
  const {workspaceId,pageId,requestId}=location,meetingId=await guestInvitationId(workspaceId,requestId);
  const limited=await portableRateLimit('public_form','booking-status:'+workspaceId);
  if(limited)return limited;
  const [row]=await portableDb().execute<{start:string;end:string;open:boolean;email:string;state:string|null;meetingStart:number|null;meetingEnd:number|null;teamStart:number;teamEnd:number;teamTitle:string;team:boolean|null}>(sql`
    SELECT r.start,r."end",b.cancelled AS team,b.start_at AS "teamStart",b.end_at AS "teamEnd",b.title AS "teamTitle",(p.id=r.page_id AND p.allow_guest_proof) AS open,i.email,
      CASE WHEN EXISTS(SELECT 1 FROM portable_calendar_reschedules c WHERE c.workspace_id=m.workspace_id AND c.meeting_id=m.id
        AND c.status IN ('submitting','attention')) THEN 'checking' ELSE m.status END AS state,
      m.start_at AS "meetingStart",m.end_at AS "meetingEnd"
    FROM portable_guest_booking_requests r
    JOIN private_workspaces w ON w.id=r.workspace_id
    JOIN login_identities i ON i.id=w.owner_id
    LEFT JOIN portable_team_bookings b ON b.workspace_id=r.workspace_id AND b.page_id=r.page_id AND b.id=r.id
    LEFT JOIN portable_published_availability p ON p.workspace_id=w.id
    LEFT JOIN portable_calendar_meetings m ON m.workspace_id=w.id AND m.owner_id=w.owner_id AND m.id=${meetingId}
    WHERE r.workspace_id=${workspaceId} AND r.page_id=${pageId} AND r.id=${requestId}
      AND r.verified_at IS NOT NULL AND r.created_at>${Date.now()-guestStatusRetention}
  `);
  if(!row||!loginConfig(env).allowedEmails.includes(row.email))return null;
  if(row.team!==null)return row.team?{state:'cancelled' as const}:{state:'reserved' as const,start:new Date(Number(row.teamStart)).toISOString(),end:new Date(Number(row.teamEnd)).toISOString(),calendar:{id:requestId,title:row.teamTitle}};
  const meeting=row.state&&row.meetingStart&&row.meetingEnd?{
    state:row.state,start:new Date(Number(row.meetingStart)).toISOString(),end:new Date(Number(row.meetingEnd)).toISOString(),
  }:null;
  return guestBookingStatus(row.start,row.end,process.env.HARBOR_PUBLIC_AVAILABILITY_ENABLED==='true'&&row.open===true,meeting);
}

export function POST(request:Request){
  return guestBookingStatusRoute(request,process.env.HARBOR_GUEST_BOOKING_PROOF_ENABLED==='true',()=>loginConfig(env),readPortableGuestBookingStatus);
}
