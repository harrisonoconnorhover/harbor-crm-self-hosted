'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Portable CRM uses document navigation. */

import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {listPortableMeetings,meetingReceipt} from '../db/postgres/portable-meeting-store';
import type {PortableInvite,PortableReschedule} from '../lib/calendar/portable-meetings';
import {scheduledInstants} from '../lib/email/schedule';

type Receipt=ReturnType<typeof meetingReceipt>;
type Page=Awaited<ReturnType<typeof listPortableMeetings>>;
const endpoint='/api/calendar/meetings';
const statusLabels={submitting:'Submitting',attention:'Needs attention',scheduled:'Scheduled',cancelling:'Cancelling',cancel_attention:'Cancellation needs attention',cancelled:'Cancelled',rejected:'Invitation not sent'};
const changeLabels={submitting:'Rescheduling',attention:'Reschedule needs attention',applied:'Rescheduled',rejected:'Google did not apply the reschedule'};
const format=(at:string,timeZone:string)=>new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone}).format(new Date(at));

type ChangeRequest={action:'check'|'cancel';id:string}|{action:'reschedule';input:PortableReschedule};
class MeetingRequestRejected extends Error {}
async function meetingRequest(body:{action:'invite';input:PortableInvite}|ChangeRequest){
  // Allow for provider checks, a write, and the cancellation readback.
  const signal=AbortSignal.timeout(50_000);
  try{
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    const data=await response.json() as Receipt&{code?:string;error?:string};
    const beforeDispatch=response.status===503&&data?.code==='calendar_preflight_timeout';
    if((beforeDispatch||response.status>=400&&response.status<500)&&typeof data?.error==='string')
      throw new MeetingRequestRejected(data.error);
    if(!response.ok)throw Error(data?.error||'Could not confirm the Calendar request.');
    return data;
  }catch(error){
    if(signal.aborted)throw Error('Harbor could not confirm the Calendar request. Try the same request again or check the invitation.');
    throw error;
  }
}

export function PortableMeetingInvite({contactId,recipient}:{contactId:string;recipient:string}){
  const sending=useRef(false);
  const [draft,setDraft]=useState<{title:string;local:string;duration:string}>();
  const [review,setReview]=useState<PortableInvite>();
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [error,setError]=useState('');
  const [receipt,setReceipt]=useState<Receipt>();
  function prepare(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const fields=new FormData(event.currentTarget),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local=String(fields.get('start')||''),title=String(fields.get('title')||'').trim(),duration=String(fields.get('duration'));
    const times=scheduledInstants(local,timeZone);
    if(times.length!==1||Date.parse(times[0])<=Date.now()){
      setError('Choose an unambiguous future time in your browser time zone.');
      return;
    }
    const [start]=times,end=new Date(Date.parse(start)+Number(duration)*60_000).toISOString();
    setError('');
    setDraft({local,title,duration});
    setReview({id:crypto.randomUUID(),contactId,recipient,title,start,end,timeZone});
  }
  async function send(){
    if(!review||sending.current)return;
    sending.current=true;
    setBusy(true);
    setError('');
    try{
      const result=await meetingRequest({action:'invite',input:review});
      if(result?.id!==review.id||!Object.hasOwn(statusLabels,result.status))throw Error('Invitation receipt unavailable.');
      setReceipt(result);
      setUncertain(false);
    }catch(error){
      if(!uncertain&&error instanceof MeetingRequestRejected)setError(error.message);
      else{
        setUncertain(true);
        setError('The invitation may already have been sent. Retry the same invitation or check Calendar.');
      }
    }
    finally{sending.current=false;setBusy(false);}
  }
  return <section aria-label="Meeting invitation">
    <h2>Meeting invitation</h2>
    {receipt?<div><p role="status">{statusLabels[receipt.status]} · <a href="/?view=calendar">View Calendar</a></p>
      {receipt.status==='rejected'&&<button type="button" onClick={()=>{setReceipt(undefined);setReview(undefined);}}>Edit invitation</button>}</div>:
      review?<div>
        <p><strong>{review.title}</strong> · {review.recipient}</p>
        <p>{format(review.start,review.timeZone)} to {format(review.end,review.timeZone)} ({review.timeZone})</p>
        <p>Google Calendar will notify this guest.</p>
        <button type="button" disabled={busy} onClick={()=>void send()}>{busy?'Sending…':uncertain?'Retry same invitation':'Send invitation'}</button>{' '}
        <button type="button" disabled={busy||uncertain} onClick={()=>{setReview(undefined);setError('');}}>Edit details</button>
      </div>:
      <form onSubmit={prepare}>
        <p>Guest {recipient}</p>
        <fieldset>
          <label>Meeting title<input name="title" maxLength={200} required defaultValue={draft?.title}/></label>
          <label>Start time in your browser time zone<input name="start" type="datetime-local" defaultValue={draft?.local} required/></label>
          <label>Duration<select name="duration" defaultValue={draft?.duration??"30"}>
            {[15,30,45,60,90,120].map(value=><option key={value} value={value}>{value} minutes</option>)}
          </select></label>
        </fieldset>
        <button type="submit">Review invitation</button>
      </form>}
    {error&&<p role="alert">{error} <a href="/?view=calendar">View Calendar</a></p>}
  </section>;
}

