'use client';

import {useEffect,useState} from 'react';
import type {GuestBookingStatus} from '@/lib/calendar/guest-booking-status';

const notices:Record<GuestBookingStatus['state'],string>={
  pending:'Your request is awaiting the organizer’s confirmation.',
  confirmed:'Your meeting is confirmed. Check your email for the Calendar invitation.',
  checking:'The organizer is checking the Calendar outcome.',
  cancelled:'Your meeting was cancelled.',
  closed:'This request is closed.',
};

async function readStatus(receipt:string,signal:AbortSignal){
  const response=await fetch('/api/public/booking-status',{method:'POST',credentials:'omit',signal,
    headers:{'content-type':'application/json'},body:JSON.stringify({receipt})});
  const value=await response.json() as GuestBookingStatus&{error?:string};
  if(!response.ok)throw Error(value.error||'Harbor could not check this booking.');
  return value;
}

export function BookingStatus({receipt}:{receipt?:string}){
  const [status,setStatus]=useState<GuestBookingStatus|null>(null),[error,setError]=useState('');
  const [check,setCheck]=useState(0),[finished,setFinished]=useState(-1);
  useEffect(()=>{
    const controller=new AbortController();
    const token=receipt??new URLSearchParams(window.location.hash.slice(1)).get('receipt');
    const lookup=token?readStatus(token,AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])):
      Promise.reject(Error('Open the private status link from your booking request.'));
    void lookup.then(result=>{
      if(!controller.signal.aborted){setStatus(result);setError('');}
    },reason=>{
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Harbor could not check this booking.');
    }).finally(()=>{
      if(!controller.signal.aborted)setFinished(check);
    });
    return ()=>controller.abort();
  },[receipt,check]);

  const waiting=finished!==check;
  const time=status?.start&&status.end?new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'short'})
    .formatRange(new Date(status.start),new Date(status.end)):null;
  return <section aria-label="Booking status">
    {error?<p role="alert">{error}</p>:<p role="status">{status?notices[status.state]:'Checking booking status…'}</p>}
    {time&&!error&&<p><time dateTime={status?.start}>{time}</time> in your time zone.</p>}
    <button type="button" disabled={waiting} onClick={()=>setCheck(value=>value+1)}>
      {waiting?'Checking…':'Refresh status'}
    </button>
  </section>;
}
