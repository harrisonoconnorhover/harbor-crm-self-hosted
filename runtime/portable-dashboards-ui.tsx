'use client';

import {CustomReportResults} from './portable-custom-report-results';
import {useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {dashboardCardKey,type DashboardCardSource} from '../lib/portable-dashboards';
import {objectPath} from '../lib/portable-custom-objects';
import type {PortableDashboardFilters,PortableDashboard,PortableDashboardDefinition,PortableDashboardDetail} from '../lib/portable-dashboards';
import type {DealsWithoutFollowUp} from '../db/postgres/deal-follow-up-store';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import {recordSearchLimit} from '../lib/portable-records';
import type {PortableReportAssigneeOption,PortableReportPage,PortableReportPipelineOption} from '../lib/portable-reports';
import {DrillableReportResults} from './portable-report-drilldown';
import type {ReportCustomPropertyLabel} from './portable-report-drilldown';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableFollowUpPanel} from './portable-follow-up-panel';
import './portable-contacts.css';
import './portable-dashboards.css';

type DashboardPage={items:PortableDashboard[];next:string|null};
type DraftCard=PortableDashboardDefinition['cards'][number]&{label:string};
function cardSource(card:DashboardCardSource):DashboardCardSource{
  return 'reportId' in card?{reportId:card.reportId,wide:card.wide}:{objectId:card.objectId,by:card.by,sum:card.sum,wide:card.wide};
}
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

