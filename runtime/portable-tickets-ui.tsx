'use client';

import {useRef,useState,type FormEvent} from 'react';
import {supportTags} from '../lib/team-inbox';
import {ticketPriorities,ticketStatuses} from '../lib/crm';
import type {PortableTicketPage,PortableTicketQuery,PortableTicketRecord} from '../lib/portable-tickets';
import {standardField} from '../lib/standard-properties';
import {responseLabels} from '../lib/first-response';
import {ResponseDetail,ResponseSettings,TicketTime} from './portable-first-response-ui';
import {closeSlaInput,closeSlaLabels,slaPriorities,type CloseSlaPolicy} from '../lib/ticket-sla';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableTicketCasePortal} from './portable-case-portal-ui';
import {PortableRecycleAction,portableRecycleBinLink} from './portable-contact-recycle-ui';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type Assignee={id:string;label:string};
type Related={kind:'contacts'|'companies';id:string;name:string};
type TicketSlaPolicy=Pick<CloseSlaPolicy,'revision'|'enabled'|'targets'|'warningMinutes'>;
type Grant={id:string;canEdit:boolean;canCreate:boolean;canDelete:boolean;restrictedEdit:boolean;workspaceId:string};
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

function TicketTags({tags,workspaceId,filters}:{tags:string[];workspaceId?:string;filters?:string}){
  return <span className="ticket-tags">{tags.map(tag=>{
    const params=new URLSearchParams(filters);
    for(const key of ['after','afterDueAt','afterUpdatedAt'])params.delete(key);
    params.set('tag',tag);
    return <a key={tag} className="ticket-tag" href={withWorkspace('/tickets?'+params,workspaceId)}>{tag}</a>;
  })}</span>;
}

function FirstResponseSummary({ticket}:{ticket:PortableTicketRecord}){
  const response=ticket.firstResponse;
  if(!response)return <>—</>;
  return <>{responseLabels[response.status]}{!response.respondedAt&&<> · <TicketTime value={response.dueAt}/></>}</>;
}

