'use client';

import {useEffect,useState,type FormEvent} from 'react';
import type {DashboardRecordsPage,PortableDashboard,PortableDashboardDefinition,PortableDashboardDetail} from '../lib/portable-dashboards';
import type {DealsWithoutFollowUp} from '../db/postgres/deal-follow-up-store';
import {portableRecordPath} from '../lib/portable-record-path';
import {recordSearchLimit} from '../lib/portable-records';
import type {PortableReportAssigneeOption,PortableReportPage,PortableReportPipelineOption} from '../lib/portable-reports';
import {ReportResults,type ReportCustomPropertyLabel} from './portable-reports-ui';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableFollowUpPanel} from './portable-follow-up-panel';
import './portable-contacts.css';
import './portable-dashboards.css';

type DashboardPage={items:PortableDashboard[];next:string|null};
type DraftCard=PortableDashboardDefinition['cards'][number]&{label:string};
const api='/api/reporting';
const reportPath=(id:string)=>'/?view=reports&reportId='+encodeURIComponent(id);

async function request<T>(query='',body?:unknown){
  const response=await fetch(api+query,body?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }:{cache:'no-store'});
  if(!response.ok){
    const result=await response.json().catch(()=>null) as {error?:string}|null;
    throw Error(result?.error??'Could not complete the dashboard request.');
  }
  return await response.json() as T;
}

type ReportLabels={pipelines:PortableReportPipelineOption[];assignees:PortableReportAssigneeOption[];customProperties:ReportCustomPropertyLabel[]};

function DashboardCardResults({card,dashboardId,workspaceId,...labels}:ReportLabels&{
  card:Extract<PortableDashboardDetail['cards'][number],{missing:false}>;dashboardId:string;workspaceId?:string;
}){
  const [selection,setSelection]=useState<{group?:string;after?:string}|null>(null);
  const [result,setResult]=useState<{path:string;page?:DashboardRecordsPage;error?:string}>();
  const [attempt,setAttempt]=useState(0);
  const params=new URLSearchParams({view:'dashboardRecords',id:dashboardId,reportId:card.reportId});
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(selection?.after)params.set('after',selection.after);
  if(selection?.group!==undefined)params.set('group',selection.group);
  const path=selection?api+'?'+params:null;
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();
    async function load(url:string){
      try{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error(response.status===404?'This dashboard or report is unavailable.':'Could not load matching records.');
        const page=await response.json() as DashboardRecordsPage;
        if(!controller.signal.aborted)setResult({path:url,page});
      }catch(error){
        if(!controller.signal.aborted)setResult({path:url,error:error instanceof Error?error.message:'Could not load matching records.'});
      }
    }
    void load(path);
    return ()=>controller.abort();
  },[path,attempt]);
  function select(next:typeof selection){
    setResult(undefined);
    setSelection(next);
    setAttempt(n=>n+1);
  }
  const current=result?.path===path?result:undefined,page=current?.page;
  const group=selection?.group===undefined?undefined:card.result.rows.find(row=>(row.key??'')===selection.group)?.label;
  return <>
    <ReportResults preview={{definition:card.definition,result:card.result}} {...labels} onOpenRecords={group=>select({group})}/>
    {selection&&<section className="portable-dashboard-records" aria-label={'Matching records for '+card.definition.name} aria-live="polite">
      <div><h4>{group?'Records in '+group:'Matching '+card.definition.kind}</h4><button type="button" onClick={()=>select(null)}>Close</button></div>
      {current?.error?<p role="alert">{current.error} <button type="button" onClick={()=>select(selection)}>Retry</button></p>:
        !page?<p>Loading records…</p>:page.records.length?<ul>{page.records.map(record=><li key={record.id}>
          <a href={portableRecordPath(page.kind,record.id,workspaceId)}>{record.name}</a></li>)}</ul>:<p>No matching records.</p>}
      {(selection.after||page?.next)&&<nav aria-label="Matching record pages">
        {selection.after&&<button type="button" onClick={()=>select({group:selection.group})}>First records</button>}
        {page?.next&&<button type="button" onClick={()=>select({group:selection.group,after:page.next!})}>Next records</button>}
      </nav>}
    </section>}
    {!workspaceId&&<a href={reportPath(card.reportId)}>Open report</a>}
  </>;
}

