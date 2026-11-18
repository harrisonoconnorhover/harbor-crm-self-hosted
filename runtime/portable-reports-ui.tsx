'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Use document navigation for saved reports in the portable renderer. */

import {useRouter} from 'next/navigation';
import {useState,type FormEvent} from 'react';
import {ticketPriorities} from '../lib/crm';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import {recordSearchLimit} from '../lib/portable-records';
import {portableReportCustomOperators,portableReportDealOutcomes,portableReportDefinition,portableReportFilename,portableReportFilterOptions,portableReportGroupLabels,portableReportGroupLimit,portableReportKinds,type PortableReportDefinition,
  portableReportTicketCategories,portableReportTicketSources,type PortableReportAssigneeOption,type PortableReportPage,type PortableReportPipelineOption,type PortableReportResult,type PortableSavedReport} from '../lib/portable-reports';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

const sourceLabels={contacts:'Contacts',companies:'Companies',deals:'Deals',tasks:'Tasks',leads:'Leads',tickets:'Tickets'} as const;
const counts=new Intl.NumberFormat('en-US');
const amounts=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

type Preview={definition:PortableReportDefinition;result:PortableReportResult;saved?:Pick<PortableSavedReport,'id'|'revision'>};

type ReportCustomProperty=Pick<PortableCustomProperty,'id'|'kind'|'label'|'type'|'options'>;
export type ReportCustomPropertyLabel=Pick<ReportCustomProperty,'id'|'label'>;
const customKinds=['contacts','companies','deals'];
export function PortableReports({email,page,after,search,item,result,pipelines,assignees,customProperties=[]}:{
  email:string;page:PortableReportPage;after?:string;search?:string;item?:PortableSavedReport;result?:PortableReportResult;
  pipelines:PortableReportPipelineOption[];assignees:PortableReportAssigneeOption[];customProperties?:ReportCustomProperty[];
}){
  const router=useRouter();
  const [kind,setKind]=useState<PortableReportDefinition['kind']>(item?.definition.kind??'contacts');
  const [amount,setAmount]=useState(item?.definition.metric==='sum');
  const [group,setGroup]=useState(!!item?.definition.groupBy);
  const savedFilter=item?.definition.filter;
  const [filterDates,setFilterDates]=useState(savedFilter?.field==='closeDate');
  const [pipelineId,setPipelineId]=useState(item?.definition.dealPipelineId??'');
  const [stageId,setStageId]=useState(item?.definition.dealStageId??'');
  const pipelineOptions=[builtinPipeline,...pipelines];
  const stageOptions=pipelineOptions.find(({id})=>id===pipelineId)?.stages??[];
  const savedCreatedDates=item?.definition.createdDateRange;
  const [filterCreatedDates,setFilterCreatedDates]=useState(!!savedCreatedDates);
  const savedDueDates=item?.definition.taskDueDateRange;
  const [filterDueDates,setFilterDueDates]=useState(!!savedDueDates);
  const savedAssignee=item?.definition.taskAssigneeId;
  const savedCustom=item?.definition.customFilter;
  const [customId,setCustomId]=useState(savedCustom?.propertyId??'');
  const [customOperator,setCustomOperator]=useState<string>(savedCustom?.operator??'is');
  const customChoices=customProperties.filter(property=>property.kind===kind);
  const customProperty=customChoices.find(property=>property.id===customId);
  const [preview,setPreview]=useState<Preview|null>(item&&result?{definition:item.definition,result,saved:{id:item.id,revision:item.revision}}:null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  function link(reportId?:string,cursor?:string){
    const params=new URLSearchParams({view:'reports'});
    if(reportId)params.set('reportId',reportId);
    if(cursor)params.set('after',cursor);
    if(search)params.set('search',search);
    return '/?'+params;
  }

  async function send(payload:unknown){
    if(busy)return;
    setBusy(true);
    setError('');
    setMessage('');
    try{
      const response=await fetch('/api/reporting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json() as {result?:PortableReportResult;item?:PortableSavedReport;deleted?:true;error?:string};
      if(!response.ok){
        setError(data.error??'Could not finish this report request.');
        return;
      }
      return data;
    }catch{
      setError('Could not confirm the request. Reload to check the saved report.');
    }finally{setBusy(false);}
  }

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const value=String(form.get('filterValue')??'');
    const filter=kind==='deals'
      ?filterDates?{field:'closeDate',operator:'between',value,valueTo:form.get('filterThrough')}:undefined
      :value?{field:portableReportGroupLabels[kind].field,operator:'eq',value}:undefined;
    const dealOutcome=kind==='deals'?form.get('dealOutcome'):null;
    const dealPipelineId=kind==='deals'?form.get('dealPipelineId')||undefined:undefined;
    const dealStageId=kind==='deals'?form.get('dealStageId')||undefined:undefined;
    const createdDateRange=filterCreatedDates?{from:form.get('createdFrom'),through:form.get('createdThrough')}:undefined;
    const taskDueDateRange=kind==='tasks'&&filterDueDates?{from:form.get('dueFrom'),through:form.get('dueThrough')}:undefined;
    const assignee=kind==='tasks'?String(form.get('taskAssignee')??''):'';
    const taskAssigneeId=assignee==='unassigned'?null:assignee.startsWith('member:')?assignee.slice('member:'.length):undefined;
    const ticketPriority=kind==='tickets'?form.get('ticketPriority')||undefined:undefined;
    const ticketSource=kind==='tickets'?form.get('ticketSource')||undefined:undefined;
    const ticketCategory=kind==='tickets'?form.get('ticketCategory')||undefined:undefined;
    const rawCustom=String(form.get('customValue')??'');
    const customValue=!customProperty||customOperator==='known'||customOperator==='unknown'?undefined:
      customProperty.type==='number'?(rawCustom===''?undefined:Number(rawCustom)):customProperty.type==='checkbox'?rawCustom==='true':rawCustom||undefined;
    const customFilter=customKinds.includes(kind)&&customId?{propertyId:customId,operator:customOperator,
      ...(customValue===undefined?{}:{value:customValue})}:undefined;
    const parsed=portableReportDefinition.safeParse({...(customFilter?{customFilter}:{}),
      name:String(form.get('name')??'').trim(),kind,metric:amount?'sum':'count',measure:amount?'amount':'',
      groupBy:group?portableReportGroupLabels[kind].field:'',sort:form.get('sort'),...(filter?{filter}:{}),...(dealOutcome?{dealOutcome}:{}),
      createdDateRange,dealPipelineId,dealStageId,taskDueDateRange,taskAssigneeId,ticketPriority,ticketSource,ticketCategory,
    });
    if(!parsed.success){
      setError(parsed.error.issues[0].message);
      setMessage('');
      return;
    }
    const definition=parsed.data;
    const intent=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    if(intent==='save'){
      const data=await send({action:'report',definition,...(item?{id:item.id,revision:item.revision}:{})});
      if(data?.item){
        setMessage('Report saved.');
        if(!item)router.replace(link(data.item.id,after));
        router.refresh();
      }
      return;
    }
    const data=await send({action:'preview',definition});
    if(data?.result)setPreview({definition,result:data.result});
  }

  async function download(){
    if(!preview||busy)return;
    setBusy(true);
    setError('');
    setMessage('');
    try{
      const source=preview.saved??{definition:preview.definition};
      const response=await fetch('/api/reporting',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'export',...source})});
      if(!response.ok){
        const data=await response.json() as {error?:string};
        setError(data.error??'Could not export this report.');
        return;
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected a CSV response.');
      const url=URL.createObjectURL(await response.blob());
      const download=document.createElement('a');
      download.href=url;
      download.download=portableReportFilename(preview.definition.name);
      download.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch{setError('Could not export this report. Try again.');}
    finally{setBusy(false);}
  }

  async function remove(){
    if(!item||!confirm('Delete “'+item.definition.name+'”?'))return;
    const data=await send({action:'deleteReport',id:item.id,revision:item.revision});
    if(data?.deleted){
      router.replace(link(undefined,after));
      router.refresh();
    }
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="reports" currentHref={link(undefined,after)}/>
    <section aria-labelledby="portable-reports-title">
      <div className="portable-contacts-heading"><h1 id="portable-reports-title">Reports</h1><a href={link(undefined,after)}>New report</a></div>
      <form method="get" action="/" role="search">
        <input type="hidden" name="view" value="reports"/>
        <label>Search saved reports<input key={search??''} type="search" name="search" defaultValue={search} maxLength={recordSearchLimit}/></label>
        <button type="submit">Search</button>
        {search&&<a href="/?view=reports">Clear search</a>}
      </form>
      {page.items.length?<div className="portable-contacts-table"><table>
        <thead><tr><th scope="col">Report</th><th scope="col">Source</th><th scope="col">Measure</th></tr></thead>
        <tbody>{page.items.map(report=><tr key={report.id}>
          <th scope="row"><a href={link(report.id,after)} aria-current={item?.id===report.id?'page':undefined}>{report.definition.name}</a></th>
          <td>{sourceLabels[report.definition.kind]}</td><td>{report.definition.metric==='sum'?'Deal amount':'Record count'}</td>
        </tr>)}</tbody>
      </table></div>:<p>{search?'No matching reports on this page.':'No saved reports on this page.'}</p>}
      {(after||page.next)&&<nav aria-label="Report pages">
        {after&&<a href={link(item?.id)}>First reports</a>}
        {page.next&&<a href={link(item?.id,page.next)}>Next reports</a>}
      </nav>}
    </section>
    <section aria-labelledby="portable-report-builder">
      <h2 id="portable-report-builder">{item?'Edit '+item.definition.name:'Build a report'}</h2>
      {error&&<p role="alert">{error}</p>}
      {message&&<p role="status">{message}</p>}
      <form onSubmit={submit} aria-label="Report settings">
        <fieldset disabled={busy}>
          <label>Report name<input name="name" defaultValue={item?.definition.name} required maxLength={100}/></label>
          <label>Source<select value={kind} onChange={event=>{
            setKind(event.target.value as PortableReportDefinition['kind']);setAmount(false);setGroup(false);setFilterDates(false);setCustomId('');
          }}>
            {portableReportKinds.map(key=><option key={key} value={key}>{sourceLabels[key]}</option>)}
          </select></label>
          <label>Measure<select value={amount?'sum':'count'} onChange={event=>setAmount(event.target.value==='sum')}>
            <option value="count">Record count</option>
            {kind==='deals'&&<option value="sum">Total deal amount</option>}
          </select></label>
          <label>Group by<select value={group?'group':'total'} onChange={event=>setGroup(event.target.value==='group')}>
            <option value="total">None</option>
            <option value="group">{portableReportGroupLabels[kind].label}</option>
          </select></label>
          {kind==='deals'?<>
            <label>Deal pipeline filter<select name="dealPipelineId" value={pipelineId} onChange={event=>{
              setPipelineId(event.target.value);setStageId('');
            }}>
              <option value="">All pipelines</option>
              {pipelineOptions.map(({id,name})=><option key={id} value={id}>{name}</option>)}
              {pipelineId&&!pipelineOptions.some(({id})=>id===pipelineId)&&<option value={pipelineId}>Unavailable pipeline</option>}
            </select></label>
            {pipelineId&&<label>Deal stage filter<select name="dealStageId" value={stageId} onChange={event=>setStageId(event.target.value)}>
              <option value="">All stages in this pipeline</option>
              {stageOptions.map(({id,name})=><option key={id} value={id}>{name}</option>)}
              {stageId&&!stageOptions.some(({id})=>id===stageId)&&<option value={stageId}>Unavailable stage</option>}
            </select></label>}
            <label>Deal outcome filter<select name="dealOutcome" defaultValue={item?.definition.dealOutcome??''}>
              <option value="">All deal outcomes</option>
              {Object.entries(portableReportDealOutcomes).map(([value,label])=><option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>Close date filter<select value={filterDates?'range':''} onChange={event=>setFilterDates(event.target.value==='range')}>
              <option value="">All close dates</option><option value="range">Between two dates</option>
            </select></label>
            {filterDates&&<>
              <label>Close date from<input type="date" name="filterValue" required
                defaultValue={savedFilter?.field==='closeDate'?savedFilter.value:undefined}/></label>
              <label>Close date through<input type="date" name="filterThrough" required
                defaultValue={savedFilter?.field==='closeDate'?savedFilter.valueTo:undefined}/></label>
            </>}
          </>:<label>{portableReportGroupLabels[kind].label} filter
            <select key={kind} name="filterValue" defaultValue={item?.definition.kind===kind?savedFilter?.value??'':''}>
              <option value="">Any value</option>
              {portableReportFilterOptions[portableReportGroupLabels[kind].field].map(value=><option key={value}>{value}</option>)}
            </select>
          </label>}
          {kind==='tickets'&&<>
            <label>Ticket priority filter<select name="ticketPriority" defaultValue={item?.definition.ticketPriority??''}>
              <option value="">All priorities</option>
              {ticketPriorities.map(priority=><option key={priority} value={priority}>{priority}</option>)}
            </select></label>
            <label>Ticket source filter<select name="ticketSource" defaultValue={item?.definition.ticketSource??''}>
              <option value="">All sources</option>
              {portableReportTicketSources.map(source=><option key={source} value={source}>{source}</option>)}
            </select></label>
            <label>Ticket category filter<select name="ticketCategory" defaultValue={item?.definition.ticketCategory??''}>
              <option value="">All categories</option>
              {portableReportTicketCategories.map(category=><option key={category} value={category}>{category}</option>)}
            </select></label>
          </>}
          {kind==='tasks'&&<>
            <label>Assignee filter<select name="taskAssignee" defaultValue={savedAssignee===null?'unassigned':savedAssignee?'member:'+savedAssignee:''}>
              <option value="">All assignees</option><option value="unassigned">Unassigned</option>
              {assignees.map(({id,label})=><option key={id} value={'member:'+id}>{label}</option>)}
              {savedAssignee&&!assignees.some(({id})=>id===savedAssignee)&&
                <option value={'member:'+savedAssignee}>Unavailable assignee</option>}
            </select></label>
            <label>Due date filter<select value={filterDueDates?'range':''} onChange={event=>setFilterDueDates(event.target.value==='range')}>
              <option value="">All due dates</option><option value="range">Between two dates</option>
            </select></label>
            {filterDueDates&&<>
              <label>Due date from<input type="date" name="dueFrom" required defaultValue={savedDueDates?.from}/></label>
              <label>Due date through<input type="date" name="dueThrough" required defaultValue={savedDueDates?.through}/></label>
            </>}
          </>}
          {customKinds.includes(kind)&&<>
            <label>Custom property filter<select value={customId} onChange={event=>{setCustomId(event.target.value);setCustomOperator('is');}}>
              <option value="">No custom property filter</option>
              {customChoices.map(property=><option key={property.id} value={property.id}>{property.label}</option>)}
              {customId&&!customProperty&&<option value={customId}>Unavailable property</option>}
            </select></label>
            {customProperty&&<>
              <label>Condition<select value={customOperator} onChange={event=>setCustomOperator(event.target.value)}>
                <option value="is">is</option>
                {(customProperty.type==='multiselect'||!['number','checkbox','select','date','datetime'].includes(customProperty.type))&&
                  <option value="contains">contains</option>}
                <option value="known">has any value</option><option value="unknown">is empty</option>
              </select></label>
              {(customOperator==='is'||customOperator==='contains')&&(customProperty.type==='checkbox'
                ?<label>Value<select name="customValue" defaultValue={String(savedCustom?.value??'true')}><option value="true">Yes</option><option value="false">No</option></select></label>
                :customProperty.options.length
                  ?<label>Value<select name="customValue" required defaultValue={savedCustom?.propertyId===customId?String(savedCustom.value??''):''}>
                    <option value="">Choose a value</option>{customProperty.options.map(option=><option key={option}>{option}</option>)}</select></label>
                  :<label>Value<input name="customValue" required type={customProperty.type==='number'?'number':'text'} step={customProperty.type==='number'?'any':undefined}
                    defaultValue={savedCustom?.propertyId===customId?String(savedCustom.value??''):''}/></label>)}
            </>}
          </>}
          <label>Create date filter<select value={filterCreatedDates?'range':''} onChange={event=>setFilterCreatedDates(event.target.value==='range')}>
            <option value="">All create dates</option><option value="range">Between two dates (UTC)</option>
          </select></label>
          {filterCreatedDates&&<>
            <label>Create date from (UTC)<input type="date" name="createdFrom" required defaultValue={savedCreatedDates?.from}/></label>
            <label>Create date through (UTC)<input type="date" name="createdThrough" required defaultValue={savedCreatedDates?.through}/></label>
          </>}
          <label>Sort<select name="sort" defaultValue={item?.definition.sort??'value-desc'}>
            <option value="value-desc">Highest value first</option>
            <option value="value-asc">Lowest value first</option>
            <option value="label">Group name</option>
          </select></label>
        </fieldset>
        <button type="submit" value="preview" disabled={busy}>Run report</button>{' '}
        <button type="submit" value="save" disabled={busy}>Save report</button>{' '}
        {item&&<button type="button" disabled={busy} onClick={()=>void remove()}>Delete report</button>}
      </form>
      {preview&&<>
        <button type="button" onClick={()=>void download()} disabled={busy}>Export CSV</button>
        <ReportResults preview={preview} pipelines={pipelines} assignees={assignees} customProperties={customProperties}/>
      </>}
    </section>
  </main>;
}

export function ReportResults({preview:{definition,result},pipelines=[],assignees=[],customProperties=[],onOpenRecords}:{
  onOpenRecords?:(group?:string)=>void;preview:Preview;pipelines?:PortableReportPipelineOption[];assignees?:PortableReportAssigneeOption[];customProperties?:ReportCustomPropertyLabel[];
}){
  const {groupBy,kind,metric,filter,dealOutcome,createdDateRange,dealPipelineId,dealStageId,taskDueDateRange,taskAssigneeId,
    customFilter,ticketPriority,ticketSource,ticketCategory}=definition;
  const customLabel=customFilter&&(customProperties.find(({id})=>id===customFilter.propertyId)?.label??'Unavailable property');
  const pipeline=[builtinPipeline,...pipelines].find(({id})=>id===dealPipelineId);
  const stageName=pipeline?.stages.find(({id})=>id===dealStageId)?.name;
  const format=metric==='sum'?amounts:counts;
  const display=(value:string|null)=>value===null?'—':format.format(value as `${number}`);
  return <div aria-live="polite" className="portable-contacts-table">
    <h3>{definition.name+' results'}</h3>
    <p>{counts.format(result.count as `${number}`)} {sourceLabels[kind].toLowerCase()} included
      {metric==='sum'?' · Unweighted deal amounts':''}</p>
    {filter&&<p>{filter.field==='closeDate'?`Close date from ${filter.value} through ${filter.valueTo}`:
      `${portableReportGroupLabels[kind].label} is ${filter.value}`}</p>}
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
    <table aria-label="Report results">
      <thead><tr><th scope="col">{groupBy?portableReportGroupLabels[kind].label:'Group'}</th>
        <th scope="col">{metric==='sum'?'Total deal amount':'Record count'}</th></tr></thead>
      <tbody>{result.rows.map(row=><tr key={row.key??'missing'}><th scope="row">{onOpenRecords?<button type="button" className="portable-dashboard-drill" onClick={()=>onOpenRecords(row.key??'')}
        aria-label={'View records for '+row.label}>{row.label}</button>:row.label}</th><td>{display(row.value)}</td></tr>)}</tbody>
      <tfoot><tr><th scope="row">{filter||customFilter||dealOutcome||createdDateRange||dealPipelineId||taskDueDateRange||
        taskAssigneeId!==undefined||ticketPriority||ticketSource||ticketCategory?'Matching records':'All records'}</th><td>{display(result.total)}</td></tr></tfoot>
    </table>
    {onOpenRecords&&<button type="button" className="portable-dashboard-drill" onClick={()=>onOpenRecords()}>View matching records</button>}
    {result.truncated&&<p>Showing {portableReportGroupLimit} groups. The total includes every group.</p>}
  </div>;
}
