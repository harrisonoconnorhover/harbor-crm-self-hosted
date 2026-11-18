'use client';

import {useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {scheduledInstants} from '../lib/email/schedule';
import {PortableEmailTemplatePicker} from './portable-email-template-ui';

type Schedule={kind:'gmail';id:string;recipient:string;subject:string;body:string;scheduledFor:number};

const subscribeTimeZone=()=>()=>{};
const browserTimeZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimeZone=()=>null;

export function PortableGmailComposer({endpoint,recordId,sender,recipient,onQueued}:{
  endpoint:string;recordId:string;sender:string;recipient:string;onQueued:()=>void;
}){
  const pending=useRef<Schedule|null>(null);
  const running=useRef(false);
  const subjectField=useRef<HTMLInputElement>(null);
  const messageField=useRef<HTMLTextAreaElement>(null);
  const [timing,setTiming]=useState<'now'|'later'>('later');
  const [local,setLocal]=useState('');
  const [occurrence,setOccurrence]=useState('');
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const timeZone=useSyncExternalStore(subscribeTimeZone,browserTimeZone,serverTimeZone);
  const times=timing==='later'&&timeZone?scheduledInstants(local,timeZone):[];
  const selectedTime=times.length===1?times[0]:times.includes(occurrence)?occurrence:undefined;
  const skippedTime=timing==='later'&&local&&timeZone&&times.length===0;

  async function schedule(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(running.current)return;
    const form=event.currentTarget,fields=new FormData(form);
    const retry=pending.current!==null;
    if(!pending.current){
      const scheduledFor=timing==='now'?Date.now():selectedTime?Date.parse(selectedTime):NaN;
      if(!Number.isFinite(scheduledFor)){setError('Choose a valid send time.');return;}
      pending.current={kind:'gmail',id:crypto.randomUUID(),recipient,subject:String(fields.get('subject')||''),
        body:String(fields.get('message')||''),scheduledFor};
    }
    running.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pending.current)});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        if(!retry&&response.status<500)pending.current=null;
        throw Error(result.error||'Could not schedule this email.');
      }
      form.reset();
      pending.current=null;
      setTiming('later');
      setLocal('');
      setOccurrence('');
      setUncertain(false);
      setNotice('Email queued.');
      onQueued();
    }catch(error){
      const held=!!pending.current;
      setUncertain(held);
      setError(held?'The email may already be queued. Retry this same request to check.':
        error instanceof Error?error.message:'Could not schedule this email.');
    }finally{running.current=false;setBusy(false);}
  }

  function applyTemplate(template:{subject:string;body:string}){
    const subject=subjectField.current,message=messageField.current;
    if(running.current||pending.current||!subject||!message)return;
    if((subject.value||message.value)&&!window.confirm('Replace the subject and message in this draft?'))return;
    subject.value=template.subject;
    message.value=template.body;
    setNotice('Template applied to the draft. Review it before scheduling.');
    subject.focus();
  }

  return <details>
    <summary>Schedule Gmail email</summary>
    <p>From {sender} · To {recipient}</p>
    <PortableEmailTemplatePicker contactId={recordId} disabled={busy||uncertain} onApply={applyTemplate}/>
    <form onSubmit={schedule}>
      <fieldset disabled={busy||uncertain}>
        <label>Subject<input ref={subjectField} name="subject" required maxLength={200}/></label>
        <label>Plain-text email<textarea ref={messageField} name="message" required maxLength={8000}/></label>
        <label>When to send<select value={timing} onChange={event=>setTiming(event.target.value==='now'?'now':'later')}>
          <option value="later">Schedule for later</option>
          <option value="now">As soon as possible</option>
        </select></label>
        {timing==='later'?<>
          <label>Send at ({timeZone??'browser time zone'})<input name="when" type="datetime-local" value={local} required
            onChange={event=>{setLocal(event.target.value);setOccurrence('');}}/></label>
          {skippedTime&&<p>That local time does not exist. Choose another send time.</p>}
          {times.length>1&&<label>This time occurs twice. Choose an occurrence<select name="occurrence" value={occurrence} required
            onChange={event=>setOccurrence(event.target.value)}>
            <option value="">Choose one</option>
            {times.map((at,index)=><option key={at} value={at}>{index===0?'First':'Second'} occurrence · {new Intl.DateTimeFormat('en',{
              timeZone:timeZone??undefined,timeZoneName:'longOffset',hour:'numeric',minute:'2-digit',
            }).formatToParts(new Date(at)).find(part=>part.type==='timeZoneName')?.value}</option>)}
          </select></label>}
        </>:
          <p>Harbor queues the email for the next available worker run. Check the queue for its delivery status.</p>}
      </fieldset>
      <button type="submit" disabled={busy}>{uncertain?'Retry same email':busy?'Queuing…':timing==='now'?'Queue email now':'Schedule email'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
  </details>;
}
