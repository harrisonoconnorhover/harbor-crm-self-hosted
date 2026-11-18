'use client';

import {Inbox} from 'lucide-react';
import {useState,type FormEvent} from 'react';
import {EmailSuppressionSettings} from '../app/email-suppression';
import {EmailNeverLog} from '../app/email-never-log';
import {PortableEmailTemplates} from './portable-email-template-ui';
import {PortableGooglePanel,type PersonalGoogleStatus} from './portable-google-panel';
import './portable-contacts.css';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-settings.css';

export function PortableEmailSettings({email,inboxAvailable,personal,googleOutcome}:{email:string;inboxAvailable:boolean;personal?:PersonalGoogleStatus;googleOutcome?:string}){
  const showConnection=personal!==undefined||inboxAvailable;
  const [url,setUrl]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [checkingInbox,setCheckingInbox]=useState(false);
  const [inboxResult,setInboxResult]=useState<{ok:boolean;text:string}>();

  async function checkInbox(){
    setCheckingInbox(true);
    setInboxResult(undefined);
    const unavailable='Could not verify the Gmail inbox connection. Try again shortly.';
    try{
      const response=await fetch('/api/email/inbox',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'check_connection'})});
      const data=await response.json() as {connection?:string;error?:string};
      const ok=response.ok&&data.connection==='ok';
      setInboxResult({ok,text:ok?'Gmail inbox connection verified.':data.error||unavailable});
    }catch{setInboxResult({ok:false,text:unavailable});}
    finally{setCheckingInbox(false);}
  }


  async function createLink(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const address=new FormData(event.currentTarget).get('email');
    setBusy(true);
    setError('');
    setUrl('');
    try{
      const response=await fetch('/api/email/suppressions',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'unsubscribeLink',email:address})});
      const result=await response.json() as {url?:string;error?:string};
      if(!response.ok||!result.url)throw Error(result.error||'Could not create the opt-out link.');
      setUrl(result.url);
    }catch(error){setError(error instanceof Error?error.message:'Could not create the opt-out link.');}
    finally{setBusy(false);}
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="email-settings"/>
    <section className="portable-settings-content" aria-labelledby="portable-email-heading">
      <header className="portable-settings-heading">
        <h1 id="portable-email-heading">Email settings</h1>
        <nav aria-label="Email settings sections">
          {showConnection&&<a href="#email-connection">Gmail connection</a>}
          <a href="#email-templates">Templates</a>
          <a href="#email-suppressions">Do not email</a>
          <a href="#email-never-log">Never log</a>
          <a href="#email-opt-out">Opt-out link</a>
        </nav>
      </header>
      {showConnection&&<div id="email-connection">
        {personal!==undefined&&<PortableGooglePanel provider="gmail" status={personal} outcome={googleOutcome}/>}
        {inboxAvailable&&<section className="portable-provider-card" aria-label="Gmail inbox">
          <header className="portable-provider-heading">
            <span className="portable-provider-icon"><Inbox size={20} aria-hidden="true"/></span>
            <h2>Gmail inbox</h2>
          </header>
          <div className="portable-provider-connection">
            <div className="portable-provider-actions">
              <button type="button" disabled={checkingInbox} onClick={()=>void checkInbox()}>
                {checkingInbox?'Checking…':'Check Gmail inbox connection'}
              </button>
            </div>
          </div>
          {inboxResult&&<p role={inboxResult.ok?'status':'alert'}>{inboxResult.text}</p>}
        </section>}
      </div>}
      <div id="email-templates"><PortableEmailTemplates/></div>
      <div id="email-suppressions"><EmailSuppressionSettings portable/></div>
      <div id="email-never-log"><EmailNeverLog portable/></div>
      <section id="email-opt-out" aria-label="Recipient opt-out link">
        <h2>Recipient opt-out link</h2>
        <p>The person who opens this link can confirm an opt-out for that address in this workspace. Share it only with the intended recipient.</p>
        <form onSubmit={createLink}>
          <label>Recipient email<input name="email" type="email" maxLength={254} required disabled={busy}
            onChange={()=>{setUrl('');setError('');}}/></label>
          <button type="submit" disabled={busy}>{busy?'Creating…':'Create opt-out link'}</button>
        </form>
        {error&&<p role="alert">{error}</p>}
        {url&&<label>Opt-out link<input readOnly value={url} onFocus={event=>event.target.select()}/></label>}
      </section>
    </section>
  </main>;
}
