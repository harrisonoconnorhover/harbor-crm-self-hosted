'use client';
import {validationSummary} from '@/lib/property-validation';
import {propertyTypeLabel} from '@/lib/property-text';
import {useEffect,useRef,useState} from 'react';
import type {Kind} from '@/lib/crm';
import type {Property} from '@/lib/workspace';
import type {DefinitionHistoryPage,DefinitionSnapshot} from '@/lib/property-definition-history';
import {Dialog} from './workspace-tools';
const labels:Record<keyof DefinitionSnapshot,string>={showRelativeTime:'Relative time display',linkText:'Default link text',allowCustomLinkText:'Allow custom link text',uniqueValues:'Unique values',validation:'Validation rules',archivedAt:'Status',label:'Name',description:'Description',type:'Type',options:'Options'};
const text=(v:unknown,key:keyof DefinitionSnapshot)=>key==='showRelativeTime'?(v?'Shown':'Hidden'):key==='allowCustomLinkText'?(v?'Allowed':'Not allowed'):key==='uniqueValues'?(v?'Required':'Not required'):key==='validation'?validationSummary(v as DefinitionSnapshot['validation'])||'None':key==='type'?propertyTypeLabel(String(v)):key==='archivedAt'?(v?'Archived '+new Date(String(v)).toLocaleString():'Active'):Array.isArray(v)?v.join('; ')||'None':String(v||'Empty');
export function PropertyDefinitionHistory({kind,property,onClose}:{kind:Kind;property:Property;onClose:()=>void}){
 const [page,setPage]=useState<DefinitionHistoryPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null),retry=useRef<number|undefined>(undefined);
 async function load(before?:number){request.current?.abort();const controller=new AbortController();request.current=controller;retry.current=before;setBusy(true);setError('');
  try{const query=new URLSearchParams({kind,...(property.standardField?{field:property.standardField}:{id:property.id})});if(before)query.set('before',String(before));const response=await fetch('/api/property-definition-history?'+query,{signal:controller.signal});const data=await response.json() as DefinitionHistoryPage&{error?:string};if(!response.ok)throw Error(data.error);setPage(data);}
  catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not load definition history.');}
  finally{if(!controller.signal.aborted)setBusy(false);}
 }
 useEffect(()=>{void load();return()=>request.current?.abort();},[]);
 return <Dialog title={`Definition history · ${page?.property.label||property.label}`} onClose={onClose} busy={false}><div className="tool-body">
  <p><strong>{kind} · {property.standardField||'custom:'+property.id}</strong></p>
  <p>{property.standardField?'Changes to this standard property’s dropdown options or date display setting.':'Changes to this custom property’s definition and archive status, plus its creation details.'} Record-value history is available separately. Group moves and colors are not included.</p>
  {page&&<p className="usage-fill">{property.standardField?'Built-in property. Only changes made after standard-settings history was introduced are recorded; earlier changes were not reconstructed.':page.created?`Created ${new Date(page.created.at).toLocaleString()} by ${page.created.by}.`:'Creation date and creator are unknown: this property predates definition-history tracking.'}</p>}
  {busy&&<p role="status">Loading definition history…</p>}
  {error&&<p role="alert" className="form-error">{error} <button className="text-button" disabled={busy} onClick={()=>load(retry.current)}>Retry</button></p>}
  {page&&!page.items.length&&<p>No recorded definition changes on this page. Earlier changes were not reconstructed.</p>}
  {page?.items.map(item=><article className="usage-item" key={item.id}><div className="usage-item-title"><h3>{item.action==='created'?'Property created':item.action==='archived'?'Property archived':item.action==='restored'?'Property restored':'Definition updated'} · revision {item.revision}</h3><small>{new Date(item.changedAt).toLocaleString()} · {item.changedBy}</small></div>
   <dl className="definition-changes">{(Object.keys(labels) as (keyof DefinitionSnapshot)[]).filter(key=>!item.before||JSON.stringify(item.before[key])!==JSON.stringify(item.after[key])).map(key=><div key={key}><dt>{labels[key]}</dt><dd>{item.before&&<><span className="muted">{text(item.before[key],key)}</span><span aria-label="changed to"> → </span></>}{text(item.after[key],key)}</dd></div>)}</dl>
  </article>)}
  <div className="tool-actions"><button className="secondary" onClick={onClose}>Back to properties</button><button className="secondary" disabled={busy} onClick={()=>load()}>Latest changes</button>{page?.next&&<button className="primary" disabled={busy} onClick={()=>load(page.next!)}>Older changes</button>}</div>
 </div></Dialog>;
}
