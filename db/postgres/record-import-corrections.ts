import {and,count,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {preparePortableRecordCsv,type MappedRecordCsv,type RecordCsvChange,type RecordCsvUpdate,type RecordImportRow} from '../../lib/portable-contact-import';
import {builtinPipeline,missingDealStageMessage,missingPortableDealStageFields,type DealPipeline,type PortableDealStageCustomField} from '../../lib/portable-deal-pipelines';
import type {CompanyFields,ContactFields,DealFields,PortableRecordKind} from '../../lib/portable-records';
import {samePropertyValue,type CustomValue} from '../../lib/property-values';
import {contacts,contactEvents} from './contact-schema';
import {activeContact} from './contact-visibility';
import {companies,companyEvents} from './company-schema';
import {activeCompany} from './company-visibility';
import {deals,dealEvents} from './deal-schema';
import {activeDeal} from './deal-visibility';

const tables={contacts,companies,deals};
const visible={contacts:activeContact,companies:activeCompany,deals:activeDeal};
const singular={contacts:'contact',companies:'company',deals:'deal'};
const recordId=z.string().guid();
type Fields=ContactFields|CompanyFields|DealFields;
type Current={id:string;revision:number;data:Fields;primaryCompanyId:string|null;companyId:string|null;
  pipelineId:string|null;stageId:string|null;primaryContactId:string|null};
type Match={record?:Current;error?:string};
export type CsvCorrection={current:Current;preview:RecordCsvUpdate;data:Fields;pipelineId:string|null;stageId:string|null};
type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

function cell(data:Fields,key:string):CustomValue|undefined{
  if(key.startsWith('custom:'))return data.custom?.[key.slice(7)];
  const value=data[key as keyof Fields];
  return typeof value==='string'||typeof value==='number'||typeof value==='boolean'?value:undefined;
}

async function lookup(db:PostgresJsDatabase,workspaceId:string|undefined,kind:PortableRecordKind,csv:MappedRecordCsv):Promise<Match[]>{
  const identity=kind==='contacts'?'email':kind==='companies'?'domain':undefined;
  const idCol=csv.mapping.indexOf('recordId'),keyCol=identity?csv.mapping.indexOf(identity):-1;
  const rows=csv.rows.map(cells=>({id:cells[idCol]?.trim().toLowerCase(),key:cells[keyCol]?.trim().toLowerCase()}));
  const keys=[...new Set(rows.flatMap(({key})=>key?[key]:[]))];
  const ids=new Set(rows.flatMap(({id})=>id&&recordId.safeParse(id).success?[id]:[]));
  const byKey=new Map<string,string|null>();
  const table=tables[kind],active=visible[kind];
  if(workspaceId&&keys.length){
    const key=kind==='contacts'?sql<string>`lower(${table.data}->>'email')`:sql<string>`lower(${table.data}->>'domain')`;
    const groups=await db.select({key,total:count(),id:sql<string>`min(${table.id}::text)`}).from(table)
      .where(and(eq(table.workspaceId,workspaceId),active,inArray(key,keys))).groupBy(key);
    for(const group of groups){
      byKey.set(group.key,group.total===1?group.id:null);
      if(group.total===1)ids.add(group.id);
    }
  }
  const none=sql<string|null>`null::uuid`;
  const records=workspaceId&&ids.size?await db.select({id:table.id,revision:table.revision,data:table.data,
    primaryCompanyId:kind==='contacts'?contacts.primaryCompanyId:none,companyId:kind==='deals'?deals.companyId:none,
    pipelineId:kind==='deals'?deals.pipelineId:none,stageId:kind==='deals'?deals.stageId:none,
    primaryContactId:kind==='deals'?deals.primaryContactId:none}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),active,inArray(table.id,[...ids]))):[];
  const byId=new Map(records.map(record=>[record.id,record]));
  const matches=rows.map(({id,key}):Match=>{
    if(id){
      const record=byId.get(id);
      if(!record)return {error:'Record ID does not match an active '+singular[kind]+' in this workspace.'};
      if(identity&&key&&String(cell(record.data,identity)??'').toLowerCase()!==key)
        return {error:'The Record ID and '+identity+' identify different records. Check the spreadsheet.'};
      return {record};
    }
    if(!key||!byKey.has(key))return {};
    const foundId=byKey.get(key);
    return foundId?{record:byId.get(foundId)}:{error:'Multiple '+kind+' use this '+identity+'. Resolve the duplicates or supply a Record ID.'};
  });
  const counts=new Map<string,number>();
  for(const {record} of matches)if(record)counts.set(record.id,(counts.get(record.id)??0)+1);
  return matches.map(match=>match.record&&counts.get(match.record.id)!>1
    ?{error:'This '+singular[kind]+' appears more than once in the CSV. Keep one correction per record.'}:match);
}

