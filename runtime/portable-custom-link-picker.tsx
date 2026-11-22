'use client';

import {useState} from 'react';
import type {PortableSearchCursor,PortableSearchPage} from '../lib/crm-search';

type Props={
  objectId:string;recordId:string;workspaceId?:string;busy:boolean;
  onLink:(objectId:string,recordId:string)=>void;
};

export function CustomLinkPicker({objectId,recordId,workspaceId,busy,onLink}:Props){
  return <details><summary>Link a custom record</summary>
    <CustomRecordPicker exclude={{objectId,recordId}} workspaceId={workspaceId} busy={busy} action="Link" onPick={onLink}/>
  </details>;
}

export function CustomRecordPicker({exclude,workspaceId,busy,action,onPick}:{
  exclude?:{objectId:string;recordId:string};workspaceId?:string;busy?:boolean;action:'Link'|'Check access';
  onPick:(objectId:string,recordId:string,name:string)=>void;
}){
  const [query,setQuery]=useState('');
  const [page,setPage]=useState<PortableSearchPage|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  async function search(cursor?:PortableSearchCursor|null){
    if(loading||!query.trim())return;
    setLoading(true);setError('');
    try{
      const url='/api/crm/search'+(workspaceId?'?'+new URLSearchParams({workspaceId}):'');
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({query:query.trim(),kind:'custom-objects',cursor:cursor??undefined})});
      if(!response.ok)throw Error();
      setPage(await response.json() as PortableSearchPage);
    }catch{setPage(null);setError('Could not search custom records. Try again.');}
    finally{setLoading(false);}
  }
  const matches=page?.results.filter(row=>row.kind==='custom-objects'&&(!exclude||row.objectId!==exclude.objectId||row.id!==exclude.recordId));
  return <>
    <form onSubmit={event=>{event.preventDefault();void search();}}><fieldset disabled={busy||loading}>
      <label>Find a custom record<input type="search" required maxLength={120} value={query}
        onChange={event=>{setQuery(event.target.value);setPage(null);setError('');}}/></label>
      <button disabled={!query.trim()}>Search records</button>
    </fieldset></form>
    {loading&&<p role="status">Searching…</p>}{error&&<p role="alert">{error}</p>}
    {page&&<><ul>{matches?.map(row=>row.kind==='custom-objects'&&<li key={row.objectId+row.id}>
      {row.name} · {row.detail}{' '}<button type="button" disabled={busy||loading} aria-label={action+' '+row.name+' · '+row.detail}
        onClick={()=>onPick(row.objectId,row.id,row.name+' · '+row.detail)}>{action}</button>
    </li>)}</ul>{!matches?.length&&<p>No matching records on this page.</p>}
    {page.previous&&<button type="button" disabled={busy||loading} onClick={()=>void search(page.previous)}>Previous matches</button>}
    {page.next&&<button type="button" disabled={busy||loading} onClick={()=>void search(page.next)}>More matches</button>}</>}
  </>;
}
