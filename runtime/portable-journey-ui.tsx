'use client';
import Link from 'next/link';
import {useState,type FormEvent,type ReactNode} from 'react';
import {ArrowLeft,ArrowUpRight,Check,Code2,Globe,MousePointer2} from 'lucide-react';
import type {ReportPeriod,TrafficQuery} from '../lib/portable-web-attribution';
import type {readAttribution,readTraffic} from '../db/postgres/web-attribution-store';
import './portable-journey.css';

type Report=Awaited<ReturnType<typeof readAttribution>>;
type Site=Report['sites'][number];
const number=new Intl.NumberFormat('en-US');
const credit=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC',timeZoneName:'short'});
function time(ms:number){return <time dateTime={new Date(ms).toISOString()}>{date.format(ms)}</time>;}
type CreditGroup='Source'|'Medium'|'Campaign';
type ReportFilters={contactId?:string;siteId?:string;period?:ReportPeriod;creditGroup?:CreditGroup;inquiryId?:string;cursor?:NonNullable<Report['next']>};
function link(tab:'report'|'sites'|'traffic',filters:ReportFilters={}){
  const {contactId,siteId,period,inquiryId,creditGroup}=filters;
  const q=new URLSearchParams({view:'web-attribution',tab});
  if(siteId)q.set('siteId',siteId);
  if(period&&period!=='30d')q.set('period',period);
  if(creditGroup&&creditGroup!=='Source'&&tab==='report')q.set('creditGroup',creditGroup);
  if(contactId&&tab==='report')q.set('contactId',contactId);
  if(inquiryId)q.set('inquiryId',inquiryId);
  if(tab==='report'&&filters.cursor){
    q.set('beforeAt',String(filters.cursor.beforeAt));
    q.set('beforeId',filters.cursor.beforeId);
    q.set('through',String(filters.cursor.through));
  }
  return '/?'+q;
}
function siteName(sites:Site[],id:string){return sites.find(s=>s.id===id)?.name??'Website';}

function AttributionLayout({contactId,siteId,period,creditGroup,tab,children}:ReportFilters&{tab:'report'|'sites'|'traffic';children:ReactNode}){
  return <section className="harbor-attribution">
    <header className="journey-header"><Link href="/?view=reports">Reports</Link><h1>Marketing analytics</h1></header>
    <nav aria-label="Marketing analytics" className="journey-tabs">
      <a href={link('report',{contactId,siteId,period,creditGroup})} aria-current={tab==='report'?'page':undefined}>Web attribution</a>
      <a href={link('traffic',{siteId,period})} aria-current={tab==='traffic'?'page':undefined}>Traffic</a>
      <a href={link('sites',{siteId,period})} aria-current={tab==='sites'?'page':undefined}>Tracking sites</a>
    </nav>
    {children}
  </section>;
}

export function WebAttribution({result,contactId,siteId,period,creditGroup:initialGroup,cursor,tab,harborOrigin}:ReportFilters&{
  result:Report;tab:'report'|'sites';harborOrigin:string;
}){
  const [creditGroup,setCreditGroup]=useState<CreditGroup>(initialGroup??'Source');
  function changeGroup(value:CreditGroup){
    setCreditGroup(value);
    window.history.replaceState(window.history.state,'',link('report',{contactId,siteId,period,creditGroup:value,cursor}));
  }
  return <AttributionLayout tab={tab} contactId={contactId} siteId={siteId} period={period} creditGroup={creditGroup}>{result.contact&&<p>Conversion paths for <a href={'/?contact='+result.contact.id}>{result.contact.name}</a> · <a href={link('report',{siteId,period,creditGroup})}>Show all contacts</a></p>}
    {tab==='sites'?<SiteSettings key={siteId} sites={result.sites} siteId={siteId} harborOrigin={harborOrigin}/>:
      result.selected?<ConversionPath cursor={cursor} result={result} contactId={contactId} siteId={siteId} period={period} creditGroup={creditGroup}/>:<AttributionOverview cursor={cursor} result={result} contactId={contactId} siteId={siteId} period={period} group={creditGroup} setGroup={changeGroup}/>}
  </AttributionLayout>;
}

