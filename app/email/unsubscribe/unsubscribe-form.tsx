'use client';
import {useState} from 'react';
import {unsubscribeInput} from '@/lib/email/unsubscribe';
export function UnsubscribeForm(){
 const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
 async function submit(){
  const body=unsubscribeInput.safeParse({token:window.location.hash.slice(1)});
  if(!body.success){setError('This unsubscribe link is incomplete. Use the link in your email.');return;}
  const unconfirmed='We couldn’t confirm your unsubscribe request. Try again using this same link.';
  setBusy(true);setError('');
  try{
   const response=await fetch('/api/email/unsubscribe',{
    method:'POST',credentials:'omit',signal:AbortSignal.timeout(20_000),
    headers:{'content-type':'application/json'},body:JSON.stringify(body.data),
   });
   const result=await response.json() as {unsubscribed?:boolean;error?:string};
   if(!response.ok||result.unsubscribed!==true){
    setError(response.status<500&&result.error?result.error:unconfirmed);
    return;
   }
   setDone(true);
   window.history.replaceState(null,'',window.location.pathname);
  }catch{setError(unconfirmed);}finally{setBusy(false);}
 }
 return done?<p className="unsubscribe-success" role="status">You’re unsubscribed. This workspace’s future Harbor emails to your address are blocked.</p>:<form onSubmit={event=>{event.preventDefault();void submit();}}>
  {error&&<p role="alert">{error}</p>}<button disabled={busy}>{busy?'Saving…':'Unsubscribe from email'}</button>
 </form>;
}
