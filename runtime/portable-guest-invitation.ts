import {sql} from 'drizzle-orm';
import {ApiError} from '../lib/api-error';
import {guestInvitationChanged,guestInvitationId,guestInvitationRoute,onlyGuestContact,
  type GuestInvitationInput} from '../lib/calendar/guest-invitation';
import {portableInvite} from '../lib/calendar/portable-meetings';
import type {HarborIdentity} from '../lib/identity';
import {portableApiIdentity} from './portable-api-identity';
import {portableCalendarConfig,portableGuestInvitesEnabled} from './portable-calendar-config';
import {portableDb} from './portable-db';
import {requestIdentity} from './portable-identity';
import {sendPortableGuestInvitation} from './portable-meeting-routes';

async function approvePortableGuestInvitation(request:Request,user:HarborIdentity,input:GuestInvitationInput){
  const current=await requestIdentity(request.headers);
  if(current?.userId!==user.userId||current.email!==user.email||portableCalendarConfig()?.owner!==user.email.toLowerCase())
    throw new ApiError(403,'Calendar invitations are unavailable for this account.');
  const db=portableDb();
  const proof=sql`FROM portable_guest_booking_requests r
    JOIN portable_published_availability p ON p.workspace_id=r.workspace_id AND p.id=r.page_id
    JOIN private_workspaces w ON w.id=r.workspace_id AND w.owner_id=${user.userId}
    WHERE p.allow_guest_proof AND r.page_id=${input.pageId} AND r.id=${input.requestId} AND r.verified_at IS NOT NULL`;
  const [saved]=await db.execute<{workspaceId:string;email:string;start:string;end:string;title:string;timeZone:string}>(sql`
    SELECT r.workspace_id AS "workspaceId",r.email,r.start,r."end",p.title,p.time_zone AS "timeZone" ${proof}`);
  if(!saved)throw guestInvitationChanged();
  const contactMatches=sql`workspace_id=${saved.workspaceId} AND archived_at IS NULL AND lower(data->>'email')=${saved.email}`;
  const contact=onlyGuestContact(Array.from(await db.execute<{id:string}>(sql`SELECT id FROM contacts WHERE ${contactMatches} LIMIT 2`)));
  const guard=sql`EXISTS(SELECT 1 ${proof} AND r.email=${saved.email} AND r.start=${saved.start} AND r."end"=${saved.end}
    AND p.title=${saved.title} AND p.time_zone=${saved.timeZone} AND r.start::timestamptz>clock_timestamp())
    AND (SELECT count(*) FROM (SELECT id FROM contacts WHERE ${contactMatches} LIMIT 2) matches)=1
    AND EXISTS(SELECT 1 FROM contacts WHERE ${contactMatches} AND id=${contact.id})
    AND NOT EXISTS(SELECT 1 FROM portable_email_suppressions WHERE workspace_id=${saved.workspaceId} AND email=${saved.email})`;
  const invitation=portableInvite.parse({id:await guestInvitationId(saved.workspaceId,input.requestId),contactId:contact.id,
    recipient:saved.email,title:saved.title,start:saved.start,end:saved.end,timeZone:saved.timeZone});
  return sendPortableGuestInvitation(request,user,invitation,guard);
}

export function POST(request:Request){
  return guestInvitationRoute(request,portableGuestInvitesEnabled(),()=>portableApiIdentity(request),
    (user,input)=>approvePortableGuestInvitation(request,user,input));
}
