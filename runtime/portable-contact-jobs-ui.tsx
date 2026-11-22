'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {jobDetailsHref,jobIssueLabel,jobStatusLabel} from '../lib/portable-job-labels';
import {scheduledInstants} from '../lib/email/schedule';
import {queuedRecipientBlockedNotice} from '../lib/email/suppression';
import {PortableGmailComposer} from './portable-gmail-composer';

type Cursor={at:number;id:string};
type Receipt={number:number;startedAt:number;endedAt:number|null;outcome:string|null};
type Job={id:string;body:string;actorEmail:string;kind:string;gmail:{sender:string;recipient:string;subject:string;providerId:string|null}|null;status:string;attempts:number;issue:string|null;waitForLifecycle?:string|null;scheduledFor:number;availableAt:number;finishedAt:number|null;operatorReviewedAt:number|null;recipientBlocked:boolean;receipts:Receipt[]};
type Page={items:Job[];next:Cursor|null};
type Request={id:string;body:string;scheduledFor:number};
const time=(at:number)=><WorkspaceDate value={at}/>;
const noteSubmitDeadlineMs=12_000;

export function PortableContactJobs({recordId,workspaceId,grantId,readOnly,gmail}:{
  recordId:string;workspaceId?:string;grantId?:string;readOnly:boolean;gmail?:{sender:string;recipient:string};
}){
  const query=new URLSearchParams({recordId});
  if(workspaceId)query.set('workspaceId',workspaceId);
  const base='/api/background-jobs?'+query;
  const [page,setPage]=useState<Page>();
  const [accessLost,setAccessLost]=useState(false);
  const [after,setAfter]=useState<Cursor>();
  const [refresh,setRefresh]=useState(0);
  const pending=useRef<Request|null>(null);
  const submitting=useRef(false);
  const [uncertain,setUncertain]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const [queuedNoteId,setQueuedNoteId]=useState<string>();

  useEffect(()=>{
    const controller=new AbortController();
    const cursor=after?'&'+new URLSearchParams({afterAt:String(after.at),afterId:after.id}):'';
    fetch(base+cursor,{signal:controller.signal}).then(async response=>{
      if(controller.signal.aborted)return;
      if([401,403,404].includes(response.status)){
        setAccessLost(true);setPage(undefined);setQueuedNoteId(undefined);setStatus('');setError('');
        return;
      }
      if(!response.ok)throw Error();
      const result=await response.json() as Page;
      if(!controller.signal.aborted){setAccessLost(false);setPage(result);}
    }).catch(()=>{if(!controller.signal.aborted)setError('Could not load scheduled notes.');});
    return ()=>controller.abort();
  },[base,after,refresh]);

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(saving||submitting.current)return;
    const form=event.currentTarget,retry=pending.current!==null;
    if(!pending.current){
      const fields=new FormData(form),date=String(fields.get('when')||'');
      let scheduledFor=Date.now();
      if(date){
        const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
        const instants=scheduledInstants(date,timeZone);
        if(instants.length!==1){
          setError('Choose a date and time that occurs once in your browser time zone.');
          return;
        }
        scheduledFor=Date.parse(instants[0]);
      }
      pending.current={id:crypto.randomUUID(),body:String(fields.get('body')||''),scheduledFor};
    }
    const input=pending.current;
    submitting.current=true;
    setSaving(true);
    setError('');
    setStatus('');
    setQueuedNoteId(undefined);
    try{
      const target=grantId?base+'&grantId='+grantId:base;
      const response=await fetch(target,{method:'POST',body:JSON.stringify(input),
        headers:{'content-type':'application/json'},signal:AbortSignal.timeout(noteSubmitDeadlineMs)});
      const result=await response.json() as {id?:string;error?:string};
      if(!retry&&response.status>=400&&response.status<500&&typeof result.error==='string'){
        pending.current=null;
        setError(result.error);
        return;
      }
      if(response.status!==202||result.id!==input.id)throw Error('Note queue receipt unavailable.');
      form.reset();
      pending.current=null;
      setUncertain(false);
      setAfter(undefined);
      setRefresh(value=>value+1);
      setStatus('Note queued.');
      setQueuedNoteId(input.id);
    }catch{
      setUncertain(true);
      setError('The Note may already be queued. Retry the same note to check.');
    }finally{submitting.current=false;setSaving(false);}
  }

  async function cancel(id:string){
    setSaving(true);
    setQueuedNoteId(undefined);
    setStatus('');
    setError('');
    try{
      const response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'cancelGmail',id})});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        throw Error(result.error||'Could not cancel this email.');
      }
      setStatus('Email cancelled.');
      setRefresh(value=>value+1);
    }catch(error){setError(error instanceof Error?error.message:'Could not confirm cancellation. Refresh to check.');}
    finally{setSaving(false);}
  }

  return <section id="portable-contact-jobs" className="portable-record-panel" aria-label="Scheduled notes" tabIndex={-1}>
    <h2>Scheduled notes</h2>
    {accessLost?<><p role="status">You no longer have access to these scheduled notes.</p>
      <button type="button" onClick={()=>window.location.reload()}>Reload contact</button></>:<>
    {!workspaceId&&<a href={'/?'+new URLSearchParams({view:'job-queue',queue:'all',jobContactId:recordId})}>
      View all jobs for this contact
    </a>}
    {!readOnly&&<form onSubmit={submit}>
      <fieldset disabled={saving||uncertain}>
        <label className="portable-note-text">Note<textarea name="body" required maxLength={2_000}/></label>
        <label>Run at (your time zone, optional)<input name="when" type="datetime-local"/></label>
      </fieldset>
      <button type="submit" disabled={saving}>{saving?'Scheduling…':uncertain?'Retry same note':'Schedule note'}</button>
    </form>}
    {gmail&&<PortableGmailComposer endpoint={base} recordId={recordId} {...gmail} onQueued={()=>{setAfter(undefined);setRefresh(value=>value+1);}}/>}
    {error&&<p role="alert">{error}</p>}
    {status&&<p role="status">{status}
      {queuedNoteId&&!workspaceId&&<> <a href={jobDetailsHref(queuedNoteId)}>View job</a></>}
    </p>}
    <button type="button" onClick={()=>setRefresh(value=>value+1)}>Refresh scheduled notes</button>
    {page?.items.length?<ul>{page.items.map(job=><li key={job.id}>
      <strong>{job.kind==='gmail'&&job.status==='succeeded'?'Accepted by Gmail'
        :job.status==='attention'&&job.operatorReviewedAt!==null?'Delivery unconfirmed · reviewed':jobStatusLabel(job.status,job.issue)}</strong>
      {' · '}{job.gmail?job.gmail.subject:job.body}
      {job.gmail&&<> · To {job.gmail.recipient}</>}
      {job.kind==='gmail'&&(job.status==='queued'||job.status==='running')&&
        <button type="button" disabled={saving} onClick={()=>void cancel(job.id)}>Cancel email</button>}
      {' · '}{job.attempts} {job.attempts===1?'attempt':'attempts'}
      {job.status==='queued'&&(job.waitForLifecycle?<> · Waiting for {job.waitForLifecycle}</>
        :<> · {job.attempts?'Next attempt':'Due'} {time(job.availableAt)}</>)}
      {job.issue&&<> · {jobIssueLabel(job.issue)}</>}
      {job.recipientBlocked&&<p>{queuedRecipientBlockedNotice}</p>}
      <details>
        <summary>Run details</summary>
        <p>Scheduled by {job.actorEmail}</p>
        <p>Job ID <code>{job.id}</code></p>
        {job.gmail?.providerId&&<p>Gmail receipt <code>{job.gmail.providerId}</code></p>}
        {!job.waitForLifecycle&&<p>Scheduled for {time(job.scheduledFor)}</p>}
        {job.finishedAt!==null&&<p>Finished {time(job.finishedAt)}</p>}
        {job.receipts.length?<ol>{job.receipts.map(receipt=><li key={receipt.number}>
          Started {time(receipt.startedAt)}
          {receipt.endedAt!==null&&<> · Ended {time(receipt.endedAt)}</>}
          {' · '}{receipt.outcome?jobIssueLabel(receipt.outcome):'In progress'}
        </li>)}</ol>:<p>No attempts yet.</p>}
      </details>
    </li>)}</ul>:<p>{page?'No scheduled notes on this page.':'Loading scheduled notes…'}</p>}
    {after&&<button type="button" onClick={()=>setAfter(undefined)}>Newest notes</button>}{' '}
    {page?.next&&<button type="button" onClick={()=>setAfter(page.next??undefined)}>Older notes</button>}
    </>}
  </section>;
}
