import {GoogleConnectionError} from '../google-oauth-result';
import {googleRefreshFailure,readGoogleResponseJSON} from '../google-oauth-response';
import {z} from 'zod';
import {offsetDateTime} from '../iso-date-time';
import type {MeetingInput} from './model';
const accountEmailScope='https://www.googleapis.com/auth/userinfo.email';
export const CALENDAR_AVAILABILITY_SCOPES=['https://www.googleapis.com/auth/calendar.freebusy',accountEmailScope];
export const CALENDAR_OWNED_SCOPE='https://www.googleapis.com/auth/calendar.events.owned';
export const CALENDAR_SCOPES=[CALENDAR_OWNED_SCOPE,'https://www.googleapis.com/auth/calendar.events.freebusy',accountEmailScope];
export type CalendarConfig={clientId:string;clientSecret:string;redirectUri:string};
export type CalendarTokens={accessToken:string;refreshToken:string;expiresAt:number};
export class CalendarError extends Error{constructor(public code:'reauth'|'unavailable'|'unknown'|'rejected'|'missing'|'conflict',message:string){super(message);}}
const rejectedRequest='Google Calendar rejected the request. Check the connection and meeting details.';
export class CalendarInsertRejected extends CalendarError {
 constructor(){super('rejected',rejectedRequest);}
}
export class CalendarCancellationConflict extends CalendarError {
 constructor(message:string){super('conflict',message);}
}
const insertValidationError=z.object({error:z.object({code:z.literal(400),
 errors:z.array(z.union([
  z.object({domain:z.literal('global'),reason:z.enum(['required','invalid','badRequest'])}),
  z.object({domain:z.literal('calendar'),reason:z.literal('timeRangeEmpty')}),
 ])).min(1)})});
async function call(url:string,init:RequestInit,write:boolean|'insert'=false,fetcher:typeof fetch=fetch){let r:Response;try{r=await fetcher(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw new CalendarError(write?'unknown':'unavailable',write?'Calendar outcome unknown. Check status before creating another invitation.':'Google Calendar is temporarily unavailable.');}
 if(!r.ok){
  if(write==='insert'&&r.status===400){
   const payload=await readGoogleResponseJSON(r,4096).catch(()=>null);
   if(insertValidationError.safeParse(payload).success)throw new CalendarInsertRejected();
   throw new CalendarError('rejected',rejectedRequest);
  }
  const refresh=await googleRefreshFailure(init,r,'Google Calendar');
  if(refresh)throw new CalendarError(refresh.code,refresh.message);
  await r.body?.cancel();if(r.status===401)throw new CalendarError('reauth','Reconnect Google Calendar to continue.');if(r.status===412)throw new CalendarError('conflict','This event changed in Google Calendar. Review its current details before trying a new change.');if((r.status===404||r.status===410)&&(!write||init.method==='DELETE'))throw new CalendarError('missing',write?'The event was not found during cancellation. Review Google Calendar before trying another change.':'The event was not found. Absence does not prove an earlier invitation failed.');if(r.status>=500||write&&r.status===409)throw new CalendarError(write?'unknown':'unavailable','Google Calendar did not confirm the outcome. Check status before retrying.');throw new CalendarError('rejected',r.status===429?'Google Calendar rate limit reached. Try later.':'Google Calendar rejected the request. Check the connection and meeting details.');
 }
 if(r.status===204)return null;
 const reader=r.body?.getReader();if(!reader)throw new CalendarError(write?'unknown':'unavailable','Empty calendar response.');let size=0;const chunks:Uint8Array[]=[];try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>256000)throw Error('large');chunks.push(p.value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));}catch{await reader.cancel();throw new CalendarError(write?'unknown':'unavailable','Unreadable calendar response. Check status before retrying.');}finally{reader.releaseLock();}}