// Supply the existing name and stage to the shared CSV validator for partial
// corrections. Only nonblank columns in the original mapping can become edits.
function validationSource(source:MappedRecordCsv,matches:Match[],kind:PortableRecordKind){
  if(!matches.some(match=>match.record||match.error))return source;
  const mapping=[...source.mapping];
  for(const field of kind==='deals'?['name','pipelineId','stage']:['name'])if(!mapping.includes(field))mapping.push(field);
  const rows=source.rows.map((cells,index)=>mapping.map((field,col)=>{
    const value=cells[col]??'',current=matches[index].record;
    if(current&&(field==='email'&&kind==='contacts'||field==='domain'&&kind==='companies'))return '';
    if(value.trim()||!current)return value;
    if(field==='name')return current.data.name;
    if(kind==='deals'&&field==='pipelineId')return current.pipelineId??'default';
    if(kind==='deals'&&field==='stage')return current.stageId??String(cell(current.data,'stage')??'');
    return value;
  }));
  return {...source,mapping,rows};
}

export async function prepareReviewedCsv(db:PostgresJsDatabase,workspaceId:string|undefined,kind:PortableRecordKind,
  csv:MappedRecordCsv,pipelines:DealPipeline[],stageFields:PortableDealStageCustomField[]){
  const matches=await lookup(db,workspaceId,kind,csv);
  const matched=new Set(matches.flatMap((match,i)=>match.record?[i+2]:[]));
  const prepared=preparePortableRecordCsv(kind,validationSource(csv,matches,kind),pipelines,stageFields,matched);
  const updates:CsvCorrection[]=[];
  const previewedIds=new Set<string>();
  const pipelineById=new Map([builtinPipeline,...pipelines].map(p=>[p.id,p]));
  function evaluate<T extends Fields|{data:DealFields;pipelineId:string|null;stageId:string|null}>(row:RecordImportRow<T>):RecordImportRow<T>{
    const index=row.row-2,{record:current,error}=matches[index];
    if(error)return {row:row.row,state:'error',message:error};
    if(!current||row.state!=='create')return row;
    const item=row.data;
    const deal='pipelineId' in item&&'data' in item?item as {data:DealFields;pipelineId:string|null;stageId:string|null}:undefined;
    const proposed=deal?deal.data:item as Fields;
    const data={...current.data};
    const changes:RecordCsvChange[]=[];
    for(const [col,field] of csv.mapping.entries()){
      if(!field||['recordId','email','domain','primaryCompanyId','pipelineId','stage'].includes(field)||!(csv.rows[index][col]??'').trim())continue;
      const before=cell(current.data,field)??null,after=cell(proposed,field);
      if(after===undefined||samePropertyValue(before,after))continue;
      changes.push({field,label:csv.fields.get(field)!,before,after});
      if(field.startsWith('custom:'))data.custom={...data.custom,[field.slice(7)]:after};
      else Object.assign(data,{[field]:after});
    }
    if(deal){
      const beforePipeline=pipelineById.get(current.pipelineId??'default'),afterPipeline=pipelineById.get(deal.pipelineId??'default');
      const stage=afterPipeline?.stages.find(s=>s.id===(deal.stageId??deal.data.stage));
      if(!stage||!afterPipeline)return {row:row.row,state:'error',message:'Choose a current pipeline and stage.'};
      const samePipeline=current.pipelineId===deal.pipelineId;
      const sameStage=samePipeline&&(current.stageId??cell(current.data,'stage'))===(deal.stageId??stage.name);
      if(!samePipeline)changes.push({field:'pipelineId',label:'Pipeline',before:beforePipeline?.name??null,after:afterPipeline.name});
      if(!sameStage)changes.push({field:'stage',label:'Deal stage',before:beforePipeline?.stages.find(s=>s.id===current.stageId)?.name??cell(current.data,'stage')??null,after:stage.name});
      if(!sameStage)Object.assign(data,{stage:stage.name});
      const missing=missingPortableDealStageFields(stage.requiredProperties,data as DealFields,sameStage?current.data as DealFields:undefined,stageFields);
      if(missing.length)return {row:row.row,state:'error',message:missingDealStageMessage(stage.name,missing)};
    }
    if(changes.length){
      const identity=kind==='contacts'?{email:String(cell(current.data,'email')??'')}:{identifier:kind==='companies'?String(cell(current.data,'domain')??current.id):current.id};
      updates.push({current,data,pipelineId:deal?.pipelineId??null,stageId:deal?.stageId??null,
        preview:{row:row.row,state:'update',name:current.data.name,...identity,changes}});
    }
    // Both update rows and no-change rows show the saved record name.
    previewedIds.add(current.id);
    return {row:row.row,state:'skip',message:changes.length?'Existing '+singular[kind]+'.':'No changes to matched '+singular[kind]+': '+current.data.name+'.'};
  }
  if(prepared.kind==='contacts')prepared.rows=prepared.rows.map(row=>evaluate(row));
  if(prepared.kind==='companies')prepared.rows=prepared.rows.map(row=>evaluate(row));
  if(prepared.kind==='deals')prepared.rows=prepared.rows.map(row=>evaluate(row));
  return {prepared,updates,previewedIds:[...previewedIds]};
}

