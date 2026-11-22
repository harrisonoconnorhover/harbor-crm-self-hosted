'use client';
import {WorkspaceDate,useWorkspaceDefaults} from './portable-workspace-format';
import {workspaceNumber} from '../lib/portable-account-defaults';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {MarketingAudienceStatus,MarketingAudienceFilter} from '../lib/marketing-audience';
import type {MarketingActivityPage,RecipientHistoryPage} from '../lib/marketing-campaign';
import {PortableMarketingFormSettings} from './portable-marketing-form-settings';
import {PortableMarketingDesigns} from './portable-marketing-designs-ui';
import './portable-contacts.css';
import './portable-settings.css';
import './portable-marketing.css';

type Preview={total:number;emails:string[];next:string|null;status:MarketingAudienceStatus;designRevision?:number};
type Design={id:string;name:string;revision:number};
const defaultNumber=new Intl.NumberFormat();
const route='/api/marketing/campaigns';
type ActivityPages={campaignAfter:string|null;issueAfter:string|null};
const firstPages:ActivityPages={campaignAfter:null,issueAfter:null};

async function read<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const result=await response.json();
  if(!response.ok)throw Error((result as {error?:string}|null)?.error??'Could not load marketing. Refresh to try again.');
  return result as T;
}

function RecipientHistory(){
  const [email,setEmail]=useState(''),[page,setPage]=useState<RecipientHistoryPage|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[older,setOlder]=useState(false);
  async function lookup(after:RecipientHistoryPage['next']=null){
    setBusy(true);setError('');
    try{
      const result=await read<RecipientHistoryPage>(route,{action:'recipientHistory',email,...after?{after}:{}});
      setPage(result);setOlder(after!==null);
    }catch(e){setError(e instanceof Error?e.message:'Could not load recipient history.');}
    finally{setBusy(false);}
  }
  return <section><h2>Recipient history</h2>
    <form className="marketing-row" onSubmit={event=>{event.preventDefault();void lookup();}}>
      <label>Recipient email<input type="email" required maxLength={320} value={email} disabled={busy}
        onChange={event=>{setEmail(event.target.value);setPage(null);setError('');setOlder(false);}}/></label>
      <button disabled={busy}>Find deliveries</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {page&&<><p role="status">{page.items.length?('Showing '+page.items.length+' campaign'+(page.items.length===1?'':'s')+' for '+email+'.'):'No campaign deliveries found for '+email+'.'}</p>
      <ul className="marketing-list">{page.items.map(row=><li key={row.id}><div><strong>{row.name}</strong>
        <p>Campaign created <WorkspaceDate value={row.createdAt} day>{new Date(row.createdAt).toLocaleDateString()}</WorkspaceDate> · {row.state} · {row.attempts} {row.attempts===1?'attempt':'attempts'}</p>
        {row.providerId&&<p>Provider message ID: {row.providerId}</p>}{row.lastIssue&&<p>{row.lastIssue}</p>}
      </div></li>)}</ul>
      {(older||page.next)&&<nav aria-label="Recipient history pages">
        {older&&<button disabled={busy} onClick={()=>void lookup()}>Most recent deliveries</button>}{' '}
        {page.next&&<button disabled={busy} onClick={()=>void lookup(page.next)}>Older deliveries</button>}
      </nav>}
    </>}
  </section>;
}

