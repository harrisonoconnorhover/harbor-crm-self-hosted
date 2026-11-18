'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {AvailabilityPageInput,AvailabilityState,VerifiedBookingCursor} from '@/lib/calendar/published-availability';
import type {GuestInvitationStatus} from '@/lib/calendar/guest-invitation';
import type {GuestBookingSummary} from '@/lib/calendar/guest-booking';
import type {CalendarSuggestions} from '@/lib/calendar/suggestions';

const endpoint='/api/calendar/availability-page';
type Suggestions={value:CalendarSuggestions;timeZone:string};
type State=AvailabilityState&{enabled:boolean;verifiedRequests?:GuestBookingSummary[];
  guestInvitesEnabled?:boolean;nextVerifiedRequests?:VerifiedBookingCursor|null};

async function readSharingState({signal,cursor}:{signal?:AbortSignal;cursor?:VerifiedBookingCursor}={}){
  const deadline=AbortSignal.timeout(20_000);
  const url=cursor?endpoint+'?'+new URLSearchParams({pageId:cursor.pageId,afterId:cursor.afterId}):endpoint;
  const response=await fetch(url,{cache:'no-store',signal:signal?AbortSignal.any([signal,deadline]):deadline});
  if(!response.ok)throw Error('Could not check the shared page.');
  const state=await response.json() as State;
  if(typeof state?.enabled!=='boolean'||(cursor&&state.page?.id!==cursor.pageId))throw Error('Could not check the shared page.');
  return state;
}

