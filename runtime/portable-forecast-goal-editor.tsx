'use client';
import {useState,type FormEvent} from 'react';
import {parseTargetCents} from '../lib/forecast-targets';
import type {ForecastScope} from '../lib/portable-forecast';

export function ForecastGoalEditor({scope,fiscalStartMonth,amountCents,revision}:{scope:ForecastScope;fiscalStartMonth:string;amountCents:number|null;revision:number}){
  const [amount,setAmount]=useState(amountCents===null?'':(amountCents/100).toFixed(2));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(event:FormEvent){
    event.preventDefault();
    const cents=amount.trim()===''?null:parseTargetCents(amount);
    if(cents===null&&amount.trim()){setError('Enter a positive amount or zero, with up to two decimal places.');return;}
    setError('');setBusy(true);
    try{
      const response=await fetch('/api/forecast-targets',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...scope,fiscalStartMonth,revision,amountCents:cents})});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        throw Error(result.error||'Could not save the goal.');
      }
      window.location.reload();
    }catch(cause){setError(cause instanceof TypeError?'Could not confirm the save. Reload to check the goal.':cause instanceof Error?cause.message:'Could not save the goal.');setBusy(false);}
  }
  return <form onSubmit={save} className="forecast-goal-form">
    <label>{scope.period==='quarter'?'Quarterly':'Monthly'} revenue goal<input inputMode="decimal" maxLength={18} value={amount} onChange={event=>setAmount(event.target.value)}/></label>
    <button disabled={busy||amount.trim()===''&&amountCents===null}>{busy?'Saving…':'Save goal'}</button>
    {error&&<p role="alert">{error}</p>}
  </form>;
}

export function FiscalCalendarEditor({start}:{start:number}){
  const [selection,setSelection]=useState(start),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(event:FormEvent){
    event.preventDefault();
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/forecast-targets',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'set_calendar',start:selection,expectedStart:start})});
      if(!response.ok)throw Error(((await response.json()) as {error?:string}).error||'Could not save the calendar.');
      window.location.reload();
    }catch(cause){setError(cause instanceof TypeError?'Reload to check the saved fiscal calendar.':cause instanceof Error?cause.message:'Could not save the calendar.');setBusy(false);}
  }
  return <details><summary>Workspace fiscal calendar</summary><form onSubmit={save} className="forecast-goal-form">
    <label>Fiscal year starts in<select value={selection} onChange={event=>setSelection(Number(event.target.value))}>
      {Array.from({length:12},(_,i)=><option key={i} value={i+1}>
        {new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(Date.UTC(2026,i,1))}</option>)}</select></label>
    {(selection-start)%3!==0&&<p role="status">This changes which months make up each quarter. Existing goals will appear under Goals from earlier calendars for overlapping quarters. Set a new goal for the new dates.</p>}
    <button disabled={busy||selection===start}>Save calendar</button>
    {error&&<p role="alert">{error}</p>}
  </form><p>Quarter goals stay with the three months they cover.</p></details>;
}
