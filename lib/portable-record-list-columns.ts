import type {PortableRecordKind,PortableRecordOwner} from './portable-records';
import type {PortableCustomProperty,PortableCustomValues} from './portable-custom-properties';
import {standardFields} from './standard-properties';

export const portableLastContactedColumn={id:'lastContacted',label:'Last contacted'} as const;

const defaults={
  contacts:[{id:'name',label:'Name'},{id:'email',label:'Email'},{id:'phone',label:'Phone'},{id:'title',label:'Job title'},
    {id:'lifecycle',label:'Lifecycle stage'},{id:'primaryCompanyName',label:'Primary company'}],
  companies:[{id:'name',label:'Name'},{id:'domain',label:'Domain'},{id:'website',label:'Website'},{id:'industry',label:'Industry'},
    {id:'city',label:'City'},{id:'lifecycle',label:'Lifecycle stage'}],
  deals:[{id:'name',label:'Name'},{id:'amount',label:'Amount'},{id:'closeDate',label:'Close date'},{id:'stageName',label:'Deal stage'},
    {id:'pipelineName',label:'Pipeline'},{id:'companyName',label:'Company'},{id:'primaryContactName',label:'Primary contact'}],
} as const;

export function portableDefaultRecordListColumns(kind:PortableRecordKind):readonly {id:string;label:string}[]{
  return defaults[kind];
}

export const portableCustomColumnId=(column:string)=>column.startsWith('custom:')?column.slice('custom:'.length):undefined;

export function portableRecordListValue(row:{data:{custom?:PortableCustomValues;recordOwner?:PortableRecordOwner}},values:Record<string,unknown>,column:string){
  if(column==='owner')return row.data.recordOwner?.label;
  const id=portableCustomColumnId(column);
  if(id===undefined)return values[column];
  const value=row.data.custom?.[id];
  if(typeof value==='boolean')return value?'Yes':'No';
  return Array.isArray(value)?value.join('; '):value;
}

export function portableRecordListColumns(kind:PortableRecordKind,custom:readonly Pick<PortableCustomProperty,'id'|'kind'|'label'>[]=[],canReadOutreach=true):{id:string;label:string}[]{
  const basic=portableDefaultRecordListColumns(kind);
  const extensions=standardFields(kind).filter(field=>!basic.some(column=>column.id===field.id)).map(({id,label})=>({id,label}));
  return [...basic,...extensions,{id:'owner',label:'Record owner'},{id:'createdAt',label:'Create date'},{id:'updatedAt',label:'Last modified date'},
    ...(kind==='contacts'&&canReadOutreach?[portableLastContactedColumn]:[]),
    ...custom.filter(property=>property.kind===kind).map(({id,label})=>({id:'custom:'+id,label}))];
}