export function PortableMeetingHistory({page,cancellationsEnabled,reschedulesEnabled}:{page:Page;cancellationsEnabled:boolean;reschedulesEnabled:boolean}){
  const router=useRouter();
  const pending=useRef(false);
  const [busy,setBusy]=useState(false);
  const [review,setReview]=useState<string>();
  const [rescheduleId,setRescheduleId]=useState<string>();
  const [reschedule,setReschedule]=useState<PortableReschedule>();
  const [notice,setNotice]=useState<{text:string;error:boolean}>();
  function reviewReschedule(event:FormEvent<HTMLFormElement>,item:Receipt){
    event.preventDefault();
    const fields=new FormData(event.currentTarget),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const times=scheduledInstants(String(fields.get('start')||''),timeZone),minutes=Number(fields.get('duration'));
    if(times.length!==1||Date.parse(times[0])<=Date.now()||!Number.isInteger(minutes)||minutes<1||minutes>1440){
      setNotice({text:'Choose an unambiguous future time and a duration of at most 24 hours.',error:true});
      return;
    }
    const [start]=times,end=new Date(Date.parse(start)+minutes*60_000).toISOString();
    setReschedule({id:crypto.randomUUID(),meetingId:item.id,revision:item.revision,start,end,timeZone});
    setNotice(undefined);
  }
  async function update(request:ChangeRequest){
    if(pending.current)return;
    pending.current=true;
    setBusy(true);
    setNotice(undefined);
    try{
      const receipt=await meetingRequest(request);
      setReview(undefined);
      setRescheduleId(undefined);
      setReschedule(undefined);
      setNotice({text:receipt.reschedule?changeLabels[receipt.reschedule.status]:statusLabels[receipt.status],error:false});
      router.refresh();
    }catch(error){setNotice({text:error instanceof Error?error.message:'Could not check this invitation.',error:true});}
    finally{pending.current=false;setBusy(false);}
  }
  return <section aria-label="Calendar invitations">
    <h2>Invitations</h2>
    <nav aria-label="Invitation status">
      <a href="/?view=calendar" aria-current={page.needsReview?undefined:'page'}>All invitations</a>{' · '}
      <a href="/?view=calendar&amp;filter=needs_review" aria-current={page.needsReview?'page':undefined}>Needs review</a>
    </nav>
    {notice&&<p role={notice.error?'alert':'status'}>{notice.text}</p>}
    {page.items.length?<ul>{page.items.map(item=><li key={item.id}>
      <strong>{item.title}</strong> · {item.recipient} · {item.reschedule?changeLabels[item.reschedule.status]:statusLabels[item.status]}
      <p>{format(item.start,item.timeZone)} · <a href={'/?contact='+item.contactId}>Open contact</a>
        {item.eventUrl&&<> · <a href={item.eventUrl}>Open in Google Calendar</a></>}</p>
      {(item.status==='attention'||item.status==='submitting')&&
        <button type="button" disabled={busy} onClick={()=>void update({action:'check',id:item.id})}>Check invitation</button>}
      {(item.status==='cancelling'||item.status==='cancel_attention')&&
        <button type="button" disabled={busy} onClick={()=>void update({action:'check',id:item.id})}>Check cancellation</button>}
      {item.reschedule&&<>
        <p>Proposed time {format(item.reschedule.start,item.reschedule.timeZone)}</p>
        <p>Harbor holds both times while the outcome is unclear. Checking reads the event in Google Calendar.</p>
        <button type="button" disabled={busy} onClick={()=>void update({action:'check',id:item.id})}>Check reschedule</button>
      </>}
      {reschedulesEnabled&&item.canReschedule&&(rescheduleId===item.id?(reschedule?<div>
        <p>{format(reschedule.start,reschedule.timeZone)} to {format(reschedule.end,reschedule.timeZone)} ({reschedule.timeZone})</p>
        <p>Google Calendar will notify {item.recipient} of this new time.</p>
        <button type="button" disabled={busy} onClick={()=>void update({action:'reschedule',input:reschedule})}>Confirm reschedule</button>{' '}
        <button type="button" disabled={busy} onClick={()=>{setReschedule(undefined);setRescheduleId(undefined);}}>Keep meeting</button>
      </div>:<form onSubmit={event=>reviewReschedule(event,item)}>
        <label>New start time in your browser time zone <input name="start" type="datetime-local" required/></label>
        <label>Duration in minutes <input name="duration" type="number" min="1" max="1440" step="1"
          defaultValue={Math.round((Date.parse(item.end)-Date.parse(item.start))/60_000)} required/></label>
        <button type="submit" disabled={busy}>Review reschedule</button>{' '}
        <button type="button" disabled={busy} onClick={()=>setRescheduleId(undefined)}>Keep meeting</button>
      </form>):<button type="button" disabled={busy||!!rescheduleId||!!review} onClick={()=>{setRescheduleId(item.id);setNotice(undefined);}}>Reschedule meeting</button>)}
      {cancellationsEnabled&&item.canCancel&&rescheduleId!==item.id&&(review===item.id?<div>
        <p>Cancel this meeting and notify {item.recipient}?</p>
        <button type="button" disabled={busy} onClick={()=>void update({action:'cancel',id:item.id})}>Confirm cancellation</button>{' '}
        <button type="button" disabled={busy} onClick={()=>setReview(undefined)}>Keep meeting</button>
      </div>:<button type="button" disabled={busy||!!rescheduleId||!!review} onClick={()=>{setReview(item.id);setNotice(undefined);}}>Cancel meeting</button>)}
    </li>)}</ul>:<p>{page.needsReview?'No invitations need review on this page.':'No invitations on this page.'}</p>}
    {page.next&&<a href={'/?'+new URLSearchParams({view:'calendar',...(page.needsReview?{filter:'needs_review'}:{}),afterAt:String(page.next.at),afterId:page.next.id})}>Older invitations</a>}
  </section>;
}
