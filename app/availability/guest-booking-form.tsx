'use client';

import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {BookingStatus} from '../booking-status/booking-status';
import type {GuestBookingInput} from '@/lib/calendar/guest-booking';
import {guestProofMinutes,guestProofWindow} from '@/lib/calendar/guest-proof-window';
import './guest-booking.css';

const requestIdShape=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const rejectedBeforeRequest=new Set([400,403,404,409,413,429]);

export function AvailabilityCard({children}:{children:ReactNode}){
  return <main className="lead-form-page"><section className="lead-form-card">{children}</section></main>;
}

export function GuestBookingForm({id,slots,refreshAlternatives}:{id:string;slots:{start:string;label:string}[];refreshAlternatives?:()=>void}){
  const [stage,setStage]=useState<'request'|'verify'|'done'>('request');
  const [replacement,setReplacement]=useState<{code:string;unavailable:string[]}|null>(null);
  const [requestId,setRequestId]=useState('');
  const [receipt,setReceipt]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const attempt=useRef<{requestId:string;email:string;start:string}|null>(null);
  const submitting=useRef(false);
  const storageKey='harbor:guest-booking:'+id;
  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{
      if(!active||attempt.current)return;
      try{
        const saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');
        const now=Date.now();
        if(typeof saved?.requestId==='string'&&requestIdShape.test(saved.requestId)&&
          Number.isSafeInteger(saved.expiresAt)&&saved.expiresAt>now&&saved.expiresAt<=now+guestProofWindow){
          setRequestId(saved.requestId);setStage('verify');
        }else sessionStorage.removeItem(storageKey);
      }catch{/* The current page still works when browser storage is unavailable. */}
    });
    return ()=>{active=false;};
  },[storageKey]);

  function clearAttempt(){
    setReplacement(null);attempt.current=null;
    setRequestId('');
    try{sessionStorage.removeItem(storageKey);}catch{/* Browser storage may be blocked. */}
  }

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(submitting.current||stage==='done')return;
    const fields=new FormData(event.currentTarget);
    let input:GuestBookingInput & {alternativeStart?:string};
    let newAttempt=false;
    if(stage==='request'){
      const email=String(fields.get('email')),start=String(fields.get('start'));
      if(attempt.current?.email!==email||attempt.current.start!==start){
        attempt.current={requestId:crypto.randomUUID(),email,start};
        newAttempt=true;
        setRequestId(attempt.current.requestId);
        // Retain only the ID and a local deadline, even if the email reply is lost.
        const expiresAt=Math.min(Date.now()+guestProofWindow,Date.parse(start));
        try{sessionStorage.setItem(storageKey,JSON.stringify({requestId:attempt.current.requestId,expiresAt}));}catch{/* In-page retries still work. */}
      }
      input={action:'request',...attempt.current};
    }else{
      if(!requestId)return;
      input=replacement?{action:'verify',requestId,code:replacement.code,alternativeStart:String(fields.get('alternativeStart'))}
        :{action:'verify',requestId,code:String(fields.get('code')).trim()};
    }
    submitting.current=true;setBusy(true);setError('');
    try{
      const response=await fetch('/api/public/availability/'+id,{method:'POST',credentials:'omit',
        headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30_000)});
      if(newAttempt&&rejectedBeforeRequest.has(response.status))clearAttempt();
      const result=await response.json() as {error?:string;accepted?:boolean;verified?:boolean;receipt?:string};
      if(response.status===409&&input.action==='verify'&&refreshAlternatives){
        const lost=input.alternativeStart??attempt.current?.start;
        setReplacement({code:input.code,unavailable:[...new Set([...(replacement?.unavailable??[]),...(lost?[lost]:[])])]});
        refreshAlternatives();
        throw Error('That time was taken. Choose another opening with the same verification code.');
      }
      if(!response.ok||!(input.action==='request'?result.accepted:result.verified&&result.receipt)){
        throw Error(result.error||'Could not confirm the request. Try again with the same details.');
      }
      if(input.action==='verify'&&result.receipt){setReceipt(result.receipt);clearAttempt();}
      setStage(input.action==='request'?'verify':'done');
    }catch(e){setError(e instanceof Error?e.message:'Could not confirm the request.');}
    finally{submitting.current=false;setBusy(false);}
  }
  if(stage==='done')return <>
    <p>Email verified. Save your private status link to check this request later.</p>
    <p><a href={'/booking-status#receipt='+encodeURIComponent(receipt)} rel="noreferrer">Open private status link</a></p>
    <BookingStatus receipt={receipt}/>
  </>;
  if(stage==='request'&&!slots.length)return <p>There are no open times on this page.</p>;
  const alternatives=replacement?slots.filter(slot=>!replacement.unavailable.includes(slot.start)):[];
  return <form onSubmit={submit}>
    <fieldset key={stage} disabled={busy}>
      {stage==='request'?<>
        <label>Meeting time<select name="start" required>
          <option value="">Choose a time</option>
          {slots.map(slot=><option key={slot.start} value={slot.start}>{slot.label}</option>)}
        </select></label>
        <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254}/></label>
      </>:replacement&&!alternatives.length?<><p>There are no other open times on this page.</p>
        <button type="button" onClick={refreshAlternatives}>Refresh times</button></>:replacement?<label>New meeting time<select name="alternativeStart" key={replacement.unavailable.join(',')} required defaultValue="">
        <option value="">Choose another time</option>
        {alternatives.map(slot=><option key={slot.start} value={slot.start}>{slot.label}</option>)}
      </select></label>:<>
        <p>If your code arrived, enter it here. Codes expire within {guestProofMinutes} minutes.</p>
        <label>Verification code<input name="code" autoComplete="one-time-code" required maxLength={43}/></label>
      </>}
    </fieldset>
    {error&&<p role="alert">{error}</p>}
    <button disabled={busy||Boolean(replacement&&!alternatives.length)}>{busy?'Checking…':stage==='request'?'Email me a code':replacement?'Reserve new time':'Verify email'}</button>
    {stage==='request'&&requestId&&error&&<button className="lead-form-secondary" type="button" disabled={busy} onClick={()=>{setError('');setStage('verify');}}>Enter a code</button>}
    {stage==='verify'&&<button className="lead-form-secondary" type="button" disabled={busy} onClick={()=>{clearAttempt();setError('');setStage('request');}}>Start over</button>}
  </form>;
}
