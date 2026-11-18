import type {Property} from './workspace';
// Match the database's BINARY text comparison and native numeric comparison.
export function uniqueValueKey(value:unknown):string|null {
 if(value===null||value===undefined||value==='')return null;
 return typeof value==='number'?'n:'+String(value):'s:'+String(value);
}
export const uniqueConflictMessage='A unique property value is already used by another record. Change that value or clear it before saving.';
export function isUniqueConflict(error:unknown):boolean {
 const messages:string[]=[];let current=error;
 for(let i=0;i<5&&current;i++){messages.push(String(current));current=current instanceof Error?current.cause:undefined;}
 return messages.some(s=>s.includes('property_unique_values.property_id')||s.includes('unique_property_conflict'));
}
export function uniqueProperties(properties:Property[]){return properties.filter(p=>p.uniqueValues&&!p.standardField);}
