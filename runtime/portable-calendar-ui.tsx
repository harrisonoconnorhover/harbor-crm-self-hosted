'use client';

import {CalendarDays} from 'lucide-react';
import {useRef,useState,type FormEvent} from 'react';
import {scheduledInstants} from '../lib/email/schedule';
import type {listPortableMeetings} from '../db/postgres/portable-meeting-store';
import {PortableMeetingHistory} from './portable-meeting-ui';
import {CalendarSuggestionsPanel} from '../app/calendar-suggestions';
import {PortableGooglePanel,type PersonalGoogleStatus} from './portable-google-panel';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';
import './portable-settings.css';

type Checked={availability:'free'|'busy';checkedAt:string;held?:true};

export function PortableCalendar({email,meetings,personal,googleOutcome,cancellationsEnabled,reschedulesEnabled}:{email:string;personal?:PersonalGoogleStatus;googleOutcome?:string;meetings?:Awaited<ReturnType<typeof listPortableMeetings>>;cancellationsEnabled:boolean;reschedulesEnabled:boolean}){
  const pending=useRef(false);
  const [checking,setChecking]=useState(false);
  const [result,setResult]=useState<Checked>();
  const [error,setError]=useState('');
  const [connectionStatus,setConnectionStatus]=useState('');
  const [connectionError,setConnectionError]=useState('');
  const canCheckAvailability=personal===undefined||personal&&personal!=='unavailable'&&!personal.needsReconnect;

  async function checkConnection(){
    if(pending.current)return;
    pending.current=true;
    setChecking(true);
    setConnectionStatus('');
    setConnectionError('');
    try{
      const response=await fetch('/api/calendar/availability',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'check_connection'})});
      const result=await response.json() as {connection?:string;error?:string};
      if(response.ok&&result.connection==='ok')setConnectionStatus('Google Calendar connection verified.');
      else setConnectionError(result.error||'Could not verify the Google Calendar connection.');
    }catch{setConnectionError('Could not verify the Google Calendar connection. Try again shortly.');}
    finally{pending.current=false;setChecking(false);}
  }

  async function check(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(pending.current)return;
    const fields=new FormData(event.currentTarget),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const instants=scheduledInstants(String(fields.get('start')||''),timeZone);
    setResult(undefined);
    setError('');
    if(instants.length!==1){setError('Choose an unambiguous time in your browser time zone.');return;}
    const [start]=instants,end=new Date(Date.parse(start)+Number(fields.get('duration'))*60_000).toISOString();
    pending.current=true;
    setChecking(true);
    try{
      const response=await fetch('/api/calendar/availability',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({start,end,timeZone})});
      if(!response.ok){
        const data=await response.json() as {error?:string};
        setError(data.error||'Calendar availability could not be confirmed.');
        return;
      }
      setResult(await response.json() as Checked);
    }catch{setError('Calendar availability could not be confirmed. Try again shortly.');}
    finally{pending.current=false;setChecking(false);}
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="calendar" calendarAvailable/>
    <section className="portable-settings-content" aria-labelledby="portable-calendar-heading">
      <header className="portable-settings-heading">
        <h1 id="portable-calendar-heading">Calendar availability</h1>
      </header>
      {personal!==undefined?<PortableGooglePanel provider="calendar" status={personal} outcome={googleOutcome}/>:
        <section className="portable-provider-card" aria-label="Google Calendar connection">
          <header className="portable-provider-heading">
            <span className="portable-provider-icon"><CalendarDays size={20} aria-hidden="true"/></span>
            <h2>Google Calendar</h2>
          </header>
          <div className="portable-provider-connection">
            <div className="portable-provider-actions">
              <button type="button" disabled={checking} onClick={()=>void checkConnection()}>Check Calendar connection</button>
            </div>
          </div>
          {connectionStatus&&<p role="status">{connectionStatus}</p>}
          {connectionError&&<p role="alert">{connectionError}</p>}
        </section>}
      {canCheckAvailability&&<>
        <section aria-label="Check availability">
          <h2>Check a time</h2>
          <p>Check a time on your primary Google Calendar. Confirm availability with guests separately.</p>
          <form onSubmit={check} onChange={()=>{setResult(undefined);setError('');}}>
            <fieldset disabled={checking}>
              <label>Start time in your browser time zone <input name="start" type="datetime-local" required/></label>
              <label>Duration <select name="duration" defaultValue="30">
                {[15,30,45,60,90,120].map(minutes=><option key={minutes} value={minutes}>{minutes} minutes</option>)}
              </select></label>
            </fieldset>
            <button type="submit" disabled={checking}>{checking?'Checking…':'Check availability'}</button>
          </form>
          {result&&<p role="status"><strong>{result.held?'Held in Harbor':result.availability==='busy'?'Busy':'Free'}</strong> · Checked {new Date(result.checkedAt).toLocaleTimeString()}</p>}
          {error&&<p role="alert">{error}</p>}
        </section>
        <CalendarSuggestionsPanel/>
      </>}
      {meetings&&<PortableMeetingHistory page={meetings} cancellationsEnabled={cancellationsEnabled} reschedulesEnabled={reschedulesEnabled}/>}
    </section>
  </main>;
}
