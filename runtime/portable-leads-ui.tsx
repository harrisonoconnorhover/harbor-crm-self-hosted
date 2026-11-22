'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useRouter} from 'next/navigation';
import {useEffect,useState,type FormEvent} from 'react';
import {LeadRoutingSettings,RouteShownLeads,RoutingPreview} from './portable-lead-routing-ui';
import {leadStages} from '../lib/crm';
import {standardExtensions} from '../lib/standard-properties';
import {recordSearchLimit} from '../lib/portable-records';
import type {LeadHistory,LeadPage,LeadQuery,LeadRecord} from '../lib/portable-leads';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableRecycleAction,portableRecycleBinLink} from './portable-contact-recycle-ui';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

const properties=standardExtensions.leads;
const choiceFields=properties.filter(property=>property.options);
const textFields=properties.filter(property=>!property.options);

function leadLink(query:LeadQuery,{record,after,add}:{record?:string;after?:string;add?:boolean}={}){
  const params=new URLSearchParams({kind:'leads'});
  if(query.workspaceId)params.set('workspaceId',query.workspaceId);
  if(query.search)params.set('search',query.search);
  if(query.stage)params.set('stage',query.stage);
  if(query.owner)params.set('owner',query.owner);
  if(after)params.set('after',after);
  if(record)params.set('record',record);
  if(add)params.set('add','1');
  return '/?'+params;
}

function linkedOption(id:string|null|undefined,name:string|null|undefined){
  return id&&name?{id,name}:null;
}

function LeadHistoryPanel({id,revision,workspaceId}:{id:string;revision:number;workspaceId?:string}){
  const [open,setOpen]=useState(false);
  const [before,setBefore]=useState<number|null>(null);
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;revision:number;page?:LeadHistory}>();
  const query=new URLSearchParams({view:'history',id});
  if(workspaceId)query.set('workspaceId',workspaceId);
  if(before!==null)query.set('before',String(before));
  const key=query.toString();
  const current=result?.key===key&&result.revision===revision?result:undefined;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch('/api/leads?'+key,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as LeadHistory;
      if(!controller.signal.aborted)setResult({key,revision,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key,revision});});
    return ()=>controller.abort();
  },[open,key,revision,retry]);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Lead history</summary>
    {open&&<>
      {!current?<p role="status">Loading lead history…</p>:!current.page?<p role="alert">Could not load lead history.{' '}
        <button type="button" onClick={()=>{setResult(undefined);setRetry(n=>n+1);}}>Retry</button>
      </p>:!current.page.entries.length?<p>No saved changes on this page.</p>:<ol>
        {current.page.entries.map(entry=>{
          const {previous,data}=entry;
          const action=data.routingChange==='queued'?(previous?.assigneeLabel?'Released '+previous.assigneeLabel+' and queued for automatic routing':'Queued for automatic routing'):data.routingChange==='cancelled'?'Automatic routing cancelled':!previous?'Lead added':previous.dealId!==data.dealId?'Converted to deal':
            previous.data.leadStage!==data.data.leadStage?`${previous.data.leadStage} → ${data.data.leadStage}`:
            (previous.assigneeId??null)!==(data.assigneeId??null)?(data.assigneeLabel?'Assigned to '+data.assigneeLabel:'Assignee cleared'):
            previous.contactId!==data.contactId?'Linked contact changed':
            previous.companyId!==data.companyId?'Linked company changed':'Lead edited';
          return <li key={entry.revision}>{action} · {entry.actorName||'Name unavailable'} ·{' '}
            <time dateTime={entry.occurredAt}><WorkspaceDate value={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</WorkspaceDate></time>
          </li>;
        })}
      </ol>}
      {before!==null&&<button type="button" onClick={()=>setBefore(null)}>Newest changes</button>}{' '}
      {current?.page?.next!=null&&<button type="button" onClick={()=>setBefore(current.page!.next)}>Older changes</button>}
    </>}
  </details>;
}

