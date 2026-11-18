'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {readPortableActivityHistory,readPortableActivityRemovals,readPortableOutreach} from '../db/postgres/portable-contact-activity-store';
import {localDateTime,scheduledInstants} from '../lib/email/schedule';
import {hasActivityFilters,portableOutreachKinds,type PortableActivityFilters,type PortableActivityMutation,type PortableOutreach} from '../lib/portable-contact-activities';
import {activityTypeLabel} from '../lib/activity-date-policy';
import {jobDetailsHref} from '../lib/portable-job-labels';

type Page=NonNullable<Awaited<ReturnType<typeof readPortableOutreach>>>;
type Activity=Page['items'][number]&{fromGmail?:true};
const date=(at:number)=>new Date(at).toLocaleString();

type HistoryPage=NonNullable<Awaited<ReturnType<typeof readPortableActivityHistory>>>;
function ActivityHistory({endpoint,item}:{endpoint:string;item:Activity}){
  const [open,setOpen]=useState(false);
  const [before,setBefore]=useState<number|null>(null);
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;page?:HistoryPage}>();
  const path=endpoint+'&history='+item.id+(before===null?'':'&before='+before);
  const key=path+'#'+item.revision;
  const visible=result?.key===key?result:undefined;

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch(path,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as HistoryPage;
      if(!controller.signal.aborted)setResult({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[open,path,key,retry]);

  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Activity history</summary>
    {open&&<>
      {!visible?<p role="status">Loading changes…</p>:!visible.page?<p role="alert">Could not load activity history.{' '}
        <button type="button" onClick={()=>{setResult(undefined);setRetry(value=>value+1);}}>Retry</button>
      </p>:visible.page.items.length===0?<p>No saved edits for this activity.</p>:<ul>
        {visible.page.items.map(change=><li key={change.revision}>
          <p>{change.editorName} · <time dateTime={new Date(change.editedAt).toISOString()}>{date(change.editedAt)}</time></p>
          {change.previousAt!==change.occurredAt&&<p>When it happened: {date(change.previousAt)} → {date(change.occurredAt)}</p>}
          {change.previousSummary!==change.summary&&<div><p>Previous summary: {change.previousSummary}</p><p>Saved summary: {change.summary}</p></div>}
        </li>)}
      </ul>}
      {before!==null&&<button type="button" onClick={()=>setBefore(null)}>Newest edits</button>}{' '}
      {visible?.page?.next!=null&&<button type="button" onClick={()=>setBefore(visible.page!.next)}>Older edits</button>}
    </>}
  </details>;
}

type RemovalsPage=NonNullable<Awaited<ReturnType<typeof readPortableActivityRemovals>>>;
function ActivityRemovals({endpoint,refresh}:{endpoint:string;refresh:number}){
  const [open,setOpen]=useState(false);
  const [after,setAfter]=useState<RemovalsPage['next']>(null);
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;page?:RemovalsPage}>();
  const path=endpoint+'&removed=1'+(after?'&'+new URLSearchParams({afterAt:String(after.at),afterId:after.id}):'');
  const key=path+'#'+refresh+':'+retry;
  const visible=result?.key===key?result:undefined;

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch(path,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as RemovalsPage;
      if(!controller.signal.aborted)setResult({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[open,path,key]);

  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Activity removals by teammates</summary>
    {open&&<>
      {!visible?<p role="status">Loading removals…</p>:!visible.page?<p role="alert">Could not load removals.{' '}
        <button type="button" onClick={()=>setRetry(value=>value+1)}>Retry</button>
      </p>:visible.page.items.length===0?<p>No removals on this page.</p>:<ul>
        {visible.page.items.map(item=><li key={item.id}>
          {activityTypeLabel(item.kind)} removed by {item.removedBy} · <time dateTime={new Date(item.removedAt).toISOString()}>{date(item.removedAt)}</time>
        </li>)}
      </ul>}
      {after&&<button type="button" onClick={()=>setAfter(null)}>Newest removals</button>}{' '}
      {visible?.page?.next&&<button type="button" onClick={()=>setAfter(visible.page!.next)}>Older removals</button>}
    </>}
  </details>;
}

type ActivitySource={contactId:string}|{kind:'companies'|'deals';recordId:string};
export function PortableLoggedActivity({readOnly,workspaceId,grantId,refreshKey=0,onSaved,...source}:ActivitySource&{
  readOnly:boolean;workspaceId?:string;grantId?:string;refreshKey?:number;onSaved?:()=>void;
}){
  const query=new URLSearchParams('contactId' in source?{contactId:source.contactId}:{kind:source.kind,recordId:source.recordId});
  if(workspaceId)query.set('workspaceId',workspaceId);
  const endpoint='/api/logged-activities?'+query;
  const inFlight=useRef(false);
  const [filters,setFilters]=useState<PortableActivityFilters>({});
  const filtered=hasActivityFilters(filters);
  // Filters apply to the list read only; writes, history and removals keep the unfiltered endpoint.
  const listEndpoint=endpoint+(filtered?'&'+new URLSearchParams(Object.entries(filters).filter(([,value])=>value) as [string,string][]):'');
  const [filterError,setFilterError]=useState('');
  const [result,setResult]=useState<{key:string;page?:Page}>();
  const [after,setAfter]=useState<Page['next']>(null);
  const [refresh,setRefresh]=useState(0);
  const [pending,setPending]=useState<PortableOutreach>();
  const [editing,setEditing]=useState<Activity>();
  const editingTime=editing?localDateTime(new Date(editing.occurredAt),Intl.DateTimeFormat().resolvedOptions().timeZone):'';
  const [saving,setSaving]=useState(false);
  const pageKey=JSON.stringify([listEndpoint,after,refresh,refreshKey]);
  const visible=result?.key===pageKey?result:undefined;
  const page=visible?.page,loadError=!!visible&&!visible.page;
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');

  useEffect(()=>{
    const controller=new AbortController();
    const cursor=after?'&'+new URLSearchParams({afterAt:String(after.at),afterId:after.id}):'';
    fetch(listEndpoint+cursor,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as Page;
      if(!controller.signal.aborted)setResult({key:pageKey,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key:pageKey});});
    return ()=>controller.abort();
  },[listEndpoint,after,pageKey]);

  function applyFilters(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const fields=new FormData(event.currentTarget);
    const channel=portableOutreachKinds.find(value=>value===fields.get('channel'));
    const from=String(fields.get('from')??'')||undefined,to=String(fields.get('to')??'')||undefined;
    if(from&&to&&from>to){setFilterError('Choose a From date on or before the To date.');return;}
    setFilterError('');
    setAfter(null);
    setFilters({channel,from,to});
  }

  async function send(input:PortableOutreach|PortableActivityMutation,success:string,uncertain:string){
    if(inFlight.current)return false;
    inFlight.current=true;
    setSaving(true);
    setError('');
    setStatus('');
    try{
      const target=grantId?endpoint+'&grantId='+grantId:endpoint;
      const response=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      if(!response.ok){
        const body=await response.json() as {error?:string};
        setError(body.error||'Could not save the activity.');
        return false;
      }
      setAfter(null);
      setRefresh(value=>value+1);
      setStatus(success);
      onSaved?.();
      return true;
    }catch{
      setError(uncertain);
      return false;
    }finally{inFlight.current=false;setSaving(false);}
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(inFlight.current)return;
    const form=event.currentTarget,fields=new FormData(form);
    const local=String(fields.get('occurredAt')??'');
    // An unchanged displayed time keeps its exact stored seconds and offset.
    const sameDate=editing&&local===editingTime;
    const times=sameDate?[]:scheduledInstants(local,Intl.DateTimeFormat().resolvedOptions().timeZone);
    if(!sameDate&&times.length!==1){setError('Choose an unambiguous date and time in your browser time zone.');return;}
    const occurredAt=sameDate?editing.occurredAt:Date.parse(times[0]);
    const summary=String(fields.get('summary')??'');
    if(editing){
      const saved=await send({action:'update',id:editing.id,expectedRevision:editing.revision,occurredAt,summary},
        'Activity updated.','Could not confirm the update. Refresh the timeline before retrying.');
      if(saved)setEditing(undefined);
      return;
    }
    const kind=portableOutreachKinds.find(value=>value===fields.get('kind'));
    if(!kind)return;
    // Retry the same request only if the submitted details still match it.
    const input=pending?.kind===kind&&pending.occurredAt===occurredAt&&pending.summary===summary
      ?pending:{id:crypto.randomUUID(),kind,occurredAt,summary};
    setPending(input);
    if(await send(input,activityTypeLabel(kind)+' logged.','Could not confirm the save. Submit again to check the same request.')){
      form.reset();
      setPending(undefined);
    }
  }

  async function remove(item:Activity){
    if(inFlight.current||!confirm('Remove this logged activity and its edit history?'))return;
    const removed=await send({action:'remove',id:item.id,expectedRevision:item.revision},'Activity removed.',
      'Could not confirm the removal. Refresh the timeline to check.');
    if(removed&&editing?.id===item.id)setEditing(undefined);
  }

  return <section id="portable-logged-activities" className="portable-record-panel" aria-label="Logged activities" tabIndex={-1}>
    <h2>Logged activities</h2>
    {page&&<p><strong>Last contacted</strong> · {page.lastContacted===null?'No outreach logged':date(page.lastContacted)}</p>}
    {page&&<p><strong>Last logged activity</strong> · {page.lastActivity===null?'No activity logged':date(page.lastActivity)}</p>}
    {!readOnly&&<form className="portable-activity-editor" key={editing?.id??'new'} onSubmit={save}>
      {editing&&<p>{'Editing '+(editing.fromGmail?'received Gmail':activityTypeLabel(editing.kind).toLowerCase())}</p>}
      <fieldset disabled={saving}>
        {!editing&&<label>Activity type<select name="kind">{portableOutreachKinds.map(kind=><option key={kind} value={kind}>{activityTypeLabel(kind)}</option>)}</select></label>}
        <label>When it happened (your time zone)<input type="datetime-local" name="occurredAt" defaultValue={editingTime} required/></label>
        <label className="portable-note-text">Summary<textarea name="summary" defaultValue={editing?.summary} maxLength={editing?.fromGmail?10_000:2_000} required/></label>
      </fieldset>
      <button type="submit" disabled={saving}>{editing?'Save changes':saving?'Logging…':'Log activity'}</button>
      {editing&&<button type="button" disabled={saving} onClick={()=>setEditing(undefined)}>Cancel edit</button>}
    </form>}
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error}</p>}
    <form className="portable-activity-filters" aria-label="Filter activities" onSubmit={applyFilters} key={'activity-filter:'+listEndpoint}>
      <label>Channel<select name="channel" defaultValue={filters.channel??''}>
        <option value="">All channels</option>
        {portableOutreachKinds.map(kind=><option key={kind} value={kind}>{activityTypeLabel(kind)}</option>)}
      </select></label>
      <label>From (UTC date)<input type="date" name="from" defaultValue={filters.from??''}/></label>{' '}
      <label>To (UTC date)<input type="date" name="to" defaultValue={filters.to??''}/></label>{' '}
      <div className="portable-activity-filter-actions">
        <button type="submit">Apply filters</button>
        {filtered&&<button type="button" onClick={()=>{setFilterError('');setAfter(null);setFilters({});}}>Clear filters</button>}
      </div>
    </form>
    {filterError&&<p role="alert">{filterError}</p>}
    {loadError&&<p role="alert">Could not load activities. <button type="button" onClick={()=>setRefresh(value=>value+1)}>Retry</button></p>}
    {!loadError&&filtered&&page&&page.items.length===0&&<p>No activities match these filters. Dates are inclusive UTC days.</p>}
    {!loadError&&page?.items.length?<ul>{page.items.map((item:Activity)=>{
      const hasHistory=!item.fromInquiry&&!item.fromScheduledGmail&&(!workspaceId||!item.fromGmail);
      return <li key={item.id}>
          <strong>{item.fromScheduledGmail?'Scheduled Gmail':item.fromGmail?'Received Gmail':activityTypeLabel(item.kind)}</strong> · <time dateTime={new Date(item.occurredAt).toISOString()}>{date(item.occurredAt)}</time>
          {item.fromInquiry&&' · Unverified public form inquiry'}
          <p style={item.fromGmail?{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}:item.fromInquiry?{whiteSpace:'pre-wrap'}:undefined}>{item.summary}</p>
          {item.scheduledJobId&&<a href={jobDetailsHref(item.scheduledJobId)}>View email job receipt</a>}
          {!readOnly&&hasHistory&&<>
            <button type="button" disabled={saving} onClick={()=>{setEditing(item);setError('');setStatus('');}}>Edit activity</button>{' '}
            <button type="button" disabled={saving} onClick={()=>void remove(item)}>Remove activity</button>
          </>}
          {hasHistory&&<ActivityHistory endpoint={endpoint} item={item}/>}
      </li>;
    })}</ul>:null}
    {after&&<button type="button" onClick={()=>setAfter(null)}>Newest activities</button>}{' '}
    {page?.next&&<button type="button" onClick={()=>setAfter(page.next)}>Older activities</button>}
    <ActivityRemovals key={'activity-removals:'+endpoint} endpoint={endpoint} refresh={refresh+refreshKey}/>
  </section>;
}