function TicketSlaSummary({ticket}:{ticket:PortableTicketRecord}){
  const sla=ticket.sla;
  if(!sla?.receipt||!sla.status)return <>No close-time target</>;
  return <>{closeSlaLabels[sla.status]}{' · Close by '}
    <TicketTime value={sla.receipt.dueAt}/></>;
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

function TicketEditor({record,related,save,cancel,busy,workspaceId,assignees,restrictedEdit}:{
  record:PortableTicketRecord|null;related?:Related;save:(event:FormEvent<HTMLFormElement>)=>Promise<void>;
  cancel:()=>void;busy:boolean;workspaceId?:string;assignees:Assignee[];restrictedEdit:boolean;
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
      <label>Assigned to<select name="assigneeId" defaultValue={record?.assigneeId??''}>
        {(!restrictedEdit||!record)&&<option value="">{restrictedEdit?'Assign to me':'Unassigned'}</option>}
        {record?.assigneeId&&!assignees.some(item=>item.id===record.assigneeId)&&<option value={record.assigneeId}>{record.assigneeLabel} (unavailable)</option>}
        {assignees.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {data?.owner&&<label>Owner name (legacy)<input name="owner" maxLength={100} defaultValue={data.owner}/></label>}
      <label>Source<select name="ticketSource" defaultValue={data?.ticketSource??''}>
        <option value="">No source</option>{optionValues.ticketSource.map(source=><option key={source}>{source}</option>)}
      </select></label>
      <label>Category<select name="ticketCategory" defaultValue={data?.ticketCategory??''}>
        <option value="">No category</option>{optionValues.ticketCategory.map(category=><option key={category}>{category}</option>)}
      </select></label>
      <label>Internal tags<textarea name="tags" rows={2} aria-describedby="ticket-tag-hint" defaultValue={data?.tags?.join('\n')}/><small id="ticket-tag-hint">One tag per line. Up to 10 tags, 40 characters each.</small></label>
      <PortableRecordPicker kind="contacts" field="contactId" label="Primary contact" value={contact} workspaceId={workspaceId}/>
      <PortableRecordPicker kind="companies" field="companyId" label="Primary company" value={company} workspaceId={workspaceId}/>
      <label className="portable-ticket-description">Description<textarea name="description" maxLength={2000} defaultValue={data?.description}/></label>
    </fieldset>
    <button type="submit" disabled={busy}>{busy?'Saving…':'Save ticket'}</button>{' '}
    <button type="button" onClick={cancel} disabled={busy}>Cancel</button>
  </form>;
}

export function PortableTickets({email,result,related,query,grant,returnFilters,assignees}:{
  email:string;result:PortableTicketPage|PortableTicketRecord;related?:Related;query:PortableTicketQuery;assignees:Assignee[];grant?:Grant;returnFilters?:string;
}){
  const {status,priority,source,category,search,after,sla,sort,limit}=query;
  const workspaceId=grant?.workspaceId;
  const scope=grant?'?'+new URLSearchParams({workspaceId:grant.workspaceId,grantId:grant.id}):'';
  const inboxConversationId='data' in result?result.inboxConversationId:null;
  const saving=useRef(false);
  const [record,setRecord]=useState('data' in result?result:null);
  const readOnly=grant?.canEdit===false||record?.editable===false;
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportError,setExportError]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const relatedField=related?.kind==='contacts'?'contactId':'companyId';
  const page='records' in result?result:undefined;

  // Readers can filter by names on visible tickets without opening the workspace directory.
  const filterAssignees=new Map(assignees.map(person=>[person.id,person.label]));
  for(const ticket of page?.records??[]){
    if(ticket.assigneeId&&!filterAssignees.has(ticket.assigneeId))filterAssignees.set(ticket.assigneeId,ticket.assigneeLabel||'Teammate');
  }
  if(query.assignee&&!['me','unassigned','unavailable'].includes(query.assignee)&&!filterAssignees.has(query.assignee)){
    filterAssignees.set(query.assignee,'Selected teammate');
  }

  function listFilters(){
    const params=new URLSearchParams();
    if(related)params.set(relatedField,related.id);
    if(status)params.set('status',status);
    if(priority)params.set('priority',priority);
    if(source)params.set('source',source);
    if(category)params.set('category',category);
    if(query.tag)params.set('tag',query.tag);
    if(search)params.set('search',search);
    if(sla)params.set('sla',sla);
    if(query.assignee)params.set('assignee',query.assignee);
    if(query.response)params.set('response',query.response);
    if(sort)params.set('sort',sort);
    return params;
  }

  function listPath(cursor?:PortableTicketPage){
    const params=listFilters();
    if(limit!==25)params.set('limit',String(limit));
    if(cursor?.next)params.set('after',cursor.next);
    if(cursor?.next&&cursor.nextUpdatedAt)params.set('afterUpdatedAt',cursor.nextUpdatedAt);
    if(cursor?.next&&cursor.nextDueAt)params.set('afterDueAt',cursor.nextDueAt);
    if(workspaceId)params.set('workspaceId',workspaceId);
    return '/tickets'+(params.size?'?'+params:'');
  }

  const deadlineView=sort==='response_due';
  const helpDesk=Boolean(page&&!related&&deadlineView&&query.response);
  const currentPage=listFilters();
  if(limit!==25)currentPage.set('limit',String(limit));
  if(after)currentPage.set('after',after);
  if(query.afterDueAt)currentPage.set('afterDueAt',query.afterDueAt);
  if(query.afterUpdatedAt)currentPage.set('afterUpdatedAt',query.afterUpdatedAt);
  const fromList=page?currentPage.toString():undefined;
  const originFilters=new URLSearchParams(returnFilters);
  const fromHelpDesk=originFilters.get('sort')==='response_due'&&originFilters.has('response')&&
    !originFilters.has('contactId')&&!originFilters.has('companyId');
  function firstResponseQueue(assignee:PortableTicketQuery['assignee']){
    const params=listFilters();
    if(assignee)params.set('assignee',assignee);
    else params.delete('assignee');
    params.set('response','unanswered');
    params.set('sort','response_due');
    return withWorkspace('/tickets?'+params,workspaceId);
  }
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
    const tags=String(form.get('tags')??'').split(/\r?\n/).map(tag=>tag.trim()).filter(Boolean);
    if(!supportTags.safeParse(tags).success){
      setError('Use up to 10 distinct tags. Each tag must be 1–40 characters on its own line.');return;
    }
    const assigneeId=String(form.get('assigneeId')??'')||null;
    await write({action:'save',assigneeId:assigneeId===(record?.assigneeId??null)?undefined:assigneeId,data:{...data,tags},contactId:contactId===(record?.contactId??null)?undefined:contactId,
      companyId:companyId===(record?.companyId??null)?undefined:companyId,
      ...(record?{id:record.id,expectedRevision:record.revision}:{})});
  }

  const start=()=>{setError('');setNotice('');setEditing(true);};
  const cancel=()=>{setError('');setEditing(false);};

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page={helpDesk||fromHelpDesk?'help-desk':'tickets'} workspaceId={workspaceId} recycleHref={portableRecycleBinLink('tickets',workspaceId)}/>
    <section aria-labelledby="portable-ticket-heading">
      {record&&<a href={backToTickets}>{fromHelpDesk?'Back to Help desk':'Back to tickets'}</a>}
      {related&&<p><a href={recordPath(related.kind,related.id,workspaceId)}>Back to {related.name}</a></p>}
      {grant&&<p>{'Shared workspace · '+(readOnly?'View only':'Editor')}</p>}
      <div className="portable-contacts-heading">
        <h1 id="portable-ticket-heading">{record?.data.name??(helpDesk?'Help desk':'Tickets')}</h1>
        {!editing&&(record?!readOnly:grant?.canCreate!==false)&&<button type="button" onClick={start} disabled={busy}>{record?'Edit ticket':'Create ticket'}</button>}
      </div>
      <p role="status">{notice}</p>
      {error&&<p role="alert">{error}{record&&<> <a href={ticketPath(record.id,workspaceId,returnFilters)}>Reload ticket</a></>}{page&&<> <button type="button" onClick={()=>window.location.reload()}>Refresh tickets</button></>}</p>}
      {page&&!helpDesk&&!related&&!grant&&<><TicketSlaSettings/><ResponseSettings/></>}
      {record&&!editing&&<ResponseDetail workspaceId={workspaceId} record={record} readOnly={readOnly} busy={busy} write={write}/>}
      {editing&&<TicketEditor assignees={assignees} restrictedEdit={!!grant?.restrictedEdit} record={record} related={related} save={save} cancel={cancel} busy={busy} workspaceId={workspaceId}/>}
      {record&&!editing&&<>
        <dl>
          <dt>Status</dt><dd>{record.data.ticketStatus}</dd>
          <dt>Priority</dt><dd>{record.data.ticketPriority}</dd>
          <dt>Assigned to</dt><dd>{record.assigneeLabel||'Unassigned'}</dd>
          {record.data.owner&&<><dt>Owner name (legacy)</dt><dd>{record.data.owner}</dd></>}
          <dt>Source</dt><dd>{record.data.ticketSource||'—'}</dd>
          {inboxConversationId&&<><dt>Team inbox</dt><dd><a href={withWorkspace('/?view=team-inbox&id='+inboxConversationId,workspaceId)}>Open original conversation</a></dd></>}
          <dt>Category</dt><dd>{record.data.ticketCategory||'—'}</dd>
          <dt>Internal tags</dt><dd>{record.data.tags?.length?<TicketTags tags={record.data.tags} workspaceId={workspaceId} filters={returnFilters}/>:'—'}</dd>
          <dt>Description</dt><dd style={{whiteSpace:'pre-wrap'}}>{record.data.description||'—'}</dd>
          <dt>Primary contact</dt><dd><TicketLink kind="contacts" id={record.contactId} name={record.contactName} workspaceId={workspaceId}/></dd>
          <dt>Primary company</dt><dd><TicketLink kind="companies" id={record.companyId} name={record.companyName} workspaceId={workspaceId}/></dd>
          <dt>Close SLA</dt><dd><TicketSlaSummary ticket={record}/></dd>
          <dt>Closed date</dt><dd>{record.closedAt?<TicketTime value={record.closedAt} day/>:'—'}</dd>
        </dl>
        {!readOnly&&grant?.canDelete!==false&&<PortableRecycleAction key={record.id+':'+record.revision} action="archive" kind="tickets"
          id={record.id} revision={record.revision} name={record.data.name} scope={workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined}
          disabled={busy} onBusy={setBusy} onDone={()=>window.location.assign(portableRecycleBinLink('tickets',workspaceId))}/>}
        {!workspaceId&&<PortableTicketCasePortal key={record.id+':'+record.revision} ticket={record}/>}
        {!workspaceId&&<a href={'/?view=workflows&runTicketId='+record.id+'#recent-runs'}>View Ticket workflow runs</a>}
        {!readOnly&&<button type="button" disabled={busy} onClick={()=>write({action:'status',id:record.id,expectedRevision:record.revision,
          status:record.data.ticketStatus==='Closed'?'New':'Closed'})}>{record.data.ticketStatus==='Closed'?'Reopen ticket':'Close ticket'}</button>}
      </>}
      {page&&<>
        <nav aria-label="First-response queues">
          {([[undefined,'First responses due'],['me','My first responses'],['unassigned','Unassigned first responses'],['unavailable','First responses needing reassignment']] as const).map(([assignee,label])=>
            <a key={label} href={firstResponseQueue(assignee)}
              aria-current={query.response==='unanswered'&&deadlineView&&query.assignee===assignee?'page':undefined}>{label}</a>)}
        </nav>
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
            <label>Tag<input name="tag" maxLength={40} defaultValue={query.tag}/></label>
            <label>Assigned to<select name="assignee" aria-label="Assigned to" defaultValue={query.assignee??''}>
              <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
              <option value="unavailable">Unavailable assignees (open tickets)</option>
              {filterAssignees.size>0&&<optgroup label="Teammates">{Array.from(filterAssignees,([id,label])=>
                <option key={id} value={id}>{label}</option>)}</optgroup>}
            </select></label>
            <label>First response<select name="response" aria-label="First response" defaultValue={query.response??''}><option value="">All response targets</option>
              <option value="unanswered">All awaiting a first response</option>
              <option value="due_next_hour">Due in the next hour</option>
              {Object.entries(responseLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
            <label>Close SLA<select name="sla" defaultValue={sla??''}><option value="">All close-time targets</option>
              <option value="due_soon">{closeSlaLabels.due_soon}</option>
              <option value="overdue">{closeSlaLabels.overdue}</option>
            </select></label>
            <label>Sort<select name="sort" defaultValue={sort??''}><option value="">Default order</option>
              <option value="updated">Recently updated</option><option value="response_due">Earliest first-response deadline</option>
            </select></label>
          </fieldset>
          <button type="submit">Apply filters</button>
        </form>
        {!grant&&<div>
          <button type="button" onClick={downloadTickets} disabled={exporting}>{exporting?'Preparing CSV…':'Export CSV'}</button>
          {exportError&&<p role="alert">{exportError}</p>}
        </div>}
        {page.records.length?<div className="portable-contacts-table"><table>
          <thead><tr>{['Ticket','Status','Priority','Source','Close SLA',...(deadlineView?[]:['First response']),'Primary contact','Primary company'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{page.records.map(ticket=><tr key={ticket.id}>
            <td><a href={ticketPath(ticket.id,workspaceId,fromList)}>{ticket.data.name}</a>
              {deadlineView&&<div className="ticket-deadline"><FirstResponseSummary ticket={ticket}/></div>}
              {(helpDesk||query.assignee==='unavailable')&&<div className="ticket-queue-assignment">
                {ticket.assigneeLabel?'Assigned to '+ticket.assigneeLabel:'Unassigned'}
                {query.assignee==='unavailable'&&!readOnly&&ticket.editable!==false&&ticket.assigneeId&&
                  <button type="button" disabled={busy} aria-label={'Take over ticket: '+ticket.data.name}
                    onClick={()=>void write({action:'take_unavailable',id:ticket.id,expectedRevision:ticket.revision,previousAssigneeId:ticket.assigneeId})}>Take over ticket</button>}
                {helpDesk&&!readOnly&&!grant?.restrictedEdit&&!ticket.closedAt&&!ticket.assigneeId&&ticket.firstResponse&&!ticket.firstResponse.respondedAt&&
                  <button type="button" disabled={busy} aria-label={'Take ticket: '+ticket.data.name}
                    onClick={()=>void write({action:'take_first_response',id:ticket.id,expectedRevision:ticket.revision})}>Take ticket</button>}
              </div>}
              {ticket.data.tags&&ticket.data.tags.length>0&&<TicketTags tags={ticket.data.tags} workspaceId={workspaceId} filters={fromList}/>}
            </td><td>{ticket.data.ticketStatus}</td><td>{ticket.data.ticketPriority}</td>
            <td>{ticket.data.ticketSource||'—'}</td><td><TicketSlaSummary ticket={ticket}/></td>{!deadlineView&&<td><FirstResponseSummary ticket={ticket}/></td>}
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
