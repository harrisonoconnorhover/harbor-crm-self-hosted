import {ASSOCIATION_JSON_FIELD,ASSOCIATION_JSON_LABEL,parseAssociationLinks} from './association-exchange';
import {uniqueNumberList} from './unique-number';
import {customTextLimit} from './property-text';
import {identifierValue} from './record-api-identifier';
import {uniqueValueKey} from './property-unique';
import type {Property} from './workspace';
import { associationPair, primaryField, type Association, type PrimaryField } from "./associations";
import { kinds, type CRMRecord, type Kind } from "./crm";
import type { ImportRow } from "./csv-import";

const singular: Record<Kind,string> = {contacts:"contact",companies:"company",deals:"deal",tasks:"task",tickets:"ticket", leads: "lead"};
export const associationImportFields = kinds.flatMap(kind => [
  {id:`association:${kind}:id`,label:`Associated ${singular[kind]} Record IDs`},
  ...(kind === "contacts" ? [{id:`association:${kind}:email`,label:"Associated contact emails"}] : []),
  ...(kind === "companies" ? [{id:`association:${kind}:domain`,label:"Associated company domains"}] : []),
  {id:`association:${kind}:labels`,label:`${singular[kind][0].toUpperCase()+singular[kind].slice(1)} association labels`},
]);
export type AssociationImportField={id:string;label:string;property?:Property;multiple?:boolean};
export function associationImportFieldCatalog(properties:Property[]=[]):AssociationImportField[]{
 return [{id:ASSOCIATION_JSON_FIELD,label:ASSOCIATION_JSON_LABEL},...associationImportFields,...properties.filter(p=>p.uniqueValues&&!p.archivedAt&&!p.standardField).flatMap(p=>[
  {id:`association:${p.kind}:custom:${p.id}`,label:`Associated ${singular[p.kind]} ${p.label} (unique)`,property:p},
  {id:`association:${p.kind}:customList:${p.id}`,label:`Associated ${singular[p.kind]} ${p.label} (JSON list)`,property:p,multiple:true},
 ])];
}
export function customAssociationValues(cell:string,field:AssociationImportField):(string|number)[]{
 if(cell==='')return [];
 let values:unknown[];
 try{values=field.multiple?(field.property?.type==='number'?uniqueNumberList(cell):JSON.parse(cell)):[cell];}catch{throw Error('Use a JSON array such as ["C-001","C-002"] for multiple custom identifiers.');}
 if(!Array.isArray(values)||values.length>20)throw Error('Use a JSON array of up to 20 unique identifiers.');
 const property=field.property!;
 const normalized=values.map(value=>{
  if(property.type==='number'){
   if(typeof value!=='string'&&typeof value!=='number')throw Error(`Use numbers for ${property.label}.`);
   return identifierValue('number',String(value));
  }
  if(typeof value!=='string'||value===''||value.length>customTextLimit)throw Error(`Use non-empty text identifiers for ${property.label}.`);
  return value;
 });
 return [...new Map(normalized.map(value=>[uniqueValueKey(value),value])).values()];
}
export type ImportAssociation = {
  identifier?:{propertyId:string;label:string;value:string|number};
  targetId:string; kind:Kind; name:string; labels:string[]; primary?:PrimaryField; primaryBefore?:string;
  previous:{id:string;labels:string[]}|null; changed:boolean;
};
const tokens = (value:string) => [...new Set(value.split(";").map(v=>v.trim()).filter(Boolean))];
const unionLabels = (values:string[]) => [...new Map(values.map(v=>[v.toLowerCase(),v])).values()];
export function planImportAssociations(plan:ImportRow[],rows:string[][],mapping:string[],kind:Kind,existing:CRMRecord[],links:Association[],properties:Property[] = []) {
  const catalog=new Map(associationImportFieldCatalog(properties).map(f=>[f.id,f]));
  const uniqueIndexes=new Map<string,Map<string,CRMRecord[]>>();
  for(const field of mapping){const p=catalog.get(field)?.property;if(!p||uniqueIndexes.has(p.id))continue;const index=new Map<string,CRMRecord[]>();for(const r of existing){if(r.kind!==p.kind)continue;const key=uniqueValueKey(r.data.custom?.[p.id]);if(key!==null)index.set(key,[...(index.get(key)||[]),r]);}uniqueIndexes.set(p.id,index);}
  const byPair=new Map(links.map(link=>[JSON.stringify(associationPair(link.recordA,link.recordB)),link]));
  for (const row of plan) {
    if(row.error || (!row.data && !row.target))continue;
    try {
      const cells=rows[row.row-2], result:ImportAssociation[]=[],primaryTargets=new Map<string,string>();
      const jsonIndex=mapping.indexOf(ASSOCIATION_JSON_FIELD),jsonLinks=jsonIndex<0?[]:parseAssociationLinks(cells[jsonIndex]);
      const source=row.target || {id:"",kind,data:row.data!} as CRMRecord;
      for(const targetKind of kinds) {
        const matches=mapping.flatMap((field,index)=>{
          if(!field.startsWith(`association:${targetKind}:`)||field.endsWith(':labels'))return [];
          const definition=catalog.get(field);if(!definition)throw Error('A mapped association identifier is no longer available.');
          return [{key:field.split(':')[2],property:definition.property,values:definition.property?customAssociationValues(cells[index],definition):tokens(cells[index])}];
        });
        if(matches.filter(m=>m.values.length).length>1)throw Error(`Use one association identifier column for ${targetKind} in each row.`);
        const column=matches.find(m=>m.values.length);
        const labelIndex=mapping.indexOf(`association:${targetKind}:labels`);
        const importedLabels=labelIndex<0?[]:tokens(cells[labelIndex]);
        const perLink=jsonLinks.filter(l=>l.kind===targetKind);
        if(perLink.length&&(column||importedLabels.length))throw Error(`Use either JSON associations or separate association columns for ${targetKind}, not both.`);
        if(!column&&!perLink.length) {if(importedLabels.length)throw Error(`Provide associated ${targetKind} identifiers for these labels.`);continue;}
        if(column&&column.values.length>20)throw Error("Use at most 20 associated records of each object per row.");
        const makePrimary=importedLabels.some(l=>l.toLowerCase()==="primary");
        if(makePrimary&&column?.values.length!==1)throw Error("Choose exactly one associated record when using the Primary label.");
        const customLabels=unionLabels(importedLabels.filter(l=>l.toLowerCase()!=="primary"));
        if(customLabels.some(l=>l.length>60)||customLabels.length>5)throw Error("Use up to five association labels of 60 characters each.");
        const requests=perLink.length?perLink.map(l=>({identifier:l.id,column:{key:'id',property:undefined as Property|undefined},labels:l.labels,makePrimary:l.primary}))
          :column!.values.map(identifier=>({identifier,column:column!,labels:customLabels,makePrimary}));
        for(const request of requests) {
          const {identifier,column,makePrimary}=request;
          const found=column.property ? uniqueIndexes.get(column.property.id)?.get(uniqueValueKey(identifier)!)||[]
            : existing.filter(r=>r.kind===targetKind && (column.key==="id" ? r.id===identifier : String(r.data[column.key as "email"|"domain"]||"").trim().toLowerCase()===String(identifier).toLowerCase()));
          if(found.length!==1)throw Error(found.length ? `Multiple ${targetKind} match "${identifier}". Use Record ID.` : `No available ${targetKind} match "${identifier}". Import or create that record first.`);
          const target=found[0];
          if(target.id===source.id)throw Error("A record cannot be associated with itself.");
          if(result.some(r=>r.targetId===target.id))continue;
          const field=makePrimary?primaryField(source,target):undefined;
          if(makePrimary&&!field)throw Error("Primary is not supported for this association direction.");
          if(field&&primaryTargets.has(field)&&primaryTargets.get(field)!==target.id)throw Error("Only one target can be primary for each relationship field.");
          if(field)primaryTargets.set(field,target.id);
          const previous=source.id?byPair.get(JSON.stringify(associationPair(source.id,target.id))):undefined;
          const labels=unionLabels([...(previous?.labels||[]),...request.labels]);
          if(labels.length>5)throw Error(`Adding these labels to ${target.data.name} would exceed five. Review its existing labels first.`);
          result.push({...(column.property?{identifier:{propertyId:column.property.id,label:column.property.label,value:identifier}}:{}),targetId:target.id,kind:target.kind,name:target.data.name,labels,primary:field,primaryBefore:field ? source.data[field] ? existing.find(r=>r.id===source.data[field])?.data.name || "Unavailable record" : "None" : undefined,previous:previous?{id:previous.id,labels:previous.labels}:null,changed:!previous||JSON.stringify(labels)!==JSON.stringify(previous.labels)||!!field&&source.data[field]!==target.id});
          if(field && (row.data || row.target!.data)[field]!==target.id) {
            row.data={...(row.data||row.target!.data),[field]:target.id};
            delete row.skipped;
          }
        }
      }
      if(result.length)row.associations=result;
      if(result.some(r=>r.changed)&&row.target&&!row.data)row.skipped="No property changes; associations will be updated";
    } catch(error) {row.error=error instanceof Error?error.message:"Check association identifiers.";}
  }
  if(plan.reduce((n,r)=>n+(r.associations?.length||0),0)>2000)throw Error("Import up to 2,000 associations per batch. Split this file into smaller imports.");
  return plan;
}
