'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useRef,useState,type FormEvent} from 'react';

type Cursor={token:string;proof:string};
type Selection={id:string;threadId:string;receivedAt:string;proof:string};
type InboxItem={id:string;sender:string;subject:string;receivedAt:string|number;url:string;selection?:Selection;logged?:true};
type InboxPage={items:InboxItem[];next:Cursor|null;unavailable:number;blocked?:true};
type InboxProblem={code?:unknown;error?:unknown};
type Preview={proof:string;state:'loading'}
  |{proof:string;state:'ready';body:string;truncated:boolean}
  |{proof:string;state:'error';message:string};
type LogFeedback={proof:string;state:'saving'|'uncertain'|'error'|'done';message:string};
const subjectLimit=100;
const previewTextLimit=10_000;
const messageId=/^[a-zA-Z0-9_-]{1,200}$/;
const previewUnavailable='Could not load this preview. Try again or open the message in Gmail.';
const previewStale='This preview is no longer available. Search again or open the message in Gmail.';
const previewNeverLog='A Never log rule excludes this message from preview.';
const logUncertain='Could not confirm the save. Retry to check the same message.';
const authorizationNotice=(problem:InboxProblem|null)=>
  problem?.code==='mailbox_authorization'&&typeof problem.error==='string'?problem.error:undefined;

function previewSelection(item:InboxItem){
  const selection=item.selection;
  if(selection&&selection.id===item.id&&typeof selection.receivedAt==='string'&&selection.receivedAt===item.receivedAt&&
    messageId.test(selection.id)&&typeof selection.threadId==='string'&&messageId.test(selection.threadId)&&
    typeof selection.proof==='string'&&/^[a-zA-Z0-9_-]{43}$/.test(selection.proof))return selection;
}

function gmailLink(item:InboxItem){
  if(!messageId.test(item.id))return;
  try{
    const link=new URL(item.url);
    if(link.origin!=='https://mail.google.com'||link.username||link.password||link.pathname!=='/mail/u/'||
      link.searchParams.size!==1||!link.searchParams.get('authuser')||link.hash!=='#all/'+item.id)return;
    return link.href;
  }catch{return;}
}

