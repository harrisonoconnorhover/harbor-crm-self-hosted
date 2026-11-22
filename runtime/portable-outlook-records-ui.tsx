'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {OutlookLookup,OutlookRecordPreview,OutlookRecordProvider,OutlookRecordResults} from '../lib/outlook-records';
import './portable-outlook-records.css';

type Props={recordId:string;contactEmail:string;mail:boolean;calendar:boolean;onLogged:()=>void};
const displayDate=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
export function PortableOutlookRecords({recordId,contactEmail,mail,calendar,onLogged}:Props){
  const [provider,setProvider]=useState<OutlookRecordProvider>(mail?'outlook-mail':'outlook-calendar');
  const [through,setThrough]=useState(()=>new Date().toISOString().slice(0,10));
  const [days,setDays]=useState<1|7>(7);
  const [results,setResults]=useState<OutlookRecordResults>();
  const [attendance,setAttendance]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  const isMail=provider==='outlook-mail';
  function clear(){
    setResults(undefined);setAttendance('');setError('');setStatus('');
  }
  async function request(item?:OutlookRecordPreview){
    if(active.current||item&&!isMail&&attendance!==item.selection)return;
    const controller=new AbortController();active.current=controller;setBusy(true);setError('');setStatus('');
    const query:OutlookLookup={recordId,provider,through,days};
    if(!item)setResults(undefined);
    try{
      const response=await fetch('/api/outlook-records',{method:item?'PUT':'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(item?{...query,selection:item.selection,...(!isMail?{attended:true}:{})}:query),signal:controller.signal});
      if(!response.ok){
        const payload=await response.json() as {error?:string};
        throw Error(payload.error||'Could not complete the Outlook request.');
      }
      if(item){
        const payload=await response.json() as {logged?:boolean;alreadyLogged?:boolean};
        if(controller.signal.aborted)return;
        if(payload.logged!==true)throw Error('Could not confirm the log. Check the contact timeline.');
        setResults(previous=>previous&&({...previous,items:previous.items.map(row=>row.selection===item.selection?{...row,logged:true,canConfirmReply:false}:row)}));
        setAttendance('');setStatus(item.canConfirmReply?'Reply confirmed for sales sequences.':payload.alreadyLogged?'This item was already recorded.':isMail?'Email logged on this contact.':'Meeting logged on this contact.');
        onLogged();
      }else{
        const payload=await response.json() as OutlookRecordResults;
        if(controller.signal.aborted)return;
        if(!Array.isArray(payload.items))throw Error('Could not read Outlook results.');
        setResults(payload);
        setStatus(payload.items.length?payload.items.length+' matching '+(payload.items.length===1?'item.':'items.'):
          isMail?'No matching email in this window.':'No eligible meetings in this window.');
      }
    }catch(reason){
      if(!controller.signal.aborted){
        setResults(undefined);setAttendance('');
        setError(reason instanceof Error?reason.message:'Could not reach Outlook. Check the timeline before trying again.');
      }
    }finally{if(!controller.signal.aborted){setBusy(false);active.current=null;}}
  }
  function search(event:FormEvent){event.preventDefault();void request();}
  return <section className="portable-record-panel portable-outlook-history" aria-label="Outlook history">
    <h2>Outlook history</h2>
    <p>Find {mail&&calendar?'received email or past meetings':isMail?'received email':'past meetings'} with <strong>{contactEmail}</strong>.</p>
    <p>Only you see these search results. Logging adds the subject and date to this contact. Teammates with access to its outreach can see that entry.</p>
    <form onSubmit={search}><fieldset disabled={busy}>
      {mail&&calendar&&<label>Look for<select value={provider} onChange={event=>{clear();setProvider(event.target.value as OutlookRecordProvider);}}>
        <option value="outlook-mail">Received email</option><option value="outlook-calendar">Past meetings</option>
      </select></label>}
      <label>Window<select value={days} onChange={event=>{clear();setDays(event.target.value==='1'?1:7);}}>
        <option value={7}>7 days</option><option value={1}>1 day</option>
      </select></label>
      <label>Ending on (UTC)<input type="date" required value={through} onChange={event=>{clear();setThrough(event.target.value);}}/></label>
      <button type="submit">{busy?'Checking Outlook…':'Search Outlook'}</button>
    </fieldset></form>
    <p>{isMail?'Searches received messages in your Inbox. Email excerpts stay in this private preview.':
      'Searches ended, accepted meetings on your default calendar. Private events, all-day events and cancellations are excluded. An RSVP alone does not confirm attendance.'}</p>
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    {results&&<>
      {results.limited&&<p>Reached the Outlook search limit. Try a one-day window for a more complete search.</p>}
      {results.items.length>0&&<ul aria-label="Matching Outlook items">{results.items.map(item=><li key={item.selection}>
        <div className="portable-outlook-item">
          <strong>{item.subject}</strong>
          <time dateTime={new Date(item.occurredAt).toISOString()}><WorkspaceDate value={item.occurredAt}>{displayDate.format(item.occurredAt)}</WorkspaceDate></time>
          {item.excerpt&&<p>{item.excerpt}</p>}
          {!item.logged&&!isMail&&<label className="portable-outlook-attendance"><input type="checkbox" checked={attendance===item.selection} disabled={busy}
            onChange={event=>setAttendance(event.target.checked?item.selection:'')}/>I attended this meeting with {contactEmail}.</label>}
        </div>
        {item.canConfirmReply?<button type="button" disabled={busy} onClick={()=>void request(item)}>Confirm reply for sequences</button>:
          item.logged?<span>Already recorded</span>:
          <button type="button" disabled={busy||!isMail&&attendance!==item.selection} onClick={()=>void request(item)}>{isMail?'Log email':'Log attended meeting'}</button>}
      </li>)}</ul>}
    </>}
  </section>;
}
