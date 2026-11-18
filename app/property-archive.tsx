'use client';
import {useEffect,useRef,useState} from 'react';
import type {Kind} from '@/lib/crm';
import type {Property} from '@/lib/workspace';
import {Dialog} from './workspace-tools';
import {PropertyDefinitionHistory} from './property-definition-history';
type Page={items:Property[];next:string|null};
export function PropertyArchiveDialog({kind,property,onClose,onSaved,onUsage}:{kind:Kind;property?:Property;onClose:()=>void;onSaved:()=>Promise<void>;onUsage?:(p:Property)=>void}){
 const [page,setPage]=useState<Page>({items:[],next:null}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[history,setHistory]=useState<Property|null>(null);
 const current=useRef<string|undefined>(undefined),request=useRef<AbortController|null>(null);
 async function load(after?:string){request.current?.abort();const controller=new AbortController();request.current=controller;current.current=after;setBusy(true);setError('');
  try{const q=new URLSearchParams({kind});if(after)q.set('after',after);const r=await fetch('/api/property-archive?'+q,{signal:controller.signal}),data=await r.json() as Page&{error?:string};if(!r.ok)throw Error(data.error);setPage(data);}
  catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not load archived properties.');}finally{if(!controller.signal.aborted)setBusy(false);}
 }
 useEffect(()=>{if(!property)void load();return()=>request.current?.abort();},[]);
 async function save(p:Property,action:'archive'|'restore'){setBusy(true);setError('');setMessage('');
  try{const r=await fetch('/api/property-archive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,id:p.id,revision:p.revision||0,action})}),data=await r.json() as {error?:string};if(!r.ok)throw Error(data.error);
   await onSaved();if(action==='archive'){onClose();return;}setMessage(`${p.label} restored with its saved record values.`);await load();
  }catch(e){setError(e instanceof Error?e.message:'Could not update this property.');}finally{setBusy(false);}
 }
 if(history)return <PropertyDefinitionHistory kind={kind} property={history} onClose={()=>setHistory(null)}/>;
 return <Dialog title={property?`Archive ${property.label}?`:`Archived properties · ${kind}`} busy={busy} onClose={onClose}><div className="tool-body">
  <p>{property?'This field will disappear from active records, filters, imports and API property lists. Its existing values stay stored and return when you restore it.':'Restore an archived custom property to show it and its saved values again. Archived properties are retained until you restore them; there is no automatic purge.'}</p>
  {property&&<p>Remove references from saved views, reports, workflows, segments, pipeline stages first. Pending workflow versions and custom code may also block archiving. Display columns, layouts, groups, colors and record-value history are retained. Code that calculates property IDs and external integrations cannot be checked automatically; review them before archiving.</p>}
  {error&&<p role="alert" className="form-error">{error}{!property&&<button className="text-button" disabled={busy} onClick={()=>load(current.current)}>Retry</button>}</p>}
  {message&&<p role="status">{message}</p>}
  {busy&&<p role="status">{property?'Checking and archiving…':'Loading or restoring properties…'}</p>}
  {!property&&!busy&&!error&&!page.items.length&&<p>No archived properties for this object.</p>}
  {!property&&page.items.map(p=><article className="usage-item" key={p.id}><div className="usage-item-title"><h3>{p.label}</h3><small>{p.type} · Archived {new Date(p.archivedAt!).toLocaleString()}</small></div>{p.description&&<p>{p.description}</p>}<button className="secondary" disabled={busy} onClick={()=>save(p,'restore')} aria-label={`Restore ${p.label}`}>Restore</button> <button className="text-button" disabled={busy} onClick={()=>setHistory(p)}>Definition history</button></article>)}
  <div className="tool-actions"><button className="secondary" disabled={busy} onClick={onClose}>Back to properties</button>{property?<><button className="secondary" disabled={busy} onClick={()=>onUsage?.(property)}>View usage</button><button className="primary" disabled={busy} onClick={()=>save(property,'archive')}>Archive property</button></>:<><button className="secondary" disabled={busy} onClick={()=>load()}>First page</button>{page.next&&<button className="primary" disabled={busy} onClick={()=>load(page.next!)}>Next page</button>}</>}</div>
 </div></Dialog>;
}
