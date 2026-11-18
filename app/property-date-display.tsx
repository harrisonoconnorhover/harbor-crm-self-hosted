'use client';
import {useState} from 'react';
import type {Kind} from '@/lib/crm';
import type {Property} from '@/lib/workspace';
import type {FilterField} from '@/lib/filters';
import {Dialog} from './workspace-tools';
export function DateDisplayChoices({value,onChange}:{value:boolean;onChange:(value:boolean)=>void}){
 return <label className="form-field">Date display<select aria-label="Date display" value={value?'relative':'absolute'} onChange={e=>onChange(e.target.value==='relative')}><option value="absolute">Show date/time only</option><option value="relative">Show date/time with relative time</option></select><small className="form-intro">Adds “days ago” or “days from today” in record views. Date-only values keep their calendar day; timestamps use your device’s time zone. Saved values, forms, filters, reports and exports are unchanged.</small></label>;
}
export function StandardDateDisplayDialog({kind,field,properties,onSaved,onClose}:{kind:Kind;field:FilterField;properties:Property[];onSaved:()=>Promise<void>;onClose:()=>void}){
 const previous=properties.find(p=>p.kind===kind&&p.standardField===field.id);
 const [relative,setRelative]=useState(!!previous?.showRelativeTime),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <Dialog title={`Date display · ${field.label}`} busy={busy} onClose={onClose}><form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{
  const r=await fetch('/api/property-date-display',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,field:field.id,revision:previous?.revision||0,showRelativeTime:relative})}),body=await r.json() as {error?:string};if(!r.ok)throw Error(body.error||'Could not save display.');await onSaved();onClose();
 }catch(e){setError(e instanceof Error?e.message:'Could not save display.');}finally{setBusy(false)}}}><div className="tool-body"><DateDisplayChoices value={relative} onChange={setRelative}/>{error&&<p className="form-error" role="alert">{error}</p>}</div><footer className="preview-footer"><button className="primary" disabled={busy||relative===!!previous?.showRelativeTime}>Save display</button><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button></footer></form></Dialog>;
}
