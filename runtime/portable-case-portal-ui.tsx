'use client';

import {useRef,useState,type FormEvent} from 'react';
import type {CasePortalChange,CasePortalState} from '../lib/portable-case-portal';
import {PublishedArticlePicker} from './portable-published-article-picker';
import {portableArticlePath} from '../lib/portable-knowledge';
import type {PortableTicketRecord} from '../lib/portable-tickets';
import './portable-case-portal.css';

const endpoint='/api/case-portal';
const accessLabels={invited:'Invitation issued',active:'Signed in',revoked:'Revoked',expired:'Expired'};

function CaseArticleField({initial}:{initial:NonNullable<CasePortalState['publication']>['article']}){
  const [article,setArticle]=useState(initial);
  return <div>
    <input type="hidden" name="articleId" value={article?.id??''}/>
    {article&&<p>{article.title??'Unpublished article'} <button type="button" onClick={()=>setArticle(null)}>Remove article</button></p>}
    <PublishedArticlePicker action="Attach" onSelect={({id,title})=>setArticle({id,title})}/>
  </div>;
}

export function PortableTicketCasePortal({ticket}:{ticket:PortableTicketRecord}){
  const [state,setState]=useState<CasePortalState>();
  const [busy,setBusy]=useState(false),pending=useRef(false);
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[invitation,setInvitation]=useState('');
  const linkInput=useRef<HTMLInputElement>(null);

  async function sync(change?:CasePortalChange){
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');setMessage('');
    try{
      const response=await fetch(change?endpoint:endpoint+'?ticketId='+ticket.id,change?{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(change),
      }:{cache:'no-store'});
      const result=await response.json() as CasePortalState&{error?:string;inviteToken?:string};
      if(!response.ok)throw Error(result.error??'Could not load portal settings.');
      const {inviteToken,...next}=result;
      setState(next);
      if(inviteToken&&next.center){
        setInvitation(window.location.origin+'/help/'+next.center.id+'/cases#invite='+inviteToken);
      }else if(!change||change.action==='revoke')setInvitation('');
      if(change)setMessage({invite:'Invitation ready.',revoke:'Customer access revoked.',publish:'Case published.',withdraw:'Case withdrawn.'}[change.action]);
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not load portal settings.');}
    finally{pending.current=false;setBusy(false);}
  }

  const linked=state?.contact;
  const stale=state&&(state.ticketRevision!==ticket.revision||state.contact?.id!==(ticket.contactId??undefined));
  function save(action:CasePortalChange['action'],fields?:FormData){
    if(!state||!linked||stale)return;
    const target={ticketId:ticket.id,ticketRevision:state.ticketRevision,contactId:linked.id,
      expectedRevision:action==='withdraw'||action==='publish'?state.publicationRevision:state.access?.revision??0};
    void sync(action==='publish'?{...target,action,subject:String(fields?.get('subject')??''),update:String(fields?.get('update')??''),articleId:String(fields?.get('articleId')??'')||null}:{...target,action});
  }
  function publish(event:FormEvent<HTMLFormElement>){
    event.preventDefault();save('publish',new FormData(event.currentTarget));
  }
  async function copyLink(){
    try{await navigator.clipboard.writeText(invitation);setMessage('Invitation link copied.');}
    catch{linkInput.current?.focus();linkInput.current?.select();setMessage('Invitation link selected. Copy it to share.');}
  }
  const hasAccess=state?.access?.state==='active'||state?.access?.state==='invited';
  return <details className="portable-case-settings" onToggle={e=>{
    if(e.currentTarget.open&&!state&&!pending.current)void sync();
  }}>
    <summary>Customer portal</summary>
    <div className="portable-case-controls">
      {busy&&!state&&<p role="status">Loading portal settings…</p>}
      {error&&<p role="alert">{error} <button type="button" disabled={busy} onClick={()=>void sync()}>Reload portal settings</button></p>}
      {stale?<p>Ticket details have changed. <button type="button" onClick={()=>window.location.reload()}>Reload ticket</button></p>:state&&<>
        {!state.center?.enabled&&<p><a href={portableArticlePath}>Open the public help center</a> to share cases.</p>}
        {!linked&&<p>Link a primary contact to share this case.</p>}
        {linked&&<>
          {state.center?.enabled&&<form onSubmit={publish} key={state.publicationRevision}>
            <h3>Case for {linked.name}</h3>
            <p>{state.publication?'Published':'Private'} · The customer sees the ticket status, subject and update below.</p>
            <fieldset disabled={busy}>
              <label>Customer-facing subject<input name="subject" maxLength={200} required defaultValue={state.publication?.subject??''}/></label>
              <label>Customer update<textarea name="update" maxLength={4000} rows={3} defaultValue={state.publication?.update??''}/></label>
              <CaseArticleField initial={state.publication?.article??null}/>
              <div className="portable-case-actions"><button type="submit">{state.publication?'Save published case':'Publish case'}</button>
                {state.publication&&<button type="button" onClick={()=>save('withdraw')}>Withdraw case</button>}</div>
            </fieldset>
          </form>}
          {!state.center?.enabled&&state.publication&&<button type="button" disabled={busy} onClick={()=>save('withdraw')}>Withdraw case</button>}
          {(state.center?.enabled||hasAccess)&&<section aria-label="Customer access">
            <h3>Access for {linked.name}</h3>
            <p>{state.access?accessLabels[state.access.state]:'No invitation issued'}</p>
            <p>Share the link privately with this contact to open their published cases. Issuing a new link ends their previous access.</p>
            <div className="portable-case-actions">{state.center?.enabled&&<button type="button" disabled={busy} onClick={()=>save('invite')}>{hasAccess?'Replace invitation':'Create invitation'}</button>}
              {hasAccess&&<button type="button" disabled={busy} onClick={()=>save('revoke')}>Revoke customer access</button>}</div>
            {invitation&&<div className="portable-case-link"><label>Customer invitation link<input ref={linkInput} readOnly value={invitation} onFocus={e=>e.currentTarget.select()}/></label>
              <button type="button" onClick={()=>void copyLink()}>Copy link</button></div>}
          </section>}
        </>}
      </>}
      {message&&<p role="status">{message}</p>}
    </div>
  </details>;
}