type Traffic=Awaited<ReturnType<typeof readTraffic>>;
const trafficLabels={source:'Traffic source',medium:'UTM medium',campaign:'UTM campaign',page:'Page'};
function trafficLink(siteId:string|undefined,group:TrafficQuery['group'],period?:ReportPeriod,cursor?:Traffic['next']){
  const params=new URLSearchParams({view:'web-attribution',tab:'traffic',group});
  if(siteId)params.set('siteId',siteId);
  if(period&&period!=='30d')params.set('period',period);
  if(cursor){
    params.set('afterViews',String(cursor.afterViews));
    params.set('afterLabel',cursor.afterLabel);
    params.set('through',String(cursor.through));
  }
  return '/?'+params;
}
function PeriodFilter({period,onChange}:{period?:ReportPeriod;onChange:(value:ReportPeriod)=>void}){
  return <div><label htmlFor="journey-period">Reporting period</label> <select id="journey-period" value={period??'30d'} onChange={e=>onChange(e.target.value as ReportPeriod)}>
    <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
    <option value="previous7d">Previous 7 days</option><option value="30d">Last 30 days</option>
  </select></div>;
}
export function WebsiteTraffic({result,query}:{result:Traffic;query:TrafficQuery}){
  return <AttributionLayout tab="traffic" siteId={query.siteId} period={query.period}>
    <div className="journey-report-tools"><PeriodFilter period={query.period} onChange={p=>window.location.assign(trafficLink(query.siteId,query.group,p))}/>
      <label htmlFor="traffic-site">Website</label> <select id="traffic-site" value={query.siteId??''} onChange={e=>window.location.assign(trafficLink(e.target.value||undefined,query.group,query.period))}>
        <option value="">All tracking sites</option>
        {result.sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
      </select>
    </div>
    <dl className="journey-metrics"><div><dt>Page views</dt><dd>{number.format(result.pageviews)}</dd></div>
      <div><dt>Visitors</dt><dd>{number.format(result.visitors)}</dd></div></dl>
    <section className="journey-card"><h2>Website traffic</h2>
      <label htmlFor="traffic-group">Group visits by</label> <select id="traffic-group" value={query.group} onChange={e=>window.location.assign(trafficLink(query.siteId,e.target.value as TrafficQuery['group'],query.period))}>
        {Object.entries(trafficLabels).map(([value,name])=><option key={value} value={value}>{name}</option>)}
      </select>
      {result.rows.length?<><p>Visitors are counted once per browser per website. A visitor can appear in more than one row.</p>
        <div className="journey-scroll"><table aria-label="Website traffic"><thead><tr>
          <th>{trafficLabels[query.group]}</th><th>Page views</th><th>Visitors</th>
        </tr></thead><tbody>{result.rows.map(row=><tr key={row.label}><th scope="row">{row.label}</th>
          <td>{number.format(row.views)}</td><td>{number.format(row.visitors)}</td></tr>)}</tbody></table></div></>:
        <p>{query.afterViews?'No more groups on this page.':result.sites.length?'No measured visits in this period.':
          <><a href={link('sites')}>Connect a tracking site</a> to see visits here.</>}</p>}
      {(query.afterViews!==undefined||result.next)&&<nav className="journey-actions" aria-label="Traffic pages">
        {query.afterViews!==undefined&&<a href={trafficLink(query.siteId,query.group,query.period)}>First page</a>}
        {result.next&&<a href={trafficLink(query.siteId,query.group,query.period,result.next)}>Next page</a>}
      </nav>}
    </section>
  </AttributionLayout>;
}

function AttributionOverview({result,contactId,siteId,period,cursor,group,setGroup}:ReportFilters&{result:Report;group:CreditGroup;setGroup:(value:CreditGroup)=>void}){
  const {sites,recent}=result;
  const rows=group==='Source'?result.sources.map(({source,...values})=>({label:source,...values})):
    group==='Medium'?result.mediums:result.campaigns;
  return <>
    <div className="journey-report-tools"><PeriodFilter period={period} onChange={p=>window.location.assign(link('report',{contactId,siteId,period:p,creditGroup:group}))}/>
      <div className="journey-site-filter"><label htmlFor="journey-filter">Website</label> <select id="journey-filter" value={siteId??''} onChange={e=>window.location.assign(link('report',{contactId,siteId:e.target.value||undefined,period,creditGroup:group}))}>
        <option value="">All tracking sites</option>
        {sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
      </select></div>
    </div>
    <dl className="journey-metrics">{result.pageviews!==null&&<div><dt>Page views</dt><dd>{number.format(result.pageviews)}</dd></div>}
      <div><dt>Attributed form inquiries</dt><dd>{number.format(result.conversions)}</dd></div></dl>
    <section className="journey-card"><h2>{group} credit</h2>
      <label>Group credit by <select value={group} onChange={event=>{
        const value=event.target.value;
        if(value==='Source'||value==='Medium'||value==='Campaign')setGroup(value);
      }}><option>Source</option><option>Medium</option><option>Campaign</option></select></label>
      {rows.length?<><p>First and last touch each credit one visit per inquiry. Linear credit is split equally across all its recorded page views.</p>
        <div className="journey-scroll"><table><thead><tr><th>{group==='Source'?'Traffic source':group}</th><th>First touch</th><th>Last touch</th><th>Linear credit</th></tr></thead>
          <tbody>{rows.map(row=><tr key={row.label}><th scope="row">{row.label}</th><td>{number.format(row.first)}</td>
            <td>{number.format(row.last)}</td><td>{row.linear>0&&row.linear<.01?'<0.01':credit.format(row.linear)}</td></tr>)}</tbody>
        </table></div></>:<p>{!sites.length?<><a href={link('sites')}>Connect a tracking site</a> to measure where your form inquiries begin.</>:
          'Credit appears after a visitor with a recorded page view submits a Harbor form.'}</p>}
    </section>
    <section className="journey-card"><h2>Recent conversion paths</h2>
      {recent.length?<ul className="journey-conversions">{recent.map(item=><li key={item.inquiryId}><div>
        <a href={link('report',{contactId,siteId,period,creditGroup:group,cursor,inquiryId:item.inquiryId})}>{item.formTitle} <ArrowUpRight size={14}/></a>
        <span>{siteName(sites,item.siteId)}</span></div>{time(item.convertedAt)}</li>)}</ul>:<p>{cursor?'No more conversion paths on this page.':'No attributed inquiries in this period.'}</p>}
      {(cursor||result.next)&&<nav className="journey-actions" aria-label="Conversion path pages">
        {cursor&&<a href={link('report',{contactId,siteId,period,creditGroup:group})}>Newest inquiries</a>}
        {result.next&&<a href={link('report',{contactId,siteId,period,creditGroup:group,cursor:result.next})}>Older inquiries</a>}
      </nav>}
    </section>
  </>;
}

function ConversionPath({result,contactId,siteId,period,creditGroup,cursor}:ReportFilters&{result:Report}){
  const inquiry=result.selected!;
  return <><a className="journey-back" href={link('report',{contactId,siteId,period,creditGroup,cursor})}><ArrowLeft size={15}/> All conversion paths</a>
    <section className="journey-card"><h2>{inquiry.formTitle}</h2>
      <p>{siteName(result.sites,inquiry.siteId)} · Submitted {time(inquiry.convertedAt)}</p>
      <h3>Path to inquiry</h3>
      {result.pathTotal>result.path.length&&<p>Showing the first 50 and last 50 of {number.format(result.pathTotal)} page views.</p>}
      <ol className="journey-path">{result.path.map(step=><li key={step.id}><MousePointer2 aria-hidden="true" size={16}/>
        <div><strong>{step.path}</strong><span>{[step.source,step.medium,step.campaign].filter(Boolean).join(' · ')}</span>{time(step.at)}</div></li>)}</ol>
      <a href={'/?'+new URLSearchParams({view:'forms',formId:inquiry.formId,submissionId:inquiry.inquiryId})+'#form-inquiries'}>Open form inquiry <ArrowUpRight size={14}/></a>
      {inquiry.contactId&&!contactId&&<> · <a href={'/?contact='+inquiry.contactId}>Open contact</a></>}
    </section></>;
}

function SiteSettings({sites:initial,siteId,harborOrigin}:{sites:Site[];siteId?:string;harborOrigin:string}){
  const [sites,setSites]=useState(initial);
  const [selectedId,select]=useState<string|undefined>(siteId??initial[0]?.id);
  const selected=sites.find(s=>s.id===selectedId);
  function saved(site:Site){
    setSites(current=>[...current.filter(s=>s.id!==site.id),site].sort((a,b)=>a.name.localeCompare(b.name)));
    select(site.id);
  }
  return <div className="journey-settings">
    <aside className="journey-site-list"><h2>Tracking sites</h2>
      {sites.length?<ul>{sites.map(s=><li key={s.id}>
        <button type="button" onClick={()=>select(s.id)} aria-current={selectedId===s.id?'true':undefined}>
          <Globe size={17}/><span><strong>{s.name}</strong><small>{s.origin}</small></span>
          <span className={'journey-status '+(s.enabled?'enabled':'')}>{s.enabled?'Active':'Paused'}</span>
        </button>
      </li>)}</ul>:<p>Register the website where visitors discover your forms.</p>}
      {selectedId&&<button type="button" onClick={()=>select(undefined)}>Add tracking site</button>}
    </aside>
    <div className="journey-site-detail">
      <SiteEditor key={selected?.id??'new'} site={selected} onSave={saved}/>
      {selected&&<Installation site={selected} harborOrigin={harborOrigin}/>}
    </div>
  </div>;
}

function SiteEditor({site,onSave}:{site?:Site;onSave:(s:Site)=>void}){
  const [newId]=useState(()=>crypto.randomUUID());
  const [name,setName]=useState(site?.name??''),[origin,setOrigin]=useState(site?.origin??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [stale,setStale]=useState(false);
  async function save(enabled:boolean){
    setError('');setStatus('');
    const url=URL.parse(origin.trim());
    if(!url||![url.origin,url.origin+'/'].includes(origin.trim())||
      !(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))){
      setError('Enter an exact website origin, such as https://www.example.com.');return;
    }
    setBusy(true);
    try{
      const response=await fetch('/api/web-attribution',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:site?.id??newId,revision:site?.revision??0,name:name.trim(),origin:url.origin,enabled})});
      const result=await response.json() as Site&{error?:string};
      if(!response.ok){
        setStale(response.status===409);throw Error(result.error||'Could not save tracking site.');
      }
      onSave(result);setName(result.name);setStatus(result.enabled?'Site settings saved.':'Tracking paused.');
    }catch(e){setError(e instanceof Error?e.message:'Could not save tracking site.');}
    finally{setBusy(false);}
  }
  function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();void save(site?.enabled??true);}
  return <section className="journey-card"><h2>{site?'Site settings':'Add tracking site'}</h2>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>Site name<input required value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="Company website"/></label>
      <label>Website origin<input required type="url" readOnly={!!site} value={origin} maxLength={254}
        onChange={e=>setOrigin(e.target.value)} placeholder="https://www.example.com"/></label>
      <div className="journey-actions"><button className="journey-primary" disabled={busy||!name.trim()||!origin.trim()||stale||site&&name.trim()===site.name}>
        {site?'Save name':'Add site'}</button>
        {site&&<button type="button" disabled={busy||stale||name.trim()!==site.name} onClick={()=>void save(!site.enabled)}>
          {site.enabled?'Pause tracking':'Resume tracking'}</button>}</div>
    </fieldset></form>
    {error&&<p role="alert">{error} {stale&&<a href={link('sites',{siteId:site?.id})}>Reload site settings</a>}</p>}
    {status&&<p role="status">{status}</p>}
  </section>;
}

