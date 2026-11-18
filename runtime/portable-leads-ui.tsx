'use client';

import {useRouter} from 'next/navigation';
import {useEffect,useState,type FormEvent} from 'react';
import {leadStages} from '../lib/crm';
import {standardExtensions} from '../lib/standard-properties';
import {recordSearchLimit} from '../lib/portable-records';
import type {LeadHistory,LeadPage,LeadQuery,LeadRecord} from '../lib/portable-leads';
import {PortableRecordPicker} from './portable-record-picker';
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
          const action=!previous?'Lead added':previous.dealId!==data.dealId?'Converted to deal':
            previous.data.leadStage!==data.data.leadStage?`${previous.data.leadStage} → ${data.data.leadStage}`:
            (previous.assigneeId??null)!==(data.assigneeId??null)?(data.assigneeLabel?'Assigned to '+data.assigneeLabel:'Assignee cleared'):
            previous.contactId!==data.contactId?'Linked contact changed':
            previous.companyId!==data.companyId?'Linked company changed':'Lead edited';
          return <li key={entry.revision}>{action} · {entry.actorName||'Name unavailable'} ·{' '}
            <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
          </li>;
        })}
      </ol>}
      {before!==null&&<button type="button" onClick={()=>setBefore(null)}>Newest changes</button>}{' '}
      {current?.page?.next!=null&&<button type="button" onClick={()=>setBefore(current.page!.next)}>Older changes</button>}
    </>}
  </details>;
}

export function PortableLeads({email,page,query,record,adding,grant,assignees}:{
  email:string;page:LeadPage;query:LeadQuery;record?:LeadRecord;adding:boolean;grant?:{id:string;role:'viewer'|'editor'};
  assignees:{id:string;label:string}[];
}){
  const workspaceId=query.workspaceId,readOnly=grant?.role==='viewer';
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
      const result=await response.json() as {id?:string;dealId?:string;created?:boolean;error?:string};
      if(!response.ok||!result.id){
        setError(result.error??'Could not save the lead.');
        return;
      }
      if(!record)router.replace(leadLink(query,{record:result.id,after:query.after}));
      router.refresh();
      setStatus(result.dealId?(result.created?'Deal created.':'This lead already has a deal.'):record?'Lead saved.':'Lead added.');
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
      assigneeId:assigneeId===(record?.assigneeId??null)?undefined:assigneeId});
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="leads" workspaceId={workspaceId}/>
    <section aria-labelledby="portable-leads-title">
      <div className="portable-contacts-heading"><h1 id="portable-leads-title">Leads</h1>
        {!readOnly&&<a href={leadLink(query,{after:query.after,add:true})}>Add lead</a>}</div>
      {workspaceId&&<p>{'Shared workspace · '+(readOnly?'View only':'Editor')}</p>}
      <form action="/" method="get" aria-label="Lead filters">
        <input type="hidden" name="kind" value="leads"/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <fieldset>
          <label>View<select name="owner" defaultValue={query.owner??''}>
            <option value="">All leads</option>
            <option value="mine">My leads</option>
            <option value="unassigned">Unassigned</option>
          </select></label>
          <label>Search leads<input name="search" type="search" maxLength={recordSearchLimit} defaultValue={query.search}/></label>
          <label>Stage<select name="stage" defaultValue={query.stage??''}>
            <option value="">All stages</option>
            {leadStages.map(stage=><option key={stage}>{stage}</option>)}
          </select></label>
        </fieldset>
        <button type="submit">Apply</button> <a href={home('/?kind=leads')}>Clear filters</a>
      </form>
      <div className="portable-contacts-table">
        <table aria-label="Leads">
          <thead><tr><th>Lead</th><th>Stage</th><th>Lead label</th><th>Assignee</th><th>Contact</th><th>Company</th></tr></thead>
          <tbody>{page.records.map(lead=><tr key={lead.id}>
            <td><a href={leadLink(query,{record:lead.id,after:query.after})}>{lead.data.name}</a></td>
            <td>{lead.data.leadStage}</td><td>{lead.data.leadLabel||'—'}</td><td>{lead.assigneeLabel||'Unassigned'}</td>
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
      {readOnly&&<p>You can view this lead. Ask the workspace owner for editor access to change it.</p>}
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
          {readOnly?<p>Assignee · {record?.assigneeLabel||'Unassigned'}</p>:<label>Assignee<select name="assigneeId" defaultValue={record?.assigneeId??''}>
            <option value="">Unassigned</option>
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
      {record&&<LeadHistoryPanel id={record.id} revision={record.revision} workspaceId={workspaceId}/>}
      {record?.dealId?record.dealArchived?<p>Converted deal is archived.{!readOnly&&<> <a href={home('/?view=recycle-bin&kind=deals')}>Open Recycle Bin</a></>}</p>:
        <p><a href={home('/?kind=deals&record='+record.dealId)}>Open converted deal</a></p>:
        record&&!readOnly&&record.data.leadStage!=='Disqualified'&&<details><summary>Convert to deal</summary>
          <form onSubmit={event=>{
            event.preventDefault();
            const form=new FormData(event.currentTarget);
            void send({action:'convert',...target,dealName:form.get('dealName')});
          }} aria-label="Convert lead to deal">
            <p>Creates a deal in the default pipeline using this lead’s saved contact and company, and marks the lead Qualified.</p>
            <label>Deal name<input name="dealName" defaultValue={record.data.name} maxLength={160} required disabled={busy}/></label>
            <button type="submit" disabled={busy}>Create deal</button>
          </form></details>}
    </section>}
  </main>;
}
