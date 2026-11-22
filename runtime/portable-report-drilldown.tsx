'use client';
import {useWorkspaceDefaults} from './portable-workspace-format';
import {workspaceNumber} from '../lib/portable-account-defaults';
import {firstResponseOutcomeLabels} from '../lib/first-response';

import {useEffect,useState} from 'react';
import {portableRecordPath} from '../lib/portable-record-path';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import type {DashboardRecordsPage} from '../lib/portable-dashboards';
import {portableReportHasFilters,portableReportMetricLabel,portableReportCustomOperators,portableReportGroupHeading,portableReportDealOutcomes,portableReportGroupLabels,portableReportGroupLimit,
  type PortableReportAssigneeOption,type PortableReportDefinition,type PortableReportPipelineOption,type PortableReportResult} from '../lib/portable-reports';
import {ReportChart} from './portable-report-chart';

const counts=new Intl.NumberFormat('en-US');
const percent=new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:1});
const amounts=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
type Preview={definition:PortableReportDefinition;result:PortableReportResult};
export type ReportCustomPropertyLabel={id:string;label:string};
type DrilldownProps=Preview&{recordsQuery:string;workspaceId?:string;returnPath?:string;pipelines?:PortableReportPipelineOption[];
  assignees?:PortableReportAssigneeOption[];teams?:{id:string;label:string}[];customProperties?:ReportCustomPropertyLabel[]};

