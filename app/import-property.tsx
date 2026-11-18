'use client';
import {useState} from 'react';
import type {Kind} from '@/lib/crm';
import {propertyInput,propertyTypes,type Property} from '@/lib/workspace';
import type {ValidationRules} from '@/lib/property-validation';
import {PropertyValidationEditor} from './property-validation';
import {DateDisplayChoices} from './property-date-display';
import {Dialog} from './report-dialog';
import './import-property.css';

const typeLabels:Record<Property['type'],string>={text:'Single-line text',textarea:'Multi-line text',url:'URL',email:'Email',number:'Number',date:'Date',datetime:'Date and time',checkbox:'Yes / No',select:'Dropdown',multiselect:'Multiple checkboxes'};
export function ImportPropertyDialog({header,kinds,values,onCreated,onCatalog,onClose}:{
 header:string;kinds:Kind[];values:string[];onCreated:(property:Property)=>void;onCatalog:(properties:Property[])=>void;onClose:()=>void;
}){
 const [kind,setKind]=useState(kinds[0]),[label,setLabel]=useState(header.trim().slice(0,80)),[type,setType]=useState<Property['type']>('text');
 const [description,setDescription]=useState(''),[options,setOptions]=useState(''),[uniqueValues,setUniqueValues]=useState(false);
 const [validation,setValidation]=useState<ValidationRules|null>(null),[relative,setRelative]=useState(false),[linkText,setLinkText]=useState(''),[customLinkText,setCustomLinkText]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 function changeType(next:Property['type']){setType(next);setValidation(null);setUniqueValues(false);setRelative(false);setLinkText('');setCustomLinkText(false);setOptions('');setError('');}
 function useOptions(){
  const seen=new Set<string>(),choices:string[]=[];
  for(const value of values)for(const part of type==='multiselect'?value.split(';'):[value]){
   const option=part.trim();if(!option||seen.has(option.toLowerCase()))continue;
   if(option.length>80){setError('A column value is longer than 80 characters. Edit the options or choose a text property.');return;}
   seen.add(option.toLowerCase());choices.push(option);
   if(choices.length>50){setError('This column has more than 50 choices. Enter up to 50 options or choose a text property.');return;}
  }
  setOptions(choices.join('\n'));setError('');
 }
 async function create(){
  const parsed=propertyInput.safeParse({kind,label,description,type,validation,uniqueValues,
   ...(['date','datetime'].includes(type)?{showRelativeTime:relative}:{}),...(type==='url'?{linkText,allowCustomLinkText:customLinkText}:{}),
   options:['select','multiselect'].includes(type)?options.split('\n').map(s=>s.trim()).filter(Boolean):[]});
  if(!parsed.success){setError(parsed.error.issues[0]?.message||'Check the property settings.');return;}
  setBusy(true);setError('');
  try{
   const response=await fetch('/api/crm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'property',...parsed.data})});
   const result=await response.json().catch(()=>({})) as {property?:Property;error?:string};
   if(!response.ok||!result.property)throw Error(result.error||'Could not confirm the new property. Check existing properties before trying again.');
   onCreated(result.property);
  }catch(e){
   setError(e instanceof Error?e.message:'Could not confirm the new property.');
   // A lost response may still have saved the definition. Refresh only the
   // bounded catalog; the server's unique-name guard prevents a duplicate.
   try{const r=await fetch('/api/import-jobs?catalog=1');if(r.ok){const c=await r.json() as {properties:Property[]};onCatalog(c.properties);}}catch{}
  }finally{setBusy(false);}
 }
 return <Dialog title="Create property" className="import-property-dialog" returnFocus onClose={()=>{if(!busy)onClose();}}>
  <form className="import-property-form" onSubmit={e=>{e.preventDefault();if(!busy)void create();}}>
   <p>Create a property for <b>{header}</b>. It will be mapped to this column when saved. The property stays in your CRM even if you cancel the import.</p>
   {error&&<p className="form-error" role="alert">{error} You can cancel and choose an existing property from the mapping.</p>}
   <fieldset disabled={busy}>
    <label className="form-field">Object<select aria-label="New property object" value={kind} disabled={kinds.length===1} onChange={e=>setKind(e.target.value as Kind)}>{kinds.map(k=><option key={k} value={k}>{k[0].toUpperCase()+k.slice(1)}</option>)}</select></label>
    <label className="form-field">Property name<input autoFocus required maxLength={80} value={label} onChange={e=>setLabel(e.target.value)}/></label>
    <label className="form-field">Description<textarea maxLength={1000} rows={2} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <label className="form-field">Property type<select value={type} onChange={e=>changeType(e.target.value as Property['type'])}>{propertyTypes.map(t=><option key={t} value={t}>{typeLabels[t]}</option>)}</select></label>
    {['select','multiselect'].includes(type)&&<div><label className="form-field">Options (one per line)<textarea required rows={5} value={options} onChange={e=>setOptions(e.target.value)}/></label><button type="button" onClick={useOptions}>Use column values as options</button><p>Up to 50 options. {type==='multiselect'?'Semicolons separate multiple choices in CSV cells.':'Each CSV cell must match one option.'} Review the choices before saving.</p></div>}
    {['text','textarea','number'].includes(type)&&<label className="import-property-check"><input type="checkbox" checked={uniqueValues} onChange={e=>setUniqueValues(e.target.checked)}/>Require unique values</label>}
    {uniqueValues&&<p>Set at creation only, up to ten per object. Text matches exactly; numbers compare numerically. Empty values are allowed. You can select this field as the import’s matching property.</p>}
    <details><summary>Validation rules (optional)</summary><PropertyValidationEditor key={type} type={type} value={validation} onChange={setValidation}/></details>
    {['date','datetime'].includes(type)&&<DateDisplayChoices value={relative} onChange={setRelative}/>}
    {type==='datetime'&&<p>CSV dates and times must include a time zone, for example 2026-11-06T14:30:00-05:00.</p>}
    {type==='url'&&<><label className="form-field">Default link text<input maxLength={200} value={linkText} onChange={e=>setLinkText(e.target.value)}/></label><label className="import-property-check"><input type="checkbox" checked={customLinkText} onChange={e=>setCustomLinkText(e.target.checked)}/>Allow custom link text on individual records</label></>}
   </fieldset>
   <div className="import-property-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!label.trim()}>{busy?'Creating…':'Create and map property'}</button></div>
  </form>
 </Dialog>;
}
