'use client';

import {useRef,useState,type FormEvent} from 'react';
import {ticketPriorities,ticketStatuses} from '../lib/crm';
import type {PortableTicketPage,PortableTicketQuery,PortableTicketRecord} from '../lib/portable-tickets';
import {standardField} from '../lib/standard-properties';
import {closeSlaInput,closeSlaLabels,slaPriorities,type CloseSlaPolicy} from '../lib/ticket-sla';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type Related={kind:'contacts'|'companies';id:string;name:string};
type TicketSlaPolicy=Pick<CloseSlaPolicy,'revision'|'enabled'|'targets'|'warningMinutes'>;
type Grant={id:string;role:'viewer'|'editor';workspaceId:string};
const withWorkspace=(path:string,workspaceId?:string)=>workspaceId?path+(path.includes('?')?'&':'?')+'workspaceId='+workspaceId:path;
const ticketPath=(id:string,workspaceId?:string,from?:string)=>{
  const query=new URLSearchParams({id,...(workspaceId?{workspaceId}:{}),...(from?{from}:{})});
  return '/tickets?'+query;
};
const recordPath=(kind:Related['kind'],id:string,workspaceId?:string)=>withWorkspace(kind==='contacts'?'/?contact='+id:'/?kind=companies&record='+id,workspaceId);
const optionValues={
  ticketSource:standardField('tickets','ticketSource')?.options??[],
  ticketCategory:standardField('tickets','ticketCategory')?.options??[],
};
const displayDate=(date:string)=>new Date(date).toISOString().slice(0,10);
const displayDeadline=(date:string)=>new Date(date).toISOString().slice(0,16).replace('T',' ')+' UTC';

function TicketSlaSummary({ticket}:{ticket:PortableTicketRecord}){
  const sla=ticket.sla;
  if(!sla?.receipt||!sla.status)return <>No close-time target</>;
  return <>{closeSlaLabels[sla.status]}{' · Close by '}
    <time dateTime={sla.receipt.dueAt}>{displayDeadline(sla.receipt.dueAt)}</time></>;
}

function TicketSlaSettings(){
  const pending=useRef(false);
  const [open,setOpen]=useState(false);
  const [policy,setPolicy]=useState<TicketSlaPolicy>();
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  async function updatePolicy(input?:TicketSlaPolicy){
    if(pending.current)return;
    pending.current=true;
    setBusy(true);
    setNotice('');
    setError('');
    try{
      const response=await fetch('/api/ticket-sla',input?{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{cache:'no-store'});
      const payload=await response.json() as TicketSlaPolicy&{error?:string};
      if(!response.ok)throw Error(payload.error??'Could not load or save close-time targets.');
      setPolicy(payload);
      if(input)setNotice('Close-time targets saved for new tickets.');
    }catch(error){setError(error instanceof Error?error.message:'Could not load or save close-time targets.');}
    finally{setBusy(false);pending.current=false;}
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!policy)return;
    const form=new FormData(event.currentTarget);
    const targets=Object.fromEntries(slaPriorities.map(priority=>{
      const value=String(form.get(priority)??'').trim();
      return [priority,value?Number(value):null];
    }));
    const warning=String(form.get('warningMinutes')??'').trim();
    const input=closeSlaInput.safeParse({revision:policy.revision,enabled:form.has('enabled'),
      targets,warningMinutes:warning?Number(warning):undefined});
    if(!input.success){
      setNotice('');
      setError(input.error.issues[0].message);
      return;
    }
    void updatePolicy(input.data);
  }

  return <div>
    <button type="button" aria-expanded={open} aria-controls="portable-ticket-sla-settings" disabled={busy}
      onClick={()=>{setOpen(!open);if(!open)void updatePolicy();}}>Close-time targets</button>
    {open&&<div id="portable-ticket-sla-settings">
      <p>Set targets in minutes by priority. Leave a priority blank when it has no target. Goals apply to newly created tickets.</p>
      <p role="status">{busy&&!policy?'Loading close-time targets…':notice}</p>
      {error&&<p role="alert">{error}{' '}
        <button type="button" disabled={busy} onClick={()=>void updatePolicy()}>Reload saved targets</button></p>}
      {policy&&<form key={policy.revision} aria-label="Close-time targets" onSubmit={save}>
        <fieldset disabled={busy}>
          <label><input type="checkbox" name="enabled" defaultChecked={policy.enabled}/> Enable close-time targets</label>
          {slaPriorities.map(priority=><label key={priority}>{priority} close target (minutes)
            <input type="number" name={priority} min={1} max={525600} step={1} defaultValue={policy.targets[priority]??''}/>
          </label>)}
          <label>Due-soon warning (minutes)
            <input type="number" required name="warningMinutes" min={0} max={525600} step={1} defaultValue={policy.warningMinutes}/>
          </label>
        </fieldset>
        <button type="submit" disabled={busy}>{busy?'Saving…':'Save close-time targets'}</button>
      </form>}
    </div>}
  </div>;
}