export function CalendarAvailabilitySharing({result}:{result:Suggestions|null}){
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [viewingOlderRequests,setViewingOlderRequests]=useState(false);
  const [selected,setSelected]=useState<string[]>([]),[title,setTitle]=useState('Meeting availability');
  const [allowGuestProof,setAllowGuestProof]=useState(false);
  const pending=useRef<{key:string;id:string}|null>(null);
  const active=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    void readSharingState({signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted)setState(value);
    }).catch(()=>{
      if(!controller.signal.aborted)setError('Could not load the shared page.');
    });
    return ()=>controller.abort();
  },[]);
  async function refresh(cursor?:VerifiedBookingCursor){
    if(active.current)return;
    active.current=true;setBusy(true);setError('');
    try{
      setState(await readSharingState({cursor}));
      setViewingOlderRequests(Boolean(cursor));
    }
    catch{setError('Could not reload the shared page.');}
    finally{active.current=false;setBusy(false);}
  }
  async function confirmGuest(pageId:string,requestId:string){
    if(active.current)return;
    active.current=true;setBusy(true);setError('');
    try{
      const response=await fetch('/api/calendar/guest-invitations',{method:'POST',signal:AbortSignal.timeout(55_000),
        headers:{'content-type':'application/json'},body:JSON.stringify({pageId,requestId})});
      const invitation=await response.json() as GuestInvitationStatus&{error?:string};
      if(!response.ok)throw Error(invitation.error||'Check Calendar before trying this invitation again.');
      setState(current=>current?.page?.id===pageId?{...current,verifiedRequests:current.verifiedRequests?.map(
        guest=>guest.id===requestId?{...guest,invitation}:guest,
      )}:current);
    }catch(e){
      setError(e instanceof Error?e.message:'Check Calendar before trying this invitation again.');
    }finally{active.current=false;setBusy(false);}
  }
  async function save(input:AvailabilityPageInput){
    if(active.current)return;
    active.current=true;setBusy(true);setError('');
    try{
      const response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(20_000),
        headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const value=await response.json() as State&{error?:string};
      if(!response.ok)throw Error(value.error||'Could not confirm the shared page.');
      setState({...value,verifiedRequests:state?.verifiedRequests&&[],guestInvitesEnabled:state?.guestInvitesEnabled,
        nextVerifiedRequests:undefined});
      setViewingOlderRequests(false);
      pending.current=null;setSelected([]);
    }catch(e){
      setError(e instanceof Error?e.message:'Could not confirm the shared page.');
    }finally{active.current=false;setBusy(false);}
  }
  const timeZone=result?.timeZone;
  const format=new Intl.DateTimeFormat(undefined,{
    timeZone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'shortOffset',
  });
  const suggested=result?.value.slots??[];
  const publishThrough=Date.parse(result?.value.checkedAt??'')+14*86_400_000;
  const slots=suggested.filter(slot=>Date.parse(slot.end)<=publishThrough);
  const plainTimes=suggested.length>0&&<ul>{suggested.map(({start,end})=>
    <li key={start}>{format.formatRange(new Date(start),new Date(end))}</li>)}</ul>;
  const reload=error&&<p role="alert">{error}{' '}
    <button type="button" disabled={busy} onClick={()=>void refresh()}>
      Reload shared page
    </button>
  </p>;
  if(!state?.enabled)return <>{plainTimes}{reload}</>;
  const chosen=slots.filter(slot=>selected.includes(slot.start));
  const {page,revision,nextVerifiedRequests}=state;
  const proofOffered=state.verifiedRequests!==undefined;
  function publish(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!timeZone||!chosen.length||active.current)return;
    const payload={action:'publish' as const,previousId:revision,title,timeZone,slots:chosen,allowGuestProof:proofOffered&&allowGuestProof};
    const key=JSON.stringify(payload);
    if(pending.current?.key!==key)pending.current={key,id:crypto.randomUUID()};
    void save({...payload,id:pending.current.id});
  }
  return <>
    {slots.length<suggested.length&&plainTimes}
    <section aria-label="Share meeting times">
      <h3>Share meeting times</h3>
      <p>Anyone with the link can see the selected times and title. Choose times within the next 14 days.</p>
      {page&&<p><a href={'/availability/'+page.id} target="_blank" rel="noreferrer">Open shared page</a>{' '}
        <button type="button" disabled={busy} onClick={()=>void save({action:'unpublish',id:page.id})}>Unpublish page</button>
      </p>}
      {page?.allowGuestProof&&state.verifiedRequests&&<div>
        <h4>Verified meeting requests</h4>
        {state.verifiedRequests.length?<ul>{state.verifiedRequests.map(request=><li key={request.id}>
          {request.email} · {new Intl.DateTimeFormat(undefined,{timeZone:page.timeZone,dateStyle:'medium',timeStyle:'short'})
            .formatRange(new Date(request.start),new Date(request.end))}
          {' '}{request.invitation?<GuestInvitationReceipt invitation={request.invitation}/>:state.guestInvitesEnabled&&
            <button type="button" disabled={busy} aria-label={'Send Calendar invitation to '+request.email}
              onClick={()=>void confirmGuest(page.id,request.id)}>Send invitation</button>}
        </li>)}</ul>:<p>No verified requests for this link.</p>}
        <button type="button" disabled={busy} onClick={()=>void refresh()}>
          {viewingOlderRequests?'Newest requests':'Refresh requests'}
        </button>
        {nextVerifiedRequests?.pageId===page.id&&<>{' '}
          <button type="button" disabled={busy} onClick={()=>void refresh(nextVerifiedRequests)}>Older requests</button>
        </>}
      </div>}
      {slots.length>0&&<form onSubmit={publish}>
        <fieldset disabled={busy}>
          <legend>Choose up to 12 times</legend>
          <label className="form-field">Public page title <input value={title} maxLength={100} required
            onChange={event=>setTitle(event.target.value)}/></label>
          {proofOffered&&<label><input type="checkbox" checked={allowGuestProof}
            onChange={event=>setAllowGuestProof(event.target.checked)}/> Let guests request a time and verify by email</label>}
          <ul>{slots.map(({start,end})=>{
            const checked=selected.includes(start);
            return <li key={start}><label>
              <input type="checkbox" checked={checked} disabled={!checked&&chosen.length>=12}
                onChange={()=>setSelected(checked?selected.filter(time=>time!==start):[...chosen.map(slot=>slot.start),start])}/>
              {' '}{format.formatRange(new Date(start),new Date(end))}
            </label></li>;
          })}</ul>
        </fieldset>
        {page&&<p>Publishing these times replaces the current link.</p>}
        <button disabled={busy||!chosen.length}>{page?'Replace link':'Publish link'}</button>
      </form>}
      {reload}
    </section>
  </>;
}


function GuestInvitationReceipt({invitation}:{invitation:GuestInvitationStatus}){
  const {status,eventUrl}=invitation;
  if(status==='scheduled')return eventUrl?<a href={eventUrl} target="_blank" rel="noreferrer">Scheduled in Google Calendar</a>:'Scheduled';
  if(status==='cancelled')return 'Cancelled';
  if(status==='failed'||status==='rejected')return 'Invitation failed';
  return 'Check this invitation’s outcome in Calendar.';
}
