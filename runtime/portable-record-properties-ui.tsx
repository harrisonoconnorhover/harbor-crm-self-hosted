'use client';

import {useId,useRef,useState,type MouseEvent} from 'react';
import {ListFilter,Search,X} from 'lucide-react';
import {workspaceDate,workspaceNumber,type AccountDefaults} from '../lib/portable-account-defaults';
import {useWorkspaceDefaults} from './portable-workspace-format';
import type {FilterField} from '../lib/filters';
import {propertyGroupCatalog,propertyGroupFor,type PropertyOrganization} from '../lib/property-groups';
import {propertyLinkHref} from '../lib/property-links';
import {portablePropertyGroupFields,type PortableCustomProperty} from '../lib/portable-custom-properties';
import {portableCustomColumnId} from '../lib/portable-record-list-columns';
import type {CompanyRecord,ContactRecord,DealRecord,PortableRecordKind} from '../lib/portable-records';
import './portable-record-properties.css';

type Props={
  kind:PortableRecordKind;
  record:ContactRecord|CompanyRecord|DealRecord;
  customProperties:PortableCustomProperty[];
  hiddenStandardFields:string[];
  organization?:PropertyOrganization;
  lastContacted?:string|null;
};

const emptyOrganization:PropertyOrganization={groups:[],assignments:{}};
const recordDates:FilterField[]=[
  {id:'createdAt',label:'Create date',group:'Record information',type:'datetime'},
  {id:'updatedAt',label:'Last modified date',group:'Record information',type:'datetime'},
];

function propertyText(value:unknown){
  if(Array.isArray(value))return value.join('; ');
  if(typeof value==='boolean')return value?'Yes':'No';
  return typeof value==='string'||typeof value==='number'?String(value):'';
}

function displayValue(field:FilterField,value:unknown,defaults:AccountDefaults|null){
  const text=propertyText(value);
  if(!text)return '';
  if(field.type==='date'||field.type==='datetime'){
    if(defaults)return workspaceDate(text,defaults,field.type==='datetime');
    if(field.type==='datetime')return text.replace('T',' ').replace(/(?:\.\d+)?Z$/,' UTC');
  }
  if(defaults&&field.type==='number'&&typeof value==='number')return workspaceNumber(value,defaults,field.id==='amount'?'money':'number');
  return text;
}

function PropertyValue({field,value,text}:{field:FilterField;value:unknown;text:string}){
  if(!text)return <span className="portable-property-unset">Not set</span>;
  const type=field.id==='email'?'email':field.id==='website'||field.id==='linkedinUrl'?'url':field.type;
  const href=propertyLinkHref(type,value);
  if(href)return <a href={href} target={type==='url'?'_blank':undefined} rel={type==='url'?'noreferrer':undefined}>{text}</a>;
  if(type==='date'||type==='datetime')return <time dateTime={String(value)}>{text}</time>;
  return <>{text}</>;
}

export function PortableRecordProperties({kind,record,customProperties,hiddenStandardFields,organization=emptyOrganization,lastContacted}:Props){
  const defaults=useWorkspaceDefaults();
  const dialog=useRef<HTMLDialogElement>(null);
  const searchInput=useRef<HTMLInputElement>(null);
  const heading=useId();
  const [query,setQuery]=useState('');
  const fields=portablePropertyGroupFields(kind,customProperties.filter(property=>property.kind===kind))
    .filter(field=>!hiddenStandardFields.includes(field.id));
  const extra:Record<string,unknown>={owner:record.data.recordOwner?.label??'Unassigned',createdAt:record.createdAt,updatedAt:record.updatedAt};
  if('primaryCompanyName' in record){
    fields.push({id:'primaryCompanyName',label:'Primary company',type:'text'});
    extra.primaryCompanyName=record.primaryCompanyName;
  }
  if('primaryContactName' in record){
    fields.push({id:'companyName',label:'Company',type:'text'},{id:'primaryContactName',label:'Primary contact',type:'text'});
    Object.assign(extra,{companyName:record.companyName,primaryContactName:record.primaryContactName,stage:record.stageName,pipelineId:record.pipelineName});
  }
  fields.push(...recordDates);
  if(lastContacted!==undefined){
    fields.push({id:'lastContacted',label:'Last contacted',group:'Record information',type:'datetime'});
    extra.lastContacted=lastContacted;
  }
  const values:Record<string,unknown>={...record.data,...extra};
  const catalog=propertyGroupCatalog(kind,fields,organization);
  const search=query.trim().toLocaleLowerCase();
  const groups=catalog.map(group=>({...group,rows:fields.filter(field=>propertyGroupFor(kind,field,organization)===group.id)
    .map(field=>{
      const customId=portableCustomColumnId(field.id);
      const value=customId?record.data.custom?.[customId]:values[field.id];
      return {field,value,text:displayValue(field,value,defaults)};
    })
    .filter(({field,value,text})=>!search||[field.label,propertyText(value),text,group.name].some(text=>text.toLocaleLowerCase().includes(search)))}))
    .filter(group=>group.rows.length);
  const count=groups.reduce((sum,group)=>sum+group.rows.length,0);

  function open(){
    setQuery('');
    dialog.current?.showModal();
    searchInput.current?.focus();
  }
  function openHistory(event:MouseEvent<HTMLAnchorElement>){
    dialog.current?.close();
    const history=document.getElementById('portable-property-history');
    if(history instanceof HTMLDetailsElement){
      event.preventDefault();
      history.open=true;
      history.scrollIntoView({block:'center'});
      history.querySelector('summary')?.focus();
    }
  }
  return <>
    <button className="portable-properties-trigger" type="button" aria-haspopup="dialog" onClick={open}>
      <ListFilter size={16} aria-hidden="true"/>View all properties
    </button>
    <dialog className="portable-properties-dialog" aria-labelledby={heading} ref={dialog} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.currentTarget.close();}
    }}>
      <header><div><h2 id={heading}>All properties</h2><p>{record.data.name}</p></div>
        <button type="button" aria-label="Close" onClick={()=>dialog.current?.close()}><X size={18} aria-hidden="true"/></button>
      </header>
      <div className="portable-properties-search">
        <label><Search size={17} aria-hidden="true"/><input ref={searchInput} type="search" aria-label="Search properties"
          placeholder="Search properties" value={query} onChange={event=>setQuery(event.currentTarget.value)}/></label>
        <span role="status">{count} {count===1?'property':'properties'}</span>
      </div>
      <div className="portable-properties-results">
        {groups.map(group=><section key={group.id}><h3>{group.name}</h3><dl>{group.rows.map(({field,value,text})=>
          <div key={field.id}><dt>{field.label}</dt><dd style={field.multiline?{whiteSpace:'pre-wrap'}:undefined}><PropertyValue field={field} value={value} text={text}/></dd></div>
        )}</dl></section>)}
        {!count&&<p>No matching properties. <button type="button" onClick={()=>{setQuery('');searchInput.current?.focus();}}>Clear search</button></p>}
      </div>
      <footer><a href="#portable-property-history" onClick={openHistory}>View property history</a></footer>
    </dialog>
  </>;
}
