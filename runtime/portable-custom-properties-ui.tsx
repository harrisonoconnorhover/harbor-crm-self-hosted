'use client';

import {useId,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {MultipleChoice} from '../app/multiple-choice';
import {DateTimeInput} from '../app/property-datetime';
import {PropertyOrganization} from '../app/property-groups';
import {customPropertyTypeLabels,portableCustomPropertyTypes,portableCustomTextLimit,portablePropertyGroupFields,
  type PortableCustomPatch,type PortableCustomProperty,type PortableCustomPropertyKind,type PortableCustomPropertyType,
  type PortableCustomValues} from '../lib/portable-custom-properties';
import {propertyLinkHref} from '../lib/property-links';
import {customTextLimit} from '../lib/property-text';
import {samePropertyValue} from '../lib/property-values';

const fieldName=(id:string)=>'custom:'+id;
const normalizeLineBreaks=(value:string)=>value.replace(/\r\n?/g,'\n');
const inputMaxLength:Partial<Record<PortableCustomPropertyType,number>>={text:portableCustomTextLimit,url:2048,email:254};

export function readCustomPropertyEdits(data:Record<string,FormDataEntryValue>,properties:PortableCustomProperty[],values:PortableCustomValues={}){
  const patch:PortableCustomPatch={};
  for(const property of properties){
    const name=fieldName(property.id);
    const value=data[name];
    delete data[name];
    if(typeof value!=='string')continue;
    if(property.type==='multiselect'){
      const selected=JSON.parse(value) as string[];
      if(!samePropertyValue(selected,values[property.id]))patch[property.id]=selected;
      continue;
    }
    const previous=String(values[property.id]??'');
    if(property.type==='textarea'?normalizeLineBreaks(value)===normalizeLineBreaks(previous):value===previous)continue;
    patch[property.id]=value===''?null:property.type==='number'?Number(value):property.type==='checkbox'?value==='true':value;
  }
  return Object.keys(patch).length?patch:undefined;
}

function StageFieldHint({id}:{id?:string}){
  return id?<small id={id} className="portable-stage-field-hint">Required for this stage</small>:null;
}

function PortableCustomDateTime({name,label,value,hintId}:{name:string;label:string;value:string;hintId?:string}){
  const [input,setInput]=useState(value);
  return <div>
    <span>{label}</span>
    <DateTimeInput label={label} value={input} onChange={setInput} invalid={!!hintId} describedBy={hintId}/>
    <input type="hidden" name={name} value={input}/>
    <StageFieldHint id={hintId}/>
  </div>;
}

function PortableCustomMultiSelect({name,property,value,hintId}:{name:string;property:PortableCustomProperty;value?:PortableCustomValues[string];hintId?:string}){
  const [selected,setSelected]=useState<string[]>(Array.isArray(value)?value:[]);
  return <>
    <MultipleChoice label={property.label} options={property.options} value={selected} onChange={setSelected}
      invalid={hintId?true:undefined} describedBy={hintId}/>
    <input type="hidden" name={name} value={JSON.stringify(selected)}/>
    <StageFieldHint id={hintId}/>
  </>;
}

export function PortableCustomFields({properties,values={},missingFields}:{
  properties:PortableCustomProperty[];values?:PortableCustomValues;missingFields:readonly string[];
}){
  const idPrefix=useId();
  if(!properties.length)return null;
  const reveal=properties.some(property=>missingFields.includes(fieldName(property.id)));
  return <details open={reveal||undefined}><summary>Custom properties</summary>
    {properties.map(property=>{
      const name=fieldName(property.id),value=String(values[property.id]??'');
      const hintId=missingFields.includes(name)?idPrefix+'-'+property.id:undefined;
      const validity={'aria-invalid':hintId?true:undefined,'aria-describedby':hintId,'aria-label':hintId?property.label:undefined};
      if(property.type==='datetime')return <PortableCustomDateTime key={property.id} name={name} label={property.label} value={value} hintId={hintId}/>;
      if(property.type==='multiselect')return <PortableCustomMultiSelect key={property.id} name={name} property={property} value={values[property.id]} hintId={hintId}/>;
      return <label key={property.id}>{property.label}
        {property.type==='checkbox'?<select name={name} defaultValue={value} {...validity}>
          <option value="">Not set</option><option value="true">Yes</option><option value="false">No</option>
        </select>:property.type==='select'?<select name={name} defaultValue={value} {...validity}>
          <option value="">Not set</option>{property.options.map(option=><option key={option}>{option}</option>)}
        </select>:property.type==='textarea'?<textarea name={name} rows={5} defaultValue={value} maxLength={customTextLimit} {...validity}/>:
          <input name={name} type={property.type==='url'?'text':property.type} defaultValue={value} {...validity}
          inputMode={property.type==='url'?'url':undefined}
          maxLength={inputMaxLength[property.type]}
          step={property.type==='number'?'any':undefined}/>}
        <StageFieldHint id={hintId}/>
      </label>;
    })}
  </details>;
}

export function PortableCustomValuesList({properties,values={}}:{properties:PortableCustomProperty[];values?:PortableCustomValues}){
  const populated=properties.filter(property=>values[property.id]!==undefined);
  return populated.length>0&&<details><summary>Custom properties</summary><dl>
    {populated.map(property=>{
      const value=values[property.id];
      const href=propertyLinkHref(property.type,value);
      return <div key={property.id}><dt>{property.label}</dt>
        <dd style={property.type==='textarea'?{whiteSpace:'pre-wrap'}:undefined}>{href?
          <a href={href} target={property.type==='url'?'_blank':undefined} rel={property.type==='url'?'noreferrer':undefined}>{String(value)}</a>:
          property.type==='datetime'?<time dateTime={String(value)}>{String(value)}</time>:
          Array.isArray(value)?value.join('; '):
          typeof value==='boolean'?(value?'Yes':'No'):String(value)}</dd></div>;
    })}
  </dl></details>;
}

export function PortableCustomPropertySettings({kind,properties}:{kind:PortableCustomPropertyKind;properties:PortableCustomProperty[]}){
  const router=useRouter();
  const [type,setType]=useState<PortableCustomPropertyType>('text');
  const [opened,setOpened]=useState(false);
  const [rename,setRename]=useState<PortableCustomProperty|null>(null);
  const [saving,setSaving]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const fields=portablePropertyGroupFields(kind,properties);

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form),label=data.get('label');
    const options=String(data.get('options')??'').split('\n').map(option=>option.trim()).filter(Boolean);
    setSaving(true);
    setNotice('');
    setError('');
    try{
      const response=await fetch('/api/custom-properties',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(rename?{action:'rename',kind,id:rename.id,expectedRevision:rename.revision,label}:
          {action:'create',kind,label,type,options})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw Error(result.error??'Could not save this custom property.');
      form.reset();
      setRename(null);
      setType('text');
      setNotice(rename?'Property renamed.':'Property added.');
      router.refresh();
    }catch(error){setError(error instanceof Error?error.message:'Could not save this custom property.');}
    finally{setSaving(false);}
  }

  return <details onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}>
    <summary>Manage properties</summary>
    {opened&&<PropertyOrganization key={kind} kind={kind} fields={fields} editableIds={fields.map(field=>field.id)} disabled={saving}
      actions={field=>{
        const property=properties.find(property=>fieldName(property.id)===field.id);
        return property&&<button type="button" disabled={saving} aria-label={'Rename '+property.label}
          onClick={()=>{setRename(property);setNotice('');setError('');}}>Rename</button>;
      }}/>}
    <form key={rename?.id??'create'} onSubmit={submit}>
      <fieldset disabled={saving}>
        <label>Property name<input name="label" required maxLength={80} defaultValue={rename?.label}/></label>
        {!rename&&<>
          <label>Field type<select value={type} onChange={event=>setType(event.target.value as PortableCustomPropertyType)}>
            {portableCustomPropertyTypes.map(option=><option key={option} value={option}>{customPropertyTypeLabels[option]}</option>)}
          </select></label>
          {(type==='select'||type==='multiselect')&&<label>Options, one per line<textarea name="options" required maxLength={4050}/></label>}
        </>}
      </fieldset>
      <button type="submit" disabled={saving}>{rename?'Save name':'Add property'}</button>{' '}
      {rename&&<button type="button" disabled={saving} onClick={()=>{setRename(null);setError('');}}>Cancel</button>}
    </form>
    {error&&<p role="alert">{error}</p>}
    <p role="status">{notice}</p>
  </details>;
}
