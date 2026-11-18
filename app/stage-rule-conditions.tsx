"use client";
import type {StageRuleCondition} from "@/lib/stage-property-rules";
import type {Property} from "@/lib/workspace";
import {stageConditionFields} from "@/lib/stage-properties";
import {DateTimeInput} from './property-datetime';

export function StageRuleConditions({conditions,properties,kind,disabled,onChange,availableFields}:{
  availableFields?:Property[]; conditions:StageRuleCondition[];properties:Property[];kind:"deals"|"tickets";disabled:boolean;onChange:(value:StageRuleCondition[])=>void;
}) {
  const fields=(availableFields??stageConditionFields(properties,kind)).filter(p=>["select","multiselect","checkbox","date","datetime"].includes(p.type));
  const change=(index:number,patch:Partial<StageRuleCondition>)=>onChange(conditions.map((c,i)=>i===index?{...c,...patch}:c));
  return <section className="stage-secondary-conditions" aria-label="Additional conditions">
    <h4>Additional conditions</h4><p>All conditions must match (AND). Changing a controlling property updates which dependent fields are shown and required.</p>
    {conditions.map((condition,index)=>{
      const field=fields.find(f=>f.id===condition.field),known=['known','unknown'].includes(condition.operator);
      const temporal=field?.type==='date'||field?.type==='datetime',datetime=field?.type==='datetime';
      const choices:(string|boolean)[]=field?.type==='checkbox'?[true,false]:field?.options ?? [];
      return <fieldset key={index} className="stage-secondary-condition" disabled={disabled}><legend>Condition {index+1}</legend>
        <label className="form-field">Property<select aria-label={`Property for condition ${index+1}`} value={condition.field} onChange={e=>change(index,{field:e.target.value,operator:'known',values:[],valueType:fields.find(f=>f.id===e.target.value)?.type==='datetime'?'datetime':undefined})}>
          {!field&&<option value={condition.field}>Unavailable property</option>}{fields.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}
        </select></label>
        <label className="form-field">Operator<select aria-label={`Operator for condition ${index+1}`} value={condition.operator} onChange={e=>change(index,{operator:e.target.value as StageRuleCondition['operator'],values:['known','unknown'].includes(e.target.value)?[]:temporal?[]:choices.length?[choices[0]]:[]})}>
          <option value="anyOf">{datetime?'is exactly':temporal?'is on':'is any of'}</option><option value="noneOf">{datetime?'is not exactly':temporal?'is not on':'is none of'}</option>
          <option value="known">is known</option><option value="unknown">is unknown</option>
          {temporal&&<><option value="before">is before</option><option value="after">is after</option></>}
        </select></label>
        {!known&&(datetime?<label className="form-field">Date and time<DateTimeInput label={`Date and time for condition ${index+1}`} value={condition.values[0] ?? ''} required disabled={disabled} onChange={value=>change(index,{valueType:'datetime',values:value?[value]:[]})}/><small>Compares the exact instant, including seconds. The saved cutoff stays fixed if your time zone changes.</small></label>:field?.type==='date'?<label className="form-field">Date<input type="date" required aria-label={`Date for condition ${index+1}`} value={String(condition.values[0] ?? '')} onChange={e=>change(index,{values:e.target.value?[e.target.value]:[]})}/></label>:<div className="stage-logic-selection" role="group" aria-label={`Values for condition ${index+1}`}>
          {choices.map(value=><label key={String(value)}><input type="checkbox" checked={condition.values.includes(value)} onChange={e=>change(index,{values:e.target.checked?[...condition.values,value]:condition.values.filter(v=>v!==value)})}/>{typeof value==='boolean'?(value?'Yes':'No'):value}</label>)}
          {condition.values.filter(v=>!choices.includes(v)).map(v=><label key={String(v)}><input type="checkbox" checked onChange={()=>change(index,{values:condition.values.filter(x=>x!==v)})}/>{String(v)} (unavailable — uncheck)</label>)}
        </div>)}
        {!known&&!condition.values.length&&<p className="form-error" role="alert">Choose a condition value.</p>}
        <button type="button" className="secondary" onClick={()=>onChange(conditions.filter((_,i)=>i!==index))}>Remove condition {index+1}</button>
      </fieldset>;
    })}
    <button type="button" className="secondary" disabled={disabled||conditions.length>=5||!fields.length} onClick={()=>onChange([...conditions,{field:fields[0].id,operator:'known',values:[]}])}>Add condition</button>
  </section>;
}
