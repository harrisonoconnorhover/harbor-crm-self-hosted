import {z} from 'zod';
import type {FilterField} from './filters';
export const taskColumnLabels={name:'Task',status:'Status',taskType:'Task type',dueDate:'Due date',priority:'Priority',owner:'Assigned to',queue:'Queue',notes:'Task notes',createdAt:'Create date (UTC)',updatedAt:'Last modified (UTC)',dueTime:'Due time',dueTimeZone:'Due time zone',recordSource:'Record source',recordSourceDetail1:'Record source detail 1',related:'Primary related record',relatedEmail:'Primary related contact email',relatedPhone:'Primary related contact phone','associated:contacts':'Associated contacts','associated:companies':'Associated companies','associated:deals':'Associated deals','associated:tickets':'Associated tickets'} as const;
export type TaskColumn=keyof typeof taskColumnLabels|`custom:${string}`;
export type TaskColumnDefinition={id:TaskColumn;label:string;type:FilterField['type']|'associations';unavailable?:boolean};
export type TaskAssociationSummary={items:{id:string;name:string}[];total:number};
export type TaskColumnValues=Record<string,unknown>;
export const defaultTaskColumns:TaskColumn[]=['name','status','dueDate','priority','owner','queue'];
const key=z.string().max(150).refine(v=>Object.hasOwn(taskColumnLabels,v)||/^custom:[a-zA-Z0-9_-]+$/.test(v),'Choose an available task column.').transform(v=>v as TaskColumn);
export const taskColumnsSchema=z.array(key).min(1).max(20,'Choose up to 20 columns.').refine(v=>v.includes('name')&&new Set(v).size===v.length,'Keep the Task column and choose each column once.');
export function taskColumnDefinitions(fields:FilterField[]=[]):TaskColumnDefinition[]{
 return [...Object.entries(taskColumnLabels).map(([id,label])=>({id:id as TaskColumn,label,type:id.startsWith('associated:')?'associations' as const:['createdAt','updatedAt','dueDate'].includes(id)?'date' as const:'text' as const})),...fields.filter(f=>f.id.startsWith('custom:')).map(f=>({id:f.id as TaskColumn,label:f.label,type:f.type}))];
}
export function selectedTaskColumns(columns:TaskColumn[],catalog:TaskColumnDefinition[],strict=false){return columns.map(id=>{const field=catalog.find(f=>f.id===id);if(field)return field;if(strict)throw Error('A selected task column is unavailable. Remove it in Edit columns.');return {id,label:'Unavailable property',type:'text',unavailable:true} as TaskColumnDefinition;});}
export function taskColumnText(value:unknown,definition:TaskColumnDefinition):string {
 if(value===null||value===undefined||value==='')return '';
 if(definition.type==='checkbox')return value===true||value===1||value==='true'?'Yes':'No';
 if(Array.isArray(value))return value.map(String).join('; ');
 if(definition.type==='date')return String(value).slice(0,10);
 return String(value);
}
