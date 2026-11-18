import {z} from 'zod';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {ApiError} from '../lib/api-error';
import type {OutlookItem,OutlookRecordProvider} from '../lib/outlook-records';

const base='https://graph.microsoft.com';
const mailPath='/v1.0/me/mailFolders/inbox/messages',calendarPath='/v1.0/me/calendar/calendarView';
const pageSize=25,pageLimit=3;
const address=z.object({emailAddress:z.object({address:z.email().max(320).transform(value=>value.toLowerCase())})});
const addresses=z.array(address).max(75);
const text=z.string().max(4096).transform(value=>value.replace(/[\u0000-\u001f\u007f]/g,' ').trim());
const identity={id:z.string().min(1).max(2048),subject:text};
const mail=z.object({...identity,'@odata.type':z.literal('#microsoft.graph.message').optional(),isDraft:z.literal(false),
  receivedDateTime:z.iso.datetime({offset:true}),from:address,sender:address,toRecipients:addresses,ccRecipients:addresses,
  bccRecipients:addresses,bodyPreview:text.optional()});
const who=(value:z.infer<typeof address>)=>value.emailAddress.address;
const response=z.object({response:z.string()});
const utc=z.object({timeZone:z.literal('UTC'),dateTime:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z?$/)
  .transform(value=>Date.parse(value.endsWith('Z')?value:value+'Z')).refine(Number.isFinite)});
const meeting=z.object({...identity,isCancelled:z.literal(false),isAllDay:z.literal(false),sensitivity:z.literal('normal'),
  hideAttendees:z.literal(false),type:z.enum(['singleInstance','occurrence','exception']),responseStatus:response,isOrganizer:z.boolean(),
  start:utc,end:utc,organizer:address,attendees:z.array(address.extend({status:response,type:z.enum(['required','optional','resource'])})).min(1).max(75)});
type Range={start:number;end:number};

export function normalizeOutlookItem(provider:OutlookRecordProvider,raw:unknown,contact:string,mailbox:string,range:Range):OutlookItem|null{
  if(contact===mailbox)return null;
  if(provider==='outlook-mail'){
    const result=mail.safeParse(raw);
    if(!result.success)return null;
    const item=result.data,occurredAt=Date.parse(item.receivedDateTime);
    if(who(item.from)!==contact||who(item.sender)!==contact||occurredAt<range.start||occurredAt>=range.end)return null;
    const participants=[item.from,item.sender,...item.toRecipients,...item.ccRecipients,...item.bccRecipients].map(who);
    return {id:item.id,subject:item.subject.slice(0,400)||'(No subject)',occurredAt,participants:[...new Set(participants)].sort(),
      excerpt:item.bodyPreview?.slice(0,240)};
  }
  const result=meeting.safeParse(raw);
  if(!result.success)return null;
  const item=result.data,organizer=who(item.organizer),ended=item.end.dateTime;
  if(item.start.dateTime>=ended||ended<range.start||ended>=range.end||
    !(item.isOrganizer?organizer===mailbox&&['organizer','none','accepted'].includes(item.responseStatus.response):
      organizer!==mailbox&&item.responseStatus.response==='accepted'))return null;
  const contactAttendees=item.attendees.filter(attendee=>who(attendee)===contact);
  if(organizer!==contact&&(contactAttendees.length!==1||contactAttendees[0].type==='resource'||contactAttendees[0].status.response!=='accepted'))return null;
  return {id:item.id,subject:item.subject.slice(0,400)||'(Untitled meeting)',occurredAt:ended,
    participants:[...new Set([organizer,...item.attendees.map(who)])].sort()};
}

export async function readOutlookItems(provider:OutlookRecordProvider,token:string,contact:string,mailbox:string,range:Range,
  signal:AbortSignal,assertCurrent:()=>Promise<void>,fetcher:typeof fetch=fetch){
  const isMail=provider==='outlook-mail',path=isMail?mailPath:calendarPath;
  const first=new URL(path,base),start=new Date(range.start).toISOString(),end=new Date(range.end).toISOString();
  first.searchParams.set('$top',String(pageSize));
  if(isMail){
    first.searchParams.set('$select','id,subject,from,sender,receivedDateTime,isDraft,toRecipients,ccRecipients,bccRecipients,bodyPreview');
    first.searchParams.set('$filter',`receivedDateTime ge ${start} and receivedDateTime lt ${end} and from/emailAddress/address eq '${contact.replaceAll("'","''")}'`);
    first.searchParams.set('$orderby','receivedDateTime desc');
  }else{
    first.searchParams.set('$select','id,subject,type,isCancelled,isAllDay,isOrganizer,hideAttendees,sensitivity,organizer,attendees,responseStatus,start,end');
    first.searchParams.set('startDateTime',start);first.searchParams.set('endDateTime',end);
  }
  let url=first;
  const seen=new Set<string>(),items=new Map<string,OutlookItem>();
  for(let page=0;page<pageLimit;page++){
    await assertCurrent();
    seen.add(url.href);
    const result=await fetcher(url,{method:'GET',redirect:'error',cache:'no-store',signal,
      headers:{authorization:'Bearer '+token,prefer:'IdType="ImmutableId", outlook.timezone="UTC"'}});
    if(!result.ok){
      void result.body?.cancel().catch(()=>{});
      if(result.status===401||result.status===403)throw new ApiError(409,'Reconnect this Outlook connection in Settings and check its permissions.');
      if(result.status===429)throw new ApiError(429,'Outlook is busy. Wait a moment before searching again.');
      throw new ApiError(503,'Outlook could not complete this lookup. Try again.');
    }
    const raw=await readBoundedRequestText(result,512*1024);
    if(raw===null)throw new ApiError(422,'This Outlook response is too large. Try a one-day search.');
    const data=z.object({value:z.array(z.unknown()).max(pageSize),'@odata.nextLink':z.string().max(8192).optional()}).parse(JSON.parse(raw));
    for(const row of data.value){
      const item=normalizeOutlookItem(provider,row,contact,mailbox,range);
      if(item)items.set(item.id,item);
    }
    const next=data['@odata.nextLink'];
    if(!next)return {items:[...items.values()],limited:false};
    if(page+1===pageLimit)break;
    const continuation=new URL(next);
    if(continuation.origin!==base||continuation.username||continuation.password||continuation.hash||
      continuation.pathname.toLowerCase()!==path.toLowerCase()||seen.has(continuation.href)){
      throw new ApiError(503,'Outlook returned an invalid next page. Start a new search.');
    }
    url=continuation;
  }
  return {items:[...items.values()],limited:true};
}
