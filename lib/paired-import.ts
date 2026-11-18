import {HISTORY_VALUE_MARKER} from './history-export-values';
import {z} from 'zod';
import {customTextLimit,isTextProperty} from './property-text';
import {importFields,ownerMemberImportField,captionImportFields,autoMap,type ImportMode} from './csv-import';
import {canProtectImportField} from './import-protection';
import {importRowMatches} from './import-matching';
import {formatPropertyText} from './property-validation';
import {uniqueNumber} from './unique-number';
import {uniqueValueKey} from './property-unique';
import {standardField} from './standard-properties';
import type {CRMRecord} from './crm';
import type {Property} from './workspace';
export const pairedKinds=['contacts','companies'] as const;
export type PairedKind=typeof pairedKinds[number];
export const PAIRED_ROWS=500,PAIRED_BYTES=2_000_000;
const mode=z.enum(['create','update','upsert']);
export const pairedImportInput=z.object({batchId:z.string().guid("Invalid uuid"),name:z.string().trim().min(1).max(120),headers:z.array(z.string().max(256)).min(1).max(100),mapping:z.array(z.string().max(150)).min(1).max(100),rows:z.array(z.array(z.string().max(customTextLimit+5)).max(100)).min(1).max(PAIRED_ROWS),modes:z.object({contacts:mode,companies:mode}).strict(),matchProperties:z.object({contacts:z.string().guid("Invalid uuid").optional(),companies:z.string().guid("Invalid uuid").optional()}).strict().prefault({}),doNotOverwrite:z.array(z.string().min(1).max(150)).max(100).default([]),defaultPrimary:z.boolean().default(true)}).strict().superRefine((v,c)=>{
 if(v.headers.length!==v.mapping.length||v.rows.some(r=>r.length!==v.mapping.length))c.addIssue({code:'custom',message:'Keep every CSV row aligned with its headers and mappings.'});
 if(new TextEncoder().encode(JSON.stringify(v.rows)).byteLength>PAIRED_BYTES)c.addIssue({code:'custom',message:'Keep imported row data within 2 MB.'});
 if(v.headers.some(h=>h.endsWith(HISTORY_VALUE_MARKER)))c.addIssue({code:'custom',message:'Use the single-object importer to restore history-value columns.'});
 const used=v.mapping.filter(Boolean);if(new Set(used).size!==used.length)c.addIssue({code:'custom',message:'Map each property only once.'});
 if(new Set(v.doNotOverwrite).size!==v.doNotOverwrite.length||v.doNotOverwrite.some(f=>!used.includes(f)||!pairedKinds.some(k=>f.startsWith(k+'/'))||!canProtectImportField(f.slice(f.indexOf('/')+1))))c.addIssue({code:'custom',message:'Protect only mapped contact or company properties.'});
});
export type PairedImportInput=z.infer<typeof pairedImportInput>;
export function pairedFields(kind:PairedKind,properties:Property[]){
 const fields=[{id:'recordId',label:'Record ID'},ownerMemberImportField,...captionImportFields(kind,properties),...importFields[kind].map(id=>({id,label:id==='owner'?'Record owner (stored text)':standardField(kind,id)?.label??id.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())})),...properties.filter(p=>p.kind===kind&&!p.archivedAt&&!p.standardField).map(p=>({id:'custom:'+p.id,label:p.label+' (custom)'}))];
 return fields.map(f=>({...f,id:kind+'/'+f.id}));
}
export function autoMapPaired(headers:string[],properties:Property[]){
 const used=new Set<string>();return headers.map(header=>{
  const h=header.trim(),n=h.toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
  let field='';
  if(/^(company )?association labels?$/.test(n))field='relationship/labels';
  else if(/^(is )?primary company$/.test(n))field='relationship/primary';
  else{
   const kind:PairedKind=/^compan(y|ies)(\b|[.:])/.test(n)?'companies':'contacts';
   const stripped=h.replace(/^(contacts?|compan(?:y|ies))[ .:_-]+/i,'');
   const mapped=autoMap([stripped],kind,properties)[0];
   if(mapped&&!mapped.startsWith('association:'))field=kind+'/'+mapped;
   if(kind==='companies'&&/^company domain( name)?$/i.test(h))field='companies/domain';
  }
  if(!field||used.has(field))return '';used.add(field);return field;
 });
}
export function objectFile(input:Pick<PairedImportInput,'mapping'|'rows'>,kind:PairedKind){
 const columns=input.mapping.flatMap((f,i)=>f.startsWith(kind+'/')?[{field:f.slice(kind.length+1),index:i}]:[]);
 if(!columns.length)throw Error(`Map at least one ${kind==='contacts'?'contact':'company'} property.`);
 const sourceRows:number[]=[],rows:string[][]=[];
 input.rows.forEach((row,i)=>{const cells=columns.map(c=>row[c.index]);if(cells.some(v=>v.trim())){sourceRows.push(i+2);rows.push(cells);}});
 if(!rows.length)throw Error(`No ${kind==='contacts'?'contact':'company'} values were found. Use the single-object importer for a file containing just one object.`);
 return {mapping:columns.map(c=>c.field),rows,sourceRows};
}
function comparable(field:string,value:string,kind:PairedKind,properties:Property[]){
 const p=field.startsWith('custom:')?properties.find(p=>p.id===field.slice(7)):undefined;
 if(p&&isTextProperty(p.type))return value;
 const trimmed=value.trim();if(field==='email'||field==='domain'||field==='ownerMember')return trimmed.toLowerCase();
 const type=p?.type??standardField(kind,field,properties)?.type;
 if(type==='checkbox'&&/^(true|yes|1|false|no|0)$/i.test(trimmed))return /^(true|yes|1)$/i.test(trimmed)?'true':'false';
 if(type==='number'&&trimmed){try{return String(p?.uniqueValues?uniqueNumber(trimmed):Number(trimmed));}catch{return trimmed;}}
 return trimmed;
}
export type ObjectGroups={mapping:string[];rows:string[][];sourceRows:number[][];bySource:Map<number,number>;mode:ImportMode;matchProperty?:string};
export function coalesceObject(input:Pick<PairedImportInput,'mapping'|'rows'|'matchProperties'|'modes'>,kind:PairedKind,properties:Property[],existing:CRMRecord[]):ObjectGroups{
 const file=objectFile(input,kind),identifier=input.matchProperties[kind]?properties.find(p=>p.kind===kind&&p.id===input.matchProperties[kind]&&p.uniqueValues&&!p.standardField&&!p.archivedAt):undefined;
 if(input.matchProperties[kind]&&(!identifier||!file.mapping.includes('custom:'+identifier.id)))throw Error(`Map the selected unique ${kind==='contacts'?'contact':'company'} property.`);
 const available=new Set(pairedFields(kind,properties).map(f=>f.id.slice(kind.length+1)));if(file.mapping.some(f=>!available.has(f)))throw Error('A mapped property is no longer available. Refresh properties.');
 const natural=kind==='contacts'?'email':'domain',hasIdentifier=file.mapping.includes('recordId')||!!identifier||file.mapping.includes(natural),effectiveMode=input.modes[kind]==='upsert'&&!hasIdentifier?'create':input.modes[kind];
 const rows:string[][]=[],sourceRows:number[][]=[],bySource=new Map<number,number>(),keys=new Map<string,number>();
 for(const [i,cells]of file.rows.entries()){
  const line=file.sourceRows[i],{recordId,matches}=importRowMatches(cells,file.mapping,kind,existing,identifier);
  if(recordId&&!matches.length)throw Error(`CSV row ${line}: ${kind==='contacts'?'contact':'company'} Record ID is unavailable.`);
  if(matches.length>1&&effectiveMode!=='create')throw Error(`CSV row ${line}: multiple ${kind} match. Use Record ID.`);
  let key=matches.length===1?'record:'+matches[0].id:'';
  if(!key&&recordId)key='id:'+recordId;
  if(!key&&identifier){const raw=cells[file.mapping.indexOf('custom:'+identifier.id)];if(raw.trim()){const value=identifier.type==='number'?uniqueNumber(raw):formatPropertyText(identifier,raw);key='unique:'+uniqueValueKey(value);}}
  if(!key&&file.mapping.includes(natural)){const raw=cells[file.mapping.indexOf(natural)].trim().toLowerCase();if(raw)key='natural:'+raw;}
  if(!key)key='new:'+JSON.stringify(cells.map((v,j)=>comparable(file.mapping[j],v,kind,properties)));
  const group=keys.get(key);
  if(group===undefined){keys.set(key,rows.length);bySource.set(line,rows.length);rows.push([...cells]);sourceRows.push([line]);continue;}
  const ignored=effectiveMode==='create'&&matches.length>0||effectiveMode==='update'&&!matches.length;
  if(!ignored)cells.forEach((value,j)=>{
   if(!value.trim())return;
   if(rows[group][j].trim()&&comparable(file.mapping[j],rows[group][j],kind,properties)!==comparable(file.mapping[j],value,kind,properties))throw Error(`CSV rows ${sourceRows[group][0]} and ${line}: conflicting ${kind==='contacts'?'contact':'company'} values for ${file.mapping[j].startsWith('custom:')?properties.find(p=>p.id===file.mapping[j].slice(7))?.label??'custom property':file.mapping[j]}. Keep one value per identifier.`);
   if(!rows[group][j].trim())rows[group][j]=value;
  });
  bySource.set(line,group);sourceRows[group].push(line);
 }
 return {mapping:file.mapping,rows,sourceRows,bySource,mode:effectiveMode,matchProperty:identifier?.id};
}
export function relationshipCells(input:PairedImportInput,line:number){
 const row=input.rows[line-2],labelColumn=input.mapping.indexOf('relationship/labels'),primaryColumn=input.mapping.indexOf('relationship/primary'),rawLabels=labelColumn<0?'':row[labelColumn];
 const labels=[...new Map(rawLabels.split(';').map(v=>v.trim()).filter(Boolean).map(v=>[v.toLowerCase(),v])).values()];
 const labelPrimary=labels.some(v=>v.toLowerCase()==='primary'),customLabels=labels.filter(v=>v.toLowerCase()!=='primary');
 if(customLabels.length>5||customLabels.some(v=>v.length>60))throw Error(`CSV row ${line}: use up to five company association labels of 60 characters each.`);
 const value=primaryColumn<0?'':row[primaryColumn].trim();if(value&&!/^(yes|no|true|false|1|0)$/i.test(value))throw Error(`CSV row ${line}: Primary company must be yes/no or true/false.`);
 return {labels:customLabels,primary:labelPrimary||/^(yes|true|1)$/i.test(value),hasPrimaryColumn:primaryColumn>=0,hasValues:!!rawLabels.trim()||/^(yes|true|1)$/i.test(value)};
}
