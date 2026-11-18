import type {Data,Kind} from './crm';
import {propertyValue} from './record-properties';

export const canProtectImportField=(field:string)=>!!field&&field!=='recordId'&&!field.startsWith('association:')&&!field.startsWith('linkText:');
export function importValuePopulated(value:unknown):boolean {
 if(value==null||value==='')return false;
 if(Array.isArray(value))return value.length>0;
 if(typeof value==='object')return Object.keys(value).length>0;
 return true; // Zero and false are real values.
}
export function importFieldPopulated(data:Data,field:string,kind:Kind){
 return importValuePopulated(propertyValue(data,field==='ownerMember'?'owner':field))||
  ((field==='owner'||field==='ownerMember')&&importValuePopulated(data[kind==='tasks'?'taskAssignee':'recordOwner']));
}
export function importProtectionPaths(field:string,kind:Kind){
 if(field==='owner'||field==='ownerMember')return ['$.owner',kind==='tasks'?'$.taskAssignee':'$.recordOwner'];
 return [field.startsWith('custom:')?'$.custom.'+JSON.stringify(field.slice(7)):'$.'+JSON.stringify(field)];
}
