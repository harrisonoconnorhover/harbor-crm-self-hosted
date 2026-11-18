'use client';

import {useState,type FormEvent} from 'react';
import {CalendarAvailabilitySharing} from './calendar-availability-sharing';
import type {CalendarSuggestions} from '@/lib/calendar/suggestions';

export function CalendarSuggestionsPanel({connectionId}:{connectionId?:string}){
  const [result,setResult]=useState<{value:CalendarSuggestions;timeZone:string}|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function find(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const fields=new FormData(event.currentTarget),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    setBusy(true);setError('');setResult(null);
    try{
      const response=await fetch('/api/calendar/availability',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({mode:'suggest',startLocal:fields.get('start'),endLocal:fields.get('end'),timeZone,
          durationMinutes:Number(fields.get('duration')),...(connectionId?{connectionId}:{})})});
      const value=await response.json() as CalendarSuggestions&{error?:string};
      if(!response.ok)throw Error(value.error||'Could not check these times.');
      setResult({value,timeZone});
    }catch(e){setError(e instanceof Error?e.message:'Could not check these times.');}
    finally{setBusy(false);}
  }
  return <section className="panel tool-body" aria-label="Find open meeting times">
    <h2>Find open meeting times</h2>
    <p>Choose a window of up to eight hours in your browser’s time zone. Harbor checks your calendar and saved holds.</p>
    <form onSubmit={find} onChange={()=>{setResult(null);setError('');}}>
      <fieldset disabled={busy}>
        <label className="form-field">Window starts <input name="start" type="datetime-local" required/></label>
        <label className="form-field">Window ends <input name="end" type="datetime-local" required/></label>
        <label className="form-field">Meeting duration <select name="duration" defaultValue="30">
          {[15,30,45,60,90,120].map(minutes=><option key={minutes} value={minutes}>{minutes} minutes</option>)}
        </select></label>
      </fieldset>
      <button type="submit" disabled={busy}>{busy?'Checking…':'Find open times'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {result&&<div role="status">
      <p>{result.value.slots.length?result.value.slots.length+' open start times.':'No open times in this window.'} Times can change before booking.</p>
    </div>}
    <CalendarAvailabilitySharing result={result}/>
  </section>;
}