export async function applyRecordCorrections(tx:Tx,workspaceId:string,actorId:string,kind:PortableRecordKind,updates:CsvCorrection[]){
  if(!updates.length)return;
  const occurredAt=new Date().toISOString(),table=tables[kind];
  const edits=updates.map(({current,data,pipelineId,stageId})=>({record_id:current.id,rev:current.revision,data,pipeline:pipelineId,stage:stageId}));
  const stageChanges=kind==='deals'?sql`, pipeline_id=edits.pipeline, stage_id=edits.stage`:sql``;
  const saved=await tx.execute<{id:string}>(sql`UPDATE ${table} SET data=edits.data,
    revision=${table.revision}+1, updated_at=${occurredAt}${stageChanges}
    FROM jsonb_to_recordset(${JSON.stringify(edits)}::jsonb) AS edits(record_id uuid,rev integer,data jsonb,pipeline uuid,stage uuid)
    WHERE ${table.workspaceId}=${workspaceId} AND ${visible[kind]} AND ${table.id}=edits.record_id AND ${table.revision}=edits.rev
    RETURNING ${table.id}`);
  if(saved.length!==updates.length)throw new ApiError(409,'A matched record changed. Review the import again.');
  const event=(current:Current)=>({workspaceId,actorId,revision:current.revision+1,occurredAt});
  if(kind==='contacts')await tx.insert(contactEvents).values(updates.map(({current,data})=>({...event(current),contactId:current.id,
    previous:current.data as ContactFields,data:data as ContactFields,previousPrimaryCompanyId:current.primaryCompanyId,primaryCompanyId:current.primaryCompanyId})));
  if(kind==='companies')await tx.insert(companyEvents).values(updates.map(({current,data})=>({...event(current),companyId:current.id,
    previous:current.data as CompanyFields,data:data as CompanyFields})));
  if(kind==='deals')await tx.insert(dealEvents).values(updates.map(({current,data,pipelineId,stageId})=>({...event(current),dealId:current.id,
    previous:current.data as DealFields,data:data as DealFields,previousPipelineId:current.pipelineId,pipelineId,previousStageId:current.stageId,stageId,
    previousCompanyId:current.companyId,companyId:current.companyId,previousPrimaryContactId:current.primaryContactId,primaryContactId:current.primaryContactId})));
}