export function PortableMarketingUI({initialStatus,campaignsHome=false}:{initialStatus:MarketingAudienceStatus;campaignsHome?:boolean}){
  const defaults=useWorkspaceDefaults();
  const countLabel=(value:number)=>defaults?workspaceNumber(value,defaults):defaultNumber.format(value);
  const recipientCount=(count:number)=>countLabel(count)+(count===1?' recipient':' recipients');
  const [tab,setTab]=useState(campaignsHome?'Delivery activity':'Campaigns'),[status,setStatus]=useState(initialStatus);
  const [{campaigns,issues,campaignNext,issueNext,providerRetryAtMs,pages},setActivity]=useState<MarketingActivityPage&{pages:ActivityPages}>({
    campaigns:[],issues:[],campaignNext:null,issueNext:null,providerRetryAtMs:null,pages:firstPages,
  });
  const requestVersion=useRef(0);
  const [designs,setDesigns]=useState<Design[]>([]),[nextDesign,setNextDesign]=useState<string|null>(null),[designId,setDesignId]=useState('');
  const [name,setName]=useState(''),[sendAfter,setSendAfter]=useState(''),[account,setAccount]=useState(''),[accountValue,setAccountValue]=useState('');
  const [related,setRelated]=useState(''),[relatedValue,setRelatedValue]=useState('');
  const [preview,setPreview]=useState<Preview>(),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[receipt,setReceipt]=useState(''),[review,setReview]=useState<{id:string;attempt:number}>();
  const requestId=useRef('');
  const leaveDesign=useRef<(()=>boolean)|null>(null);
  const registerDesignExit=useCallback((guard:(()=>boolean)|null)=>{leaveDesign.current=guard;},[]);
  const loadPage=useCallback(async(pages=firstPages)=>{
    const version=++requestVersion.current;
    const params=new URLSearchParams();
    if(pages.campaignAfter)params.set('campaignAfter',pages.campaignAfter);
    if(pages.issueAfter)params.set('issueAfter',pages.issueAfter);
    const [list,library]=await Promise.all([read<MarketingActivityPage>(route+(params.size?'?'+params:'')),
      read<{items:Design[];next:string|null}>('/api/marketing/designs')]);
    if(version!==requestVersion.current)return;
    setActivity({...list,pages});setDesigns(library.items);setNextDesign(library.next);
  },[]);
  useEffect(()=>{
    const load=()=>{void loadPage().catch(e=>setError(e.message));};
    load();window.addEventListener('harbor:marketing-design-saved',load);
    return ()=>window.removeEventListener('harbor:marketing-design-saved',load);
  },[loadPage]);
  const refresh=()=>loadPage(pages);
  const filter:MarketingAudienceFilter={...(account?{account:{field:account,value:accountValue}}:{}),
    ...(related?{related:{field:related,value:relatedValue}}:{})};
  const retryDate=providerRetryAtMs===null?null:new Date(providerRetryAtMs);
  const design=designs.find(d=>d.id===designId);
  const reset=()=>{setPreview(undefined);requestId.current='';setMessage('');setError('');};
  async function act(job:()=>Promise<void>){
    setBusy(true);setError('');setMessage('');
    try{await job();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy(false);}
  }
  async function inspect(){
    const data=await read<Preview>(route,{action:'preview',filter});
    setStatus(data.status);setPreview({...data,designRevision:design?.revision});requestId.current=crypto.randomUUID();
  }
  return <section className="portable-settings-content portable-marketing">
    <header className="portable-settings-heading"><h1>{campaignsHome?'Campaigns':'Email marketing'}</h1>
      <nav aria-label={campaignsHome?'Campaign sections':'Email marketing sections'}>{(campaignsHome?['Delivery activity','Campaigns','Email designs']:['Campaigns','Email designs','Website forms','Delivery activity']).map(t=>
        <button key={t} type="button" aria-pressed={tab===t} onClick={()=>{
          if(t!==tab&&tab==='Email designs'&&leaveDesign.current&&!leaveDesign.current())return;
          setTab(t);
        }}>{campaignsHome&&t==='Campaigns'?'Create campaign':t}</button>)}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Document navigation preserves the unsaved email design prompt. */}
        <a href="/?view=web-attribution">Marketing analytics</a>
      </nav>
    </header>
    {error&&<p className="marketing-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {tab==='Website forms'&&<PortableMarketingFormSettings/>}
    {tab==='Email designs'&&<PortableMarketingDesigns registerExit={registerDesignExit}/>}
    {tab==='Campaigns'&&<>
      <section className="marketing-source"><div><h2>Salesforce audience</h2>
        {status.completedAt?<p>Last completed sync <time dateTime={status.completedAt}><WorkspaceDate value={status.completedAt}>{new Date(status.completedAt).toLocaleString()}</WorkspaceDate></time></p>:
          <p>Run a Salesforce audience sync to see eligible contacts.</p>}</div>
        <div><strong>{countLabel(status.contacts)}</strong><span>Contacts in Salesforce snapshot</span></div>
        <div><strong>{status.state}</strong><span>Sync status</span></div>
      </section>
      <section><h2>New campaign</h2>
        <form className="marketing-builder" onSubmit={e=>{e.preventDefault();void act(inspect);}}>
          <fieldset disabled={busy} onChange={reset}>
            <label>Campaign name<input maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>
            <label>Email design<select value={designId} onChange={e=>setDesignId(e.target.value)}>
              <option value="">Choose a saved design</option>{designs.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            {nextDesign&&<button type="button" onClick={()=>void act(async()=>{
              const more=await read<{items:Design[];next:string|null}>('/api/marketing/designs?after='+encodeURIComponent(nextDesign));
              setDesigns(old=>[...old,...more.items]);setNextDesign(more.next);
            })}>Load more designs</button>}
            {!designs.length&&<button type="button" onClick={()=>setTab('Email designs')}>Open email designs</button>}
            <label>Earliest send time (optional, local time)<input type="datetime-local" value={sendAfter} onChange={e=>setSendAfter(e.target.value)}/></label>
            <label>Account field<select value={account} onChange={e=>setAccount(e.target.value)}>
              <option value="">All accounts</option>{status.mapping?.accountFields.map(f=><option key={f}>{f}</option>)}</select></label>
            {account&&<label>{account} equals<input required maxLength={500} value={accountValue} onChange={e=>setAccountValue(e.target.value)}/></label>}
            <label>Related {status.mapping?.related?.object??'object'} field<select value={related} onChange={e=>setRelated(e.target.value)}>
              <option value="">Any related record</option>{status.mapping?.related?.fields.map(f=><option key={f}>{f}</option>)}</select></label>
            {related&&<label>{related} equals<input required maxLength={500} value={relatedValue} onChange={e=>setRelatedValue(e.target.value)}/></label>}
          </fieldset>
          <button type="submit" disabled={busy}>Preview eligible recipients</button>
        </form>
        {preview&&<div className="marketing-preview"><h3>{countLabel(preview.total)} eligible {preview.total===1?'recipient':'recipients'}</h3>
          <p>Only distinct, opted-in addresses are included. Harbor checks consent and email blocks again before each send.</p>
          {!!preview.emails.length&&<details><summary>Show sample addresses</summary><ul>{preview.emails.slice(0,10).map(a=><li key={a}>{a}</li>)}</ul></details>}
          {(!design||!name.trim())&&<p>Choose a saved design and name the campaign to queue this audience.</p>}
          <button type="button" className="primary" disabled={busy||!preview.total||!design||!name.trim()||design.revision!==preview.designRevision||preview.status.state!=='ready'}
            onClick={()=>void act(async()=>{
              const result=await read<{total:number}>(route,{action:'queue',id:requestId.current,name:name.trim(),designId,
                designRevision:preview.designRevision,expectedTotal:preview.total,snapshot:preview.status.generation,sendAfter:sendAfter?new Date(sendAfter).getTime():undefined,filter});
              reset();setName('');setSendAfter('');setMessage('Queued '+recipientCount(result.total)+'.');setTab('Delivery activity');await loadPage();
            })}>Queue campaign for {countLabel(preview.total)}</button>
        </div>}
      </section></>}
    {tab==='Delivery activity'&&<>
      <section><div className="marketing-row"><h2>Recent campaigns</h2><button type="button" disabled={busy} onClick={()=>void act(refresh)}>Refresh</button></div>
        {retryDate&&<p role="status">The email provider requested a pause for campaigns and form notifications.
          {retryDate.toJSON()&&<> Sending can resume after <time dateTime={retryDate.toISOString()}><WorkspaceDate value={retryDate.getTime()}>{retryDate.toLocaleString()}</WorkspaceDate></time>.</>}</p>}
        {!campaigns.length?<p>{pages.campaignAfter?'No older campaigns on this page.':'No campaigns queued yet.'}</p>:<ul className="marketing-list">{campaigns.map(c=><li key={c.id}><div>
          <strong>{c.name}</strong>{c.sendAfter&&<p>Scheduled from <WorkspaceDate value={c.sendAfter}>{new Date(c.sendAfter).toLocaleString()}</WorkspaceDate></p>}<p>{recipientCount(c.audienceSize)} · {Object.entries(c.states).map(([k,v])=>countLabel(v)+' '+k).join(' · ')}</p></div>
          {c.sourceChanged?<span>Salesforce source changed. Review a new campaign.</span>:c.active?<button type="button" disabled={busy} onClick={()=>void act(async()=>{
            await read(route,{action:'pause',id:c.id,paused:!c.paused});await refresh();
          })}>{c.paused?'Resume':'Pause'}</button>:<span>Archived dispatch</span>}</li>)}</ul>}
        {(pages.campaignAfter||campaignNext)&&<nav aria-label="Campaign pages">
          {pages.campaignAfter&&<button disabled={busy} onClick={()=>void act(()=>loadPage({...pages,campaignAfter:null}))}>Most recent campaigns</button>}
          {campaignNext&&<button disabled={busy} onClick={()=>void act(()=>loadPage({...pages,campaignAfter:campaignNext}))}>Older campaigns</button>}
        </nav>}
      </section>
      <RecipientHistory/>
      <section><h2>Needs a decision</h2>{!issues.length?<p>{pages.issueAfter?'No more delivery issues on this page.':'No delivery issues to review.'}</p>:<ul className="marketing-list">{issues.map(i=><li key={i.id}>
        <div><strong>{i.email}</strong><p>{i.campaignName} · {i.state==='sending'?'Awaiting confirmation':i.state} · {i.lastIssue}</p>
          {i.state==='sending'&&<p>Confirmation was due <time dateTime={new Date(i.dueAt).toISOString()}><WorkspaceDate value={i.dueAt}>{new Date(i.dueAt).toLocaleString()}</WorkspaceDate></time>.</p>}
          {review?.id===i.id&&review.attempt===i.attempts&&<label>Verified provider message ID<input value={receipt} onChange={e=>setReceipt(e.target.value)}/></label>}</div>
        <button type="button" disabled={busy} onClick={()=>void act(async()=>{
          if(review?.id!==i.id||review.attempt!==i.attempts){setReceipt('');setReview({id:i.id,attempt:i.attempts});return;}
          await read(route,{action:'resolve',id:i.id,expectedAttempt:i.attempts,resolution:'accepted',providerId:receipt});await refresh();
        })}>{review?.id===i.id&&review.attempt===i.attempts?'Record receipt':'Verify receipt'}</button>
        <button type="button" disabled={busy} onClick={()=>void act(async()=>{
          await read(route,{action:'resolve',id:i.id,expectedAttempt:i.attempts,resolution:'skip'});await refresh();
        })}>Close without resending</button></li>)}</ul>}
        {(pages.issueAfter||issueNext)&&<nav aria-label="Delivery issue pages">
          {pages.issueAfter&&<button disabled={busy} onClick={()=>void act(()=>loadPage({...pages,issueAfter:null}))}>First delivery issues</button>}
          {issueNext&&<button disabled={busy} onClick={()=>void act(()=>loadPage({...pages,issueAfter:issueNext}))}>More delivery issues</button>}
        </nav>}
      </section></>}
  </section>;
}
