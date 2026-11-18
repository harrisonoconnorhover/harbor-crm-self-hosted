import {z} from 'zod';
import {sql,type SQL} from 'drizzle-orm';
import type {HarborIdentity} from '../lib/identity';
import {readContacts} from '../db/postgres/contact-store';
import {abandonPortableCancellation,claimPortableCancellation,findPendingPortableReschedule,findPortableMeeting,findPortableReschedule,
  matchesInvite,matchesReschedule,meetingReceipt,reservePortableMeeting,reservePortableReschedule,
  settlePortableCancellation,settlePortableMeeting,settlePortableReschedule} from '../db/postgres/portable-meeting-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {CALENDAR_AVAILABILITY_SCOPES,CALENDAR_OWNED_SCOPE,CalendarCancellationConflict,CalendarError,CalendarInsertRejected,calendarBusy,calendarBusyExcept,
  calendarIdentity,calendarTokens,cancelCalendarMeeting,insertMeeting,providerEventId,readMeeting,rescheduleCalendarMeeting,
  safeEventUrl,type CalendarEvent} from '../lib/calendar/google';
import {portableInvite,portableReschedule,type PortableInvite} from '../lib/calendar/portable-meetings';
import {portableApiIdentity} from './portable-api-identity';
import {portableCalendarCancellationsEnabled,portableCalendarConfig,portableCalendarInvitesEnabled,portableCalendarReschedulesEnabled} from './portable-calendar-config';
import {portableDb} from './portable-db';
import {boundedGoogleRead} from './portable-google-connections';
import {requestIdentity} from './portable-identity';

