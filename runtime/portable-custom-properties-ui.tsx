'use client';

import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {teamOptions} from './portable-workspace-teams-ui';
import type {DirectoryTeam} from '../lib/portable-workspace-teams';
import {MultipleChoice} from '../app/multiple-choice';
import {DateTimeInput} from '../app/property-datetime';
import {PropertyOrganization} from '../app/property-groups';
import {customPropertyTypeLabels,portableCustomPropertyTypes,portableCustomTextLimit,portablePropertyGroupFields,
  type PortableCustomPatch,type PortableCustomProperty,type PortableCustomPropertyKind,type PortableCustomPropertyType,
  type PortableCustomValues} from '../lib/portable-custom-properties';
import type {PortableStandardAccess} from '../lib/portable-standard-property-access';
import {customTextLimit} from '../lib/property-text';
import {samePropertyValue} from '../lib/property-values';

type EditableField=Pick<PortableCustomProperty,'id'|'label'|'type'|'options'>;
const fieldName=(id:string)=>'custom:'+id;
const normalizeLineBreaks=(value:string)=>value.replace(/\r\n?/g,'\n');
const inputMaxLength:Partial<Record<PortableCustomPropertyType,number>>={text:portableCustomTextLimit,url:2048,email:254};

export function readCustomPropertyEdits(data:Record<string,FormDataEntryValue>,properties:EditableField[],values:PortableCustomValues={}){
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

function PortableCustomMultiSelect({name,property,value,hintId}:{name:string;property:EditableField;value?:PortableCustomValues[string];hintId?:string}){
  const [selected,setSelected]=useState<string[]>(Array.isArray(value)?value:[]);
  return <>
    <MultipleChoice label={property.label} options={property.options} value={selected} onChange={setSelected}
      invalid={hintId?true:undefined} describedBy={hintId}/>
    <input type="hidden" name={name} value={JSON.stringify(selected)}/>
    <StageFieldHint id={hintId}/>
  </>;
}

export function PortableCustomFields({properties,values={},missingFields,expanded=false}:{
  properties:EditableField[];values?:PortableCustomValues;missingFields:readonly string[];expanded?:boolean;
}){
  const idPrefix=useId();
  if(!properties.length)return null;
  const reveal=properties.some(property=>missingFields.includes(fieldName(property.id)));
  return <details open={expanded||reveal||undefined}><summary>Custom properties</summary>
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

type VisibilityTarget={action:'access'|'standardAccess';id:string;label:string;audience?:string;revision:number};

export function PortableCustomPropertySettings({kind,properties,standardAccess,initiallyOpen=false}:{
  kind:PortableCustomPropertyKind;properties:PortableCustomProperty[];standardAccess:PortableStandardAccess[];initiallyOpen?:boolean;
}){
  const router=useRouter();
  const [type,setType]=useState<PortableCustomPropertyType>('text');
  const [opened,setOpened]=useState(initiallyOpen);
  const [rename,setRename]=useState<PortableCustomProperty|null>(null);
  const [access,setAccess]=useState<VisibilityTarget|null>(null);
  const stageAccess=kind==='deals'&&access?.id==='stage';
  const propertyName=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(rename)propertyName.current?.focus();},[rename]);
  const audienceSelect=useRef<HTMLSelectElement>(null);
  useEffect(()=>{if(access)audienceSelect.current?.focus();},[access]);
  const [audience,setAudience]=useState('workspace');
  const [teams,setTeams]=useState<DirectoryTeam[]>([]);
  const teamChoices=teamOptions(teams);
  const [teamError,setTeamError]=useState(false);
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    fetch('/api/workspaces',{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as {teams:DirectoryTeam[]};
      setTeams(result.teams);
    }).catch(()=>{if(!controller.signal.aborted)setTeamError(true);});
    return ()=>controller.abort();
  },[opened,kind]);
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
        body:JSON.stringify(access?{action:access.action,kind,id:access.id,expectedRevision:access.revision,audience:data.get('audience')}:rename?{action:'rename',kind,id:rename.id,expectedRevision:rename.revision,label}:
          {action:'create',kind,label,type,options,audience:data.get('audience')})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw Error(result.error??'Could not save this property.');
      form.reset();
      setAudience('workspace');
      setAccess(null);
      setRename(null);
      setType('text');
      setNotice(access?(stageAccess?'Stage permissions saved.':'Visibility saved.'):rename?'Property renamed.':'Property added.');
      router.refresh();
    }catch(error){setError(error instanceof Error?error.message:'Could not save this property.');}
    finally{setSaving(false);}
  }

  return <details open={initiallyOpen||undefined} onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}>
    <summary>Manage properties</summary>
    {opened&&<PropertyOrganization key={kind} kind={kind} fields={fields} editableIds={fields.map(field=>field.id)} disabled={saving}
      actions={field=>{
        const property=properties.find(property=>fieldName(property.id)===field.id);
        const rule=property??standardAccess.find(rule=>rule.id===field.id);
        if(!rule)return null;
        const stageRule=kind==='deals'&&rule.id==='stage';
        const selectedAudience=rule.audience??'workspace';
        return <>{property&&<button id={'property-'+property.id} type="button" disabled={saving} aria-label={'Rename '+property.label}
          onClick={()=>{setAccess(null);setRename(property);setNotice('');setError('');}}>Rename</button>}
          {selectedAudience!=='workspace'&&<small>{stageRule&&'Stage changes · '}{selectedAudience==='owner'?'Owner only':'Owner and '+(teamChoices.find(team=>team.id===selectedAudience)?.label??'selected team')}</small>}
          <button type="button" disabled={saving} aria-label={stageRule?'Change who can move deals':'Change visibility of '+field.label}
            onClick={()=>{
              setRename(null);
              setAccess({action:property?'access':'standardAccess',id:rule.id,label:field.label,audience:selectedAudience,revision:rule.revision});
              setAudience(selectedAudience);setNotice('');setError('');
            }}>{stageRule?'Stage permissions':'Visibility'}</button></>;
      }}/>}
    <form key={access?'access-'+access.id:rename?.id??'create'} onSubmit={submit}>
      <fieldset disabled={saving}>
        {!access&&<label>Property name<input ref={propertyName} name="label" required maxLength={80} defaultValue={rename?.label}/></label>}
        {!rename&&<label>{stageAccess?'Who can change deal stages?':access?'Who can see '+access.label+'?':'Who can see this property?'}
          <select name="audience" ref={audienceSelect} value={audience} onChange={event=>setAudience(event.target.value)}>
            <option value="workspace">{stageAccess?'Everyone who can edit this deal':'Everyone with access to this record'}</option>
            <option value="owner">Workspace owner only</option>
            {access?.audience&&access.audience!=='owner'&&access.audience!=='workspace'&&!teams.some(team=>team.id===access.audience)&&
              <option value={access.audience}>Current team</option>}
            {teamChoices.map(team=><option key={team.id} value={team.id}>Owner and members of {team.label}</option>)}
          </select>
          {stageAccess&&<small>Other editors can see stages and create deals in the first stage of a pipeline.</small>}
          <small>Team access uses each teammate’s primary team.</small>
          {teamError&&<small role="alert">Reload this page to see all team choices.</small>}
        </label>}
        {!rename&&!access&&<>
          <label>Field type<select value={type} onChange={event=>setType(event.target.value as PortableCustomPropertyType)}>
            {portableCustomPropertyTypes.map(option=><option key={option} value={option}>{customPropertyTypeLabels[option]}</option>)}
          </select></label>
          {(type==='select'||type==='multiselect')&&<label>Options, one per line<textarea name="options" required maxLength={4050}/></label>}
        </>}
      </fieldset>
      <button type="submit" disabled={saving}>{access?(stageAccess?'Save stage permissions':'Save visibility'):rename?'Save name':'Add property'}</button>{' '}
      {(rename||access)&&<button type="button" disabled={saving} onClick={()=>{setAccess(null);setRename(null);setAudience('workspace');setError('');}}>Cancel</button>}
    </form>
    {error&&<p role="alert">{error}</p>}
    <p role="status">{notice}</p>
  </details>;
}
