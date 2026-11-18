import {decodeHistoryValue} from './history-export-values';
import {formatPropertyText} from './property-validation';
import {uniqueNumber} from './unique-number';
import {uniqueValueKey} from './property-unique';
import type {CRMRecord,Kind} from './crm';
import type {Property} from './workspace';

// Shared by single-object planning and same-file object coalescing. Record IDs
// retain precedence, including a blank mapped ID explicitly requesting creation.
export function importRowMatches(cells:string[],mapping:string[],kind:Kind,existing:CRMRecord[],identifier?:Property,historyColumns:number[]=[]){
 const owned=existing.filter(r=>r.kind===kind),idColumn=mapping.indexOf('recordId'),recordId=idColumn<0?'':cells[idColumn]?.trim()??'';
 const uniqueKey=identifier?null:kind==='contacts'?'email':kind==='companies'?'domain':null;
 const identityColumn=uniqueKey?mapping.indexOf(uniqueKey):-1,identity=identityColumn<0?'':(cells[identityColumn]??'').trim().toLowerCase();
 let customMatches:CRMRecord[]=[];
 if(identifier&&idColumn<0){
  const column=mapping.indexOf('custom:'+identifier.id),decoded=historyColumns.includes(column)?decodeHistoryValue(cells[column]):cells[column];
  const value=decoded==null||decoded===''?null:identifier.type==='number'?uniqueNumber(decoded):decoded.trim()?decoded:undefined;
  const key=uniqueValueKey(value);
  if(key!==null)customMatches=owned.filter(r=>uniqueValueKey(r.data.custom?.[identifier.id])===key);
  // Exact legacy values take priority over current text-cleanup rules.
  if(!customMatches.length&&typeof value==='string'){
   const cleaned=uniqueValueKey(formatPropertyText(identifier,value));
   if(cleaned!==null)customMatches=owned.filter(r=>uniqueValueKey(r.data.custom?.[identifier.id])===cleaned);
  }
 }
 const matches=recordId?owned.filter(r=>r.id===recordId):idColumn>=0?[]:identifier?customMatches:identity&&uniqueKey?owned.filter(r=>String(r.data[uniqueKey]||'').trim().toLowerCase()===identity):[];
 return {recordId,matches};
}
