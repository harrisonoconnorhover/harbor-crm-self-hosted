import {z} from 'zod';
import {portableRecordKind,type PortableRecordKind} from './portable-records';
import {standardFields} from './standard-properties';
import type {PortableCustomProperty} from './portable-custom-properties';
import type {CustomValue} from './property-values';

const coreFields:Record<PortableRecordKind,Record<string,string>>={
  contacts:{name:'Name',email:'Email',phone:'Phone number',title:'Job title',lifecycle:'Lifecycle stage'},
  companies:{name:'Name',domain:'Domain',website:'Website',industry:'Industry',city:'City',lifecycle:'Lifecycle stage'},
  deals:{name:'Name',amount:'Amount',closeDate:'Close date',stage:'Deal stage'},
};
const customPrefix='custom:';
const customId=z.string().guid("Invalid uuid");
export function portableCustomHistoryId(field:string){
  if(!field.startsWith(customPrefix))return undefined;
  return customId.safeParse(field.slice(customPrefix.length)).data;
}

export function portableHistoryFields(kind:PortableRecordKind,customProperties:readonly PortableCustomProperty[]=[]){
  const fields=new Map([...Object.entries(coreFields[kind]),...standardFields(kind).map(field=>[field.id,field.label] as const)]);
  fields.set('owner','Record owner');
  for(const property of customProperties)if(property.kind===kind)fields.set(customPrefix+property.id,property.label);
  return [...fields.entries()];
}

export const portablePropertyHistoryQuery=z.object({
  kind:portableRecordKind,
  history:z.string().guid("Invalid uuid"),
  field:z.string().min(1).max(80).optional(),
  search:z.string().trim().max(120).refine(value=>!value.includes('\0')).optional(),
  afterField:z.string().min(1).max(80).optional(),
  workspaceId:z.string().guid("Invalid uuid").optional(),
  before:z.coerce.number().int().min(1).max(2147483647).optional(),
}).strict().refine(input=>{
  const known=(field:string)=>portableHistoryFields(input.kind).some(([id])=>id===field)||!!portableCustomHistoryId(field);
  if(input.field)return known(input.field)&&input.afterField===undefined&&input.search===undefined;
  return (input.before===undefined)===(input.afterField===undefined)&&(!input.afterField||known(input.afterField));
});

export type PortablePropertyHistoryQuery=z.output<typeof portablePropertyHistoryQuery>;
type Value=CustomValue|null;
export type PortablePropertyChange={
  revision:number;occurredAt:string;actorName:string|null;previous:Value;value:Value;
};
export type PortablePropertyHistoryPage={items:PortablePropertyChange[];next:number|null};

export type PortableHistoryCursor={revision:number;field:string};
export type PortableRecordHistoryPage={
  items:(PortablePropertyChange&{field:string;label:string})[];
  next:PortableHistoryCursor|null;
};
