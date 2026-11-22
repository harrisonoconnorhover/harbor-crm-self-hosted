import {sharedToolAllowed} from './shared-tool-permission';
import {and,asc,eq,inArray,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {scheduledInstants,validTimeZone} from '../../lib/email/schedule';
import type {CalendarHostIssue,CollectiveRosterPreview,BookingHostOptions,HostSearch,BookingReviewFilter,TeamBookingCursor,TeamCalendar,TeamChange,TeamSchedule,TeamWindow} from '../../lib/calendar/team-booking';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {workspaceViewers} from './workspace-viewer-schema';
import {privateWorkspaces} from './workspace-schema';
import {loginIdentities} from './identity-schema';
import {teamOffers,teamPages,teamBookings,teamAttendees} from './portable-meeting-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader=Pick<Db,'execute'|'select'>;
export type ReadTeamBusy=(owner:string,emails:string[],start:string,end:string)=>Promise<Map<string,TeamWindow[]>>;
type Candidate={at:string;users:string[];calendars:string[]};
type CalendarCheck={expires:number;busy:Map<string,TeamWindow[]>};
type Page=TeamCalendar&{workspaceId:string;moving?:{id:string;users:string[];start:number;useRoster?:boolean}};
const inaccessible=()=>new ApiError(403,'Open a workspace where you have current scheduling access.');
const busy=()=>new ApiError(409,'This time is no longer available. Choose another time.');
const activeOffer=sql`(w.owner_id=o.user_id AND o.grant_id IS NULL OR EXISTS (
  SELECT 1 FROM portable_workspace_viewers v WHERE v.workspace_id=o.workspace_id AND v.viewer_id=o.user_id
    AND v.id=o.grant_id AND v.role='editor' AND coalesce(v.tool_policies->'meetings'->>'view','all')<>'none'))`;
const uuidArray=(ids:string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[]`;

export function bookedTeamTime(user:SQL,start:number|SQL,end:number|SQL,workspaceId?:string,skip?:{workspaceId:string;id:string}){
  return sql`EXISTS (SELECT 1 FROM portable_team_booking_hosts h JOIN portable_team_bookings b
    ON b.workspace_id=h.workspace_id AND b.id=h.booking_id WHERE h.user_id=${user} AND NOT b.cancelled
    ${workspaceId===undefined?sql``:sql`AND h.workspace_id=${workspaceId}`}
    ${skip?sql`AND (b.workspace_id,b.id)<>(${skip.workspaceId}::uuid,${skip.id}::uuid)`:sql``}
    AND b.start_at<${end} AND b.end_at>${start})`;
}

export async function lockBookingHosts(tx:Reader,userIds:string[]){
  for(const id of [...new Set(userIds)].sort()){
    await tx.execute(sql`SELECT pg_advisory_xact_lock(198715,hashtext(${id}))`);
  }
}

export async function findTeamCalendar(db:Reader,id:string){
  const [page]=await db.select().from(teamPages).where(and(eq(teamPages.id,id),eq(teamPages.closed,false)));
  return page;
}

// Ordinary moves keep the originally booked hosts. A roster move selects from the current calendar.
export async function reschedulingPage(db:Reader,workspaceId:string,id:string,useRoster=false){
  const [saved]=await db.select({page:teamPages,start:teamBookings.start}).from(teamBookings)
    .innerJoin(teamPages,and(eq(teamPages.workspaceId,teamBookings.workspaceId),eq(teamPages.id,teamBookings.pageId)))
    .where(and(eq(teamBookings.workspaceId,workspaceId),eq(teamBookings.id,id),eq(teamBookings.cancelled,false),
      eq(teamPages.closed,false),sql`${teamBookings.start}>extract(epoch FROM clock_timestamp())*1000`));
  if(!saved)throw new ApiError(409,'This booking is no longer available to reschedule. Refresh the schedule.');
  const assigned=await db.select({id:teamAttendees.userId}).from(teamAttendees)
    .where(and(eq(teamAttendees.workspaceId,workspaceId),eq(teamAttendees.bookingId,id)));
  if(!assigned.length)throw busy();
  return {...saved.page,moving:{id,users:assigned.map(host=>host.id),start:saved.start,useRoster}};
}

function requiredHosts(page:Page){
  if(page.moving&&!page.moving.useRoster)return page.moving.users.length;
  return page.mode==='collective'?page.hosts.length:1;
}

const hasOfferedHours=sql`(o.weekly_days IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.windows) win WHERE (win->>'end')::timestamptz>now()))`;
const hostPageSize=20;
async function hosts(db:Reader,workspaceId:string,search?:HostSearch,ids?:string[]){
  const label=sql`concat_ws(' · ',nullif(i.full_name,''),i.email)`;
  return Array.from(await db.execute<{id:string;userId:string;label:string;email:string}>(sql`
    SELECT o.id,o.user_id AS "userId",${label} AS label,i.email
    FROM portable_team_availability o JOIN private_workspaces w ON w.id=o.workspace_id
    JOIN login_identities i ON i.id=o.user_id WHERE o.workspace_id=${workspaceId} AND ${activeOffer}
    ${ids?sql`AND o.id=ANY(${uuidArray(ids)})`:sql``}
    ${search?.query?sql`AND strpos(lower(${label}),lower(${search.query}))>0`:sql``}
    ${search?.after?sql`AND (i.email,o.id)>(${search.after.email},${search.after.id}::uuid)`:sql``}
    AND ${hasOfferedHours}
    ORDER BY i.email,o.id LIMIT ${ids?.length??hostPageSize+1}`));
}

// Expand the weekly rule on offer "o". Skip a date if the clocks skip either boundary.
export function weeklyOfferWindows(asOf:SQL,through:SQL=sql`${asOf}+interval '336 hours'`){
  return sql`
  SELECT bounds.starts,least(bounds.ends,${through}) AS ends,o.weekly_live AS live
  FROM (SELECT (${asOf} AT TIME ZONE o.weekly_zone)::date AS today,
    ((${through}) AT TIME ZONE o.weekly_zone)::date AS last_day) horizon
  CROSS JOIN LATERAL generate_series(-1,horizon.last_day-horizon.today) n
  CROSS JOIN LATERAL (SELECT horizon.today+n AS day) d
  CROSS JOIN LATERAL (SELECT d.day+o.weekly_start AS local_start,
    (d.day+CASE WHEN o.weekly_end<o.weekly_start THEN 1 ELSE 0 END)+o.weekly_end AS local_end) shift
  CROSS JOIN LATERAL (SELECT shift.local_start AT TIME ZONE o.weekly_zone AS starts,
    shift.local_end AT TIME ZONE o.weekly_zone AS ends) bounds
  WHERE extract(isodow FROM d.day)::integer=ANY(o.weekly_days) AND bounds.ends>${asOf}
    AND (bounds.starts AT TIME ZONE o.weekly_zone)=shift.local_start
    AND (bounds.ends AT TIME ZONE o.weekly_zone)=shift.local_end`;
}

function offeredWindows(asOf:SQL,through?:SQL){
  return sql`SELECT (entry->>'start')::timestamptz AS starts,(entry->>'end')::timestamptz AS ends,
    (entry->>'liveGoogle')::boolean AS live FROM jsonb_array_elements(o.windows) entry
    UNION ALL ${weeklyOfferWindows(asOf,through)}`;
}

// PostgreSQL merges touching and overlapping ranges per host. Keep the live-check
// ranges separately so a manual offer cannot mask a partial calendar requirement.
function hostCoverage(asOf:SQL,through?:SQL){
  return sql`SELECT range_agg(tstzrange(win.starts,win.ends,'[)')) AS offered,
    range_agg(tstzrange(win.starts,win.ends,'[)')) FILTER (WHERE win.live) AS live
    FROM (${offeredWindows(asOf,through)}) win WHERE win.starts<win.ends`;
}

// Expand weekly hours in the host’s local calendar, then generate bookable starts in UTC.
async function choices(db:Reader,page:Page,start?:number,after?:number){
  const grid=15*60_000;
  if(start!==undefined&&start%grid!==0)return [];
  const span=page.duration*60_000;
  // A confirmation needs one proposed interval per host. Browsing generates only starts after the cursor.
  const offeredStarts=sql`ceil(extract(epoch FROM lower(win.span))/900)::bigint*900000`;
  const first=after===undefined?offeredStarts:sql`greatest(${offeredStarts},${(Math.floor(after/grid)+1)*grid}::bigint)`;
  const slots=start===undefined?sql`LATERAL unnest(coverage.offered) AS win(span)
      CROSS JOIN LATERAL generate_series(${first},(extract(epoch FROM upper(win.span))*1000)::bigint-${span},900000) AS slot(at)`:
    sql`(VALUES (${start}::bigint)) AS slot(at)`;
  return Array.from(await db.execute<Candidate>(sql`
    WITH candidates AS (
      SELECT o.user_id,o.last_assigned_at,slot.at,
        CASE WHEN coverage.live && tstzrange(to_timestamp(slot.at/1000.0),to_timestamp((slot.at+${span}::bigint)/1000.0),'[)')
          THEN i.email ELSE '' END AS calendar
      FROM portable_team_availability o JOIN private_workspaces w ON w.id=o.workspace_id
      JOIN login_identities i ON i.id=o.user_id
      CROSS JOIN LATERAL (${hostCoverage(sql`now()`)}) coverage
      CROSS JOIN ${slots}
      WHERE o.workspace_id=${page.workspaceId} AND ${activeOffer}
        AND ${page.moving&&!page.moving.useRoster?sql`o.user_id IN (${sql.join(page.moving.users.map(user=>sql`${user}`),sql`,`)})`:
          sql`o.id=ANY(${uuidArray(page.hosts)})`}
        AND slot.at>extract(epoch FROM clock_timestamp())*1000
        ${start===undefined?sql``:sql`AND coverage.offered @> tstzrange(to_timestamp(slot.at/1000.0),to_timestamp((slot.at+${span}::bigint)/1000.0),'[)')`}
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.time_off) absence
          WHERE (absence->>'startMs')::bigint<slot.at+${span}::bigint AND (absence->>'endMs')::bigint>slot.at)
        AND NOT ${bookedTeamTime(sql`o.user_id`,sql`slot.at`,sql`slot.at+${span}::bigint`,undefined,page.moving?{workspaceId:page.workspaceId,id:page.moving.id}:undefined)}
        AND NOT EXISTS (SELECT 1 FROM portable_calendar_meetings m WHERE m.owner_id=o.user_id
          AND m.status NOT IN ('cancelled','rejected') AND m.start_at<slot.at+${span}::bigint AND m.end_at>slot.at)
        AND NOT EXISTS (SELECT 1 FROM portable_calendar_reschedules c JOIN portable_calendar_meetings m
          ON m.workspace_id=c.workspace_id AND m.id=c.meeting_id WHERE m.owner_id=o.user_id AND c.status IN ('submitting','attention')
          AND c.start_at<slot.at+${span}::bigint AND c.end_at>slot.at)
    ) SELECT at::text AS at,array_agg(user_id ORDER BY last_assigned_at NULLS FIRST,user_id) AS users,
      array_agg(calendar ORDER BY last_assigned_at NULLS FIRST,user_id) AS calendars
      FROM candidates GROUP BY candidates.at HAVING count(*)>=${requiredHosts(page)}
      ORDER BY candidates.at LIMIT 1344`));
}

async function readCalendarCheck(db:Reader,page:Page,rows:Candidate[],probe:ReadTeamBusy):Promise<CalendarCheck>{
  const emails=[...new Set(rows.flatMap(row=>row.calendars).filter(Boolean))];
  if(!emails.length)return {expires:0,busy:new Map()};
  const [owner]=await db.select({email:loginIdentities.email}).from(privateWorkspaces)
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId)).where(eq(privateWorkspaces.id,page.workspaceId));
  const from=Number(rows[0].at),to=Number(rows[rows.length-1].at)+page.duration*60000;
  const busy=await probe(owner.email,emails,new Date(from).toISOString(),new Date(to).toISOString());
  return {expires:Date.now()+15000,busy};
}

function openUsers(row:Candidate,duration:number,check:CalendarCheck|undefined){
  const start=Number(row.at),end=start+duration*60000;
  return row.users.filter((_,i)=>{
    const email=row.calendars[i];
    if(!email)return true;
    const busy=check&&Date.now()<check.expires?check.busy.get(email):undefined;
    return !!busy&&!busy.some(slot=>Date.parse(slot.start)<end&&Date.parse(slot.end)>start);
  });
}

export async function teamSlotPage(db:Reader,page:Page,probe:ReadTeamBusy,range:{start?:string;after?:string}={}){
  const rows=await choices(db,page,range.start?Date.parse(range.start):undefined,range.after?Date.parse(range.after):undefined);
  const check=await readCalendarCheck(db,page,rows,probe);
  const open=rows.filter(row=>Number(row.at)!==page.moving?.start&&openUsers(row,page.duration,check).length>=requiredHosts(page));
  const size=120;
  const slots=open.slice(0,size).map(({at})=>({start:new Date(Number(at)).toISOString(),end:new Date(Number(at)+page.duration*60000).toISOString()}));
  return {slots,next:open.length>size?slots[size-1].start:null};
}

export async function checkTeamBooking(db:Reader,page:Page,start:string,probe:ReadTeamBusy){
  return readCalendarCheck(db,page,await choices(db,page,Date.parse(start)),probe);
}

// Use the current roster and time. The existing reservation already makes its host busy.
async function hostChangeBooking(db:Reader,w:string,id:string){
  const {moving,...page}=await reschedulingPage(db,w,id);
  if(page.mode!=='rotation'||moving.users.length!==1)throw new ApiError(409,'Choose a round-robin booking with one host.');
  return {page,host:moving.users[0],start:moving.start};
}

export async function replacementHostOptions(db:Db,w:string,userId:string,grant:string|null,id:string,probe:ReadTeamBusy):Promise<BookingHostOptions>{
  if(!await access(db,w,userId,grant,false))throw new ApiError(404,'Booking unavailable.');
  const {page,host,start}=await hostChangeBooking(db,w,id);
  const rows=await choices(db,page,start);
  const check=await readCalendarCheck(db,page,rows,probe);
  const available=rows.length?openUsers(rows[0],page.duration,check):[];
  const roster=await hosts(db,w,undefined,page.hosts);
  return {expectedHost:host,start:new Date(start).toISOString(),
    hosts:roster.filter(person=>available.includes(person.userId)&&person.userId!==host)
      .map(person=>({id:person.userId,label:person.label}))};
}

function sameHosts(a:string[],b:string[]){
  return a.length===b.length&&a.every(id=>b.includes(id));
}

async function updateBookedHosts(tx:Tx,w:string,id:string,bookedUsers:string[],users:string[]){
  const removed=bookedUsers.filter(host=>!users.includes(host));
  const added=users.filter(host=>!bookedUsers.includes(host));
  if(removed.length)await tx.delete(teamAttendees).where(and(eq(teamAttendees.workspaceId,w),eq(teamAttendees.bookingId,id),inArray(teamAttendees.userId,removed)));
  if(added.length)await tx.insert(teamAttendees).values(added.map(userId=>({workspaceId:w,bookingId:id,userId})));
}

async function collectiveRoster(db:Reader,w:string,id:string){
  const booking=await reschedulingPage(db,w,id);
  if(booking.mode!=='collective')throw new ApiError(409,'Choose a collective meeting.');
  const proposed=await hosts(db,w,undefined,booking.hosts);
  if(proposed.length!==booking.hosts.length)throw new ApiError(409,'A calendar host is unavailable. Update the calendar roster before changing this booking.');
  const users=proposed.map(h=>h.userId);
  // Check the proposed group together, excluding only this reservation from their busy time.
  const page={...booking,moving:{...booking.moving,users}};
  return {page,proposed,bookedUsers:booking.moving.users};
}

export async function previewCollectiveRoster(db:Db,w:string,user:string,grant:string|null,id:string,probe:ReadTeamBusy):Promise<CollectiveRosterPreview>{
  if(!await access(db,w,user,grant,false))throw inaccessible();
  const {page,proposed,bookedUsers}=await collectiveRoster(db,w,id);
  const booked=await db.select({id:loginIdentities.id,label:sql<string>`concat_ws(' · ',nullif(${loginIdentities.fullName},''),${loginIdentities.email})`})
    .from(loginIdentities).where(inArray(loginIdentities.id,bookedUsers)).orderBy(asc(loginIdentities.email));
  const changed=!sameHosts(bookedUsers,page.moving.users);
  const rows=changed?await choices(db,page,page.moving.start):[];
  const check=await readCalendarCheck(db,page,rows,probe);
  return {start:new Date(page.moving.start).toISOString(),booked,calendarHosts:page.hosts,changed,
    proposed:proposed.map(h=>({id:h.userId,label:h.label})),
    available:!!rows.length&&openUsers(rows[0],page.duration,check).length===proposed.length};
}

export async function reserveTeamBooking(tx:Tx,page:Page,id:string,email:string,start:string,check?:CalendarCheck){
  const at=Date.parse(start);
  const [prior]=await tx.select().from(teamBookings).where(and(eq(teamBookings.workspaceId,page.workspaceId),eq(teamBookings.id,id)));
  if(prior){
    if(prior.pageId!==page.id||prior.email!==email||prior.start!==at||prior.cancelled)throw busy();
    return;
  }
  const pool=await hosts(tx,page.workspaceId,undefined,page.hosts);
  await lockBookingHosts(tx,pool.map(host=>host.userId));
  const [slot]=await choices(tx,page,at);
  if(!slot)throw busy();
  const available=openUsers(slot,page.duration,check);
  if(available.length<(page.mode==='collective'?page.hosts.length:1))throw busy();
  const assigned=page.mode==='collective'?available:available.slice(0,1);
  await tx.insert(teamBookings).values({id,workspaceId:page.workspaceId,pageId:page.id,title:page.title,email,start:at,end:at+page.duration*60_000});
  await tx.insert(teamAttendees).values(assigned.map(userId=>({workspaceId:page.workspaceId,bookingId:id,userId})));
  // Capture only enrollments active at confirmation. A booking replay or move cannot
  // stop a new enrollment, and a shared email address cannot identify a contact.
  await tx.execute(sql`WITH matches AS (
    SELECT id FROM contacts WHERE workspace_id=${page.workspaceId} AND archived_at IS NULL
      AND lower(data->>'email')=lower(${email}) LIMIT 2
  )
  UPDATE portable_sales_sequence_activations a SET team_booking_id=${id}
  FROM portable_sales_enrollments e JOIN matches c ON c.id=e.contact_id
  WHERE (a.workspace_id,a.enrollment_id)=(e.workspace_id,e.id) AND e.workspace_id=${page.workspaceId}
    AND e.state='active' AND a.team_booking_id IS NULL AND (SELECT count(*) FROM matches)=1
    AND (e.recipient IS NULL OR e.recipient=lower(${email}))`);
  if(page.mode==='rotation')await markRotationTurn(tx,page.workspaceId,assigned[0]);
}

async function markRotationTurn(tx:Tx,w:string,userId:string){
  await tx.update(teamOffers).set({lastAssignedAt:sql`floor(extract(epoch FROM clock_timestamp())*1000000)::bigint`})
    .where(and(eq(teamOffers.workspaceId,w),eq(teamOffers.userId,userId)));
}

async function access(db:Db,workspaceId:string,userId:string,grantId:string|null,write:boolean){
  const query=db.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces).where(eq(privateWorkspaces.id,workspaceId));
  const [workspace]=await (write?query.for('update'):query);
  if(!workspace)throw inaccessible();
  if(workspace.ownerId===userId&&!grantId)return true;
  if(!grantId)throw inaccessible();
  const grant=db.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(eq(workspaceViewers.workspaceId,workspaceId),
    eq(workspaceViewers.viewerId,userId),eq(workspaceViewers.id,grantId),eq(workspaceViewers.role,'editor')));
  if(!(await (write?grant.for('share'):grant)).length)throw inaccessible();
  if(!await sharedToolAllowed(db,userId,workspaceId,'meetings',write?'edit':'view'))throw inaccessible();
  return false;
}

export async function organizerSlotPage(db:Db,w:string,user:string,grant:string|null,selection:{move:string;useRoster?:boolean}|{page:string},probe:ReadTeamBusy,after?:string){
  if(!await access(db,w,user,grant,false))throw new ApiError(404,'Calendar unavailable.');
  if('move' in selection){
    const page=await reschedulingPage(db,w,selection.move,selection.useRoster);
    const slots=await teamSlotPage(db,page,probe,{after});
    return selection.useRoster?{...slots,original:new Date(page.moving.start).toISOString(),
      roster:{booked:page.moving.users,calendar:page.hosts}}:slots;
  }
  const page=await findTeamCalendar(db,selection.page);
  if(page?.workspaceId!==w)throw new ApiError(404,'Calendar unavailable.');
  return teamSlotPage(db,page,probe,{after});
}

export async function readTeamSchedule(db:Db,w:string,user:string,grant:string|null,publicBooking:boolean,calendarOwner?:string,after?:TeamBookingCursor,guestEmail?:string,hostSearch?:HostSearch,reviewFilter?:BookingReviewFilter):Promise<TeamSchedule>{
  return db.transaction(async tx=>{
    const owner=await access(tx,w,user,grant,false);
    const outsideHours=reviewFilter==='outsideHours';
    const bookingStart=sql`to_timestamp(b.start_at/1000.0)`,bookingEnd=sql`to_timestamp(b.end_at/1000.0)`;
    const teamConflicts=reviewFilter==='team';
    const formerHosts=reviewFilter==='formerHosts';
    if((teamConflicts||formerHosts)&&!owner)throw inaccessible();
    const [offer]=await tx.select().from(teamOffers).where(and(eq(teamOffers.workspaceId,w),eq(teamOffers.userId,user)));
    const timeOff=(offer?.timeOff??[]).filter(period=>period.endMs>Date.now());
    const overlaps=timeOff.map(p=>sql`(b.start_at<${p.endMs}::bigint AND b.end_at>${p.startMs}::bigint)`);
    const pageSize=100;
    const appointments=await tx.execute<{id:string;title:string;email:string;start:string;end:string;pageId?:string;canReschedule:boolean;multipleContacts?:boolean;awayHostNames?:string[];formerHostNames?:string[];outsideHoursHostNames?:string[];hostNames:string[]}>(sql`
      WITH upcoming AS (
        SELECT b.* ${teamConflicts?sql`, conflicts.names AS "awayHostNames"`:sql``}
          ${formerHosts?sql`, former.names AS "formerHostNames"`:sql``}
          ${outsideHours?sql`, uncovered.names AS "outsideHoursHostNames"`:sql``}
        FROM portable_team_bookings b
        ${outsideHours?sql`CROSS JOIN LATERAL (
          SELECT array_agg(concat_ws(' · ',nullif(i.full_name,''),i.email) ORDER BY i.email) AS names
          FROM portable_team_booking_hosts h JOIN portable_team_availability o
            ON o.workspace_id=h.workspace_id AND o.user_id=h.user_id
          JOIN private_workspaces w ON w.id=o.workspace_id JOIN login_identities i ON i.id=h.user_id
          WHERE h.workspace_id=b.workspace_id AND h.booking_id=b.id AND ${activeOffer}
            ${owner?sql``:sql`AND h.user_id=${user}`}
            AND NOT EXISTS (SELECT 1 FROM (${hostCoverage(bookingStart,bookingEnd)}) coverage
              WHERE coverage.offered @> tstzrange(${bookingStart},${bookingEnd},'[)'))
        ) uncovered`:sql``}
        ${formerHosts?sql`CROSS JOIN LATERAL (
          SELECT array_agg(concat_ws(' · ',nullif(i.full_name,''),i.email) ORDER BY i.email) AS names
          FROM portable_team_booking_hosts h JOIN login_identities i ON i.id=h.user_id
          WHERE h.workspace_id=b.workspace_id AND h.booking_id=b.id AND NOT EXISTS (
            SELECT 1 FROM portable_team_calendars c
            JOIN portable_team_availability o ON o.workspace_id=c.workspace_id AND o.id=ANY(c.hosts)
            JOIN private_workspaces w ON w.id=c.workspace_id
            WHERE c.workspace_id=b.workspace_id AND c.id=b.page_id AND o.user_id=h.user_id AND ${activeOffer}
          )
        ) former`:sql``}
        ${teamConflicts?sql`CROSS JOIN LATERAL (
          SELECT array_agg(concat_ws(' · ',nullif(i.full_name,''),i.email) ORDER BY i.email) AS names
          FROM portable_team_booking_hosts h JOIN portable_team_availability o
            ON o.workspace_id=h.workspace_id AND o.user_id=h.user_id
          JOIN login_identities i ON i.id=h.user_id
          WHERE h.workspace_id=b.workspace_id AND h.booking_id=b.id AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.time_off) p
            WHERE (p->>'startMs')::bigint<b.end_at AND (p->>'endMs')::bigint>b.start_at
              AND (p->>'endMs')::bigint>extract(epoch FROM now())*1000
          )
        ) conflicts`:sql``}
        WHERE b.workspace_id=${w} AND NOT b.cancelled
          ${guestEmail?sql`AND b.email=${guestEmail}`:sql``}
          ${teamConflicts?sql`AND conflicts.names IS NOT NULL`:sql``}
          ${outsideHours?sql`AND uncovered.names IS NOT NULL`:sql``}
          ${formerHosts?sql`AND former.names IS NOT NULL`:sql``}
          ${reviewFilter==='mine'?sql`AND (${overlaps.length?sql.join(overlaps,sql` OR `):sql`false`})`:sql``}
          AND b.end_at>extract(epoch FROM now())*1000
          ${after?sql`AND (b.start_at,b.id)>(${Date.parse(after.start)}::bigint,${after.id}::uuid)`:sql``}
          AND EXISTS (SELECT 1 FROM portable_team_booking_hosts h WHERE h.workspace_id=b.workspace_id AND h.booking_id=b.id
            ${!owner||reviewFilter==='mine'?sql`AND h.user_id=${user}`:sql``})
        ORDER BY b.start_at,b.id LIMIT ${pageSize+1}
      )
      SELECT b.id,b.title,b.email,b.start_at::text AS start,b.end_at::text AS end,
        ${owner?sql`b.page_id AS "pageId",`:sql``}
        ${teamConflicts?sql`b."awayHostNames",`:sql``}
        ${outsideHours?sql`b."outsideHoursHostNames",`:sql``}
        ${formerHosts?sql`b."formerHostNames",`:sql``}
        ${owner?sql`EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id=b.workspace_id AND c.archived_at IS NULL
          AND lower(c.data->>'email')=b.email OFFSET 1) AS "multipleContacts",`:sql``}

        (${owner}::boolean AND b.start_at>extract(epoch FROM now())*1000 AND EXISTS (
          SELECT 1 FROM ${teamPages} c WHERE c.id=b.page_id AND c.workspace_id=b.workspace_id AND NOT c.closed)) AS "canReschedule",
        ARRAY(SELECT concat_ws(' · ',nullif(i.full_name,''),i.email)
          FROM portable_team_booking_hosts h JOIN login_identities i ON i.id=h.user_id
          WHERE h.workspace_id=b.workspace_id AND h.booking_id=b.id ORDER BY i.email) AS "hostNames"
      FROM upcoming b ORDER BY b.start_at,b.id`);
    const meetings=appointments.slice(0,pageSize).map(row=>({...row,start:new Date(Number(row.start)).toISOString(),end:new Date(Number(row.end)).toISOString()}));
    const last=meetings.at(-1);
    const [organizer]=await tx.select({email:loginIdentities.email}).from(privateWorkspaces).innerJoin(loginIdentities,
      eq(loginIdentities.id,privateWorkspaces.ownerId)).where(eq(privateWorkspaces.id,w));
    const candidates=owner?await hosts(tx,w,hostSearch):[];
    const lastHost=candidates[hostPageSize-1];
    const pages=owner?await tx.select().from(teamPages).where(and(eq(teamPages.workspaceId,w),eq(teamPages.closed,false))).orderBy(asc(teamPages.title)):[];
    const ids=[...new Set(pages.flatMap(calendar=>calendar.hosts))];
    // A calendar may still name a former host or an offer outside the picker’s current page.
    const roster=ids.length?await tx.execute<{id:string;label:string;issue:CalendarHostIssue|null}>(sql`
      SELECT o.id,concat_ws(' · ',nullif(i.full_name,''),i.email) AS label,
        CASE WHEN NOT ${activeOffer} THEN 'access' WHEN NOT ${hasOfferedHours} THEN 'hours' END AS issue
      FROM portable_team_availability o JOIN private_workspaces w ON w.id=o.workspace_id
      JOIN login_identities i ON i.id=o.user_id WHERE o.workspace_id=${w} AND o.id=ANY(${uuidArray(ids)})`):[];
    const hostById=new Map(roster.map(host=>[host.id,host]));
    const canEditAvailability=owner||await sharedToolAllowed(tx,user,w,'meetings','edit');
    return {owner,canEditAvailability,publicBooking,liveGoogle:organizer.email===calendarOwner,revision:offer?.revision??0,windows:(offer?.windows??[]).filter(win=>Date.parse(win.end)>Date.now()),
      timeOff:timeOff.map(({from,through,timeZone,startTime,endTime,pauseLeadRouting})=>({from,through,timeZone,startTime,endTime,pauseLeadRouting})),
      weekly:offer?.weeklyDays?{days:offer.weeklyDays,timeZone:offer.weeklyZone!,start:offer.weeklyStart!.slice(0,5),
        end:offer.weeklyEnd!.slice(0,5),liveGoogle:offer.weeklyLive}:null,
      hosts:candidates.slice(0,hostPageSize).map(({id,label})=>({id,label})),
      nextHosts:candidates.length>hostPageSize?{email:lastHost.email,id:lastHost.id}:null,
      pages:pages.map(page=>{
        const hostLabels:Record<string,string>={};
        const hostIssues:{id:string;reason:CalendarHostIssue}[]=[];
        for(const id of page.hosts){
          const host=hostById.get(id);
          hostLabels[id]=host?.label??'Former host';
          if(!host||host.issue)hostIssues.push({id,reason:host?.issue??'former'});
        }
        return {...page,hostLabels,hostIssues};
      }),
      meetings,nextBookings:appointments.length>pageSize&&last?{start:last.start,id:last.id}:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

async function updatedTimeOff(tx:Tx,current:(typeof teamOffers.$inferSelect)['timeOff'],
  input:Extract<TeamChange,{action:'timeOff'}>,now:number){
  const period=input.period;
  const previous=current.find(p=>p.from===period.from&&p.through===period.through&&p.timeZone===period.timeZone
    &&p.startTime===period.startTime&&p.endTime===period.endTime);
  const periods=current.filter(p=>p.endMs>now&&p!==previous);
  if(input.operation==='add'){
    let startMs:number,endMs:number;
    if(previous){
      // Changing the routing choice keeps the saved calendar boundaries.
      startMs=previous.startMs;
      endMs=previous.endMs;
    }else if(period.startTime&&period.endTime){
      if(!validTimeZone(period.timeZone))throw new ApiError(400,'Choose a time zone supported for local clock times.');
      const start=scheduledInstants(period.from+'T'+period.startTime,period.timeZone)[0];
      const end=scheduledInstants(period.through+'T'+period.endTime,period.timeZone).at(-1);
      if(!start||!end)throw new ApiError(400,'That local time does not exist. Check the clock change and choose another time.');
      // On a fall-back day, cover both occurrences of an hour the rep marked as unavailable.
      startMs=Date.parse(start);endMs=Date.parse(end);
    }else{
      const [bounds]=await tx.execute<{start:string;end:string}>(sql`SELECT
        extract(epoch FROM (${period.from}::date::timestamp AT TIME ZONE ${period.timeZone}))*1000 AS start,
        extract(epoch FROM ((${period.through}::date+1)::timestamp AT TIME ZONE ${period.timeZone}))*1000 AS end`);
      startMs=Number(bounds.start);endMs=Number(bounds.end);
    }
    if(endMs<=now||endMs<=startMs)throw new ApiError(400,'Choose time off that ends in the future.');
    if(periods.length>=24)throw new ApiError(400,'Remove a time-off period before adding another.');
    periods.push({...period,pauseLeadRouting:period.pauseLeadRouting??previous?.pauseLeadRouting,startMs,endMs});
  }
  return periods.sort((a,b)=>a.startMs-b.startMs);
}

export async function changeTeamSchedule(db:Db,w:string,actor:PostgresSessionActor,grant:string|null,input:TeamChange,probe:ReadTeamBusy){
  const user=actor.userId;
  let check:CalendarCheck|undefined;
  if(input.action==='useCalendarHosts'){
    if(!await access(db,w,user,grant,false))throw inaccessible();
    const {page,bookedUsers}=await collectiveRoster(db,w,input.id);
    if(!sameHosts(bookedUsers,page.moving.users)&&sameHosts(input.calendarHosts,page.hosts)&&page.moving.start===Date.parse(input.expectedStart))
      check=await checkTeamBooking(db,page,input.expectedStart,probe);
  }else if(input.action==='replaceHost'){
    if(!await access(db,w,user,grant,false))throw inaccessible();
    const booking=await hostChangeBooking(db,w,input.id);
    if(booking.host===input.expectedHost&&booking.start===Date.parse(input.expectedStart)&&booking.host!==input.host)
      check=await checkTeamBooking(db,booking.page,input.expectedStart,probe);
  }else if(input.action==='book'||input.action==='reschedule'){
    if(!await access(db,w,user,grant,false))throw inaccessible();
    const page:Page|undefined=input.action==='reschedule'?await reschedulingPage(db,w,input.id,!!input.roster):await findTeamCalendar(db,input.pageId);
    if(page?.workspaceId!==w)throw busy();
    if(page.moving?.start!==Date.parse(input.start))check=await checkTeamBooking(db,page,input.start,probe);
  }
  await db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw inaccessible();
    const owner=await access(tx,w,user,grant,true);
    if(input.action==='offer'||input.action==='weekly'||input.action==='timeOff'){
      const [before]=await tx.select().from(teamOffers).where(and(eq(teamOffers.workspaceId,w),eq(teamOffers.userId,user)));
      if((before?.revision??0)!==input.revision)throw new ApiError(409,'Availability changed. Reload before saving.');
      const now=Date.now();
      let values:Partial<typeof teamOffers.$inferInsert>&{revision:number}={revision:input.revision+1};
      if(input.action==='offer'){
        if(input.windows.some(win=>Date.parse(win.end)<=now||Date.parse(win.end)>now+14*86400000))
          throw new ApiError(400,'Offer times within the next 14 days.');
        values.windows=input.windows;
      }else{
        const zone=input.action==='weekly'?input.hours?.timeZone:input.period.timeZone;
        if(zone){
          const valid=await tx.execute(sql`SELECT 1 FROM pg_timezone_names WHERE name=${zone} LIMIT 1`);
          if(!valid.length)throw new ApiError(400,'Choose a recognized time zone.');
        }
        if(input.action==='weekly'){
          const h=input.hours;
          values={...values,weeklyDays:h?.days??null,weeklyZone:h?.timeZone??null,weeklyStart:h?.start??null,
            weeklyEnd:h?.end??null,weeklyLive:h?.liveGoogle??false};
        }else{
          values.timeOff=await updatedTimeOff(tx,before?.timeOff??[],input,now);
        }
      }
      if(before)await tx.update(teamOffers).set(values).where(eq(teamOffers.id,before.id));
      else await tx.insert(teamOffers).values({windows:[],...values,id:crypto.randomUUID(),workspaceId:w,userId:user,grantId:grant});
      return;
    }
    if(!owner)throw inaccessible();
    if(input.action==='useCalendarHosts'){
      const {page,bookedUsers}=await collectiveRoster(tx,w,input.id);
      const {start,users}=page.moving;
      if(start!==Date.parse(input.expectedStart)||!sameHosts(page.hosts,input.calendarHosts))
        throw new ApiError(409,'The booking time or calendar roster changed. Review the hosts again.');
      if(sameHosts(bookedUsers,users))return;
      if(!sameHosts(bookedUsers,input.expectedHosts))throw new ApiError(409,'The booked hosts changed. Review them again.');
      await lockBookingHosts(tx,[...bookedUsers,...users]);
      const [slot]=await choices(tx,page,start);
      if(!slot||openUsers(slot,page.duration,check).length!==users.length)throw busy();
      await updateBookedHosts(tx,w,input.id,bookedUsers,users);
      return;
    }
    if(input.action==='replaceHost'){
      const {page,host,start}=await hostChangeBooking(tx,w,input.id);
      if(start!==Date.parse(input.expectedStart))throw new ApiError(409,'This booking time changed. Refresh the schedule.');
      if(host===input.host)return;
      if(host!==input.expectedHost)throw new ApiError(409,'This booking has a different host. Refresh the schedule.');
      await lockBookingHosts(tx,[host,input.host]);
      const [slot]=await choices(tx,page,start);
      if(!slot||!openUsers(slot,page.duration,check).includes(input.host))
        throw new ApiError(409,'This host is no longer available at the booked time. Choose another host.');
      await tx.update(teamAttendees).set({userId:input.host}).where(and(eq(teamAttendees.workspaceId,w),
        eq(teamAttendees.bookingId,input.id),eq(teamAttendees.userId,host)));
      await markRotationTurn(tx,w,input.host);
      return;
    }
    if(input.action==='reschedule'){
      const page=await reschedulingPage(tx,w,input.id,!!input.roster);
      const start=Date.parse(input.start);
      if(input.roster&&!sameHosts(page.hosts,input.roster.calendar))
        throw new ApiError(409,'The calendar roster changed. Review replacement times again.');
      const candidates=input.roster?await hosts(tx,w,undefined,page.hosts):[];
      if(start===page.moving.start){
        if(input.roster&&(page.moving.users.length!==requiredHosts(page)||
          !page.moving.users.every(user=>candidates.some(host=>host.userId===user))))
          throw new ApiError(409,'The booking has different hosts. Review replacement times again.');
        return;
      }
      if(page.moving.start!==Date.parse(input.expectedStart))throw new ApiError(409,'This booking time changed. Refresh the schedule.');
      if(input.roster&&!sameHosts(page.moving.users,input.roster.booked))
        throw new ApiError(409,'The booked hosts changed. Review replacement times again.');
      await lockBookingHosts(tx,[...page.moving.users,...candidates.map(h=>h.userId)]);
      const [slot]=await choices(tx,page,start);
      const available=slot?openUsers(slot,page.duration,check):[];
      if(available.length<requiredHosts(page))throw busy();
      if(input.roster){
        const assigned=page.mode==='rotation'?available.slice(0,1):available;
        await updateBookedHosts(tx,w,input.id,page.moving.users,assigned);
        if(page.mode==='rotation'&&!page.moving.users.includes(assigned[0]))await markRotationTurn(tx,w,assigned[0]);
      }
      await tx.update(teamBookings).set({start,end:start+page.duration*60000})
        .where(and(eq(teamBookings.workspaceId,w),eq(teamBookings.id,input.id)));
      return;
    }
    if(input.action==='changeHosts'){
      const page=await findTeamCalendar(tx,input.id);
      if(page?.workspaceId!==w)throw new ApiError(404,'Calendar unavailable.');
      if(sameHosts(input.hosts,page.hosts))return;
      if(!sameHosts(input.expectedHosts,page.hosts))throw new ApiError(409,'The calendar hosts changed. Refresh the schedule and edit the current hosts.');
      const offered=await hosts(tx,w,undefined,input.hosts);
      if(offered.length!==input.hosts.length)throw new ApiError(409,'Choose current hosts who have offered availability.');
      await tx.update(teamPages).set({hosts:input.hosts}).where(and(eq(teamPages.workspaceId,w),eq(teamPages.id,page.id)));
      return;
    }
    if(input.action==='create'){
      const {id,title,mode,duration,hosts:hostIds,publicEnabled}=input;
      const page={id,title,mode,duration,hosts:hostIds,publicEnabled};
      const [current]=await tx.select().from(teamPages).where(eq(teamPages.id,page.id));
      if(current){
        if(!current.closed&&current.publicEnabled===page.publicEnabled&&current.workspaceId===w&&current.title===page.title&&current.mode===page.mode&&current.duration===page.duration&&JSON.stringify(current.hosts)===JSON.stringify(page.hosts))return;
        throw new ApiError(409,'Calendar already exists. Reload before creating one.');
      }
      if((await tx.select({id:teamPages.id}).from(teamPages).where(and(eq(teamPages.workspaceId,w),eq(teamPages.closed,false))).limit(20)).length===20)
        throw new ApiError(409,'Close an unused calendar before adding another.');
      const offered=await hosts(tx,w,undefined,hostIds);
      if(page.hosts.some(id=>!offered.some(host=>host.id===id)))throw new ApiError(409,'Choose current hosts who have offered availability.');
      await tx.insert(teamPages).values({...page,workspaceId:w});
      return;
    }
    if(input.action==='close'){
      await tx.update(teamPages).set({closed:true}).where(and(eq(teamPages.workspaceId,w),eq(teamPages.id,input.id)));return;
    }
    if(input.action==='cancel'){
      const changed=await tx.update(teamBookings).set({cancelled:true}).where(and(eq(teamBookings.workspaceId,w),
        eq(teamBookings.id,input.id),input.expectedStart?eq(teamBookings.start,Date.parse(input.expectedStart)):undefined))
        .returning({id:teamBookings.id});
      if(input.expectedStart&&!changed.length)throw new ApiError(409,'This booking changed. Review the current schedule before cancelling.');
      return;
    }
    const page=await findTeamCalendar(tx,input.pageId);
    if(page?.workspaceId!==w)throw busy();
    await reserveTeamBooking(tx,page,input.id,input.email,input.start,check);
  });
}

export async function publicTeamCalendar(db:Reader,id:string){
  const [page]=await db.select({page:teamPages,ownerId:privateWorkspaces.ownerId,email:loginIdentities.email})
    .from(teamPages).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,teamPages.workspaceId))
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(teamPages.id,id),eq(teamPages.closed,false),eq(teamPages.publicEnabled,true)));
  return page;
}
