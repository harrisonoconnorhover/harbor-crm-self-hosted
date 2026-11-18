import {z} from 'zod';
import {offsetDateTime} from './iso-date-time';
import {csvCell} from './crm';
import {recordViewConfig,queryFromView,validRecordColumns} from './shared-record-views';
import {sharedListKinds} from './shared-record-list';
import type {Property} from './workspace';
export const recordExportInput=z.object({workspaceId:z.string().guid("Invalid uuid"),kind:z.enum(sharedListKinds),config:recordViewConfig,columns:z.array(z.string().max(150)).min(1).max(20)}).strict().superRefine((v,c)=>{if(!validRecordColumns(v.kind,v.columns))c.addIssue({code:'custom',message:'Choose available view columns, with Name first.'});try{queryFromView(v.workspaceId,v.kind,v.config)}catch{c.addIssue({code:'custom',message:'Check the view filters and sort.'})}});
// SQL casts scalars to text so large SQLite integers survive export exactly.
export function exportCustomValue(value:string|null,storage:string|null,type:Property['type']):string{
 if(value===null||storage==='null')return '';
 if(type==='number')return ['integer','real'].includes(storage||'')&&Number.isFinite(Number(value))?value:'Invalid value';
 if(type==='checkbox')return ['true','false','integer'].includes(storage||'')&&['0','1'].includes(value)?value==='1'?'Yes':'No':'Invalid value';
 if(type==='multiselect'){try{const parsed=JSON.parse(value);return storage==='array'&&Array.isArray(parsed)&&parsed.length<=50&&parsed.every(v=>typeof v==='string')?parsed.join('; '):'Invalid value'}catch{return 'Invalid value'}}
 if(storage!=='text')return 'Invalid value';
 if(type==='date'&&!z.string().date().safeParse(value).success)return 'Invalid value';
 if(type==='datetime'){if(!offsetDateTime.safeParse(value).success)return 'Invalid value';return new Date(value).toISOString()}
 return value;
}

export function exportCsvCell(value:unknown,numeric=false){
 if(numeric&&typeof value==='string'&&/^-?(?:[0-9]+(?:\.[0-9]+)?)(?:e[+-]?[0-9]+)?$/i.test(value)&&Number.isFinite(Number(value)))return '"'+value+'"';
 if(typeof value==='string'&&/^[\s\u0000-\u001f]*[=+@\-＝＋＠－]/u.test(value))value="'"+value;
 return csvCell(value);
}
