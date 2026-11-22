'use client';

import {useState,type FormEvent} from 'react';
import type {WebhookSettingsPage} from '../db/postgres/webhook-management-store';
import {portableExternalRecordKind,type PortableExternalRecordKind} from '../lib/portable-api-tokens';

const endpoint='/api/webhook-subscriptions';
const title=(value:string)=>value.charAt(0).toUpperCase()+value.slice(1);
const statusLabels:Record<string,string>={pending:'Queued',sending:'Sending',delivered:'Delivered',failed:'Failed',uncertain:'Outcome unknown'};
type Cursor=NonNullable<WebhookSettingsPage['next']>;
type Lookup={eventId:string}|{recordId:string;object:PortableExternalRecordKind};
type Review={action:'edit';id:string}|{action:'remove';id:string}|{action:'retry'|'confirm_received';id:string;attempts:number};

function RecordTypes({selected=[],busy}:{selected?:string[];busy:boolean}){
  return <fieldset disabled={busy}><legend>Record types</legend>
    {portableExternalRecordKind.options.map(kind=><label className="portable-webhook-choice" key={kind}>
      <input type="checkbox" name="object" value={kind} defaultChecked={selected.includes(kind)}/>{title(kind)}</label>)}
  </fieldset>;
}

async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  if(!response.ok){
    const result=await response.json().catch(()=>null) as {error?:string}|null;
    throw Error(result?.error??'Could not load webhook settings.');
  }
  return await response.json() as T;
}

