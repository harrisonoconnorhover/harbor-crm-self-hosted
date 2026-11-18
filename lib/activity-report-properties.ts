import {filterFields,type FilterField} from './filters';
import {schemas,type Kind,stages} from './crm';
import {recordSourceFieldIds} from './record-source';
import type {DealStageSource} from './forecast';
import type {Property} from './workspace';

// Current stored record properties supply dimensions, not activity measurements.
// Derived revenue, activity dates, stage-age and related-record names need their
// own query semantics and are not silently read from record JSON.
export function activityRecordFields(kind:Kind|undefined,properties:Property[],pipeline:DealStageSource=stages):FilterField[]{
 if(!kind)return [];
 const stored=new Set([...Object.keys(schemas[kind].shape),'createdAt','updatedAt',...recordSourceFieldIds]);
 return filterFields(kind,properties.filter(p=>!p.archivedAt),pipeline)
  .filter(f=>(stored.has(f.id)||f.id.startsWith('custom:'))&&!['name','owner'].includes(f.id))
  .map(f=>({...f,id:'record:'+f.id,label:`Associated ${kind} · ${f.label}`}));
}
export function activityMeasureFields(kind:string,fields:FilterField[]){
 return kind==='activities'?fields.filter(f=>!f.id.startsWith('record:')):fields;
}