function TicketLink({kind,id,name,workspaceId}:{kind:Related['kind'];id:string|null;name:string|null;workspaceId?:string}){
  return id?<a href={recordPath(kind,id,workspaceId)}>{name??(kind==='contacts'?'Contact':'Company')}</a>:<>—</>;
}

function TicketEditor({record,related,save,cancel,busy,workspaceId}:{
  record:PortableTicketRecord|null;related?:Related;save:(event:FormEvent<HTMLFormElement>)=>Promise<void>;
  cancel:()=>void;busy:boolean;workspaceId?:string;
}){
  const data=record?.data;
  const contact=record?.contactId?{id:record.contactId,name:record.contactName??'Contact'}:related?.kind==='contacts'?related:null;
  const company=record?.companyId?{id:record.companyId,name:record.companyName??'Company'}:related?.kind==='companies'?related:null;
  return <form className="portable-ticket-editor" onSubmit={save}>
    <h2>{record?'Edit ticket':'Create ticket'}</h2>
    <fieldset disabled={busy}>
      <label>Ticket name<input required name="name" maxLength={160} defaultValue={data?.name}/></label>
      <label>Status<select name="ticketStatus" defaultValue={data?.ticketStatus??'New'}>
        {ticketStatuses.map(status=><option key={status}>{status}</option>)}
      </select></label>
      <label>Priority<select name="ticketPriority" defaultValue={data?.ticketPriority??'Medium'}>
        {ticketPriorities.map(priority=><option key={priority}>{priority}</option>)}
      </select></label>
      <label>Owner name<input name="owner" maxLength={100} defaultValue={data?.owner}/></label>
      <label>Source<select name="ticketSource" defaultValue={data?.ticketSource??''}>
        <option value="">No source</option>{optionValues.ticketSource.map(source=><option key={source}>{source}</option>)}
      </select></label>
      <label>Category<select name="ticketCategory" defaultValue={data?.ticketCategory??''}>
        <option value="">No category</option>{optionValues.ticketCategory.map(category=><option key={category}>{category}</option>)}
      </select></label>
      <PortableRecordPicker kind="contacts" field="contactId" label="Primary contact" value={contact} workspaceId={workspaceId}/>
      <PortableRecordPicker kind="companies" field="companyId" label="Primary company" value={company} workspaceId={workspaceId}/>
      <label className="portable-ticket-description">Description<textarea name="description" maxLength={2000} defaultValue={data?.description}/></label>
    </fieldset>
    <button type="submit" disabled={busy}>{busy?'Saving…':'Save ticket'}</button>{' '}
    <button type="button" onClick={cancel} disabled={busy}>Cancel</button>
  </form>;
}

