import {and,desc,eq,or,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableInvite,PortableReschedule} from '../../lib/calendar/portable-meetings';
import type {CalendarSlot} from '../../lib/calendar/suggestions';
import {contacts,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {workspaceEmailBlocked} from './email-suppression-store';
import {jobClock} from './job-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableMeetings as meetings,portableReschedules as changes} from './portable-meeting-schema';

type Db=PostgresJsDatabase;
type Meeting=typeof meetings.$inferSelect;
type Change=typeof changes.$inferSelect;
const scope=(ownerId:string)=>and(eq(privateWorkspaces.id,meetings.workspaceId),
  eq(privateWorkspaces.ownerId,ownerId),eq(meetings.ownerId,ownerId));
const key=(row:Pick<Meeting,'workspaceId'|'id'>)=>and(eq(meetings.workspaceId,row.workspaceId),eq(meetings.id,row.id));
const open=sql`${meetings.status} IN ('submitting','attention')`;
const pendingChange=sql`${changes.status} IN ('submitting','attention')`;
const reviewCutoff=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint-60000`;
const uncertainInvitationCondition=eq(meetings.status,'attention');
const staleInvitationCondition=and(eq(meetings.status,'submitting'),sql`coalesce(${meetings.cancellationStartedAt},${meetings.createdAt})<=${reviewCutoff}`);
const uncertainCancellationCondition=eq(meetings.status,'cancel_attention');
const staleCancellationCondition=and(eq(meetings.status,'cancelling'),sql`coalesce(${meetings.cancellationStartedAt},${meetings.createdAt})<=${reviewCutoff}`);
const uncertainRescheduleCondition=eq(changes.status,'attention');
const staleRescheduleCondition=and(eq(changes.status,'submitting'),sql`${changes.createdAt}<=${reviewCutoff}`);
export const meetingReceipt=(row:Meeting,change?:Change|null)=>{
  const canChange=row.status==='scheduled'&&row.start>Date.now()&&(!change||!isPortableReschedulePending(change));
  return {id:row.id,contactId:row.contactId,title:row.input.title,recipient:row.input.recipient,
    start:row.rescheduleRevision?new Date(row.start).toISOString():row.input.start,
    end:row.rescheduleRevision?new Date(row.end).toISOString():row.input.end,
    timeZone:row.rescheduledTimeZone??row.input.timeZone,status:row.status,eventUrl:row.eventUrl,createdAt:row.createdAt,
    revision:row.rescheduleRevision,canCancel:canChange,canReschedule:canChange,
    reschedule:change?{id:change.id,start:change.input.start,end:change.input.end,timeZone:change.input.timeZone,status:change.status}:null};
};
export const isPortableReschedulePending=(change:Change)=>change.status==='submitting'||change.status==='attention';
export const matchesInvite=(row:Meeting,input:PortableInvite)=>Object.entries(input).every(([field,value])=>
  row.input[field as keyof PortableInvite]===value);
export const matchesReschedule=(row:Change,input:PortableReschedule)=>Object.entries(input).every(([field,value])=>
  row.input[field as keyof PortableReschedule]===value);

export async function findPortableReschedule(db:Db,workspaceId:string,id:string){
  const [change]=await db.select().from(changes).where(and(eq(changes.workspaceId,workspaceId),eq(changes.id,id)));
  return change;
}

export async function findPendingPortableReschedule(db:Pick<Db,'select'>,meeting:Meeting){
  const [change]=await db.select().from(changes).where(and(eq(changes.workspaceId,meeting.workspaceId),
    eq(changes.meetingId,meeting.id),pendingChange));
  return change;
}

export async function findPortableMeeting(db:Db,ownerId:string,id:string){
  const [result]=await db.select({row:meetings}).from(meetings).innerJoin(privateWorkspaces,scope(ownerId))
    .where(eq(meetings.id,id));
  return result?.row;
}

export async function listPortableMeetings(db:Db,ownerId:string,after?:{at:number;id:string},needsReview=false){
  const rows=await db.select({row:meetings,change:changes}).from(meetings).innerJoin(privateWorkspaces,scope(ownerId))
    .leftJoin(changes,and(eq(changes.workspaceId,meetings.workspaceId),eq(changes.meetingId,meetings.id),pendingChange))
    .where(and(after?sql`(${meetings.createdAt},${meetings.id}) < (${after.at},${after.id}::uuid)`:undefined,
      needsReview?or(uncertainInvitationCondition,staleInvitationCondition,uncertainCancellationCondition,staleCancellationCondition,uncertainRescheduleCondition,staleRescheduleCondition):undefined))
    .orderBy(desc(meetings.createdAt),desc(meetings.id)).limit(26);
  const last=rows[24]?.row;
  return {needsReview,items:rows.slice(0,25).map(({row,change})=>meetingReceipt(row,change)),
    next:rows.length>25?{at:last.createdAt,id:last.id}:null};
}

// One snapshot covers both tables. A concurrent successful reschedule moves
// the proposed slot to the meeting and clears the hold in the same commit.
function slotHeldCondition(workspaceId:string|SQL,start:number|SQL,end:number|SQL,except?:string){
  return sql`
    EXISTS (SELECT 1 FROM ${meetings} WHERE workspace_id=${workspaceId}
      AND status NOT IN ('cancelled','rejected') AND end_at>${start} AND start_at<${end}
      ${except?sql`AND id<>${except}`:sql``})
    OR EXISTS (SELECT 1 FROM ${changes} WHERE workspace_id=${workspaceId}
      AND status IN ('submitting','attention') AND end_at>${start} AND start_at<${end})
  `;
}
async function slotHeld(db:Pick<Db,'execute'>,workspaceId:string|SQL,start:number,end:number,except?:string){
  const [row]=await db.execute<{held:boolean}>(sql`SELECT (${slotHeldCondition(workspaceId,start,end,except)}) AS held`);
  return row.held;
}

const ownerWorkspace=(ownerId:string)=>sql`(SELECT ${privateWorkspaces.id} FROM ${privateWorkspaces} WHERE ${privateWorkspaces.ownerId}=${ownerId})`;
export function portableCalendarSlotHeld(db:Db,ownerId:string,start:number,end:number){
  return slotHeld(db,ownerWorkspace(ownerId),start,end);
}

export async function portableOpenCalendarSlots(db:Db,ownerId:string,slots:CalendarSlot[]){
  if(!slots.length)return [];
  const candidates=slots.map(({start,end})=>({start,end,from:Date.parse(start),to:Date.parse(end)}));
  const rows=await db.execute<CalendarSlot>(sql`
    SELECT candidate.value->>'start' AS start,candidate.value->>'end' AS end
    FROM jsonb_array_elements(${JSON.stringify(candidates)}::jsonb) WITH ORDINALITY candidate(value,position)
    WHERE NOT (${slotHeldCondition(ownerWorkspace(ownerId),sql`(candidate.value->>'from')::bigint`,sql`(candidate.value->>'to')::bigint`)})
    ORDER BY candidate.position
  `);
  return Array.from(rows);
}

export function reservePortableMeeting(db:Db,ownerId:string,accountId:string,input:PortableInvite,guestGuard?:SQL){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
    if(!workspaceId)return {result:'missing'} as const;
    const [existing]=await tx.select().from(meetings).where(key({workspaceId,id:input.id}));
    if(existing)return {result:'existing',row:existing} as const;
    if(guestGuard&&!(await tx.execute<{allowed:boolean}>(sql`SELECT (${guestGuard}) AS allowed`))[0]?.allowed)
      return {result:'guest_changed'} as const;
    const [contact]=await tx.select({data:contacts.data}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,input.contactId),activeContact));
    if(!contact)return {result:'missing'} as const;
    if(contact.data.email?.trim().toLowerCase()!==input.recipient)return {result:'address_changed'} as const;
    if(await workspaceEmailBlocked(tx,workspaceId,input.recipient))return {result:'blocked'} as const;
    const start=Date.parse(input.start),end=Date.parse(input.end),at=await jobClock(tx);
    if(start<=at||end>at+366*86_400_000)return {result:'invalid_time'} as const;
    if(await slotHeld(tx,workspaceId,start,end))return {result:'overlap'} as const;
    const [row]=await tx.insert(meetings).values({workspaceId,id:input.id,contactId:input.contactId,ownerId,accountId,
      input,start,end,createdAt:at,status:'submitting'}).returning();
    return {result:'reserved',row} as const;
  });
}

export async function settlePortableMeeting(db:Db,row:Meeting,status:'attention'|'scheduled'|'cancelled'|'rejected',eventUrl:string|null=null){
  const [saved]=await db.update(meetings).set({status,eventUrl})
    .where(and(key(row),eq(meetings.accountId,row.accountId),status==='rejected'?eq(meetings.status,'submitting'):open)).returning();
  if(saved)return saved;
  const [current]=await db.select().from(meetings).where(key(row));
  return current;
}

export async function claimPortableCancellation(db:Db,row:Meeting){
  return db.transaction(async tx=>{
    if(await lockRecordWorkspace(tx,row.ownerId,false,undefined,undefined,true)!==row.workspaceId||
      await findPendingPortableReschedule(tx,row))return;
    const [claimed]=await tx.update(meetings).set({status:'cancelling',cancellationStartedAt:sql`floor(extract(epoch from clock_timestamp())*1000)`})
      .where(and(key(row),eq(meetings.status,'scheduled'),eq(meetings.rescheduleRevision,row.rescheduleRevision),
        sql`${meetings.start}>extract(epoch from clock_timestamp())*1000`)).returning();
    return claimed;
  });
}

export async function abandonPortableCancellation(db:Db,claim:Meeting){
  if(claim.status!=='cancelling'||claim.cancellationStartedAt===null)return;
  const [saved]=await db.update(meetings).set({status:'scheduled',cancellationStartedAt:null})
    .where(and(key(claim),eq(meetings.accountId,claim.accountId),eq(meetings.status,'cancelling'),
      eq(meetings.rescheduleRevision,claim.rescheduleRevision),
      eq(meetings.cancellationStartedAt,claim.cancellationStartedAt))).returning();
  return saved;
}

export async function settlePortableCancellation(db:Db,row:Meeting,status:'cancelled'|'cancel_attention'){
  const [saved]=await db.update(meetings).set({status,...(status==='cancelled'?{eventUrl:null}:{})})
    .where(and(key(row),eq(meetings.accountId,row.accountId),sql`${meetings.status} IN ('cancelling','cancel_attention')`)).returning();
  if(saved)return saved;
  const [current]=await db.select().from(meetings).where(key(row));
  return current;
}

export function reservePortableReschedule(db:Db,row:Meeting,input:PortableReschedule,originalEtag:string){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,row.ownerId,false,undefined,undefined,true);
    if(workspaceId!==row.workspaceId)return {result:'changed'} as const;
    const [prior]=await tx.select().from(changes).where(and(eq(changes.workspaceId,workspaceId),eq(changes.id,input.id)));
    if(prior)return {result:'existing',change:prior} as const;
    const [current]=await tx.select().from(meetings).where(and(key(row),eq(meetings.status,'scheduled'),
      eq(meetings.accountId,row.accountId),eq(meetings.rescheduleRevision,input.revision))).for('update');
    if(!current||await findPendingPortableReschedule(tx,current))return {result:'changed'} as const;
    const [contact]=await tx.select({data:contacts.data}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,current.contactId),activeContact));
    if(contact?.data.email?.trim().toLowerCase()!==current.input.recipient||
      await workspaceEmailBlocked(tx,workspaceId,current.input.recipient))return {result:'guest_unavailable'} as const;
    const start=Date.parse(input.start),end=Date.parse(input.end),at=await jobClock(tx);
    if(current.start<=at||start<=at||end>at+366*86_400_000)return {result:'invalid_time'} as const;
    if(start===current.start&&end===current.end&&input.timeZone===(current.rescheduledTimeZone??current.input.timeZone))return {result:'unchanged'} as const;
    if(await slotHeld(tx,workspaceId,start,end,row.id))return {result:'overlap'} as const;
    const [change]=await tx.insert(changes).values({workspaceId,id:input.id,meetingId:row.id,input,originalEtag,start,end,createdAt:at,status:'submitting'}).returning();
    return {result:'reserved',change} as const;
  });
}

export function settlePortableReschedule(db:Db,change:Change,outcome:'applied'|'attention'|'rejected'|'not_applied',eventUrl?:string|null){
  return db.transaction(async tx=>{
    const status=outcome==='not_applied'?'rejected':outcome;
    const unsettled=outcome==='applied'?pendingChange:outcome==='not_applied'?
      and(pendingChange,sql`${changes.originalEtag} = ${change.originalEtag}`):eq(changes.status,'submitting');
    const [saved]=await tx.update(changes).set({status})
      .where(and(eq(changes.workspaceId,change.workspaceId),eq(changes.id,change.id),unsettled)).returning();
    if(saved&&outcome==='applied'){
      const [meeting]=await tx.update(meetings).set({start:saved.start,end:saved.end,
        rescheduleRevision:saved.input.revision+1,rescheduledTimeZone:saved.input.timeZone,eventUrl})
        .where(and(key({workspaceId:saved.workspaceId,id:saved.meetingId}),eq(meetings.status,'scheduled'),
          eq(meetings.rescheduleRevision,saved.input.revision))).returning({id:meetings.id});
      if(!meeting)throw Error('Could not finalize the Calendar change receipt.');
    }
    if(saved)return saved;
    const [current]=await tx.select().from(changes).where(and(eq(changes.workspaceId,change.workspaceId),eq(changes.id,change.id)));
    return current;
  });
}

export async function portableCalendarReceiptStatus(db:Db){
  const [status]=await db.execute<{
    uncertain_invitation:boolean;stale_invitation:boolean;uncertain_cancellation:boolean;stale_cancellation:boolean;
    uncertain_reschedule:boolean;stale_reschedule:boolean;
  }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM ${meetings} WHERE ${uncertainInvitationCondition}) AS uncertain_invitation,
      EXISTS (SELECT 1 FROM ${meetings} WHERE ${staleInvitationCondition}) AS stale_invitation,
      EXISTS (SELECT 1 FROM ${meetings} WHERE ${uncertainCancellationCondition}) AS uncertain_cancellation,
      EXISTS (SELECT 1 FROM ${meetings} WHERE ${staleCancellationCondition}) AS stale_cancellation,
      EXISTS (SELECT 1 FROM ${changes} WHERE ${uncertainRescheduleCondition}) AS uncertain_reschedule,
      EXISTS (SELECT 1 FROM ${changes} WHERE ${staleRescheduleCondition}) AS stale_reschedule
  `);
  const {uncertain_invitation:uncertainInvitation,stale_invitation:staleInvitation,
    uncertain_cancellation:uncertainCancellation,stale_cancellation:staleCancellation,
    uncertain_reschedule:uncertainReschedule,stale_reschedule:staleReschedule}=status;
  const attention=uncertainInvitation||staleInvitation||uncertainCancellation||staleCancellation||uncertainReschedule||staleReschedule;
  return {result:attention?'attention':'ok',uncertainInvitation,staleInvitation,uncertainCancellation,staleCancellation,uncertainReschedule,staleReschedule};
}