export function AddObjectReportToDashboard({objectId,by,sum}:{objectId:string;by?:string;sum?:string}){
  const router=useRouter();
  const [page,setPage]=useState<DashboardPage>();
  const [selected,setSelected]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const card={objectId,by,sum,wide:false};
  async function browse(after?:string){
    setBusy(true);setError('');
    try{
      const params=new URLSearchParams({view:'dashboards'});
      if(after)params.set('after',after);
      setPage(await request<DashboardPage>('?'+params));setSelected('');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const dashboard=page?.items.find(d=>d.id===selected);
    const data=new FormData(event.currentTarget);
    if(!dashboard&&selected!=='new')return;
    setBusy(true);setError('');
    try{
      const {item}=await request<{item:PortableDashboard}>('',{action:'dashboard',
        definition:{name:dashboard?.definition.name??data.get('name'),cards:[...(dashboard?.definition.cards??[]),card]},
        ...(dashboard?{id:dashboard.id,revision:dashboard.revision}:{})});
      router.push('/?view=dashboards&dashboardId='+item.id);
    }catch(e){setError((e as Error).message);setBusy(false);}
  }
  return <div>{page?<form onSubmit={save}><fieldset disabled={busy}><legend>Add to dashboard</legend>
    <label htmlFor="object-report-dashboard">Dashboard</label> <select id="object-report-dashboard" required value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">Choose a dashboard</option><option value="new">New dashboard</option>
      {page.items.map(d=>{
        const has=d.definition.cards.some(c=>dashboardCardKey(c)===dashboardCardKey(card));
        const full=d.definition.cards.length>=20;
        return <option key={d.id} value={d.id} disabled={has||full}>{d.definition.name}{has?' (already added)':full?' (full)':''}</option>;
      })}</select>
    {selected==='new'&&<label>Dashboard name <input required name="name" maxLength={100}/></label>}
    <button disabled={!selected}>Save to dashboard</button>
    <button type="button" onClick={()=>browse()}>Reload dashboards</button>
    {page.next&&<button type="button" onClick={()=>browse(page.next??undefined)}>More dashboards</button>}
    <button type="button" onClick={()=>{setPage(undefined);setError('');}}>Cancel</button>
    </fieldset></form>:<button type="button" disabled={busy} onClick={()=>browse()}>Add to dashboard</button>}
    {error&&<p role="alert">{error}</p>}</div>;
}

type ReportLabels={pipelines:PortableReportPipelineOption[];assignees:PortableReportAssigneeOption[];customProperties:ReportCustomPropertyLabel[]};

function DashboardCardResults({card,dashboardId,workspaceId,filters,returnPath,...labels}:ReportLabels&{
  filters:PortableDashboardFilters;returnPath:string;
  card:Extract<PortableDashboardDetail['cards'][number],{missing:false;reportId:string}>;dashboardId:string;workspaceId?:string;
}){
  const params=new URLSearchParams({view:'dashboardRecords',id:dashboardId,reportId:card.reportId});
  if(workspaceId)params.set('workspaceId',workspaceId);
  for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
  return <>
    {filters.dashboardPipeline&&card.definition.kind!=='deals'&&<p className="portable-filter-note">The pipeline filter applies only to Deal cards.</p>}
    <DrillableReportResults returnPath={returnPath} key={params.toString()} definition={card.definition} result={card.result} recordsQuery={params.toString()} workspaceId={workspaceId} {...labels}/>
    {!workspaceId&&<a href={reportPath(card.reportId)}>Open report</a>}
  </>;
}

export function PortableDashboards({email,workspaceId,page,after,search,detail,reports,pipelines,assignees,customProperties,followUp,filters}:{filters:PortableDashboardFilters;email:string;workspaceId?:string;page:DashboardPage;after?:string;search?:string;followUp?:DealsWithoutFollowUp;
  detail?:PortableDashboardDetail;reports:PortableReportPage;pipelines:PortableReportPipelineOption[];assignees:PortableReportAssigneeOption[];customProperties:ReportCustomPropertyLabel[]}){
  const item=detail?.item;
  const [cards,setCards]=useState<DraftCard[]>(()=>detail?.cards.map(card=>({
    ...cardSource(card),
    label:card.missing?'Unavailable report':'custom' in card?[card.custom.name,card.custom.fieldLabel,card.custom.sumLabel].filter(Boolean).join(' · '):card.definition.name,
  }))??[]);
  const [options,setOptions]=useState(reports);
  const [optionsAfter,setOptionsAfter]=useState<string>();
  const [reportId,setReportId]=useState('');
  const [rangeError,setRangeError]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  function link(id?:string,cursor?:string,keepFilters=false){
    const params=new URLSearchParams({view:'dashboards'});
    if(workspaceId)params.set('workspaceId',workspaceId);
    if(id)params.set('dashboardId',id);
    if(cursor)params.set('after',cursor);
    if(search)params.set('search',search);
    if(keepFilters)for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
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
    if(report&&!cards.some(card=>dashboardCardKey(card)===reportId)&&cards.length<20){
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
      const definition={name:form.get('name'),cards:cards.map(cardSource)};
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
      {item&&<a href={link(undefined,after)}>Back to dashboards</a>}
      <div className="portable-contacts-heading"><h1 id="portable-dashboards-title">{item?.definition.name??'Dashboards'}</h1>{!workspaceId&&<a href={link(undefined,after)}>New dashboard</a>}</div>
      <details className="portable-report-library" open={!item}><summary>Browse dashboards</summary>
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
      </details>
    </section>
    {followUp&&<PortableFollowUpPanel key={workspaceId??'own'} workspaceId={workspaceId} deals={followUp}/>}
    {detail&&<section aria-label="Saved dashboard results">
      {detail.cards.some(card=>'definition' in card)&&<form className="portable-dashboard-filters" aria-label="Dashboard filters" method="get" action="/" onSubmit={event=>{
        const data=new FormData(event.currentTarget),from=String(data.get('createdFrom')??''),through=String(data.get('createdThrough')??'');
        if(Boolean(from)!==Boolean(through)||from>through){event.preventDefault();setRangeError('Choose both dates, with the start on or before the end.');}
      }}>
        <input type="hidden" name="view" value="dashboards"/><input type="hidden" name="dashboardId" value={detail.item.id}/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        {search&&<input type="hidden" name="search" value={search}/>}{after&&<input type="hidden" name="after" value={after}/>}
        <label>Created from (UTC)<input type="date" name="createdFrom" defaultValue={filters.createdFrom}/></label>
        <label>Created through (UTC)<input type="date" name="createdThrough" defaultValue={filters.createdThrough}/></label>
        {detail.cards.some(card=>'definition' in card&&card.definition.kind==='deals')&&<label>Deal pipeline<select name="dashboardPipeline" defaultValue={filters.dashboardPipeline??''}>
          <option value="">All pipelines</option>{[builtinPipeline,...pipelines].map(pipeline=><option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
        </select></label>}
        <button type="submit">Apply filters</button>
        {(filters.createdFrom||filters.dashboardPipeline)&&<a href={link(detail.item.id,after)}>Clear dashboard filters</a>}
        {rangeError&&<p role="alert">{rangeError}</p>}
      </form>}
      {detail.cards.length?<div className="portable-dashboard-grid">{detail.cards.map(card=>
        <article id={'reportId' in card?'report-'+card.reportId:undefined} key={dashboardCardKey(card)} className={card.wide?'portable-dashboard-wide':undefined}>
          {card.missing?<><h3>Report unavailable</h3><p>{workspaceId?'This report is no longer available.':'This saved report is missing. Remove the card to update the dashboard.'}</p></>:
            'custom' in card?<><h3>{[card.custom.name,card.custom.fieldLabel,card.custom.sumLabel].filter(Boolean).join(' · ')}</h3>
              <CustomReportResults workspaceId={workspaceId} objectId={card.objectId} by={card.by} sumId={card.sum} {...card.custom}/>
              {filters.createdFrom&&<p className="portable-filter-note">Custom object totals include all creation dates.</p>}
              <a href={objectPath({workspaceId,objectId:card.objectId,summary:'1',by:card.by,sum:card.sum})}>Open object report</a></>:
            <DashboardCardResults returnPath={link(detail.item.id,after,true)} filters={filters} card={card} dashboardId={detail.item.id} workspaceId={workspaceId} pipelines={pipelines} assignees={assignees} customProperties={customProperties}/>}
        </article>,
      )}</div>:<p>{workspaceId?'This dashboard has no report cards.':'Add a report to start tracking results here.'}</p>}
    </section>}
    {!workspaceId&&<section aria-label="Dashboard settings">
      <details className="portable-report-settings" open={!item}><summary>{item?'Edit dashboard':'Build a dashboard'}</summary>
      {error&&<p role="alert">{error}</p>}
      <form onSubmit={save}>
        <label>Dashboard name<input name="name" defaultValue={item?.definition.name} required maxLength={100} disabled={busy}/></label>
        <label className="portable-dashboard-share"><input type="checkbox" name="teamVisible" disabled={busy} defaultChecked={item?.teamVisible??false}/>
          <span>Share with workspace teammates<small>Current and future teammates can read these report cards and open their matching records.</small></span></label>
        <fieldset disabled={busy}>
          <legend>Choose saved reports</legend>
          <label>Report<select value={reportId} onChange={event=>setReportId(event.target.value)}>
            <option value="">Choose a report</option>
            {options.items.filter(report=>!cards.some(card=>dashboardCardKey(card)===report.id)).map(report=>
              <option key={report.id} value={report.id}>{report.definition.name}</option>)}
          </select></label>
          <button type="button" disabled={!reportId||cards.length>=20} onClick={addReport}>Add report</button>
          {optionsAfter&&<button type="button" onClick={()=>readReports()}>First reports</button>}
          {options.next&&<button type="button" onClick={()=>readReports(options.next??undefined)}>Next reports</button>}
        </fieldset>
        <p>{cards.length} of 20 cards</p>
        <ol>{cards.map((card,index)=><li key={dashboardCardKey(card)}>
          <strong>{card.label}</strong>{' '}
          <button type="button" disabled={busy||index===0} onClick={()=>move(index,-1)}>Move up</button>{' '}
          <button type="button" disabled={busy||index===cards.length-1} onClick={()=>move(index,1)}>Move down</button>{' '}
          <button type="button" disabled={busy} onClick={()=>setCards(cards.filter(item=>item!==card))}>Remove</button>
          <label><input type="checkbox" checked={card.wide} disabled={busy} onChange={event=>setCards(cards.map(item=>
            item===card?{...item,wide:event.target.checked}:item))}/>Full-width card</label>
        </li>)}</ol>
        <button type="submit" disabled={busy}>Save dashboard</button>{' '}
        {item&&<button type="button" disabled={busy} onClick={remove}>Delete dashboard</button>}
      </form></details>
    </section>}
  </main>;
}
