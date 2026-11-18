import {z} from 'zod';
import {offsetDateTime} from './iso-date-time';
import {sharedListKinds} from './shared-record-list';
import type {Property} from './workspace';
import {isCustomRecordColumn,type CustomRecordColumn} from './shared-record-sort';
export {isCustomRecordColumn,type CustomRecordColumn} from './shared-record-sort';
export type RecordColumnDefinition={id:CustomRecordColumn;label:string;type:Property['type'];unavailable?:boolean};
const jsonArray=<Item extends z.ZodType<string>>(limit:number,item:Item)=>z.string().max(6000).default('[]').transform((v,c)=>{try{return JSON.parse(v)}catch{c.addIssue({code:'custom',message:'Choose valid columns and records.'});return z.NEVER}}).pipe(z.array(item).max(limit).refine(v=>new Set(v).size===v.length,'Choose each value once.'));
export const recordColumnQuery=z.object({workspaceId:z.string().guid("Invalid uuid"),kind:z.enum(sharedListKinds),operation:z.enum(['catalog','cells']).default('catalog'),query:z.string().trim().max(160).default(''),after:z.string().max(200).default(''),columns:jsonArray(20,z.string().refine(isCustomRecordColumn)),ids:jsonArray(25,z.string().min(1).max(200))}).strict();
export type CustomCell={text:string;truncated:boolean;invalid?:boolean};
export type RecordColumnCatalog={items:RecordColumnDefinition[];next:string|null};
export type RecordColumnCells={definitions:RecordColumnDefinition[];values:Record<string,Record<string,CustomCell>>};
export function customCellPreview(value:unknown,type:Property['type']):CustomCell{
 if(value===null||value===undefined||value==='')return {text:'',truncated:false};
 let text='',valid=true;
 if(type==='checkbox'){valid=value===true||value===false||value===1||value===0;if(valid)text=value===true||value===1?'Yes':'No'}
 else if(type==='number'){valid=typeof value==='number'&&Number.isFinite(value);if(valid)text=String(value)}
 else if(type==='multiselect'){valid=Array.isArray(value)&&value.length<=50&&value.every(v=>typeof v==='string');if(valid)text=(value as string[]).join('; ')}
 else if(type==='date'){valid=z.string().date().safeParse(value).success;if(valid)text=String(value)}
 else if(type==='datetime'){valid=offsetDateTime.safeParse(value).success;if(valid)text=String(value)}
 else {valid=typeof value==='string';if(valid)text=value as string}
 if(!valid)return {text:'Invalid value',truncated:false,invalid:true};
 return {text:text.slice(0,500),truncated:text.length>500};
}