export function PortableTickets({email,result,related,query,grant,returnFilters}:{
  email:string;result:PortableTicketPage|PortableTicketRecord;related?:Related;query:PortableTicketQuery;grant?:Grant;returnFilters?:string;
}){
  const {status,priority,source,category,search,after,sla,sort,limit}=query;
  const workspaceId=grant?.workspaceId,readOnly=grant?.role==='viewer';
  const scope=grant?'?'+new URLSearchParams({workspaceId:grant.workspaceId,grantId:grant.id}):'';
  const saving=useRef(false);
  const [record,setRecord]=useState('data' in result?result:null);
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportError,setExportError]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const relatedField=related?.kind==='contacts'?'contactId':'companyId';
  const page='records' in result?result:undefined;

  function listFilters(){
    const params=new URLSearchParams();
    if(related)params.set(relatedField,related.id);
    if(status)params.set('status',status);
    if(priority)params.set('priority',priority);
    if(source)params.set('source',source);
    if(category)params.set('category',category);
    if(search)params.set('search',search);
    if(sla)params.set('sla',sla);
    if(sort)params.set('sort',sort);
    return params;
  }

  function listPath(cursor?:PortableTicketPage){
    const params=listFilters();
    if(limit!==25)params.set('limit',String(limit));
    if(cursor?.next)params.set('after',cursor.next);
    if(cursor?.next&&cursor.nextUpdatedAt)params.set('afterUpdatedAt',cursor.nextUpdatedAt);
    if(workspaceId)params.set('workspaceId',workspaceId);
    return '/tickets'+(params.size?'?'+params:'');
  }

  const fromList=page?listFilters().toString():undefined;
  const backToTickets=withWorkspace('/tickets'+(returnFilters?'?'+returnFilters:''),workspaceId);

  async function downloadTickets(){
    setExporting(true);
    setExportError('');
    try{
      const params=listFilters();
      params.set('export','csv');
      const response=await fetch('/api/tickets?'+params);
      if(!response.ok){
        const body=await response.json() as {error?:string};
        throw Error(body.error??'Could not export tickets.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected a CSV download.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-tickets.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setExportError(error instanceof Error?error.message:'Could not export tickets.');}
    finally{setExporting(false);}
  }

  async function write(input:unknown){
    if(saving.current)return;
    saving.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tickets'+scope,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const payload=await response.json() as {record?:PortableTicketRecord;error?:string};
      if(!response.ok||!payload.record)throw Error(payload.error??'Could not save this ticket.');
      setEditing(false);
      if(record){
        setRecord(payload.record);
        setNotice('Ticket saved.');
      }else{
        window.location.assign(ticketPath(payload.record.id,workspaceId,fromList));
      }
    }catch(error){setError(error instanceof Error?error.message:'Could not save this ticket.');}
    finally{setBusy(false);saving.current=false;}
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const data=Object.fromEntries(['name','ticketStatus','ticketPriority','owner','ticketSource','ticketCategory','description']
      .map(key=>[key,form.get(key)??'']));
    const contactId=form.get('contactId')||null,companyId=form.get('companyId')||null;
    await write({action:'save',data,contactId:contactId===(record?.contactId??null)?undefined:contactId,
      companyId:companyId===(record?.companyId??null)?undefined:companyId,
      ...(record?{id:record.id,expectedRevision:record.revision}:{})});
  }

  const start=()=>{setError('');setNotice('');setEditing(true);};
  const cancel=()=>{setError('');setEditing(false);};

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="tickets" workspaceId={workspaceId}/>
    <section aria-labelledby="portable-ticket-heading">
      {record&&<a href={backToTickets}>Back to tickets</a>}
      {related&&<p><a href={recordPath(related.kind,related.id,workspaceId)}>Back to {related.name}</a></p>}
      {grant&&<p>{'Shared workspace · '+(readOnly?'View only':'Editor')}</p>}
      <div className="portable-contacts-heading">
        <h1 id="portable-ticket-heading">{record?.data.name??'Tickets'}</h1>
        {!editing&&!readOnly&&<button type="button" onClick={start} disabled={busy}>{record?'Edit ticket':'Create ticket'}</button>}
      </div>
      <p role="status">{notice}</p>
      {error&&<p role="alert">{error}{record&&<> <a href={ticketPath(record.id,workspaceId,returnFilters)}>Reload ticket</a></>}</p>}
      {page&&!related&&!grant&&<TicketSlaSettings/>}
      {editing&&<TicketEditor record={record} related={related} save={save} cancel={cancel} busy={busy} workspaceId={workspaceId}/>}
      {record&&!editing&&<>
        <dl>
          <dt>Status</dt><dd>{record.data.ticketStatus}</dd>
          <dt>Priority</dt><dd>{record.data.ticketPriority}</dd>
          <dt>Owner</dt><dd>{record.data.owner||'Unassigned'}</dd>
          <dt>Source</dt><dd>{record.data.ticketSource||'—'}</dd>
          <dt>Category</dt><dd>{record.data.ticketCategory||'—'}</dd>
          <dt>Description</dt><dd style={{whiteSpace:'pre-wrap'}}>{record.data.description||'—'}</dd>
          <dt>Primary contact</dt><dd><TicketLink kind="contacts" id={record.contactId} name={record.contactName} workspaceId={workspaceId}/></dd>
          <dt>Primary company</dt><dd><TicketLink kind="companies" id={record.companyId} name={record.companyName} workspaceId={workspaceId}/></dd>
          <dt>Close SLA</dt><dd><TicketSlaSummary ticket={record}/></dd>
          <dt>Closed date</dt><dd>{record.closedAt?<time dateTime={record.closedAt}>{displayDate(record.closedAt)}</time>:'—'}</dd>
        </dl>
        {!readOnly&&<button type="button" disabled={busy} onClick={()=>write({action:'status',id:record.id,expectedRevision:record.revision,
          status:record.data.ticketStatus==='Closed'?'New':'Closed'})}>{record.data.ticketStatus==='Closed'?'Reopen ticket':'Close ticket'}</button>}
      </>}
      {page&&<>
        <form action="/tickets" method="get" aria-label="Ticket filters">
          {related&&<input type="hidden" name={relatedField} value={related.id}/>}
          {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
          <fieldset>
            <label>Search tickets<input name="search" type="search" maxLength={120} defaultValue={search}/></label>
            <label>Status<select name="status" defaultValue={status??''}><option value="">All statuses</option>
              {ticketStatuses.map(status=><option key={status}>{status}</option>)}
            </select></label>
            <label>Priority<select name="priority" defaultValue={priority??''}><option value="">All priorities</option>
              {ticketPriorities.map(priority=><option key={priority}>{priority}</option>)}
            </select></label>
            <label>Source<select name="source" defaultValue={source??''}><option value="">All sources</option>
              {optionValues.ticketSource.map(source=><option key={source}>{source}</option>)}
            </select></label>
            <label>Category<select name="category" defaultValue={category??''}><option value="">All categories</option>
              {optionValues.ticketCategory.map(category=><option key={category}>{category}</option>)}
            </select></label>
            <label>Close SLA<select name="sla" defaultValue={sla??''}><option value="">All close-time targets</option>
              <option value="due_soon">{closeSlaLabels.due_soon}</option>
              <option value="overdue">{closeSlaLabels.overdue}</option>
            </select></label>
            <label>Sort<select name="sort" defaultValue={sort??''}><option value="">Default order</option>
              <option value="updated">Recently updated</option>
            </select></label>
          </fieldset>
          <button type="submit">Apply filters</button>
        </form>
        {!grant&&<div>
          <button type="button" onClick={downloadTickets} disabled={exporting}>{exporting?'Preparing CSV…':'Export CSV'}</button>
          {exportError&&<p role="alert">{exportError}</p>}
        </div>}
        {page.records.length?<div className="portable-contacts-table"><table>
          <thead><tr>{['Ticket','Status','Priority','Source','Close SLA','Primary contact','Primary company'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{page.records.map(ticket=><tr key={ticket.id}>
            <td><a href={ticketPath(ticket.id,workspaceId,fromList)}>{ticket.data.name}</a></td><td>{ticket.data.ticketStatus}</td><td>{ticket.data.ticketPriority}</td>
            <td>{ticket.data.ticketSource||'—'}</td><td><TicketSlaSummary ticket={ticket}/></td>
            <td><TicketLink kind="contacts" id={ticket.contactId} name={ticket.contactName} workspaceId={workspaceId}/></td>
            <td><TicketLink kind="companies" id={ticket.companyId} name={ticket.companyName} workspaceId={workspaceId}/></td>
          </tr>)}</tbody>
        </table></div>:<p>No matching tickets.</p>}
        {(after||page.next)&&<nav aria-label="Ticket pages">
          {after&&<a href={listPath()}>First tickets</a>}{' '}
          {page.next&&<a href={listPath(page)}>Next tickets</a>}
        </nav>}
      </>}
    </section>
  </main>;
}
