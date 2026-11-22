'use client';
import {useState,type FormEvent} from 'react';
import type {ObjectResult} from '../db/postgres/custom-object-store';
import {objectPath,type ObjectAction,type ObjectDefinition} from '../lib/portable-custom-objects';
import {portableCustomPropertyTypes,customPropertyTypeLabels,type PortableCustomPropertyType} from '../lib/portable-custom-properties';
import {portableRecordKind,portableRecordLabels,type PortableRecordKind} from '../lib/portable-records';
import {portableRecordPath} from '../lib/portable-record-path';
import type {SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {PortableCustomFields,readCustomPropertyEdits} from './portable-custom-properties-ui';
import {CustomLinkPicker} from './portable-custom-link-picker';
import {PortableRecordPicker} from './portable-record-picker';

type List=Extract<ObjectResult,{view:'list'}>;
type Detail=Extract<ObjectResult,{view:'record'}>;
type Field=ObjectDefinition['fields'][number];
const endpoint='/api/custom-objects';
function useObjectWrite(shared?:SharedRecordWriteScope){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(input:ObjectAction,destination:string){
    if(busy)return;
    setBusy(true);setError('');
    try{
      const r=await fetch(endpoint+(shared?'?'+new URLSearchParams(shared):''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      if(!r.ok)throw Error(((await r.json()) as {error:string}).error);
      window.location.assign(destination);
    }catch(e){setError(e instanceof Error?e.message:'Could not confirm this change. Reload to check.');setBusy(false);}
  }
  return {busy,error,save};
}
export function ObjectDesigner({id,existing}:{id:string;existing?:List['type']}){
  const initial=existing?.definition;
  const [name,setName]=useState(initial?.name??''),[fields,setFields]=useState<Field[]>(initial?.fields??[]);
  const {busy,error,save}=useObjectWrite();
  function change(index:number,patch:Partial<Field>){setFields(fields.map((field,i)=>i===index?{...field,...patch}:field));}
  function submit(e:FormEvent){e.preventDefault();
    void save({action:'define',id,revision:existing?.revision??0,definition:{name,fields}},objectPath({objectId:id}));
  }
  return <form onSubmit={submit} className="custom-object-editor"><fieldset disabled={busy}><legend>Object settings</legend>
    <label>Object name<input required maxLength={100} value={name} placeholder="Subscriptions" onChange={e=>setName(e.target.value)}/></label>
    {fields.map((field,i)=>{
      const persisted=!!initial?.fields.some(f=>f.id===field.id);
      return <fieldset key={field.id}><legend>Property {i+1}</legend>
        <label>Property name<input required maxLength={100} value={field.label} onChange={e=>change(i,{label:e.target.value})}/></label>
        <label>Property type<select value={field.type} disabled={persisted} onChange={e=>change(i,{type:e.target.value as PortableCustomPropertyType,options:[]})}>
          {portableCustomPropertyTypes.map(type=><option key={type} value={type}>{customPropertyTypeLabels[type]}</option>)}</select></label>
        {(field.type==='select'||field.type==='multiselect')&&<label>Choices (one per line)<textarea required value={field.options.join('\n')}
          onChange={e=>change(i,{options:e.target.value.split('\n')})}/></label>}
        <label><input type="checkbox" checked={field.required} onChange={e=>change(i,{required:e.target.checked})}/> Required property</label>
        {!persisted&&<button type="button" onClick={()=>setFields(fields.filter(f=>f.id!==field.id))}>Remove property</button>}
      </fieldset>;
    })}
    <button type="button" disabled={fields.length>=40} onClick={()=>setFields([...fields,{id:crypto.randomUUID(),label:'',type:'text',required:false,options:[]}])}>Add property</button>
    <button type="submit">Save object</button></fieldset>{error&&<p role="alert">{error}</p>}</form>;
}

export function CustomRecordEditor({type,current,id,shared,assignees,restrictedActor,handoff=false}:{handoff?:boolean;type:List['type'];current?:Detail['record'];id:string;
  shared?:SharedRecordWriteScope;restrictedActor?:string;assignees:{id:string;label:string}[]}){
  const {busy,error,save}=useObjectWrite(shared);
  function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const data=Object.fromEntries(new FormData(e.currentTarget)),name=handoff&&current?current.name:String(data.name),owner=String(data.assignee??'');
    const stored=current?.data.recordOwner?.userId;
    const props=handoff?undefined:readCustomPropertyEdits(data,type.definition.fields,current?.data.values);
    void save({action:'save',id,objectId:type.id,schemaRevision:type.revision,revision:current?.revision??0,name,values:props,
      ...(handoff?{handoff:true}:{}),...(owner!==(stored??'')?{assigneeId:owner||null}:{})},objectPath({objectId:type.id,record:handoff?undefined:id,owner:handoff?'unavailable':undefined,workspaceId:shared?.workspaceId}));
  }
  return <form onSubmit={submit} className="custom-object-editor"><fieldset disabled={busy}><legend>{handoff?'Reassign record':'Record properties'}</legend>
    {!handoff&&<label>Record name<input required name="name" defaultValue={current?.name} maxLength={100}/></label>}
    <label>Record owner<select name="assignee" required={handoff} defaultValue={handoff?'':current?.data.recordOwner?.userId??(!current?restrictedActor:undefined)??''}>
      {handoff&&<option value="" disabled>Choose a new owner</option>}{!restrictedActor&&!handoff&&<option value="">Unassigned</option>}{!handoff&&current?.data.recordOwner&&!assignees.some(a=>a.id===current.data.recordOwner?.userId)&&
        <option value={current.data.recordOwner.userId}>{current.data.recordOwner.label}</option>}
      {assignees.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
    {!handoff&&<PortableCustomFields properties={type.definition.fields} values={current?.data.values} missingFields={[]} expanded/>}
    <button>{handoff?'Save new owner':'Save record'}</button></fieldset>{error&&<p role="alert">{error}</p>}</form>;
}

export function CustomRecordActions({detail,shared,after,afterCustom,canDelete=true}:{detail:Detail;canDelete?:boolean;shared?:SharedRecordWriteScope;after?:string;afterCustom?:string}){
  const {record,type,items,next}=detail,{busy,error,save}=useObjectWrite(shared);
  const [kind,setKind]=useState<PortableRecordKind>('companies');
  const ws=shared?.workspaceId,params={objectId:type.id,record:record.id,workspaceId:ws},destination=objectPath(params);
  const base={id:record.id,objectId:type.id,revision:record.revision};
  function link(event:FormEvent<HTMLFormElement>){event.preventDefault();
    const target=String(new FormData(event.currentTarget).get('target')??'');if(target)void save({...base,action:'link',kind,target},destination);
  }
  return <section><h2>Linked CRM records</h2>
    {items.length?<ul>{items.map(item=><li key={item.id}>
      <a href={portableRecordPath(item.kind,item.target,ws)}>{item.name}</a> · {portableRecordLabels[item.kind]}{' '}
      {item.canUnlink&&!record.archivedAt&&<button disabled={busy} onClick={()=>void save({...base,action:'unlink',kind:item.kind,target:item.target},destination)}>Unlink</button>}
    </li>)}</ul>:<p>No visible links on this page.</p>}
    {next&&<a href={objectPath({...params,after:next,afterCustom})}>More linked records</a>}
    {record.editable&&!record.archivedAt&&<details><summary>Link a CRM record</summary><form onSubmit={link}><fieldset disabled={busy}>
      <label>Object<select value={kind} onChange={e=>setKind(e.target.value as PortableRecordKind)}>
        {portableRecordKind.options.map(k=><option key={k} value={k}>{portableRecordLabels[k]}</option>)}</select></label>
      <PortableRecordPicker key={kind} kind={kind} field="target" label="Record to link" value={null} workspaceId={ws}/>
      <button>Link record</button></fieldset></form></details>}
    <section aria-label="Linked custom records"><h2>Linked custom records</h2>
      {detail.customLinks.items.length?<ul>{detail.customLinks.items.map(row=><li key={row.id}>
        <a href={objectPath({objectId:row.objectId,record:row.recordId,workspaceId:ws})}>{row.name}</a> · {row.typeName}{' '}
        {row.canUnlink&&!record.archivedAt&&<button disabled={busy} aria-label={'Unlink '+row.name}
          onClick={()=>void save({...base,action:'unlinkCustom',targetObjectId:row.objectId,target:row.recordId},destination)}>Unlink</button>}
      </li>)}</ul>:<p>No linked custom records on this page.</p>}
      {afterCustom&&<a href={objectPath({...params,after})}>First linked custom records</a>}{' '}
      {detail.customLinks.next&&<a href={objectPath({...params,after,afterCustom:detail.customLinks.next})}>More linked custom records</a>}
      {record.editable&&!record.archivedAt&&<CustomLinkPicker recordId={record.id} objectId={type.id} workspaceId={ws} busy={busy}
        onLink={(targetObjectId,target)=>void save({...base,action:'linkCustom',targetObjectId,target},destination)}/>}
    </section>
    {canDelete&&record.editable&&<button disabled={busy} onClick={()=>void save({...base,action:'archive',archived:!record.archivedAt},destination)}>
      {record.archivedAt?'Restore record':'Archive record'}</button>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
