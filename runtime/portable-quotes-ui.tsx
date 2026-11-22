'use client';
import {WorkspaceDate} from './portable-workspace-format';
import {useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {QuoteAction,QuoteDocument,QuoteEditor} from '../app/quotes';
import type {LineSet} from '../lib/commerce';
import {portableQuoteStatusLabels,type PortableQuoteDetail} from '../lib/portable-quotes';
import {quoteLabel,quoteStatus,snapshotQuote,transitions,type QuoteData} from '../lib/quotes';
import {QuoteSigning} from './portable-quote-signing-ui';
import {PortableInvoiceCreate} from './portable-invoices-ui';
import {portableRecycleBinLink} from './portable-contact-recycle-ui';

class QuoteRequestError extends Error{
  constructor(message:string,readonly status:number){super(message);}
}

async function request<T>(path:string,body?:unknown){
  const response=await fetch(path,{cache:'no-store',...(body?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }:{})});
  const result=await response.json() as T&{error?:string};
  if(!response.ok)throw new QuoteRequestError(result.error??'Could not finish the quote request.',response.status);
  return result;
}

export function PortableQuoteCreate({dealId}:{dealId:string}){
  const router=useRouter();
  const [attempt,setAttempt]=useState<{id:string;expectedUpdatedAt:string;lineRevision:number}>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [sourceChanged,setSourceChanged]=useState(false);
  async function create(){
    setBusy(true);setError('');setSourceChanged(false);
    try{
      let source=attempt;
      if(!source){
        const lines=await request<LineSet>('/api/deal-line-items?dealId='+dealId);
        source={id:crypto.randomUUID(),expectedUpdatedAt:lines.deal.updatedAt,lineRevision:lines.revision};
        setAttempt(source);
      }
      const result=await request<{id:string}>('/api/quotes',{action:'create',dealId,...source});
      router.push('/quotes?id='+result.id);
    }catch(e){
      setError((e as Error).message);
      setSourceChanged(e instanceof QuoteRequestError&&e.status===409);
    }
    finally{setBusy(false);}
  }
  return <section aria-label="Deal quotes">
    <h2>Quotes</h2>
    <button type="button" disabled={busy} onClick={()=>void create()}>{busy?'Creating draft…':attempt?'Retry draft':'Create quote draft'}</button>{' '}
    <a href={'/quotes?dealId='+dealId}>View quotes</a>
    {error&&<p role="alert">{error}{' '}{sourceChanged&&<button type="button" onClick={()=>{setAttempt(undefined);setError('');}}>Refresh source</button>}</p>}
  </section>;
}

