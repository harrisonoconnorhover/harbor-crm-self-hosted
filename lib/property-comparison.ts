import {relativeCalendarDay} from './relative-date-filter';
import type {FilterField,FilterRule} from './filters';
export const propertyComparisonOperators=['beforeProperty','afterProperty','gtProperty','ltProperty'] as const;
export const isPropertyComparison=(operator:string)=>propertyComparisonOperators.some(v=>v===operator);
export const filterRuleFields=(rule:FilterRule)=>[rule.field,...(isPropertyComparison(rule.operator)&&rule.compareField?[rule.compareField]:[])];
export function comparisonFields(field:FilterField|undefined,fields:FilterField[]){return field&&['date','datetime','number'].includes(field.type)?fields.filter(f=>f.id!==field.id&&f.type===field.type):[];}
export function matchesPropertyComparison(left:unknown,right:unknown,type:FilterField['type'],operator:string,timeZone?:string){
 const normalize=(value:unknown):number|string|null=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean'||typeof value==='object')return null;
  if(type==='number'){const n=Number(value);return Number.isFinite(n)?n:null;}
  if(typeof value!=='string')return null;
  const at=Date.parse(value);if(!Number.isFinite(at))return null;
  if(type==='datetime')return at;
  return value.length===10?value:relativeCalendarDay(new Date(at),timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone);
 };
 const a=normalize(left),b=normalize(right);if(a===null||b===null)return false;
 return operator==='beforeProperty'||operator==='ltProperty'?a<b:a>b;
}
