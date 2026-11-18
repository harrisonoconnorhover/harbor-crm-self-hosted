import {withRelativeDate} from "./property-relative-time";
import {urlDisplayText} from "./property-links";
import { displayDateTime } from "./property-datetime";
import {z} from 'zod';
import {isDealRevenueField} from './deal-revenue';
import {kinds,type Kind,type CRMRecord,stages} from './crm';
import {filterFields,readFilterValue,type FilterField} from './filters';
import {editableProperties} from './record-properties';
import {standardFields} from './standard-properties';
import type {Property} from './workspace';
import {propertyText} from './workspace';
import type {DealStageSource} from './forecast';
export const layoutSurface=z.enum(['record','preview']);
export type LayoutSurface=z.infer<typeof layoutSurface>;
export const recordLayoutInput=z.object({kind:z.enum(kinds),surface:layoutSurface,revision:z.number().int().min(0),fields:z.array(z.string().min(1).max(150)).max(50).nullable()});
export type RecordLayout=z.infer<typeof recordLayoutInput>;
export function recordLayoutFields(kind:Kind,properties:Property[],catalog:DealStageSource=stages){const fields=filterFields(kind,properties,catalog).filter(f=>!['company','contact','related'].includes(f.id));
 return kind==='tasks'?[...fields,{id:'lastContacted',label:'Last contacted',type:'date' as const},{id:'lastActivity',label:'Last activity date',type:'date' as const}].map(f=>({...f,showRelativeTime:f.showRelativeTime||!!properties.find(p=>p.kind===kind&&p.standardField===f.id)?.showRelativeTime})):fields;}
export function defaultRecordLayout(kind:Kind,surface:LayoutSurface,properties:Property[],catalog:DealStageSource=stages){
 const fields=recordLayoutFields(kind,properties,catalog),available=new Set(fields.map(f=>f.id));
 const extension=new Set(standardFields(kind).map(f=>f.id));
 const ids=surface==='record'?[...editableProperties(kind,properties,catalog).filter(f=>!extension.has(f.id)).map(f=>f.id),'lastContacted',...(kind==='tickets'?['closedAt']:[]),'createdAt']:
 ['owner',kind==='deals'?'stage':kind==='tickets'?'ticketStatus':kind==='tasks'?'status':'lifecycle','lastContacted',...properties.filter(p=>!p.standardField&&p.kind===kind).map(p=>'custom:'+p.id)];
 return [...new Set(ids)].filter(id=>available.has(id)).slice(0,50);
}
export function validateRecordLayout(layout:RecordLayout,fields:FilterField[]){
 if(layout.fields===null)return;
 if(new Set(layout.fields).size!==layout.fields.length)throw Error('Choose each property only once.');
 const valid=new Set(fields.map(f=>f.id));if(layout.fields.some(id=>!valid.has(id)))throw Error('Remove unavailable properties before saving.');
}
export function recordLayoutText(record:CRMRecord,field:FilterField){
 let value=readFilterValue(record,field.id,[]);
 if(field.id==='lifecycle'&&!value)value='Lead';
 if(value==null||value==='')return '—';
 if(isDealRevenueField(field.id))return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value));
 if(['daysInCurrentStage','timeToCloseHours'].includes(field.id))return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(Number(value));
 if(field.type==='url'&&field.id.startsWith('custom:'))return urlDisplayText(record.data,{...field,id:field.id.slice(7)});
 if(field.type==='datetime')return withRelativeDate(displayDateTime(value),value,field.showRelativeTime);
 if(field.type==='date')return withRelativeDate(/^\d{4}-\d{2}-\d{2}$/.test(String(value))?String(value):Number.isFinite(Date.parse(String(value)))?new Date(String(value)).toLocaleString():'—',record.kind==='tasks'&&field.id==='dueDate'?record.data.dueAt||value:value,field.showRelativeTime);
 return field.optionLabels?.[String(value)]||propertyText(value)||'—';
}