export function PortableWebhooks({initial}:{initial:WebhookSettingsPage}){
  const [page,setPage]=useState(initial),[attention,setAttention]=useState(false),[paged,setPaged]=useState(false);
  const [lookup,setLookup]=useState<Lookup|null>(null);
  const [mode,setMode]=useState<'event'|'record'>('event'),[draft,setDraft]=useState('');
  const [object,setObject]=useState<PortableExternalRecordKind>('contacts');
  const [review,setReview]=useState<Review|null>(null),[checked,setChecked]=useState(false);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const available=page.destinations.filter(name=>!page.subscriptions.some(sub=>sub.destination===name));

  async function load(filter=attention,cursor?:Cursor,selection=lookup){
    const params=new URLSearchParams(cursor);
    if(selection)for(const [key,value] of Object.entries(selection))params.set(key,value);
    if(filter)params.set('filter','attention');
    const result=await request<WebhookSettingsPage>(endpoint+(params.size?'?'+params:''));
    setPage(result);setLookup(selection);setAttention(filter);setPaged(!!cursor);setReview(null);
  }
  async function run(fn:()=>Promise<void>){
    setBusy(true);setError('');setNotice('');
    try{await fn();}catch(error){setError(error instanceof Error?error.message:'Could not update webhook settings.');}
    finally{setBusy(false);}
  }
  function saveSubscription(event:FormEvent<HTMLFormElement>,existing?:WebhookSettingsPage['subscriptions'][number]){
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form),objects=data.getAll('object');
    if(!objects.length){setError('Choose at least one record type.');return;}
    void run(async()=>{
      await request(endpoint,existing?{action:'edit_objects',id:existing.id,expectedObjects:existing.objects,objects}:
        {action:'subscribe',destination:data.get('destination'),objects});
      if(!existing)form.reset();
      setNotice(existing?'Subscription updated.':'Subscription added.');await load();
    });
  }
  function confirm(){
    if(!review||review.action==='edit'||(review.action!=='remove'&&!checked))return;
    void run(async()=>{
      if(review.action==='remove'){
        await request(endpoint,review);setNotice('Subscription removed.');
      }else{
        await request(endpoint,{action:review.action,id:review.id,expectedAttempts:review.attempts,confirmed:true});
        setNotice(review.action==='retry'?'Delivery queued for retry.':'Receipt confirmed.');
      }
      setReview(null);await load();
    });
  }
  return <section id="record-webhooks" aria-labelledby="portable-webhook-title">
    <h2 id="portable-webhook-title">Outbound webhooks</h2>
    <p>Notify an integration when a record is created, updated, archived, restored or deleted.</p>
    {page.workspaceId&&<details><summary>Workspace ID for setup</summary><code>{page.workspaceId}</code></details>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {available.length>0?<form className="portable-token-form" onSubmit={event=>saveSubscription(event)}>
      <label>Destination<select name="destination" disabled={busy}>{available.map(name=><option key={name}>{name}</option>)}</select></label>
      <RecordTypes busy={busy}/>
      <button type="submit" disabled={busy}>Subscribe</button>
    </form>:!page.destinations.length&&<p className="portable-settings-empty">{page.workspaceId?
      (page.configurationIssue?'Ask your Harbor operator to correct the webhook destination configuration.':'Ask your Harbor operator to configure a webhook destination for this workspace.'):'Create a CRM record to initialize your workspace and see its setup ID.'}</p>}
    {page.subscriptions.length>0&&<><h3>Subscriptions</h3><ul>{page.subscriptions.map(sub=><li className="portable-token-row" key={sub.id}>
      <div><strong>{sub.destination}</strong><p>{sub.objects.map(title).join(', ')}</p></div>
      {review?.action==='edit'&&review.id===sub.id?<form className="portable-token-form" aria-label={'Edit '+sub.destination+' subscription'}
        onSubmit={event=>saveSubscription(event,sub)}>
        <RecordTypes busy={busy} selected={sub.objects}/>
        <p>These types apply to future record changes. Already queued deliveries will still be sent.</p>
        <button type="submit" disabled={busy}>Save record types</button>{' '}
        <button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel</button>
      </form>:review?.action==='remove'&&review.id===sub.id?<div className="portable-webhook-review">
        <p>Remove this subscription? This also deletes its queued deliveries and delivery history.</p>
        <button type="button" disabled={busy} onClick={confirm}>Remove subscription</button>{' '}
        <button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel</button>
      </div>:<div><button type="button" disabled={busy||!page.destinations.includes(sub.destination)} aria-label={'Edit record types for '+sub.destination}
        onClick={()=>setReview({action:'edit',id:sub.id})}>Edit record types</button>{' '}
        <button type="button" disabled={busy} aria-label={'Remove '+sub.destination} onClick={()=>setReview({action:'remove',id:sub.id})}>Remove</button></div>}
    </li>)}</ul></>}
    <h3>Recent deliveries</h3>
    <form className="portable-webhook-tools" onSubmit={event=>{
      event.preventDefault();
      const id=draft.trim();
      void run(()=>load(false,undefined,id?(mode==='event'?{eventId:id}:{object,recordId:id}):null));
    }}>
      <label>Search deliveries by<select value={mode} disabled={busy} onChange={event=>{
        setMode(event.target.value==='record'?'record':'event');setDraft('');
      }}><option value="event">Event ID</option><option value="record">Record ID</option></select></label>
      {mode==='record'&&<label><span id="webhook-history-object">Record type</span><select aria-labelledby="webhook-history-object" value={object} disabled={busy} onChange={event=>setObject(portableExternalRecordKind.parse(event.target.value))}>
        {portableExternalRecordKind.options.map(kind=><option key={kind} value={kind}>{title(kind)}</option>)}
      </select></label>}
      <label>{mode==='record'?'Find record by ID':'Find event by ID'}<input type="search" value={draft} disabled={busy} maxLength={36}
        onChange={event=>setDraft(event.target.value)}/></label>
      <button disabled={busy} type="submit">{mode==='record'?'Find record':'Find event'}</button>
      {lookup&&<button disabled={busy} type="button" onClick={()=>void run(async()=>{
        await load(attention,undefined,null);setDraft('');
      })}>{'eventId' in lookup?'Clear event filter':'Clear record filter'}</button>}
    </form>
    <div className="portable-webhook-tools">
      <label>Show deliveries<select disabled={busy} value={attention?'attention':'all'} onChange={event=>{
        const filter=event.target.value==='attention';void run(()=>load(filter));
      }}><option value="all">All deliveries</option><option value="attention">Needs attention</option></select></label>
      <button type="button" disabled={busy} onClick={()=>void run(()=>load())}>Refresh deliveries</button>
    </div>
    {lookup&&'recordId' in lookup&&<p>{title(lookup.object)} · <code>{lookup.recordId}</code></p>}
    {page.deliveries.length?<ul>{page.deliveries.map(row=><li key={row.id} className="portable-webhook-receipt">
      <div className="portable-token-row"><div><strong>{row.destination}</strong><p>{title(row.objectKind)} · {row.action}</p></div>
        <span className="portable-token-state">{row.ownerConfirmed?'Confirmed at receiver':statusLabels[row.status]}{row.httpStatus!==null&&!row.ownerConfirmed?' · HTTP '+row.httpStatus:''}</span>
      </div>
      <details><summary>Delivery details</summary>
        <dl><dt>Event ID</dt><dd><code>{row.id}</code></dd><dt>Record ID</dt><dd><code>{row.recordId}</code></dd>
          <dt>Revision</dt><dd>{row.revision}</dd><dt>Event time</dt><dd><time dateTime={row.occurredAt}>{row.occurredAt.slice(0,19).replace('T',' ')} UTC</time></dd>
          <dt>Attempts</dt><dd>{row.attempts}</dd>
          {row.ownerConfirmed&&row.httpStatus!==null&&<><dt>Last HTTP response</dt><dd>{row.httpStatus}</dd></>}
          {row.ownerConfirmed&&row.finishedAt&&<><dt>Confirmed by workspace owner</dt><dd><time dateTime={row.finishedAt}>{new Date(row.finishedAt).toISOString().slice(0,19).replace('T',' ')} UTC</time></dd></>}
        </dl>
        <button type="button" disabled={busy} onClick={()=>void run(async()=>{
          const kind=portableExternalRecordKind.parse(row.objectKind);
          await load(false,undefined,{object:kind,recordId:row.recordId});
          setMode('record');setObject(kind);setDraft(row.recordId);
        })}>View deliveries for this record</button>
      </details>
      {['failed','uncertain'].includes(row.status)&&(review&&(review.action==='retry'||review.action==='confirm_received')&&review.id===row.id?<div className="portable-webhook-review">
        <p>Check event <code>{row.id}</code> at {row.destination}. {review.action==='retry'?'A retry sends the same event ID.':'Confirming closes this delivery.'}</p>
        <label className="portable-webhook-choice"><input type="checkbox" checked={checked} disabled={busy} onChange={event=>setChecked(event.target.checked)}/>
          {review.action==='retry'?'I checked the receiver and this event still needs delivery.':'I verified that the receiver saved this event ID.'}</label>
        <button type="button" disabled={busy||!checked} onClick={confirm}>{review.action==='retry'?'Queue retry':'Confirm receipt'}</button>{' '}
        <button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel</button>
      </div>:<div>
        {row.status==='uncertain'&&<button type="button" disabled={busy} onClick={()=>{
          setChecked(false);setReview({action:'confirm_received',id:row.id,attempts:row.attempts});
        }}>Already received</button>}{' '}
        <button type="button" disabled={busy||!page.destinations.includes(row.destination)} onClick={()=>{
          setChecked(false);setReview({action:'retry',id:row.id,attempts:row.attempts});
        }}>Review retry</button>
      </div>)}
    </li>)}</ul>:<p className="portable-settings-empty">{lookup?'No matching delivery.':attention?'No deliveries need attention on this page.':'No deliveries on this page.'}</p>}
    {(paged||page.next)&&<nav aria-label="Delivery pages">
      {paged&&<button disabled={busy} type="button" onClick={()=>void run(()=>load())}>Newest deliveries</button>}
      {page.next&&<button disabled={busy} type="button" onClick={()=>void run(()=>load(attention,page.next??undefined))}>Older deliveries</button>}
    </nav>}
  </section>;
}
