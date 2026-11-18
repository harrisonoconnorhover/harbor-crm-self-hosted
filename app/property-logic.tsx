"use client";
import {useState} from 'react';
import {propertyLogicFields,objectLogic,propertyLogicInput,type PropertyLogicKind,type PropertyLogicRules} from '@/lib/property-logic';
import type {Property} from '@/lib/workspace';
import {usePipelineCatalog} from './pipeline-context';
import {Dialog} from './workspace-tools';
import {StageRuleConditions} from './stage-rule-conditions';
import {StagePropertySettings} from './stage-property-settings';
export function PropertyLogicDialog({kind,properties,onClose,onSaved}:{kind:PropertyLogicKind;properties:Property[];onClose:()=>void;onSaved:()=>Promise<void>}){
 const catalog=usePipelineCatalog(),[snapshot]=useState(()=>objectLogic(catalog,kind)),[rules,setRules]=useState<PropertyLogicRules>(()=>structuredClone(snapshot.rules)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const fields=propertyLogicFields(properties,kind),noun=kind==='contacts'?'contact':'company';
 const change=(index:number,patch:Partial<PropertyLogicRules[number]>)=>setRules(rules.map((r,i)=>i===index?{...r,...patch}:r));
 function move(i:number,n:number){const next=[...rules];[next[i],next[i+n]]=[next[i+n],next[i]];setRules(next)}
 async function save(){const parsed=propertyLogicInput.safeParse({kind,revision:snapshot.revision,rules});if(!parsed.success){setError(parsed.error.issues[0]?.message||'Check the rules.');return}setBusy(true);setError('');try{const r=await fetch('/api/property-logic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(parsed.data)});const body=await r.json().catch(()=>({})) as {error?:string};if(!r.ok)throw Error(body.error||'Could not save conditional logic.');await onSaved();onClose();}catch(e){setError(e instanceof Error?e.message:'Could not save conditional logic.')}finally{setBusy(false)}}
 return <Dialog title={`Conditional logic · ${kind}`} busy={busy} onClose={onClose}><div className="tool-body">
  <p>Show and require properties based on other values when manually creating or editing a {noun}. All conditions in each rule must match. Imports, APIs and workflows retain their existing validation.</p>
  {rules.map((rule,i)=><section className="stage-logic-rule" key={rule.id} aria-label={`Property logic rule ${i+1}`}><header><h3>Rule {i+1}</h3><div>
   <button type="button" disabled={busy||i===0} aria-label={`Move rule ${i+1} up`} onClick={()=>move(i,-1)}>↑</button><button type="button" disabled={busy||i===rules.length-1} aria-label={`Move rule ${i+1} down`} onClick={()=>move(i,1)}>↓</button>
   <button type="button" disabled={busy} onClick={()=>setRules(rules.filter((_,j)=>j!==i))}>Delete rule {i+1}</button></div></header>
   <StageRuleConditions conditions={rule.conditions} properties={properties} kind="deals" availableFields={fields} disabled={busy} onChange={conditions=>change(i,{conditions})}/>
   <StagePropertySettings items={rule.properties} properties={properties} availableFields={fields} objectLabel={noun} disabled={busy} title={`Dependent properties for rule ${i+1}`} onChange={properties=>change(i,{properties})}/>
  </section>)}
  {!rules.length&&<p>No conditional logic yet.</p>}
  <button className="secondary" disabled={busy||rules.length>=20} onClick={()=>setRules([...rules,{id:crypto.randomUUID(),conditions:[{field:'lifecycle',operator:'known',values:[]}],properties:[]}])}>Create logic</button>
  <p className="muted">Up to 20 rules, five conditions per rule and 20 different controlling/dependent fields per object. Required wins when rules overlap. Existing values are kept when fields hide.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
 </div><footer className="preview-footer"><button className="primary" disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save logic'}</button><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button></footer></Dialog>;
}
