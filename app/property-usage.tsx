'use client';
import { useEffect, useRef, useState } from 'react';
import type { Kind } from '@/lib/crm';
import type { FilterField } from '@/lib/filters';
import { usageSourceLabels, type UsagePage } from '@/lib/property-usage';
import type { PropertyFill } from '@/lib/property-definition-export';
import { Dialog } from './workspace-tools';

export function PropertyUsageDialog({kind,field,onClose,onNavigate}:{kind:Kind;field:FilterField;onClose:()=>void;onNavigate:()=>void}){
 const [page,setPage]=useState<UsagePage|null>(null),[fill,setFill]=useState<PropertyFill>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [totals,setTotals]=useState({scanned:0,matches:0,pages:0});
 const controller=useRef<AbortController|null>(null),retryCursor=useRef<string|undefined>(undefined);
 async function load(cursor?:string){
  controller.current?.abort();const request=new AbortController();controller.current=request;retryCursor.current=cursor;setBusy(true);setError('');
  try{const params=new URLSearchParams({kind,field:field.id});if(cursor)params.set('cursor',cursor);
   const r=await fetch('/api/property-usage?'+params,{signal:request.signal}),data=await r.json();if(!r.ok)throw Error((data as {error?:string}).error||'Could not inspect usage.');
   const result=data as UsagePage;setPage(result);if(!cursor)setFill(result.fill);
   setTotals(t=>({scanned:(cursor?t.scanned:0)+result.scanned,matches:(cursor?t.matches:0)+result.items.length,pages:(cursor?t.pages:0)+1}));
  }catch(e){if(!request.signal.aborted)setError(e instanceof Error?e.message:'Could not inspect usage.');}
  finally{if(!request.signal.aborted)setBusy(false);}
 }
 useEffect(()=>{void load();return()=>controller.current?.abort();},[]);
 return <Dialog title={`Property usage · ${field.label}`} onClose={onClose} busy={false}><div className="tool-body property-usage">
  <p><strong>{kind} · {field.id}</strong></p>
  {fill&&<p className="usage-fill">{fill.total===0?'No current records.':fill.filled===null?`${fill.total.toLocaleString()} current records. Fill rate is not measured for this calculated property.`:`${fill.filled.toLocaleString()} of ${fill.total.toLocaleString()} current records have a value (${(100*fill.filled/fill.total).toFixed(1)}%).`} Counts cover your whole object, including off-page records.</p>}
  <p>Inspect saved views, reports, workflows, active segments, pipeline requirements and property settings. Active runs and pending enrollment versions are included. Disabled workflows are included because they can be enabled later.</p>
  <details><summary>Scope and limitations</summary><p>These are structured references in saved configuration, including saved defaults. Implicit default record layouts, view columns, quick filters and board card fields are not enumerated; explicit selections and saved sort/group/metric defaults are checked. Unsaved screens are not listed. Group assignments and colors are informational uses. Board settings can be saved even when a view currently shows a table.</p><p>Custom code and indirect segment/tag dependencies are marked for manual review; a notice does not confirm this particular field is used. External API clients, completed workflow history, past imports and derived-field dependencies are not exhaustively inspected. This is not a deletion safety check.</p><p>Each page reads current configuration. Changes during the scan can affect results; restart before making decisions. Only 25 summaries are shown per page.</p></details>
  {page&&<p role="status">{page.complete?'Scan finished within the scope above.':'Scan in progress — more configuration remains.'} {totals.scanned} configurations inspected; {totals.matches} with references or review notices. Page {totals.pages}.</p>}
  {busy&&<p role="status">Checking configuration…</p>}
  {error&&<p className="form-error" role="alert">{error} <button className="text-button" disabled={busy} onClick={()=>load(retryCursor.current)}>Retry page</button></p>}
  {page&&!page.items.length&&<p>{page.complete?'No references or review notices on this page.':'No matches on this page. Continue scanning to check the remaining configuration.'}</p>}
  {page?.items.map(item=><article className="usage-item" key={item.source+':'+item.id}>
   <div className="usage-item-title"><div><small>{usageSourceLabels[item.source]}{item.kind?' · '+item.kind:''}</small><h3>{item.name}</h3></div>{item.href&&<a className="text-button" href={item.href} onClick={onNavigate}>{item.linkLabel}</a>}</div>
   {!!item.references.length&&<ul aria-label="Structured references">{item.references.map(reason=><li key={reason}>{reason}</li>)}</ul>}
   {!!item.review.length&&<div className="usage-review"><strong>Manual review</strong><ul>{item.review.map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
  </article>)}
  <div className="tool-actions"><button className="secondary" onClick={onClose}>Back to properties</button><button className="secondary" disabled={busy} onClick={()=>load()}>Restart scan</button>{page?.next&&<button className="primary" disabled={busy} onClick={()=>load(page.next!)}>Continue scan</button>}</div>
 </div></Dialog>;
}