const command=z.union([z.object({action:z.literal('invite'),input:portableInvite}).strict(),
  z.object({action:z.literal('reschedule'),input:portableReschedule}).strict(),
  z.object({action:z.enum(['check','cancel']),id:z.string().guid("Invalid uuid")}).strict()]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const denied=()=>json({error:'Calendar invitations are unavailable for this account.'},403);
const conflict=(error:string)=>json({error},409);
const unavailable=()=>json({error:'Calendar could not confirm this request. Check the invitation before starting another.'},503);

type Meeting=NonNullable<Awaited<ReturnType<typeof findPortableMeeting>>>;
type Change=NonNullable<Awaited<ReturnType<typeof findPortableReschedule>>>;
const pendingCancellation=(row:Meeting)=>row.status==='cancelling'||row.status==='cancel_attention';
const confirmsCancellation=(event:CalendarEvent,row:Meeting)=>event.id===providerEventId(row.id)&&event.status==='cancelled';

function matchesEvent(event:CalendarEvent,row:Meeting,email:string){
  const {input}=row;
  const guests=event.attendees?.filter(attendee=>attendee.email.toLowerCase()!==email);
  return event.id===providerEventId(input.id)&&event.extendedProperties?.private?.harborMeetingId===input.id&&
    event.organizer?.email?.toLowerCase()===email&&event.organizer.self===true&&
    (event.status==='cancelled'||(Date.parse(event.start?.dateTime||'')===row.start&&Date.parse(event.end?.dateTime||'')===row.end&&
      !event.attendeesOmitted&&guests?.length===1&&guests[0].email.toLowerCase()===input.recipient));
}

function editableEvent(event:CalendarEvent,row:Meeting,email:string){
  return event.status!=='cancelled'&&matchesEvent(event,row,email)&&event.summary===row.input.title&&
    !event.recurrence?.length&&!event.recurringEventId&&(!event.eventType||event.eventType==='default');
}

function strongEventEtag(etag:string|null|undefined):etag is string{
  return typeof etag==='string'&&/^"[\x21\x23-\x7e\x80-\xff]+"$/.test(etag);
}

function confirmsOriginalSlot(event:CalendarEvent,row:Meeting,email:string){
  const timeZone=row.rescheduledTimeZone??row.input.timeZone;
  return editableEvent(event,row,email)&&event.start?.timeZone===timeZone&&event.end?.timeZone===timeZone;
}

function confirmsReschedule(event:CalendarEvent,row:Meeting,change:Change,email:string){
  return editableEvent(event,{...row,start:change.start,end:change.end},email)&&
    event.extendedProperties?.private?.harborChangeId===change.id&&
    event.start?.timeZone===change.input.timeZone&&event.end?.timeZone===change.input.timeZone;
}

type GuestAdmission={user:HarborIdentity;input:PortableInvite;guard:SQL};
export const POST=(request:Request)=>meetingAction(request);

export function sendPortableGuestInvitation(request:Request,user:HarborIdentity,input:PortableInvite,guard:SQL){
  return meetingAction(request,{user,input,guard});
}

async function meetingAction(request:Request,guest?:GuestAdmission){
  let readDeadline:AbortSignal|undefined;
  const finishProviderChecks=()=>{
    readDeadline?.throwIfAborted();
    readDeadline=undefined;
  };
  try{
    const user=guest?.user??await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const config=portableCalendarConfig();
    if(!portableCalendarInvitesEnabled()||!config||config.owner!==user.email.toLowerCase())return denied();
    const organizerIsCurrent=async()=>{
      const current=await requestIdentity(request.headers).catch(()=>null);
      return current?.userId===user.userId&&current.email.toLowerCase()===config.owner;
    };
    let raw:unknown=guest?{action:'invite',input:guest.input}:undefined;
    if(!guest)try{const text=await readBoundedRequestText(request,4096);if(text!==null)raw=JSON.parse(text);}catch{}
    const parsed=command.safeParse(raw);
    if(!parsed.success)return json({error:'Check the meeting details.'},400);
    const action=parsed.data,db=portableDb();
    if(action.action==='check'&&!await organizerIsCurrent())return denied();
    const existing=await findPortableMeeting(db,user.userId,action.action==='invite'?action.input.id:
      action.action==='reschedule'?action.input.meetingId:action.id);
    if(action.action==='invite'&&existing){
      return matchesInvite(existing,action.input)?json(meetingReceipt(existing)):
        json({error:'This request ID was already used with different meeting details.'},409);
    }
    if(action.action==='cancel'&&!portableCalendarCancellationsEnabled())return denied();
    if(action.action==='reschedule'&&!portableCalendarReschedulesEnabled())return denied();
    if(action.action!=='invite'&&!existing)return json({error:'Meeting not found.'},404);
    const activeChange=existing&&action.action!=='invite'?await findPendingPortableReschedule(db,existing):undefined;
    const changeReceipt=async (change:Change,status=200)=>{
      const meeting=await findPortableMeeting(db,user.userId,change.meetingId);
      return meeting?json(meetingReceipt(meeting,change),status):unavailable();
    };
    if(action.action==='reschedule'&&existing){
      const replay=await findPortableReschedule(db,existing.workspaceId,action.input.id);
      if(replay)return matchesReschedule(replay,action.input)?changeReceipt(replay):
        conflict('This change ID was already used with different meeting details.');
      if(activeChange)return conflict('A reschedule is unresolved. Check its outcome before another change.');
      if(existing.status!=='scheduled'||existing.rescheduleRevision!==action.input.revision||existing.start<=Date.now()){
        return conflict('Review the current future invitation before rescheduling.');
      }
      const now=Date.now();
      if(Date.parse(action.input.start)<=now||Date.parse(action.input.end)>now+366*86_400_000){
        return json({error:'Choose a future meeting within the next year.'},400);
      }
    }
    if(action.action==='cancel'&&existing){
      if(activeChange)return conflict('A reschedule is unresolved. Check its outcome before cancelling.');
      if(existing.status==='cancelled'||pendingCancellation(existing))return json(meetingReceipt(existing));
      if(existing.status!=='scheduled'||existing.start<=Date.now())return conflict('Only a future scheduled invitation can be cancelled.');
    }
    if(action.action==='check'&&existing){
      if(activeChange?.status==='submitting'&&Date.now()-activeChange.createdAt<60_000){
        return conflict('The reschedule may still be submitting. Check again in one minute.');
      }
      if(!activeChange&&(existing.status==='scheduled'||existing.status==='cancelled'||existing.status==='rejected'))return json(meetingReceipt(existing));
      if(existing.status==='cancelling'&&Date.now()-(existing.cancellationStartedAt??0)<60_000){
        return conflict('The cancellation may still be submitting. Check again in one minute.');
      }
      if(existing.status==='submitting'&&Date.now()-existing.createdAt<60_000){
        return json({error:'The invitation may still be submitting. Check again in one minute.'},409);
      }
    }
    if(action.action==='invite'){
      const {input}=action;
      const now=Date.now();
      if(Date.parse(input.start)<=now||Date.parse(input.end)>now+366*86_400_000){
        return json({error:'Choose a future meeting within the next year.'},400);
      }
      if(input.recipient===config.owner)return json({error:'Choose a contact address other than your own.'},400);
      const contact=await readContacts(db,user.userId,{id:input.contactId,limit:1});
      if(!contact||'records' in contact)return json({error:'Contact not found.'},404);
      if(contact.data.email?.trim().toLowerCase()!==input.recipient){
        return json({error:'The contact email changed. Reopen the contact before inviting.'},409);
      }
    }
    const guestAllowed=async()=>!guest||!!(await db.execute<{allowed:boolean}>(sql`SELECT (${guest.guard}) AS allowed`))[0]?.allowed;
    const guestChanged=()=>conflict('The request, availability link, or contact changed. Refresh and review it before sending.');
    if(!await guestAllowed())return guestChanged();
    if(guest){
      const current=await requestIdentity(request.headers);
      if(current?.userId!==user.userId||current.email.toLowerCase()!==config.owner)return denied();
    }
    const {deadline,fetcher}=boundedGoogleRead();
    readDeadline=deadline;
    const {accessToken}=await calendarTokens(config,{refreshToken:config.refreshToken},[CALENDAR_OWNED_SCOPE,...CALENDAR_AVAILABILITY_SCOPES],fetcher);
    const account=await calendarIdentity(accessToken,fetcher);
    if(account.email.toLowerCase()!==config.owner)return denied();
    if(action.action!=='invite'&&existing){
      if(action.action==='check'&&!await organizerIsCurrent())return denied();
      if(existing.accountId!==account.id)return conflict('Reconnect the original Google account for this invitation.');
      const event=await readMeeting(accessToken,existing.id,fetcher).catch(()=>{
        deadline.throwIfAborted();
        return null;
      });
      if(action.action==='check'&&!await organizerIsCurrent())return denied();
      if(action.action==='reschedule'){
        if(!event||!confirmsOriginalSlot(event,existing,config.owner)||!strongEventEtag(event.etag)){
          return conflict('The event changed in Google Calendar. Review it there before rescheduling.');
        }
        const originalEtag=event.etag;
        if(await calendarBusyExcept(accessToken,existing.id,action.input.start,action.input.end,fetcher)){
          return conflict('Your primary calendar is busy during this time.');
        }
        const current=await requestIdentity(request.headers);
        if(current?.userId!==user.userId||current.email.toLowerCase()!==config.owner)return denied();
        finishProviderChecks();
        const reservation=await reservePortableReschedule(db,existing,action.input,originalEtag);
        if(reservation.result==='existing')return matchesReschedule(reservation.change,action.input)?
          changeReceipt(reservation.change):conflict('This change ID was already used with different meeting details.');
        if(reservation.result==='guest_unavailable')return conflict('The contact address changed or is on the do-not-email list.');
        if(reservation.result==='overlap')return conflict('A Harbor invitation already covers this time. Check its outcome first.');
        if(reservation.result==='unchanged')return json({error:'Choose a different meeting time.'},400);
        if(reservation.result==='invalid_time')return json({error:'Choose a future meeting within the next year.'},400);
        if(reservation.result!=='reserved')return conflict('This invitation changed. Review it again.');
        const {change}=reservation;
        if(!await organizerIsCurrent()){
          await settlePortableReschedule(db,change,'rejected');
          return denied();
        }
        if(Math.min(existing.start,change.start)<=Date.now()){
          await settlePortableReschedule(db,change,'rejected');
          return conflict('The original or proposed time has passed. Review the invitation.');
        }
        const saved=await rescheduleCalendarMeeting(accessToken,existing.id,originalEtag,event,change.id,action.input).then(result=>
          confirmsReschedule(result,existing,change,config.owner)?
            settlePortableReschedule(db,change,'applied',safeEventUrl(result.htmlLink)||null):
            settlePortableReschedule(db,change,'attention'),
        error=>settlePortableReschedule(db,change,error instanceof CalendarError&&
          (error.code==='conflict'||error.code==='reauth')?'rejected':'attention'));
        return saved?changeReceipt(saved,202):unavailable();
      }
      if(action.action==='cancel'){
        if(!event)return conflict('Google did not confirm the original event. Review it in Google Calendar.');
        const alreadyCancelled=confirmsCancellation(event,existing);
        if(!alreadyCancelled&&(!strongEventEtag(event.etag)||!editableEvent(event,existing,config.owner))){
          return conflict('The event changed in Google Calendar. Review and cancel it there.');
        }
        const current=await requestIdentity(request.headers);
        if(current?.userId!==user.userId||current.email.toLowerCase()!==config.owner)return denied();
        finishProviderChecks();
        const claimed=await claimPortableCancellation(db,existing);
        if(!claimed){
          const replay=await findPortableMeeting(db,user.userId,existing.id);
          return replay&&(pendingCancellation(replay)||replay.status==='cancelled')?json(meetingReceipt(replay)):
            conflict('This invitation changed. Review it again.');
        }
        let cancelled=alreadyCancelled;
        if(!cancelled&&event.etag){
          if(!await organizerIsCurrent()){
            await abandonPortableCancellation(db,claimed);
            return denied();
          }
          try{
            await cancelCalendarMeeting(accessToken,claimed.id,event.etag);
            cancelled=true;
          }catch(error){
            if(error instanceof CalendarCancellationConflict){
              const restored=await abandonPortableCancellation(db,claimed);
              return restored?conflict(error.message):unavailable();
            }
          }
        }
        const saved=await settlePortableCancellation(db,claimed,cancelled?'cancelled':'cancel_attention');
        return saved?json(meetingReceipt(saved),202):unavailable();
      }
      finishProviderChecks();
      if(activeChange){
        if(event&&confirmsReschedule(event,existing,activeChange,config.owner)){
          const saved=await settlePortableReschedule(db,activeChange,'applied',safeEventUrl(event.htmlLink)||null);
          return saved?changeReceipt(saved):unavailable();
        }
        if(event&&existing.rescheduleRevision===activeChange.input.revision&&confirmsOriginalSlot(event,existing,config.owner)&&
          event.extendedProperties?.private?.harborChangeId!==activeChange.id&&strongEventEtag(event.etag)){
          if(!strongEventEtag(activeChange.originalEtag)){
            return conflict('Harbor has no saved Google event version for this reschedule. Both times remain held while the outcome is unclear.');
          }
          if(event.etag===activeChange.originalEtag){
            return conflict('Google still shows the original event version. If the original details are correct, you can save a small description change in Google Calendar, keeping the time, time zone, title and guest unchanged. Review any guest notification prompt, then check again in Harbor.');
          }
          // A newer provider version fences any delayed PATCH with the original If-Match.
          const saved=await settlePortableReschedule(db,activeChange,'not_applied');
          return saved?changeReceipt(saved):unavailable();
        }
        return conflict('Google did not confirm the reschedule. Review the event in Google Calendar. Both times remain held.');
      }
      if(pendingCancellation(existing)){
        if(!event||!confirmsCancellation(event,existing))return conflict('Google did not confirm cancellation. Review the event in Google Calendar.');
        const saved=await settlePortableCancellation(db,existing,'cancelled');
        return saved?json(meetingReceipt(saved)):unavailable();
      }
      if(!event||!matchesEvent(event,existing,config.owner)){
        return json({error:'Google did not confirm the original invitation. Review it in Google Calendar.'},409);
      }
      const saved=await settlePortableMeeting(db,existing,event.status==='cancelled'?'cancelled':'scheduled',safeEventUrl(event.htmlLink)||null);
      return saved?json(meetingReceipt(saved)):unavailable();
    }
    if(action.action!=='invite')return unavailable();
    const {input}=action;
    if((await calendarBusy(accessToken,input.start,input.end,fetcher)).length){
      return json({error:'Your primary calendar is busy during this time.'},409);
    }
    const current=await requestIdentity(request.headers);
    if(current?.userId!==user.userId||current.email.toLowerCase()!==config.owner)return denied();
    finishProviderChecks();
    const reservation=await reservePortableMeeting(db,user.userId,account.id,input,guest?.guard);
    if(reservation.result==='guest_changed')return guestChanged();
    if(reservation.result==='missing')return json({error:'Contact not found.'},404);
    if(reservation.result==='address_changed')return json({error:'The contact email changed. Reopen the contact before inviting.'},409);
    if(reservation.result==='blocked')return json({error:'This contact address is on the workspace do-not-email list.'},409);
    if(reservation.result==='overlap')return json({error:'A Harbor invitation already covers this time. Check its outcome first.'},409);
    if(reservation.result==='invalid_time')return json({error:'Choose a future meeting within the next year.'},400);
    const {row}=reservation;
    if(reservation.result==='existing'){
      return matchesInvite(row,input)?json(meetingReceipt(row)):
        json({error:'This request ID was already used with different meeting details.'},409);
    }
    if((guest&&!await guestAllowed())||!await organizerIsCurrent()){
      await settlePortableMeeting(db,row,'rejected');
      return guest?guestChanged():denied();
    }
    const saved=await insertMeeting(accessToken,{...input,description:'',location:'',attendees:[input.recipient]}).then(event=>{
      const confirmed=event.status!=='cancelled'&&matchesEvent(event,row,config.owner);
      return settlePortableMeeting(db,row,confirmed?'scheduled':'attention',confirmed?safeEventUrl(event.htmlLink)||null:null);
    },error=>settlePortableMeeting(db,row,error instanceof CalendarInsertRejected?'rejected':'attention'));
    return saved?json(meetingReceipt(saved),202):unavailable();
  }catch{
    if(readDeadline?.aborted)return json({code:'calendar_preflight_timeout',
      error:'Google Calendar took too long to check this request. Try the same request again.'},503);
    return unavailable();
  }
}