const consentExample=`let harborAnalyticsAllowed = false;

function setHarborAnalyticsConsent(allowed) {
  harborAnalyticsAllowed = allowed === true;
  if (!window.HarborJourney) return;
  if (harborAnalyticsAllowed) window.HarborJourney.start();
  else window.HarborJourney.stop();
}

window.addEventListener('harbor:journey-ready', () => {
  setHarborAnalyticsConsent(harborAnalyticsAllowed);
});`;

function Installation({site,harborOrigin}:{site:Site;harborOrigin:string}){
  const snippet='<script defer src="'+harborOrigin+'/journey.js" data-site="'+site.id+'" data-paths="/,/pricing,/demo"></script>';
  const [copied,setCopied]=useState(''),[error,setError]=useState('');
  async function copy(label:string,text:string){
    try{await navigator.clipboard.writeText(text);setCopied(label);setError('');}
    catch{setError('Select the code and copy it using your keyboard.');}
  }
  return <section className="journey-card journey-install"><h2><Code2 size={18}/> Install on {site.name}</h2>
    {!site.enabled&&<p role="status">Tracking is paused for this site.</p>}
    <p>Add this tag to pages on <strong>{site.origin}</strong>. Replace the example paths with the public page paths you want to report. Other paths appear as <code>/other</code>.</p>
    <pre><code>{snippet}</code></pre><button type="button" onClick={()=>void copy('tag',snippet)}>{copied==='tag'?<><Check size={14}/> Copied site tag</>:'Copy site tag'}</button>
    <h3>Connect analytics consent</h3><p>Place this function in your site’s consent handler. Call <code>setHarborAnalyticsConsent(true)</code> after consent and <code>setHarborAnalyticsConsent(false)</code> when it is withdrawn. Apply the visitor’s saved choice on each page.</p>
    <details><summary>Consent code</summary><pre><code>{consentExample}</code></pre>
      <button type="button" onClick={()=>void copy('consent',consentExample)}>{copied==='consent'?'Copied consent code':'Copy consent code'}</button>
    </details>
    <p>For a single-page website, call <code>HarborJourney.page()</code> after each page change. To measure inquiries, link to a Harbor form or embed one with this website as its approved origin.</p>
    {error&&<p role="status">{error}</p>}
  </section>;
}