export function PortableDashboards({email,workspaceId,page,after,search,detail,reports,pipelines,assignees,customProperties,followUp}:{email:string;workspaceId?:string;page:DashboardPage;after?:string;search?:string;followUp?:DealsWithoutFollowUp;
  detail?:PortableDashboardDetail;reports:PortableReportPage;pipelines:PortableReportPipelineOption[];assignees:PortableReportAssigneeOption[];customProperties:ReportCustomPropertyLabel[]}){
  const item=detail?.item;
  const [cards,setCards]=useState<DraftCard[]>(()=>detail?.cards.map(({reportId,wide,...card})=>({
    reportId,wide,label:card.missing?'Unavailable report':card.definition.name,
  }))??[]);
  const [options,setOptions]=useState(reports);
  const [optionsAfter,setOptionsAfter]=useState<string>();
  const [reportId,setReportId]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  function link(id?:string,cursor?:string){
    const params=new URLSearchParams({view:'dashboards'});
    if(workspaceId)params.set('workspaceId',workspaceId);
    if(id)params.set('dashboardId',id);
    if(cursor)params.set('after',cursor);
    if(search)params.set('search',search);
    return '/?'+params;
  }

  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');
    try{await action();}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }

  function addReport(){
    const report=options.items.find(option=>option.id===reportId);
    if(report&&!cards.some(card=>card.reportId===reportId)&&cards.length<20){
      setCards([...cards,{reportId,wide:false,label:report.definition.name}]);
      setReportId('');
    }
  }

  function move(index:number,offset:number){
    const next=index+offset,reordered=[...cards];
    [reordered[index],reordered[next]]=[reordered[next],reordered[index]];
    setCards(reordered);
  }

  function readReports(cursor?:string){
    void run(async()=>{
      const params=new URLSearchParams({view:'library'});
      if(cursor)params.set('after',cursor);
      setOptions(await request<PortableReportPage>('?'+params));setOptionsAfter(cursor);setReportId('');
    });
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    void run(async()=>{
      const definition={name:form.get('name'),cards:cards.map(({reportId,wide})=>({reportId,wide}))};
      const {item:saved}=await request<{item:PortableDashboard}>('',{
        action:'dashboard',definition,teamVisible:form.has('teamVisible'),...(item?{id:item.id,revision:item.revision}:{}),
      });
      window.location.assign(link(saved.id,after));
    });
  }

  function remove(){
    if(!item||!confirm('Delete “'+item.definition.name+'”?'))return;
    void run(async()=>{
      await request('',{action:'deleteDashboard',id:item.id,revision:item.revision});
      window.location.assign(link(undefined,after));
    });
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="dashboards" workspaceId={workspaceId} currentHref={link(undefined,after)}/>
    <section aria-labelledby="portable-dashboards-title">
      <div className="portable-contacts-heading"><h1 id="portable-dashboards-title">Dashboards</h1>{!workspaceId&&<a href={link(undefined,after)}>New dashboard</a>}</div>
      {workspaceId&&<p>Dashboards shared by the workspace owner. Open a card to see its records.</p>}
      <form method="get" action="/" role="search" className="portable-dashboard-search">
        <input type="hidden" name="view" value="dashboards"/>{workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <label>Search dashboards<input key={search??''} type="search" name="search" defaultValue={search} maxLength={recordSearchLimit}/></label>
        <button type="submit">Search</button>
        {search&&<a href={workspaceId?'/?view=dashboards&'+new URLSearchParams({workspaceId}):'/?view=dashboards'}>Clear search</a>}
      </form>
      {page.items.length?<ul className="portable-dashboard-list">{page.items.map(dashboard=><li key={dashboard.id}>
        <a href={link(dashboard.id,after)} aria-current={item?.id===dashboard.id?'page':undefined}>{dashboard.definition.name}</a>
        {' · '+dashboard.definition.cards.length+(dashboard.definition.cards.length===1?' report':' reports')}{!workspaceId&&dashboard.teamVisible&&' · Shared with team'}
      </li>)}</ul>:<p>{search?'No matching dashboards on this page.':workspaceId?'No dashboards have been shared with this workspace.':'No dashboards on this page.'}</p>}
      {(after||page.next)&&<nav aria-label="Dashboard pages">
        {after&&<a href={link(item?.id)}>First dashboards</a>}
        {page.next&&<a href={link(item?.id,page.next)}>Next dashboards</a>}
      </nav>}
    </section>
    {followUp&&<PortableFollowUpPanel key={workspaceId??'own'} workspaceId={workspaceId} deals={followUp}/>}
    {detail&&<section aria-label="Saved dashboard results">
      <h2>{item?.definition.name}</h2>
      {detail.cards.length?<div className="portable-dashboard-grid">{detail.cards.map(card=>
        <article key={card.reportId} className={card.wide?'portable-dashboard-wide':undefined}>
          {card.missing?<><h3>Report unavailable</h3><p>{workspaceId?'This report is no longer available.':'This saved report is missing. Remove the card to update the dashboard.'}</p></>:
            <DashboardCardResults card={card} dashboardId={detail.item.id} workspaceId={workspaceId} pipelines={pipelines} assignees={assignees} customProperties={customProperties}/>}
        </article>,
      )}</div>:<p>{workspaceId?'This dashboard has no report cards.':'Add a report to start tracking results here.'}</p>}
    </section>}
    {!workspaceId&&<section aria-label="Dashboard settings">
      <h2>{item?'Edit dashboard':'Build a dashboard'}</h2>
      {error&&<p role="alert">{error}</p>}
      <form onSubmit={save}>
        <label>Dashboard name<input name="name" defaultValue={item?.definition.name} required maxLength={100} disabled={busy}/></label>
        <label className="portable-dashboard-share"><input type="checkbox" name="teamVisible" disabled={busy} defaultChecked={item?.teamVisible??false}/>
          <span>Share with workspace teammates<small>Current and future teammates can read these report cards and open their matching records.</small></span></label>
        <fieldset disabled={busy}>
          <legend>Choose saved reports</legend>
          <label>Report<select value={reportId} onChange={event=>setReportId(event.target.value)}>
            <option value="">Choose a report</option>
            {options.items.filter(report=>!cards.some(card=>card.reportId===report.id)).map(report=>
              <option key={report.id} value={report.id}>{report.definition.name}</option>)}
          </select></label>
          <button type="button" disabled={!reportId||cards.length>=20} onClick={addReport}>Add report</button>
          {optionsAfter&&<button type="button" onClick={()=>readReports()}>First reports</button>}
          {options.next&&<button type="button" onClick={()=>readReports(options.next??undefined)}>Next reports</button>}
        </fieldset>
        <p>{cards.length} of 20 cards</p>
        <ol>{cards.map((card,index)=><li key={card.reportId}>
          <strong>{card.label}</strong>{' '}
          <button type="button" disabled={busy||index===0} onClick={()=>move(index,-1)}>Move up</button>{' '}
          <button type="button" disabled={busy||index===cards.length-1} onClick={()=>move(index,1)}>Move down</button>{' '}
          <button type="button" disabled={busy} onClick={()=>setCards(cards.filter(item=>item.reportId!==card.reportId))}>Remove</button>
          <label><input type="checkbox" checked={card.wide} disabled={busy} onChange={event=>setCards(cards.map(item=>
            item.reportId===card.reportId?{...item,wide:event.target.checked}:item))}/>Full-width card</label>
        </li>)}</ol>
        <button type="submit" disabled={busy}>Save dashboard</button>{' '}
        {item&&<button type="button" disabled={busy} onClick={remove}>Delete dashboard</button>}
      </form>
    </section>}
  </main>;
}