const auth=(token:string)=>({authorization:'Bearer '+token});
const tokenShape=z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),expires_in:z.number().positive(),scope:z.string().optional(),token_type:z.string()});
export function calendarAuthorization(c:CalendarConfig,state:string,challenge:string,scopes:readonly string[]=CALENDAR_SCOPES){const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();return u.toString();}
export async function calendarTokens(c:CalendarConfig,value:{code:string;verifier:string}|{refreshToken:string},requiredScopes:readonly string[]=CALENDAR_SCOPES,fetcher:typeof fetch=fetch):Promise<CalendarTokens>{const refreshing='refreshToken' in value;let raw;try{raw=await call('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,...(refreshing?{refresh_token:value.refreshToken,grant_type:'refresh_token'}:{code:value.code,code_verifier:value.verifier,redirect_uri:c.redirectUri,grant_type:'authorization_code'})})},false,fetcher);}catch(e){if(!refreshing&&e instanceof CalendarError&&e.code==='rejected')throw new CalendarError('reauth','Reconnect Google Calendar to continue.');throw e;}
 const t=tokenShape.parse(raw),refresh=t.refresh_token||(refreshing?value.refreshToken:'');if(t.token_type.toLowerCase()!=='bearer'||!refresh||(!refreshing||t.scope)&&!requiredScopes.every(s=>t.scope?.split(' ').includes(s)))throw refreshing?new CalendarError('reauth','Calendar, availability and account email permissions with offline access are required.'):new GoogleConnectionError('permissions','Calendar, availability and account email permissions with offline access are required.');return {accessToken:t.access_token,refreshToken:refresh,expiresAt:Date.now()+t.expires_in*1000};}
export async function calendarIdentity(token:string,fetcher:typeof fetch=fetch){return z.object({id:z.string().min(1).max(200),email:z.string().email().max(254),verified_email:z.literal(true)}).parse(await call('https://www.googleapis.com/oauth2/v2/userinfo',{headers:auth(token)},false,fetcher));}
export async function calendarBusy(token:string,start:string,end:string,fetcher:typeof fetch=fetch){const d=z.object({calendars:z.record(z.string(), z.object({busy:z.array(z.object({start:offsetDateTime,end:offsetDateTime})).max(1000).optional(),errors:z.array(z.unknown()).optional()}))}).parse(await call('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',headers:{...auth(token),'content-type':'application/json'},body:JSON.stringify({timeMin:start,timeMax:end,items:[{id:'primary'}]})},false,fetcher));const c=d.calendars.primary;if(!c||c.errors?.length||!c.busy)throw new CalendarError('unavailable','Availability could not be confirmed. Try again before scheduling.');return c.busy;}
const eventTime=z.object({dateTime:offsetDateTime.optional(),date:z.string().optional(),timeZone:z.string().optional()});
const eventShape=z.object({id:z.string(),status:z.enum(['confirmed','tentative','cancelled']),htmlLink:z.string().optional(),etag:z.string().max(200).optional(),summary:z.string().max(1000).optional(),organizer:z.object({email:z.string().email(),self:z.boolean().optional()}).optional(),attendees:z.array(z.object({email:z.string().email().max(254)})).max(1000).optional(),attendeesOmitted:z.boolean().optional(),recurrence:z.array(z.string()).optional(),recurringEventId:z.string().optional(),eventType:z.string().optional(),extendedProperties:z.object({private:z.record(z.string(), z.string()).optional(),shared:z.record(z.string(), z.string()).optional()}).optional(),start:eventTime.optional(),end:eventTime.optional()});
export type CalendarEvent=z.infer<typeof eventShape>;
export function providerEventId(id:string){return id.replaceAll('-','');}
export async function insertMeeting(token:string,v:Pick<MeetingInput,'id'|'title'|'description'|'location'|'start'|'end'|'timeZone'|'attendees'>){const raw=await call('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',{method:'POST',headers:{...auth(token),'content-type':'application/json'},body:JSON.stringify({id:providerEventId(v.id),summary:v.title,description:v.description,location:v.location,start:{dateTime:v.start,timeZone:v.timeZone},end:{dateTime:v.end,timeZone:v.timeZone},attendees:v.attendees.map(email=>({email})),extendedProperties:{private:{harborMeetingId:v.id}},guestsCanModify:false})},'insert');const parsed=eventShape.safeParse(raw);if(!parsed.success)throw new CalendarError('unknown','Google returned an unreadable invitation receipt. Check status before retrying.');return parsed.data;}
export async function readMeeting(token:string,id:string,fetcher:typeof fetch=fetch){return eventShape.parse(await call('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+providerEventId(id),{headers:auth(token),cache:'no-store'},false,fetcher));}
export async function revokeCalendar(token:string){const r=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});await r.body?.cancel();return r.ok;}
export function safeEventUrl(value:string|undefined){try{const u=new URL(value||'');return u.protocol==='https:'&&u.hostname==='www.google.com'&&u.pathname.startsWith('/calendar/')||u.protocol==='https:'&&u.hostname==='calendar.google.com'?u.href:'';}catch{return '';}}

// Keep unrelated provider fields intact: only the interval and our receipt marker change.
// PATCH costs more quota than PUT, but avoids copying/replacing Google-only event fields.
export async function rescheduleCalendarMeeting(token:string,id:string,etag:string,event:CalendarEvent,changeId:string,v:{start:string;end:string;timeZone:string}){
 const raw=await call('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+providerEventId(id)+'?sendUpdates=all',{method:'PATCH',headers:{...auth(token),'content-type':'application/json','if-match':etag},body:JSON.stringify({start:{dateTime:v.start,timeZone:v.timeZone},end:{dateTime:v.end,timeZone:v.timeZone},extendedProperties:{...event.extendedProperties,private:{...event.extendedProperties?.private,harborChangeId:changeId}}})},true);
 const parsed=eventShape.safeParse(raw);if(!parsed.success)throw new CalendarError('unknown','Google returned an unreadable change receipt. Check the change outcome before trying another.');return parsed.data;
}
export async function cancelCalendarMeeting(token:string,id:string,etag:string){
 try{await call('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+providerEventId(id)+'?sendUpdates=all',{method:'DELETE',headers:{...auth(token),'if-match':etag}},true);}
 catch(error){
  if(error instanceof CalendarError&&error.code==='conflict')throw new CalendarCancellationConflict(error.message);
  if(!(error instanceof CalendarError)||error.code!=='missing')throw error;
  // A 404 can mean lost access. Only an explicit tombstone confirms cancellation.
  let event:CalendarEvent;try{event=await readMeeting(token,id);}catch(checkError){if(checkError instanceof CalendarError&&checkError.code==='missing')throw error;throw checkError;}
  if(event.id!==providerEventId(id)||event.status!=='cancelled')throw error;
 }
}
// freeBusy merges overlapping intervals, so subtracting this meeting could hide another.
// Inspect at most 1000 minimal event summaries and never assume a partial scan is free.
export async function calendarBusyExcept(token:string,id:string,start:string,end:string,fetcher:typeof fetch=fetch){
 let pageToken:string|undefined;
 for(let page=0;page<4;page++){
  const q=new URLSearchParams({timeMin:start,timeMax:end,timeZone:'UTC',singleEvents:'true',showDeleted:'false',maxResults:'250',fields:'items(id,status,transparency,start,end),nextPageToken',...(pageToken?{pageToken}:{})});
  const d=z.object({items:z.array(z.object({id:z.string(),status:z.string(),transparency:z.string().optional(),start:eventTime.optional(),end:eventTime.optional()})).max(250).default([]),nextPageToken:z.string().max(2000).optional()}).parse(await call('https://www.googleapis.com/calendar/v3/calendars/primary/events?'+q,{headers:auth(token)},false,fetcher));
  for(const e of d.items){
   if(e.id===providerEventId(id)||e.status==='cancelled'||e.transparency==='transparent')continue;
   if(!e.start?.dateTime||!e.end?.dateTime||Date.parse(e.end.dateTime)<=Date.parse(e.start.dateTime))return true;
   if(Date.parse(e.start.dateTime)<Date.parse(end)&&Date.parse(e.end.dateTime)>Date.parse(start))return true;
  }
  if(!d.nextPageToken)return false;pageToken=d.nextPageToken;
 }
 throw new CalendarError('unavailable','Availability exceeded the safe page limit. Narrow the time window or manage this meeting in Google Calendar.');
}
