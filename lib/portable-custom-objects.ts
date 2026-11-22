import {z} from 'zod';
import {ApiError} from './api-error';
import {portableCustomPatch,portableCustomPropertyTypes,portableCustomTextLimit,type PortableCustomValues} from './portable-custom-properties';
import {portableRecordKind} from './portable-records';
import {parseCustomValue} from './workspace';

const id=z.string().guid(),name=z.string().trim().min(1).max(100);
const version=z.number().int().min(0).max(2147483646);
const distinct=(names:string[])=>new Set(names.map(n=>n.toLowerCase())).size===names.length;
const property=z.object({id,label:name,type:z.enum(portableCustomPropertyTypes),options:z.array(z.string().trim().min(1).max(80)).max(50),required:z.boolean()}).strict()
  .refine(f=>distinct(f.options)&&((f.type==='select'||f.type==='multiselect')===Boolean(f.options.length)),'Use distinct options for choice fields.');
export const objectDefinition=z.object({name,fields:z.array(property).max(40)})
  .strict().refine(s=>distinct(s.fields.map(f=>f.id))&&distinct(s.fields.map(f=>f.label)),'Each property needs a distinct ID and label.');
export type ObjectDefinition=z.infer<typeof objectDefinition>;
export const objectAction=z.discriminatedUnion('action',[
  z.object({action:z.literal('define'),id,revision:version,definition:objectDefinition}).strict(),
  z.object({action:z.literal('save'),id,objectId:id,revision:version,schemaRevision:version.positive(),name,
    handoff:z.literal(true).optional(),values:portableCustomPatch.optional(),assigneeId:z.string().min(1).max(200).nullable().optional()}).strict(),
  z.object({action:z.literal('archive'),id,objectId:id,revision:version.positive(),archived:z.boolean()}).strict(),
  z.object({action:z.enum(['linkCustom','unlinkCustom']),id,objectId:id,revision:version.positive(),targetObjectId:id,target:id}).strict(),
  z.object({action:z.enum(['link','unlink']),id,objectId:id,revision:version.positive(),kind:portableRecordKind,target:id}).strict(),
]);
export type ObjectAction=z.infer<typeof objectAction>;
export function objectValues(schema:ObjectDefinition,patch:z.infer<typeof portableCustomPatch>={},previous:PortableCustomValues={}){
  const values={...previous};
  for(const [id,value] of Object.entries(patch)){
    const field=schema.fields.find(f=>f.id===id);
    if(!field)throw new ApiError(400,'Choose a property defined on this object.');
    try{
      const parsed=parseCustomValue(field,value);
      if(field.type==='text'&&typeof parsed==='string'&&parsed.length>portableCustomTextLimit)throw Error();
      if(parsed===undefined)delete values[id];else values[id]=parsed;
    }catch{throw new ApiError(400,'Enter a valid value for '+field.label+'.');}
  }
  for(const field of schema.fields)if(field.required&&values[field.id]===undefined)throw new ApiError(400,field.label+' is required.');
  return values;
}
export function validateDefinitionChange(previous:ObjectDefinition,next:ObjectDefinition,populated:boolean){
  for(const old of previous.fields){
    const current=next.fields.find(f=>f.id===old.id);
    if(!current||old.type!==current.type||old.options.some(option=>!current.options.includes(option)))
      throw new ApiError(409,'Keep existing properties, types and choices so saved records stay readable.');
  }
  if(populated&&next.fields.some(f=>f.required&&!previous.fields.find(old=>old.id===f.id)?.required))
    throw new ApiError(409,'Add optional properties to an object that already has records.');
}
export type ObjectField=ObjectDefinition['fields'][number];
export function isReportField(field:ObjectField){return field.type==='select'||field.type==='checkbox';}
export function objectSumField(definition:ObjectDefinition,id?:string){
  return id?definition.fields.find(field=>field.id===id&&field.type==='number'):undefined;
}
export function reportValueLabel(field:ObjectField,value:string|null){
  if(value===null)return 'No value';
  return field.type==='checkbox'?(value==='true'?'Yes':'No'):value;
}
const objectQuery=z.object({owner:z.literal('unavailable').optional(),summary:z.literal('1').optional(),sum:id.or(z.literal('')).optional(),by:id.or(z.literal('')).optional(),value:z.string().max(80).optional(),objectId:id.optional(),record:id.optional(),after:id.optional(),afterCustom:id.optional(),afterTask:id.optional(),afterTaskAt:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),search:z.string().trim().max(120).optional(),
  preview:z.literal('1').optional(),archived:z.literal('1').optional(),kind:portableRecordKind.optional(),target:id.optional(),workspaceId:id.optional()}).strict();
export const objectRead=objectQuery
  .refine(q=>!q.owner||!q.archived&&!q.summary&&!q.kind&&!q.record)
  .refine(q=>Boolean(q.afterTask)===(q.afterTaskAt!==undefined)&&(!q.afterTask||Boolean(q.record)))
  .refine(q=>!q.preview||Boolean(q.kind&&!q.after))
  .refine(q=>(!q.afterCustom||!!q.record)&&(!!q.kind===!!q.target)&&(!q.record||q.objectId)&&(!q.kind||!q.record&&!q.objectId&&!q.archived&&!q.search)&&
    (!q.record||!q.search&&!q.archived)&&(!q.search&&!q.archived||q.objectId))
  .refine(q=>{
    if(q.summary){
      if(q.search||q.archived||q.record||q.kind||q.value!==undefined)return false;
      return q.objectId?!q.after:q.by===undefined&&q.sum===undefined;
    }
    if(q.by===undefined&&q.value===undefined)return q.sum===undefined;
    return !!q.objectId&&!!q.by&&q.value!==undefined&&!q.record&&!q.kind&&!q.archived;
  },'Choose a custom object report or a group of active records.');
export const objectExport=objectQuery.pick({objectId:true,owner:true,by:true,value:true,search:true,archived:true})
  .required({objectId:true}).refine(q=>!q.owner||!q.archived).refine(q=>q.by===undefined&&q.value===undefined||Boolean(q.by)&&q.value!==undefined&&!q.archived,
    'Choose a group of active records to export.');
export type ObjectExport=z.output<typeof objectExport>;
export type ObjectRead=z.infer<typeof objectRead>;
export function objectPath(params:Record<string,string|undefined>={}){
  const query=new URLSearchParams({view:'custom-objects'});
  for(const [key,value] of Object.entries(params))if(value||(key==='value'&&value===''))query.set(key,value);
  return '/?'+query;
}