export function PortableGmailInbox({recordId,onLogged}:{recordId:string;onLogged:()=>void}){
  const request=useRef<AbortController|null>(null);
  const previewRequest=useRef<AbortController|null>(null);
  const logRequest=useRef<object|null>(null);
  const [subject,setSubject]=useState('');
  const [page,setPage]=useState<InboxPage|null>(null);
  const [older,setOlder]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null);
  const [logFeedback,setLogFeedback]=useState<LogFeedback|null>(null);
  const logging=logFeedback?.state==='saving';
  useEffect(()=>()=>{
    request.current?.abort();
    previewRequest.current?.abort();
    logRequest.current=null;
  },[]);

  function closePreview(){
    previewRequest.current?.abort();
    previewRequest.current=null;
    setPreview(null);
  }

  function clearResults(){
    closePreview();
    setLogFeedback(null);
    setPage(null);
    setOlder(false);
    setError('');
  }

  function blockResults(){
    closePreview();
    setLogFeedback(null);
    setPage({items:[],next:null,unavailable:0,blocked:true});
    setOlder(false);
  }

  async function openPreview({id,threadId,receivedAt,proof}:Selection){
    if(request.current||logRequest.current)return;
    closePreview();
    const controller=new AbortController();
    previewRequest.current=controller;
    setPreview({proof,state:'loading'});
    let failureMessage=previewUnavailable;
    try{
      const response=await fetch('/api/email/inbox',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({recordId,preview:{id,threadId,receivedAt,proof}}),signal:controller.signal});
      if(!response.ok){
        if(response.status===409){
          const reason=await response.json().catch(()=>null) as InboxProblem|null;
          failureMessage=authorizationNotice(reason)??(reason?.code==='never_log'?previewNeverLog:previewStale);
        }else{
          if(response.status===404)failureMessage=previewStale;
          await response.body?.cancel();
        }
        throw Error();
      }
      const result=await response.json() as {blocked?:unknown;body?:unknown;truncated?:unknown}|null;
      if(controller.signal.aborted||previewRequest.current!==controller)return;
      if(result?.blocked===true){
        blockResults();
        return;
      }
      if(typeof result?.body!=='string'||typeof result.truncated!=='boolean')throw Error();
      const body=result.body.slice(0,previewTextLimit);
      setPreview({proof,state:'ready',body,truncated:result.truncated||body.length!==result.body.length});
    }catch{
      if(!controller.signal.aborted&&previewRequest.current===controller)setPreview({proof,state:'error',message:failureMessage});
    }finally{
      if(previewRequest.current===controller)previewRequest.current=null;
    }
  }

  async function logEmail({id,threadId,receivedAt,proof}:Selection){
    if(request.current||previewRequest.current||logRequest.current||preview?.state!=='ready'||preview.proof!==proof)return;
    const attempt={};
    logRequest.current=attempt;
    setLogFeedback({proof,state:'saving',message:'Logging received email…'});
    try{
      const response=await fetch('/api/email/inbox',{method:'PUT',headers:{'content-type':'application/json'},
        body:JSON.stringify({recordId,selection:{id,threadId,receivedAt,proof}})});
      const result=await response.json().catch(()=>null) as {
        logged?:unknown;alreadyLogged?:unknown;activityId?:unknown;blocked?:unknown;
      }&InboxProblem|null;
      if(logRequest.current!==attempt)return;
      if(response.ok&&result?.blocked===true){
        blockResults();
        return;
      }
      if(response.ok&&result?.logged===true&&typeof result.alreadyLogged==='boolean'&&
        (typeof result.activityId==='string'||(result.activityId===null&&result.alreadyLogged))){
        setPage(current=>current&&!current.blocked?{...current,items:current.items.map(item=>
          item.selection?.proof===proof?{...item,logged:true}:item)}:current);
        const message=result.activityId===null?'This email was logged before and its activity was removed.':
          result.alreadyLogged?'This received email is already logged.':'Received email logged on this Contact.';
        setLogFeedback({proof,state:'done',message});
        if(result.activityId!==null)onLogged();
        return;
      }
      if(response.ok||response.status>=500)throw Error();
      if(response.status===429){
        setLogFeedback({proof,state:'error',message:'Too many requests. Wait a moment and try logging again.'});
        return;
      }
      closePreview();
      setLogFeedback({proof,state:'error',message:authorizationNotice(result)??(response.status===409&&result?.code==='never_log'?
        'A Never log rule excludes this message from logging.':'Could not log this email for this Contact. Search again to check.')});
    }catch{
      if(logRequest.current===attempt)setLogFeedback({proof,state:'uncertain',message:logUncertain});
    }finally{
      if(logRequest.current===attempt)logRequest.current=null;
    }
  }

  async function search(after?:Cursor){
    if(request.current||logRequest.current)return;
    closePreview();
    setLogFeedback(null);
    const controller=new AbortController();
    request.current=controller;
    setBusy(true);
    setError('');
    const query=subject.trim();
    try{
      const response=await fetch('/api/email/inbox',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({recordId,...(query?{subject:query}:{}),...(after?{after}:{})}),signal:controller.signal});
      const result=await response.json().catch(()=>null) as (InboxPage&{error?:string})|null;
      if(!response.ok||!result||!Array.isArray(result.items))throw Error(result?.error||'Could not search received email.');
      if(!controller.signal.aborted){
        setPage(result);
        setOlder(!result.blocked&&!!after);
      }
    }catch(error){
      if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Could not search received email.');
    }finally{
      request.current=null;
      if(!controller.signal.aborted)setBusy(false);
    }
  }

  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    void search();
  }

  return <details onToggle={event=>{if(!event.currentTarget.open)closePreview();}}>
    <summary>Find received email</summary>
    <p>Search shows headers for this Contact. Open a message to read a plain-text preview.</p>
    <form onSubmit={submit}>
      <label>Subject contains (optional)<input type="search" value={subject} maxLength={subjectLimit}
        disabled={busy||logging} onChange={event=>{setSubject(event.target.value);clearResults();}}/></label>
      <button type="submit" disabled={busy||logging}>{busy?'Searching…':'Search received email'}</button>{' '}
      <button type="button" disabled={busy||logging||(!subject&&!page&&!error)} onClick={()=>{
        setSubject('');clearResults();
      }}>Clear search</button>
    </form>
    {busy&&<p role="status">Searching received email…</p>}
    {error&&<p role="alert">{error}</p>}
    {!busy&&page?.blocked&&<p role="status">A Never log rule excludes this Contact from received-email lookup.</p>}
    {!busy&&page&&!page.blocked&&<section aria-label="Received email results">
      {page.unavailable>0&&<p role="status">{page.unavailable} {page.unavailable===1?'message was':'messages were'} unavailable on this page.</p>}
      {page.items.length?<ul>{page.items.map(item=>{
        const date=new Date(item.receivedAt),time=Number.isFinite(date.getTime())?date:undefined;
        const link=gmailLink(item),selection=previewSelection(item);
        const active=preview&&preview.proof===selection?.proof?preview:null;
        const feedback=logFeedback&&logFeedback.proof===selection?.proof?logFeedback:null;
        return <li key={item.id}>
          <strong>{item.subject||'(No subject)'}</strong>
          <p>{item.sender}{' · '}{time?<time dateTime={time.toISOString()}><WorkspaceDate value={time.getTime()}>{time.toLocaleString()}</WorkspaceDate></time>:'Date unavailable'}</p>
          {selection&&<button type="button" disabled={logging} aria-expanded={!!active} onClick={()=>{
            if(active)closePreview();
            else void openPreview(selection);
          }}>{active?'Close preview':'Preview message'}</button>}{' '}
          {link&&<a href={link} target="_blank" rel="noopener noreferrer">Open in Gmail</a>}
          {feedback?<p role={feedback.state==='error'||feedback.state==='uncertain'?'alert':'status'}>{feedback.message}</p>:
            item.logged&&<p>Previously logged</p>}
          {active&&<section aria-label="Received email preview">
            {active.state==='loading'?<p role="status">Loading message preview…</p>:
              active.state==='error'?<><p role="alert">{active.message}</p>
                {selection&&active.message!==previewNeverLog&&<button type="button" disabled={logging}
                  onClick={()=>void openPreview(selection)}>Retry preview</button>}</>:
                <><div tabIndex={0} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'24rem',overflowY:'auto'}}>
                  {active.body||'No readable text body.'}
                </div>{active.truncated&&<p>This preview was shortened. Open the complete message in Gmail.</p>}
                {selection&&!item.logged&&<>
                  <p>Logging saves a plain-text copy on this Contact. People with Contact outreach access may read it.</p>
                  <button type="button" disabled={logging} onClick={()=>void logEmail(selection)}>
                    {feedback?.state==='uncertain'?'Retry logging this email':'Log received email'}
                  </button>
                </>}</>}
          </section>}
        </li>;
      })}</ul>:<p>No eligible messages on this page.</p>}
      {older&&<button type="button" disabled={busy||logging} onClick={()=>void search()}>Latest messages</button>}{' '}
      {page.next&&<button type="button" disabled={busy||logging} onClick={()=>void search(page.next??undefined)}>Older messages</button>}
    </section>}
  </details>;
}
