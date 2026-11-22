import Link from 'next/link';
import {PortableSettingsLayout} from './portable-settings-layout';
import {PortableCrmHeader} from './portable-crm-header';
import {objectPath} from '../lib/portable-custom-objects';
import {portableRecordPath} from '../lib/portable-record-path';
import {accessExportLimit,accessExportPart,accessHistory,accessKind,type AccessQuery} from '../db/postgres/record-access-store';
import {portableDb} from './portable-db';

const labels={detail:'Record opened',list:'Record list',csv:'CSV export',integration:'Integration activity',search:'Search results',report:'Report records',related:'Linked record preview',history:'Record history viewed',document:'Document download',duplicates:'Duplicate review',merge_preview:'Merge preview',import_preview:'Import preview'};
const operationLabels={read:'Integration read',create:'Integration create',update:'Integration update',archive:'Integration archive'};
const utcTime=(at:number)=>new Date(at).toISOString().replace('T',' ').slice(0,19);
function historyRecordPath(row:Awaited<ReturnType<typeof accessHistory>>['items'][number],id:string){
  switch(row.kind){
    case 'custom-objects':return objectPath({objectId:row.customObjectId!,record:id});
    case 'products':case 'quotes':return '/'+row.kind+'?id='+id;
    case 'invoices':return '/?view=invoices&invoiceId='+id;
    default:return portableRecordPath(row.kind,id);
  }
}
export async function PortableAccessHistory({owner,email,query,part}:{part?:number;owner:string;email:string;query:AccessQuery}){
  const reversed=query.from&&query.through&&query.from>query.through;
  const filters=new URLSearchParams();
  for(const [key,value] of Object.entries(query))if(key!=='event'&&value!==undefined)filters.set(key,String(value));
  const download=new URLSearchParams(filters);
  download.delete('afterAt');download.delete('afterId');download.set('export','csv');
  if(query.event)download.set('event',query.event);
  const csv='/api/workspaces?'+download;
  const parts=new URLSearchParams(download);
  parts.delete('export');parts.set('part','1');
  if(part){
    const {events,more}=reversed?{events:[],more:false}:await accessExportPart(portableDb(),owner,query);
    const next=new URLSearchParams(parts),last=events.at(-1);
    if(last){next.set('part',String(part+1));next.set('afterAt',String(last.at));next.set('afterId',last.id);}
    const back=new URLSearchParams(parts);back.delete('part');
    return <main className="portable-contacts"><PortableCrmHeader page="settings" email={email}/>
      <PortableSettingsLayout active="record-access"><section>
        <Link href={'/?'+back} prefetch={false}>Back to filtered history</Link>
        <h1>Export record access history</h1>
        <p>Download each part before opening the next. Events are ordered newest first.</p>
        {last?<><h2>Part {part}</h2>
          <p>{events.length} {events.length===1?'event':'events'} · {utcTime(last.at)} to {utcTime(events[0].at)} UTC</p>
          <form method="post" action={csv+'&part='+part}>
            <input type="hidden" name="eventIds" value={events.map(row=>row.id).join(',')}/>
            <button type="submit">Download part {part} (CSV)</button>
          </form>
          {more?<a href={'/?'+next}>Next export part</a>:<p>Final part</p>}
        </>:<p>No matching access events.</p>}
      </section></PortableSettingsLayout></main>;
  }
  const {items,more}=reversed?{items:[],more:false}:await accessHistory(portableDb(),owner,query);
  const next=new URLSearchParams(filters);
  if(more){const last=items[items.length-1];next.set('afterAt',String(last.at));next.set('afterId',last.id);}
  return <main className="portable-contacts"><PortableCrmHeader page="settings" email={email}/>
    <PortableSettingsLayout active="record-access"><section>
    <Link href="/?view=workspaces#team-directory" prefetch={false}>Team directory</Link><h1>Record access history</h1>
    <p>Review record views and exports, including records read or changed by integrations. Times are UTC.</p>
    <form method="get" key={filters.toString()}><input type="hidden" name="view" value="record-access"/>
      {query.actor&&<><input type="hidden" name="actor" value={query.actor}/><p>Showing this member’s activity across email addresses. <Link href="/?view=settings&section=users-teams" prefetch={false}>Back to Users &amp; Teams</Link></p></>}
      <label>Object<select name="kind" aria-label="Object" defaultValue={query.kind??''}><option value="">All objects</option>
        {accessKind.options.map(kind=><option key={kind} value={kind}>{kind==='custom-objects'?'Custom objects':kind[0].toUpperCase()+kind.slice(1)}</option>)}</select></label>
      <label>Activity<select name="action" aria-label="Activity" defaultValue={query.action??''}><option value="">All activities</option>
        {Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>API operation<select name="operation" defaultValue={query.operation??''}><option value="">All operations</option>
        {Object.entries(operationLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Actor email<input type="email" name="email" defaultValue={query.email} placeholder="Any person"/></label>
      <label>From (UTC)<input type="date" name="from" defaultValue={query.from}/></label>
      <label>Through (UTC)<input type="date" name="through" defaultValue={query.through}/></label>
      <label>Record ID<input name="record" defaultValue={query.record} placeholder="Any record"/></label>
      <label>Custom object type ID<input name="objectId" defaultValue={query.objectId} placeholder="Any custom object type"/></label>
      <label>File ID<input name="file" defaultValue={query.file} placeholder="Any attachment"/></label>
      <label>API token ID<input name="token" defaultValue={query.token} placeholder="Any integration"/></label>
      <button>Apply filters</button> <Link href="/?view=record-access" prefetch={false}>Clear filters</Link>
    </form>
    {items.length>0&&<p>
      <a href={csv}>{query.event?'Download event (CSV)':'Export matching events (CSV, up to '+accessExportLimit+')'}</a>
      {!query.event&&<> · <a href={csv+'&eventIds='+items.map(item=>item.id).join(',')}>Download this page (CSV)</a></>}
    </p>}
    {more&&!query.event&&<p><a href={'/?'+parts}>Export in parts of up to {accessExportLimit} events</a></p>}
    {query.event&&<Link href={'/?'+filters} prefetch={false}>Back to results</Link>}
    {reversed?<p role="alert">Choose an end date on or after the start date.</p>:items.length?<table><thead><tr><th>Time (UTC)</th><th>Who</th><th>Activity</th><th>Records</th></tr></thead>
      <tbody>{items.map(row=><tr key={row.id}><td>{utcTime(row.at)}</td>
        <td>{row.email}{row.token&&<details><summary>{row.tokenName??'API token'} · token ID</summary><code>{row.token}</code></details>}</td>
        <td>{row.fileId?'Contact file download · Version '+row.fileRevision:row.operation?operationLabels[row.operation]:labels[row.action]}</td><td>{row.count>1&&!query.event?
          <a href={'/?'+filters+'&event='+row.id}>{row.count} {row.customName??row.kind} · View IDs</a>:
          <details open={Boolean(query.event)}><summary>{row.count} · {row.customName??row.kind}</summary>
            <ul>{row.ids.map(id=><li key={id}><a href={historyRecordPath(row,id)}>{id}</a></li>)}</ul>
            {row.fileId&&<dl><dt>File ID</dt><dd>{row.fileId}</dd><dt>Version ID</dt><dd>{row.fileVersionId}</dd></dl>}
          </details>}</td></tr>)}</tbody></table>:<p>No matching access events.</p>}
    {more&&<a href={'/?'+next}>Older activity</a>}
  </section></PortableSettingsLayout></main>;
}