export function DrillableReportResults(props:DrilldownProps){
  return <RecordsPanel key={props.recordsQuery} {...props}/>;
}
function RecordsPanel({definition,result:resultData,recordsQuery,workspaceId,returnPath,...labels}:DrilldownProps){
  const [selection,setSelection]=useState<{group?:string;after?:string}|null>(null);
  const [result,setResult]=useState<{path:string;page?:DashboardRecordsPage;error?:string}>();
  const [attempt,setAttempt]=useState(0);
  const params=new URLSearchParams(recordsQuery);
  if(selection?.after)params.set('after',selection.after);
  if(selection?.group!==undefined)params.set('group',selection.group);
  const path=selection?'/api/reporting?'+params:null;
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();
    async function load(url:string){
      try{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error(response.status===409?'This report changed. Reload to see its current results.':
          response.status===404?'This report is unavailable.':'Could not load matching records.');
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
  const group=selection?.group===undefined?undefined:resultData.rows.find(row=>(row.key??'')===selection.group)?.label;
  return <>
    <ReportResults preview={{definition,result:resultData}} {...labels} onOpenRecords={group=>select({group})}/>
    {selection&&<section className="portable-dashboard-records" aria-label={'Matching records for '+definition.name} aria-live="polite">
      <div><h4>{group?'Records in '+group:'Matching '+definition.kind}</h4><button type="button" onClick={()=>select(null)}>Close</button></div>
      {current?.error?<p role="alert">{current.error} <button type="button" onClick={()=>select(selection)}>Retry</button></p>:
        !page?<p>Loading records…</p>:page.records.length?<ul>{page.records.map(record=><li key={record.id}>
          <a href={portableRecordPath(page.kind,record.id,workspaceId,returnPath)}>{record.name}</a></li>)}</ul>:<p>No matching records.</p>}
      {(selection.after||page?.next)&&<nav aria-label="Matching record pages">
        {selection.after&&<button type="button" onClick={()=>select({group:selection.group})}>First records</button>}
        {page?.next&&<button type="button" onClick={()=>select({group:selection.group,after:page.next!})}>Next records</button>}
      </nav>}
    </section>}
  </>;
}

export function ReportResults({preview:{definition,result},pipelines=[],assignees=[],teams,customProperties=[],onOpenRecords}:{
  onOpenRecords?:(group?:string)=>void;preview:Preview;pipelines?:PortableReportPipelineOption[];assignees?:PortableReportAssigneeOption[];teams?:{id:string;label:string}[];customProperties?:ReportCustomPropertyLabel[];
}){
  const {kind,metric,filter,dealOutcome,createdDateRange,dealPipelineId,dealStageId,taskDueDateRange,taskAssigneeId,
    customFilter,ticketPriority,ticketSource,ticketCategory,ticketResponse,firstResponseChannel}=definition;
  const customLabel=customFilter&&(customProperties.find(({id})=>id===customFilter.propertyId)?.label??'Unavailable property');
  const pipeline=[builtinPipeline,...pipelines].find(({id})=>id===dealPipelineId);
  const stageName=pipeline?.stages.find(({id})=>id===dealStageId)?.name;
  const defaults=useWorkspaceDefaults();
  const format=metric==='count'?counts:amounts;
  function display(value:string|null){
    if(value===null)return '—';
    if(metric==='rate'){
      const fraction=Number(value)/100;
      return defaults?workspaceNumber(fraction,defaults,'percent'):percent.format(fraction);
    }
    return defaults?workspaceNumber(value,defaults,metric==='count'?'number':metric==='sum'?'money':'decimal'):format.format(value as `${number}`);
  }
  return <div aria-live="polite" className="portable-contacts-table">
    <h3>{definition.name+' results'}</h3>
    <p>{defaults?workspaceNumber(result.count,defaults):counts.format(result.count as `${number}`)} {metric==='average'?'answered tickets':metric==='rate'?'assessed tickets':kind} included
      {metric==='sum'?' · Unweighted deal amounts':''}</p>
    {metric==='rate'&&<p>On-time replies divided by all assessed tickets. Late replies and overdue unanswered tickets count as missed targets.</p>}
    {filter&&<p>{filter.field==='closeDate'?`Close date from ${filter.value} through ${filter.valueTo}`:
      `${portableReportGroupLabels[kind].label} is ${filter.value}`}</p>}
    {definition.teamId&&<p>{teams?(teams.find(t=>t.id===definition.teamId)?.label??'Unavailable team')+' and subteams':'Filtered to the selected team and its subteams'}</p>}
    {firstResponseChannel&&<p>First-response channel is {firstResponseChannel}</p>}
    {ticketResponse&&<p>First-response outcome is {firstResponseOutcomeLabels[ticketResponse]}</p>}
    {ticketPriority&&<p>Ticket priority is {ticketPriority}</p>}
    {ticketSource&&<p>Ticket source is {ticketSource}</p>}
    {ticketCategory&&<p>Ticket category is {ticketCategory}</p>}
    {dealOutcome&&<p>Deal outcome is {portableReportDealOutcomes[dealOutcome]}</p>}
    {dealPipelineId&&<p>Deal pipeline is {pipeline?.name??'unavailable'}</p>}
    {dealStageId&&<p>Deal stage is {stageName??'unavailable'}</p>}
    {createdDateRange&&<p>{`Create date from ${createdDateRange.from} through ${createdDateRange.through} (UTC)`}</p>}
    {taskDueDateRange&&<p>{`Due date from ${taskDueDateRange.from} through ${taskDueDateRange.through}`}</p>}
    {customFilter&&<p>{customLabel+' '+portableReportCustomOperators[customFilter.operator]+(customFilter.value===undefined?'':' '+
      (typeof customFilter.value==='boolean'?(customFilter.value?'Yes':'No'):customFilter.value))}</p>}
    {taskAssigneeId!==undefined&&<p>Assignee is {taskAssigneeId===null?'unassigned':assignees.find(({id})=>id===taskAssigneeId)?.label??'unavailable'}</p>}
    <ReportChart key={definition.chart??'table'} definition={definition} result={result} display={display} onOpenRecords={onOpenRecords}><table aria-label="Report results">
      <thead><tr><th scope="col">{portableReportGroupHeading(definition)}</th>
        <th scope="col">{portableReportMetricLabel(metric)}</th></tr></thead>
      <tbody>{result.rows.map(row=><tr key={row.key===null?'missing':'value:'+row.key}><th scope="row">{onOpenRecords?<button type="button" className="portable-dashboard-drill" onClick={()=>onOpenRecords(row.key??'')}
        aria-label={'View records for '+row.label}>{row.label}</button>:row.label}</th><td>{display(row.value)}</td></tr>)}</tbody>
      <tfoot><tr><th scope="row">{portableReportHasFilters(definition)?'Matching records':'All records'}</th><td>{display(result.total)}</td></tr></tfoot>
    </table></ReportChart>
    {onOpenRecords&&<button type="button" className="portable-dashboard-drill" onClick={()=>onOpenRecords()}>View matching records</button>}
    {result.truncated&&<p>Showing {portableReportGroupLimit} groups. The total includes every group.</p>}
  </div>;
}
