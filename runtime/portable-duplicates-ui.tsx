'use client';

import {useEffect,useState} from 'react';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import type {PortableDuplicatePage,PortableDuplicatePair} from '../lib/portable-duplicates';
import {portableDuplicatesLink} from '../lib/portable-duplicates';
import type {PortableRecycleScope} from './portable-contact-recycle-ui';
import {PortableRecordMerge} from './portable-record-merge-ui';
import './portable-contacts.css';
import './portable-duplicates.css';

type Kind='contacts'|'companies';
const standardLabels:Record<string,string>={name:'Name',email:'Email',phone:'Phone',title:'Job title',lifecycle:'Lifecycle stage',domain:'Domain',
  website:'Website',industry:'Industry',city:'City',primaryCompanyId:'Primary company'};
const detail=(record:PortableDuplicatePair['left'])=>[record.email,record.domain,record.phone,record.company,record.city].filter(Boolean).join(' · ');

// Review suggested duplicate pairs, merge one from its review, or dismiss it.
export function PortableDuplicates({kind,email,scope,customProperties}:{kind:Kind;email:string;scope?:PortableRecycleScope;customProperties:PortableCustomProperty[]}){
  const [status,setStatus]=useState<'suggested'|'dismissed'>('suggested');
  const [strength,setStrength]=useState<'all'|'strong'|'possible'>('all');
  const [query,setQuery]=useState('');
  const [cursor,setCursor]=useState<string|undefined>();
  const [page,setPage]=useState<PortableDuplicatePage>();
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [reviewing,setReviewing]=useState<string>();
  const [reload,setReload]=useState(0);
  const scopeQuery=scope?'?'+new URLSearchParams(scope):'';
  const labels=Object.fromEntries([
    ...Object.entries(standardLabels).map(([id,label])=>[id,{label}]),
    ['recordOwner',{label:kind==='contacts'?'Contact owner':'Company owner'}],
    ...customProperties.map(property=>['custom:'+property.id,{label:property.label}]),
  ]);

  useEffect(()=>{
    const controller=new AbortController();
    const params=new URLSearchParams({kind,status,strength,...(query?{query}:{}),...(cursor?{cursor}:{}),...(scope??{})});
    fetch('/api/duplicates?'+params,{signal:controller.signal}).then(async response=>{
      const result=await response.json() as PortableDuplicatePage&{error?:string};
      if(!response.ok){setError(result.error??'Could not load duplicates.');return;}
      setError('');setPage(result);
    }).catch(()=>{if(!controller.signal.aborted)setError('Could not load duplicates. Refresh and try again.');});
    return ()=>controller.abort();
  },[kind,status,strength,query,cursor,scope,reload]);

  async function change(pair:PortableDuplicatePair,action:'dismiss'|'restore'){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/duplicates'+scopeQuery,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action,kind,recordA:pair.left.id,recordB:pair.right.id})});
      const result=await response.json() as {error?:string};
      if(!response.ok){setError(result.error??'Could not update this pair.');return;}
      setMessage(action==='dismiss'?'Dismissed. Find it under Dismissed.':'Restored to suggestions.');
      setReload(value=>value+1);
    }catch{setError('Harbor could not confirm the change. Refresh to check.');}
    finally{setBusy(false);}
  }

  const plural=kind==='contacts'?'contacts':'companies';
  const listHref='/?'+new URLSearchParams({kind,...(scope?{workspaceId:scope.workspaceId}:{})});
  return <main className="portable-contacts portable-duplicates">
    <header>
      <span>⚓ Harbor</span><nav aria-label="CRM records"><a href={listHref}>Back to {plural}</a></nav>
      <span>{email} · <a href="/auth/sign-out">Sign out</a></span>
    </header>
    <section aria-labelledby="portable-duplicates-title">
      <h1 id="portable-duplicates-title">Manage duplicates</h1>
      <nav aria-label="Duplicate record type">
        {(['contacts','companies'] as const).map(choice=><a key={choice} href={portableDuplicatesLink(choice,scope?.workspaceId)}
          aria-current={choice===kind?'page':undefined}>{choice==='contacts'?'Contacts':'Companies'}</a>)}
      </nav>
      <form className="portable-duplicate-filters" role="search" onSubmit={event=>{event.preventDefault();setCursor(undefined);
        setQuery(String(new FormData(event.currentTarget).get('query')??''));}}>
        <label>Show <select value={status} onChange={event=>{setStatus(event.target.value as typeof status);setCursor(undefined);}}>
          <option value="suggested">Suggested</option><option value="dismissed">Dismissed</option></select></label>{' '}
        <label>Strength <select value={strength} onChange={event=>{setStrength(event.target.value as typeof strength);setCursor(undefined);}}>
          <option value="all">All</option><option value="strong">Strong matches</option><option value="possible">Possible matches</option></select></label>{' '}
        <label>Search <input name="query" defaultValue={query} maxLength={200}/></label> <button type="submit">Search</button>
      </form>
      {message&&<p role="status">{message}</p>}
      {error&&<p role="alert">{error}</p>}
      {!page?<p role="status">Checking {plural} for duplicates…</p>:<>
        <p>{page.total} {status==='suggested'?'suggested':'dismissed'} pair{page.total===1?'':'s'} from {page.recordsChecked} active {plural}.
          {page.limited?' The scan stopped at its limit; narrow the search to see the rest.':''}</p>
        <ol className="portable-duplicate-pairs">{page.pairs.map(pair=>{
          const key=pair.left.id+':'+pair.right.id;
          return <li key={key}>
            <p><strong>{pair.left.name}</strong>{detail(pair.left)&&' ('+detail(pair.left)+')'} and <strong>{pair.right.name}</strong>
              {detail(pair.right)&&' ('+detail(pair.right)+')'}</p>
            <p>{pair.score>=90?'Strong match':'Possible match'}: {pair.reasons.join('; ')}.</p>
            {reviewing===key?<PortableRecordMerge kind={kind} scope={scope} disabled={busy} onBusy={setBusy} labels={labels}
              records={[pair.left,pair.right].map(({id,name})=>({id,name}))}
              onDone={done=>{setReviewing(undefined);setMessage(done);setReload(value=>value+1);}}/>
            :<>{status==='suggested'&&<button type="button" disabled={busy} onClick={()=>{setMessage('');setReviewing(key);}}>Review merge</button>}{' '}
              <button type="button" disabled={busy} onClick={()=>void change(pair,status==='suggested'?'dismiss':'restore')}>
                {status==='suggested'?'Not duplicates':'Restore suggestion'}</button></>}
          </li>;
        })}</ol>
        {page.nextCursor&&<button type="button" onClick={()=>setCursor(page.nextCursor!)}>Next page</button>}
      </>}
    </section>
  </main>;
}