export function PortableLeads({email,page,query,record,adding,grant,assignees,automaticRetries}:{
  email:string;automaticRetries:boolean;page:LeadPage;query:LeadQuery;record?:LeadRecord;adding:boolean;grant?:{id:string;role:'viewer'|'editor';restrictedEdit:boolean;canCreate:boolean;canDelete:boolean;canCreateDeal:boolean};
  assignees:{id:string;label:string}[];
}){
  const workspaceId=query.workspaceId,readOnly=grant?.role==='viewer'||record?.editable===false;
  const inactiveAssignee=record?.assigneeId&&!assignees.some(choice=>choice.id===record.assigneeId);
  const scope=workspaceId&&grant?'?'+new URLSearchParams({workspaceId,grantId:grant.id}):'';
  const home=(path:string)=>workspaceId?path+(path.includes('?')?'&':'?')+'workspaceId='+workspaceId:path;
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const target={id:record?.id,expectedRevision:record?.revision};

  async function send(input:unknown){
    if(busy)return;
    setBusy(true);
    setError('');
    setStatus('');
    try{
      const response=await fetch('/api/leads'+scope,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json() as {id?:string;dealId?:string;created?:boolean;routing?:string;error?:string};
      if(!response.ok||!result.id){
        setError(result.error??'Could not save the lead.');
        return;
      }
      if(!record)router.replace(leadLink(query,{record:result.id,after:query.after}));
      router.refresh();
      setStatus(result.routing==='queued'?'Queued for automatic routing.':result.routing==='unavailable'?'No rep is available for this lead.':result.routing==='assigned'?'Lead assigned.':result.dealId?(result.created?'Deal created.':'This lead already has a deal.'):record?'Lead saved.':'Lead added.');
    }catch{
      setError('Could not confirm the save. Refresh this page to check the lead.');
    }finally{setBusy(false);}
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const data=Object.fromEntries(['name','leadStage',...properties.map(property=>property.id)]
      .map(field=>[field,form.get(field)]));
    const contactId=form.get('contactId')||null,companyId=form.get('companyId')||null,assigneeId=form.get('assigneeId')||null;
    void send({action:'save',...target,data,companyId:companyId===(record?.companyId??null)?undefined:companyId,
      contactId:contactId===(record?.contactId??null)?undefined:contactId,
      assigneeId:assigneeId==='automatic'||record&&!record.routingPending&&assigneeId===record.assigneeId?undefined:assigneeId});
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="leads" workspaceId={workspaceId} recycleHref={portableRecycleBinLink('leads',workspaceId)}/>
    <section aria-labelledby="portable-leads-title">
      <div className="portable-contacts-heading"><h1 id="portable-leads-title">Leads</h1>
        {grant?.canCreate!==false&&<a href={leadLink(query,{after:query.after,add:true})}>Add lead</a>}</div>
      {!workspaceId&&!record&&!adding&&<LeadRoutingSettings/>}
      {workspaceId&&<p>{'Shared workspace · '+(grant?.role==='viewer'?'View only':'Editor')}</p>}
      <form action="/" method="get" aria-label="Lead filters">
        <input type="hidden" name="kind" value="leads"/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <fieldset>
          <label>View<select name="owner" defaultValue={query.owner??''}>
            <option value="">All leads</option>
            <option value="mine">My leads</option>
            <option value="unassigned">Unassigned</option>
            <option value="needs-routing">Needs routing</option>
            <option value="waiting-routing">Waiting for automatic routing</option>
          </select></label>
          <label>Search leads<input name="search" type="search" maxLength={recordSearchLimit} defaultValue={query.search}/></label>
          <label>Stage<select name="stage" defaultValue={query.stage??''}>
            <option value="">All stages</option>
            {leadStages.map(stage=><option key={stage}>{stage}</option>)}
          </select></label>
        </fieldset>
        <button type="submit">Apply</button> <a href={home('/?kind=leads')}>Clear filters</a>
      </form>
      {query.owner==='waiting-routing'&&<p>Oldest leads first. Each lead can be assigned after its retry time when a routing worker is running and a rep is available.</p>}
      {(query.owner==='needs-routing'||query.owner==='waiting-routing')&&!record&&!adding&&(!grant||grant.role==='editor'&&!grant.restrictedEdit)&&
        <RouteShownLeads offerQueue={automaticRetries&&query.owner==='needs-routing'} leads={page.records.map(({id,revision})=>({id,expectedRevision:revision}))}
          shared={workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined}/>}
      <div className="portable-contacts-table">
        <table aria-label="Leads">
          <thead><tr><th>Lead</th>{query.owner==='needs-routing'&&<th>Created (UTC)</th>}{query.owner==='waiting-routing'&&<th>Retry eligible from (UTC)</th>}<th>Stage</th><th>Lead label</th><th>Assignee</th><th>Contact</th><th>Company</th></tr></thead>
          <tbody>{page.records.map(lead=><tr key={lead.id}>
            <td><a href={leadLink(query,{record:lead.id,after:query.after})}>{lead.data.name}</a></td>
            {query.owner==='needs-routing'&&<td><time dateTime={lead.createdAt}>{lead.createdAt.slice(0,16).replace('T',' ')}</time></td>}
            {query.owner==='waiting-routing'&&<td>{lead.routingRetryAt&&<time dateTime={lead.routingRetryAt}>{new Date(lead.routingRetryAt).toISOString().slice(0,16).replace('T',' ')}</time>}</td>}
            <td>{lead.data.leadStage}</td><td>{lead.data.leadLabel||'—'}</td><td>{lead.assigneeLabel||(lead.routingPending?'Waiting for routing':'Unassigned')}{query.owner==='needs-routing'&&lead.assigneeId?' (unavailable)':''}</td>
            <td>{lead.contactName||'—'}</td><td>{lead.companyName||'—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!page.records.length&&<p>No leads match this view.</p>}
      {(query.after||page.next)&&<nav aria-label="Lead pages">
        {query.after&&<a href={leadLink(query)}>First leads</a>}
        {page.next&&<a href={leadLink(query,{after:page.next})}>Next leads</a>}
      </nav>}
    </section>
    {(record||adding)&&<section aria-labelledby="portable-lead-detail">
      <div className="portable-contacts-heading"><h2 id="portable-lead-detail">{record?'Edit '+record.data.name:'Add lead'}</h2>
        <a href={leadLink(query,{after:query.after})}>Close</a></div>
      {readOnly&&<p>You have view access to this lead.</p>}
      {record&&!readOnly&&!grant?.restrictedEdit&&(!record.assigneeId||inactiveAssignee)&&!record.convertedDealUnavailable&&!record.dealId&&!['Qualified','Disqualified'].includes(record.data.leadStage)&&
        <><RoutingPreview key={record.id+':'+record.revision} id={record.id} workspaceId={workspaceId}/>
          <button type="button" disabled={busy} onClick={()=>void send({action:'route',...target})}>{record.assigneeId?'Reassign lead':'Route unassigned lead'}</button>
          {automaticRetries&&!record.routingPending&&<button type="button" disabled={busy}
            onClick={()=>void send({action:'queue_routing',...target,releaseAssigneeId:record.assigneeId??undefined})}>{record.assigneeId?'Release former assignee and queue for routing':'Queue for automatic routing'}</button>}</>}
      {error&&<p role="alert">{error}</p>}
      {status&&<p role="status">{status}</p>}
      <form key={record?.revision??'add'} onSubmit={save} aria-label={record?'Edit lead':'New lead'}>
        <fieldset disabled={busy||readOnly}>
          <label>Name<input name="name" defaultValue={record?.data.name} maxLength={160} required/></label>
          <label>Lead stage<select name="leadStage" defaultValue={record?.data.leadStage??'New'}>
            {leadStages.map(stage=><option key={stage}>{stage}</option>)}
          </select></label>
          {choiceFields.map(property=><label key={property.id}>{property.label}
            <select name={property.id} defaultValue={record?.data[property.id as keyof LeadRecord['data']]??''}>
              <option value="">—</option>
              {property.options?.map(option=><option key={option}>{option}</option>)}
            </select></label>)}
          {textFields.map(property=><label key={property.id}>{property.label}
            <textarea name={property.id} defaultValue={record?.data[property.id as keyof LeadRecord['data']]??''} maxLength={2000}/>
          </label>)}
        </fieldset>
        <fieldset disabled={busy||readOnly}>
          {readOnly?<p>Assignee · {record?.assigneeLabel||(record?.routingPending?'Waiting for routing':'Unassigned')}</p>:<label>Assignee<select name="assigneeId" defaultValue={record?(record.routingPending?'automatic':record.assigneeId??''):'automatic'}>
            {record?.routingPending&&<option value="automatic">Waiting for automatic routing</option>}
            {!record&&<option value="automatic">{grant?.restrictedEdit?'Assign to me':'Use lead routing'}</option>}
            {(!grant?.restrictedEdit||!!record&&!record.assigneeId)&&<option value="">Unassigned</option>}
            {inactiveAssignee&&<option value={record.assigneeId!}>{record.assigneeLabel} (unavailable)</option>}
            {assignees.map(({id,label})=><option key={id} value={id}>{label}</option>)}
          </select></label>}
          <PortableRecordPicker kind="contacts" field="contactId" label="Linked contact" workspaceId={workspaceId}
            value={linkedOption(record?.contactId,record?.contactName)}/>
          <PortableRecordPicker kind="companies" field="companyId" label="Linked company" workspaceId={workspaceId}
            value={linkedOption(record?.companyId,record?.companyName)}/>
        </fieldset>
        {!readOnly&&<button type="submit" disabled={busy}>{busy?'Saving…':'Save lead'}</button>}
      </form>
      {record&&!readOnly&&grant?.canDelete!==false&&<PortableRecycleAction key={record.id+':'+record.revision} action="archive" kind="leads"
          id={record.id} revision={record.revision} name={record.data.name} scope={workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined}
          disabled={busy} onBusy={setBusy} onDone={()=>router.replace(portableRecycleBinLink('leads',workspaceId))}/>}
      {record&&<LeadHistoryPanel id={record.id} revision={record.revision} workspaceId={workspaceId}/>}
      {record?.convertedDealUnavailable?<p>This lead has already been converted.</p>:record?.dealId?record.dealArchived?<p>Converted deal is archived.{!readOnly&&<> <a href={home('/?view=recycle-bin&kind=deals')}>Open Recycle Bin</a></>}</p>:
        <p><a href={home('/?kind=deals&record='+record.dealId)}>Open converted deal</a></p>:
        record&&!readOnly&&grant?.canCreateDeal!==false&&record.data.leadStage!=='Disqualified'&&<details><summary>Convert to deal</summary>
          <form onSubmit={event=>{
            event.preventDefault();
            const form=new FormData(event.currentTarget);
            void send({action:'convert',...target,dealName:form.get('dealName')});
          }} aria-label="Convert lead to deal">
            <p>Creates a deal in the default pipeline with this lead’s saved contact and company, and marks the lead Qualified.</p>
            <p>{inactiveAssignee?'Reassign this lead before converting. Its current assignee is unavailable.':
              'Deal owner: '+(record.assigneeLabel??'Unassigned')}</p>
            <label>Deal name<input name="dealName" defaultValue={record.data.name} maxLength={160} required disabled={busy}/></label>
            <button type="submit" disabled={busy}>Create deal</button>
          </form></details>}
    </section>}
  </main>;
}
