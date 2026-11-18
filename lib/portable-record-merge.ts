import {z} from 'zod';
import {portableCompanyFields,portableContactFields,type CompanyFields,type ContactFields} from './portable-records';

const recordId=z.string().guid("Invalid uuid");
const revision=z.number().int().min(1).max(2147483646);
export const portableMergeSide=z.enum(['primary','secondary']);
export type PortableMergeSide=z.infer<typeof portableMergeSide>;
export const portableMergeKind=z.enum(['contacts','companies']);
export type PortableMergeKind=z.infer<typeof portableMergeKind>;
const pair={kind:portableMergeKind,primaryId:recordId,secondaryId:recordId};

export const portableRecordMergeAction=z.discriminatedUnion('action',[
  z.object({action:z.literal('preview'),...pair}).strict(),
  z.object({action:z.literal('merge'),...pair,requestId:recordId,
    expectedRevisions:z.object({primary:revision,secondary:revision}).strict(),
    choices:z.record(z.string().max(80),portableMergeSide).refine(value=>Object.keys(value).length<=200)}).strict(),
]).refine(input=>input.primaryId!==input.secondaryId,{message:'Choose two different records.'});
export type PortableRecordMergeAction=z.infer<typeof portableRecordMergeAction>;

// Records that point at the secondary and move to the retained one.
export const portableMergeLinks={
  companies:['contacts','deals','leads','tickets','tasks','activities','associations'],
  contacts:['deals','leads','tickets','tasks','activities','meetings','notes','files','inquiries','segments','associations'],
} as const;
export type PortableMergeCounts=Partial<Record<(typeof portableMergeLinks)[PortableMergeKind][number],number>>;

type MergeData=ContactFields|CompanyFields;
// A Contact's primary Company is a column, carried beside the data for merge choices.
export type PortableMergeRecord={id:string;revision:number;data:MergeData;createdAt:string;primaryCompanyId?:string|null};
export type PortableMergePreview={
  kind:PortableMergeKind;primary:PortableMergeRecord;secondary:PortableMergeRecord;
  fields:string[];defaults:Record<string,PortableMergeSide>;counts:PortableMergeCounts;
  // Names for Company IDs shown in the review.
  companyNames?:Record<string,string>;
};
export type PortableMergeReceipt={primaryId:string;secondaryId:string;revision:number;moved:PortableMergeCounts};

// Standard fields, the record owner and each custom property can be taken from
// either record. A blank primary value defaults to the secondary's value.
export const mergeStandardFields={
  companies:[...Object.keys(portableCompanyFields.shape),'recordOwner'],
  contacts:[...Object.keys(portableContactFields.shape),'recordOwner','primaryCompanyId'],
} satisfies Record<PortableMergeKind,string[]>;

export function mergeValue(record:Pick<PortableMergeRecord,'data'|'primaryCompanyId'>,field:string):unknown{
  if(field==='primaryCompanyId')return record.primaryCompanyId??undefined;
  return field.startsWith('custom:')?record.data.custom?.[field.slice(7)]:(record.data as Record<string,unknown>)[field];
}
const blank=(value:unknown)=>value===undefined||value===null||value===''||(Array.isArray(value)&&!value.length);
export function mergeDefaults(primary:Pick<PortableMergeRecord,'data'|'primaryCompanyId'>,secondary:Pick<PortableMergeRecord,'data'|'primaryCompanyId'>,fields:string[]){
  return Object.fromEntries(fields.map(field=>[field,
    blank(mergeValue(primary,field))&&!blank(mergeValue(secondary,field))?'secondary':'primary'])) as Record<string,PortableMergeSide>;
}
export function mergeRecordData<T extends MergeData>(primary:{data:T;primaryCompanyId?:string|null},secondary:{data:T;primaryCompanyId?:string|null},
  fields:string[],choices:Record<string,PortableMergeSide>):{data:T;primaryCompanyId:string|null}{
  const defaults=mergeDefaults(primary,secondary,fields);
  const data:Record<string,unknown>={...primary.data},custom:Record<string,unknown>={...primary.data.custom};
  let primaryCompanyId=primary.primaryCompanyId??null;
  for(const field of fields){
    const value=mergeValue((choices[field]??defaults[field])==='secondary'?secondary:primary,field);
    if(field==='primaryCompanyId')primaryCompanyId=(value as string|undefined)??null;
    else if(field.startsWith('custom:')){
      if(blank(value))delete custom[field.slice(7)];else custom[field.slice(7)]=value;
    }else if(blank(value))delete data[field];
    else data[field]=value;
  }
  delete data.custom;
  return {data:{...data,...(Object.keys(custom).length?{custom}:{})} as T,primaryCompanyId};
}