export function PortableQuoteEditor({detail,dealArchived,before,version,versionBefore}:{detail:PortableQuoteDetail;dealArchived:boolean;before?:number;
  version?:number;versionBefore?:number}){
  const router=useRouter();
  const [editing,setEditing]=useState(false);
  const [disposition,setDisposition]=useState<'accept'|'decline'|'void'>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const {quote,history,published}=detail;
  const path=(options:{version?:number;before?:number;versionBefore?:number}={})=>{
    const params=new URLSearchParams({id:quote.id});
    for(const [key,value] of Object.entries(options))if(value)params.set(key,String(value));
    return '/quotes?'+params;
  };
  async function save(data:QuoteData){
    setBusy(true);
    try{
      await request('/api/quotes',{action:'save',id:quote.id,revision:quote.revision,data});
      setEditing(false);
      router.refresh();
    }finally{setBusy(false);}
  }
  async function transition(action:'publish'|'recall'){
    if(!confirm(action==='publish'?'Publish a fixed private copy of this quote for download?':
      'Recall this version and reopen the draft? Previously downloaded copies remain with their recipients.'))return;
    setBusy(true);setError('');
    try{
      await request('/api/quotes',{action,id:quote.id,revision:quote.revision});
      router.refresh();
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  async function recordDisposition(fields:Record<string,string>){
    if(!disposition)return;
    setBusy(true);
    try{
      await request('/api/quotes',{...fields,action:disposition,id:quote.id,revision:quote.revision});
      setDisposition(undefined);
      router.refresh();
    }finally{setBusy(false);}
  }

  const actions=version?[]:transitions[quote.status];
  const canEdit=actions.includes('save');
  const display=quoteStatus(quote);
  return <section className="commerce-page quote-page">
    <a href="/quotes">Back to quotes</a>{' '}
    <Link href={dealArchived?portableRecycleBinLink('deals'):'/?kind=deals&record='+quote.dealId}>
      {quote.dealName}{dealArchived?' (archived)':''}
    </Link>
    <div className="portable-contacts-heading"><h2>{quote.data.title}</h2>
      {canEdit&&<>
        <button type="button" disabled={busy} onClick={()=>setEditing(true)}>Edit draft</button>
        <button type="button" disabled={busy} onClick={()=>void transition('publish')}>Publish private version</button>
      </>}
      {actions.includes('recall')&&<button type="button" disabled={busy} onClick={()=>void transition('recall')}>Recall to draft</button>}
      {actions.includes('accept')&&<button type="button" disabled={busy} onClick={()=>setDisposition('accept')}>Record offline acceptance</button>}
      {actions.includes('decline')&&<button type="button" disabled={busy} onClick={()=>setDisposition('decline')}>Mark declined</button>}
      {actions.includes('void')&&<button type="button" disabled={busy} onClick={()=>setDisposition('void')}>Void quote</button>}
    </div>
    <p><strong>{portableQuoteStatusLabels[display]}</strong></p>
    <p>You can download a published version or share it with the buyer using a private signing link.</p>
    {error&&<p role="alert">{error}</p>}
    {published&&<a href={`/api/quotes?id=${quote.id}&version=${published.version}&download=true`}>Download HTML</a>}
    {!version&&(detail.signingLinkId||detail.signature||display==='published'&&!dealArchived)&&<QuoteSigning key={quote.id+':'+quote.version} detail={detail} canIssue={display==='published'&&!dealArchived}/>}
    {version&&<p><a href={path()}>Current quote</a></p>}
    <QuoteDocument q={quote} snapshot={published?.snapshot??snapshotQuote(quote.data)} version={published?.version??0}
      publishedAt={published?.publishedAt}/>
    {!version&&(display==='published'||display==='accepted')&&<PortableInvoiceCreate key={quote.revision} source="quote" sourceId={quote.id}/>}
    {detail.versions.length>0&&<><h3>Published versions</h3>
      <ul>{detail.versions.map(item=><li key={item.version}>
        <a href={path({version:item.version,versionBefore})}>{quoteLabel({...quote,version:item.version})}</a> ·{' '}
        <time dateTime={item.publishedAt}><WorkspaceDate value={item.publishedAt}>{new Date(item.publishedAt).toLocaleString()}</WorkspaceDate></time>
      </li>)}</ul>
      {versionBefore&&<a href={path({version})}>Latest versions</a>}{' '}
      {detail.nextVersion&&<a href={path({version,versionBefore:detail.nextVersion})}>Older versions</a>}
    </>}
    <h3>Quote history</h3>
    <ol>{detail.signature&&(!before||quote.revision<before)&&<li>Signed electronically · {detail.signature.signedName} ·{' '}
      <time dateTime={detail.signature.signedAt}><WorkspaceDate value={detail.signature.signedAt}>{new Date(detail.signature.signedAt).toLocaleString()}</WorkspaceDate></time></li>}
    {history.map(item=><li key={item.revision}>
      {{create:'Created',save:'Saved',publish:'Published',recall:'Recalled',accept:'Offline acceptance recorded',decline:'Declined',void:'Voided'}[item.action]} · {item.actorName??'Workspace owner'} ·{' '}
      <time dateTime={item.at}><WorkspaceDate value={item.at}>{new Date(item.at).toLocaleString()}</WorkspaceDate></time>
    </li>)}</ol>
    {before&&<a href={path({version,versionBefore})}>Latest changes</a>}{' '}
    {detail.next&&<a href={path({version,versionBefore,before:detail.next})}>Older changes</a>}
    {disposition&&actions.includes(disposition)&&<QuoteAction action={disposition} quote={quote} busy={busy} canClone={false}
      onClose={()=>setDisposition(undefined)} onSubmit={recordDisposition}/>}
    {editing&&canEdit&&<QuoteEditor quote={quote} busy={busy} onClose={()=>setEditing(false)} onSave={save}/>}
  </section>;
}
