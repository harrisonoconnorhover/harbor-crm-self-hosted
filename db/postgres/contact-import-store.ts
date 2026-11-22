import {captureRecordWorkflowTasks} from './record-task-workflow-store';
import {and,count,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {sha256} from '../../lib/email/crypto';
import {mapPortableRecordCsv,preparePortableRecordCsv,portableImportName,type MappedRecordCsv,type PreparedRecordCsv,type RecordImportCommit,
  type ContactImportFields,type RecordImportPreview,type RecordImportRow} from '../../lib/portable-contact-import';
import {mapPortablePairedCsv,preparePortablePairedCsv} from '../../lib/portable-paired-import';
import type {PortableCustomValues} from '../../lib/portable-custom-properties';
import type {PortableRecordKind} from '../../lib/portable-records';
import {companies,companyEvents} from './company-schema';
import {applyRecordCorrections,prepareReviewedCsv} from './record-import-corrections';
import {recordAccess,type RecordAccessActor} from './record-access-store';
import {contactImportReceipts} from './contact-import-schema';
import {contacts,contactEvents,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {listDealStageCustomFields,listPortableCustomProperties} from './custom-property-store';
import {readDealPipelines} from './deal-pipeline-store';
import {deals,dealEvents} from './deal-schema';
import {lockRecordWorkspace} from './private-workspace-store';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const companyImportId=z.string().guid("Invalid uuid");

async function checkDuplicates<T extends {email?:string;domain?:string}>(db:PostgresJsDatabase,
  workspaceId:string|undefined,object:'contacts'|'companies',rows:RecordImportRow<T>[]){
  const field=object==='contacts'?'email':'domain';
  const keys=rows.flatMap(row=>row.state==='create'&&row.data[field]?[row.data[field]!.toLowerCase()]:[]);
  if(!workspaceId||!keys.length)return rows;
  const table=object==='contacts'?contacts:companies;
  const key=object==='contacts'?sql<string>`lower(${contacts.data}->>'email')`:sql<string>`lower(${companies.data}->>'domain')`;
  const matches=await db.selectDistinct({key}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),object==='contacts'?activeContact:activeCompany,inArray(key,keys)));
  const existing=new Set(matches.map(row=>row.key));
  const message=object==='contacts'?'An existing contact uses this email.':'An existing company uses this domain.';
  return rows.map((row):RecordImportRow<T>=>row.state==='create'&&existing.has(row.data[field]?.toLowerCase()??'')
    ?{row:row.row,state:'skip',message}:row);
}

async function resolveContactImportCompanies(db:PostgresJsDatabase,workspaceId:string|undefined,csv:MappedRecordCsv,
  rows:RecordImportRow<ContactImportFields>[],lock:boolean):Promise<RecordImportRow<ContactImportFields>[]>{
  const column=csv.mapping.indexOf('primaryCompanyId');
  if(column<0)return rows;
  const targets=new Map<number,string>();
  const ids=new Set<string>();
  for(const row of rows){
    if(row.state!=='create')continue;
    const value=csv.rows[row.row-2]?.[column]?.trim().toLowerCase();
    if(!value)continue;
    targets.set(row.row,value);
    if(companyImportId.safeParse(value).success)ids.add(value);
  }
  if(!targets.size)return rows;
  const found=new Map<string,{id:string;name:string}>();
  if(workspaceId&&ids.size){
    const query=db.select({id:companies.id,name:sql<string>`${companies.data}->>'name'`}).from(companies)
      .where(and(eq(companies.workspaceId,workspaceId),activeCompany,inArray(companies.id,[...ids]))).orderBy(companies.id);
    for(const company of await (lock?query.for('share'):query))found.set(company.id,company);
  }
  return rows.map(row=>{
    const target=targets.get(row.row);
    if(row.state!=='create'||!target)return row;
    const company=found.get(target);
    return company?{...row,data:{...row.data,importCompany:company}}:
      {row:row.row,state:'error',message:'Choose an existing primary company Record ID from this workspace.'};
  });
}

async function mappedImportSource(db:PostgresJsDatabase,actorId:string,kind:PortableRecordKind,sourceHash:string,text:string,mapping?:string[],reviewMatches=false){
  const properties=mapping?.some(target=>target.startsWith('custom:'))?await listPortableCustomProperties(db,actorId,kind):[];
  const csv=mapPortableRecordCsv(kind,text,mapping,properties,false,reviewMatches);
  const reviewSource=csv.remapped?await sha256(JSON.stringify(['portable-csv-mapping-v1',sourceHash,csv.mapping])):sourceHash;
  return {csv,reviewSource};
}

async function reviewRows(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,object:PortableRecordKind,sourceHash:string,csv:MappedRecordCsv,
  reviewMatches=false,lockCompanies=false){
  const pipelines=object==='deals'?await readDealPipelines(db,actorId):[];
  const stageCustomFields=workspaceId?await listDealStageCustomFields(db,workspaceId,
    pipelines.flatMap(pipeline=>pipeline.stages.flatMap(stage=>stage.requiredProperties??[]))):[];
  const checked=reviewMatches?await prepareReviewedCsv(db,workspaceId,object,csv,pipelines,stageCustomFields):undefined;
  const prepared=checked?.prepared??preparePortableRecordCsv(object,csv,pipelines,stageCustomFields);
  const corrections=checked?.updates??[];
  if(prepared.kind==='contacts'){
    if(!reviewMatches)prepared.rows=await checkDuplicates(db,workspaceId,'contacts',prepared.rows);
    prepared.rows=await resolveContactImportCompanies(db,workspaceId,csv,prepared.rows,lockCompanies);
  }
  if(prepared.kind==='companies'&&!reviewMatches)prepared.rows=await checkDuplicates(db,workspaceId,'companies',prepared.rows);
  // Preserve old previews and receipts that implicitly selected Contacts.
  const key:unknown[]=object==='contacts'?[actorId,sourceHash,prepared.rows]:[actorId,object,sourceHash,prepared.rows];
  if(reviewMatches)key.push(object==='contacts'?'matched-contacts-v1':'matched-'+object+'-v1',corrections.map(({current,preview,pipelineId,stageId})=>
    object==='deals'?[current.id,current.revision,preview,pipelineId,stageId]:[current.id,current.revision,preview]));
  if(csv.properties.length)key.push(csv.properties.map(({id,revision})=>({id,revision})).sort((a,b)=>a.id.localeCompare(b.id)));
  const review=await sha256(JSON.stringify(key));
  const created=prepared.rows.filter(row=>row.state==='create').length;
  const skipped=prepared.rows.filter(row=>row.state==='skip').length-corrections.length;
  return {review,prepared,created,skipped,corrections,previewedIds:checked?.previewedIds??[],errors:prepared.rows.length-created-skipped-corrections.length};
}

type PreviewRow=RecordImportPreview['rows'][number];
function previewRows(prepared:PreparedRecordCsv,properties:MappedRecordCsv['properties']):PreviewRow[]{
  function customPreview(values:PortableCustomValues|undefined){
    const custom=values?properties.flatMap(({id,label})=>values[id]===undefined?[]:[{label,value:values[id]}]):[];
    return custom.length?{custom}:{};
  }
  if(prepared.kind==='contacts')return prepared.rows.map(row=>row.state==='create'
    ?{row:row.row,state:row.state,name:row.data.name,email:row.data.email,...(row.data.importCompany?{company:row.data.importCompany.name}:{}),...customPreview(row.data.custom)}:row);
  if(prepared.kind==='companies')return prepared.rows.map(row=>row.state==='create'
    ?{row:row.row,state:row.state,name:row.data.name,domain:row.data.domain,...customPreview(row.data.custom)}:row);
  return prepared.rows.map(row=>row.state==='create'
    ?{row:row.row,state:row.state,name:row.data.data.name,pipeline:row.data.pipelineName,stage:row.data.data.stage,...customPreview(row.data.data.custom)}:row);
}

export async function previewPortableRecordImport(db:PostgresJsDatabase,actor:RecordAccessActor,object:PortableRecordKind,sourceHash:string,text:string,mapping?:string[],
  reviewMatches=false):Promise<RecordImportPreview>{
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actor.userId));
    const {csv,reviewSource}=await mappedImportSource(tx,actor.userId,object,sourceHash,text,mapping,reviewMatches);
    const {prepared,corrections,previewedIds,...review}=await reviewRows(tx,actor.userId,workspace?.id,object,reviewSource,csv,reviewMatches);
    const updates=new Map(corrections.map(({preview})=>[preview.row,preview]));
    await recordAccess(tx,actor,object,'import_preview',previewedIds,workspace?.id);
    if(prepared.kind==='contacts'){
      const companyIds=new Set(prepared.rows.flatMap(row=>row.state==='create'&&row.data.importCompany?[row.data.importCompany.id]:[]));
      await recordAccess(tx,actor,'companies','import_preview',[...companyIds],workspace?.id);
    }
    return {...review,...(reviewMatches?{updates:updates.size}:{}),columns:prepared.columns,
      rows:previewRows(prepared,csv.properties).map(row=>updates.get(row.row)??row)};
  },{isolationLevel:'repeatable read'});
}

async function insertRows(tx:Transaction,workspaceId:string,actorId:string,prepared:PreparedRecordCsv){
  const now=new Date().toISOString();
  const record=()=>({workspaceId,id:crypto.randomUUID(),revision:1,createdAt:now,updatedAt:now});
  const event={workspaceId,actorId,revision:1,occurredAt:now};
  // Keep attributed revision receipts, like manual creates. An import does
  // not trigger the lifecycle or deal-stage workflows that run on updates.
  if(prepared.kind==='contacts'){
    const rows=prepared.rows.flatMap(row=>{
      if(row.state!=='create')return [];
      const {importCompany,...data}=row.data;
      return [{...record(),data,primaryCompanyId:importCompany?.id}];
    });
    await tx.insert(contacts).values(rows);
    await tx.insert(contactEvents).values(rows.map(row=>({...event,contactId:row.id,data:row.data,primaryCompanyId:row.primaryCompanyId})));
  }else if(prepared.kind==='companies'){
    const mapped=prepared.rows.flatMap(row=>row.state==='create'?[{row:row.row,record:{...record(),data:row.data}}]:[]);
    const rows=mapped.map(row=>row.record);
    await tx.insert(companies).values(rows);
    await tx.insert(companyEvents).values(rows.map(row=>({...event,companyId:row.id,data:row.data})));
    await captureRecordWorkflowTasks(tx,workspaceId,actorId,{trigger:'company_created',records:rows.map(row=>({id:row.id,recordOwner:row.data.recordOwner}))},now);
    return new Map(mapped.map(row=>[row.row,row.record.id]));
  }else{
    const rows=prepared.rows.flatMap(row=>row.state==='create'?[{...record(),data:row.data.data,
      pipelineId:row.data.pipelineId,stageId:row.data.stageId}]:[]);
    await tx.insert(deals).values(rows);
    await tx.insert(dealEvents).values(rows.map(row=>({...event,dealId:row.id,data:row.data,pipelineId:row.pipelineId,stageId:row.stageId})));
  }
}

export async function commitPortableRecordImport(db:PostgresJsDatabase,actorId:string,input:RecordImportCommit&{kind:PortableRecordKind},sourceHash:string){
  const {kind,review,requestId}=input;
  const name=portableImportName(kind);
  return db.transaction(async tx=>{
    // Serialize duplicate and pipeline checks with record and catalog writes.
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(403,'Open your own workspace to import records.');
    // New correction receipts use only the submitted request, so a replay can
    // succeed even if a custom property was retired after the original write.
    const legacy=input.reviewMatches?undefined:await mappedImportSource(tx,actorId,kind,sourceHash,input.csv,input.mapping);
    const selected=new Set(input.updateRows??[]),includeNew=input.includeNew!==false;
    const requestHash=await sha256(JSON.stringify(legacy
      ?kind==='contacts'?[legacy.reviewSource,review]:[kind,legacy.reviewSource,review]
      :['matched-'+kind+'-v1',sourceHash,input.mapping??null,review,includeNew,[...selected].sort((a,b)=>a-b)]));
    const [receipt]=await tx.select().from(contactImportReceipts)
      .where(and(eq(contactImportReceipts.workspaceId,workspaceId),eq(contactImportReceipts.requestId,requestId)));
    if(receipt){
      if(receipt.requestHash!==requestHash)throw new ApiError(409,'This request ID was already used for a different import.');
      return {result:receipt.result,replayed:true};
    }
    const {csv,reviewSource}=legacy??await mappedImportSource(tx,actorId,kind,sourceHash,input.csv,input.mapping,input.reviewMatches);
    const checked=await reviewRows(tx,actorId,workspaceId,kind,reviewSource,csv,input.reviewMatches,true);
    if(checked.review!==review)throw new ApiError(409,`${name}, the CSV or its mapping changed after preview. Review the import again.`);
    const updates=checked.corrections.filter(({preview})=>selected.has(preview.row));
    if(updates.length!==selected.size)throw new ApiError(400,'Select only record updates shown in the current preview.');
    const created=includeNew?checked.created:0;
    if(checked.errors||!(created||updates.length))throw new ApiError(400,'Fix any errors and select at least one change before importing.');
    if(created)await insertRows(tx,workspaceId,actorId,checked.prepared);
    await applyRecordCorrections(tx,workspaceId,actorId,kind,updates);
    const result={created,skipped:checked.skipped+checked.created-created+checked.corrections.length-updates.length,
      ...(input.reviewMatches?{updated:updates.length}:{})};
    await tx.insert(contactImportReceipts).values({workspaceId,requestId,requestHash,result,createdAt:new Date().toISOString()});
    return {result,replayed:false};
  });
}

async function reviewPairedRows(db:PostgresJsDatabase,actorId:string,workspaceId:string|undefined,text:string,mapping?:string[]){
  const source=mapPortablePairedCsv(text,mapping);
  const plan=preparePortablePairedCsv(source);
  const companyRows=plan.companyRows,contactRows=plan.contactRows;
  type CompanyMatch={id:string;name:string;matches:number};
  const byDomain=new Map<string,CompanyMatch>();
  const domains=companyRows.rows.flatMap(row=>row.state==='create'&&row.data.domain?[row.data.domain.toLowerCase()]:[]);
  if(workspaceId&&domains.length){
    const domain=sql<string>`lower(${companies.data}->>'domain')`;
    const matches=await db.select({domain,id:sql<string>`min(${companies.id}::text)`,
      name:sql<string>`min(${companies.data}->>'name')`,matches:count()}).from(companies)
      .where(and(eq(companies.workspaceId,workspaceId),activeCompany,inArray(domain,domains))).groupBy(domain);
    for(const match of matches)byDomain.set(match.domain,match);
  }
  const existing=new Map<number,CompanyMatch>();
  companyRows.rows=companyRows.rows.map(row=>{
    if(row.state!=='create')return row;
    if(!row.data.domain)return {row:row.row,state:'error',message:'Enter a company domain.'};
    const match=byDomain.get(row.data.domain.toLowerCase());
    if(!match)return row;
    if(match.matches!==1)return {row:row.row,state:'error',message:'Multiple companies use this domain. Resolve the duplicates before importing.'};
    existing.set(row.row,match);
    return {row:row.row,state:'skip',message:'Use existing company: '+match.name};
  });
  contactRows.rows=await checkDuplicates(db,workspaceId,'contacts',contactRows.rows.map(row=>
    row.state==='create'&&!row.data.email?{row:row.row,state:'error',message:'Enter a contact email.'}:row));
  const paired={contacts:contactRows.rows.filter(row=>row.state==='create').length,
    companies:companyRows.rows.filter(row=>row.state==='create').length,reusedCompanies:existing.size};
  const created=paired.contacts+paired.companies;
  const errors=[...contactRows.rows,...companyRows.rows].filter(row=>row.state==='error').length;
  const skipped=contactRows.rows.length+companyRows.rows.length-created-errors;
  const review=await sha256(JSON.stringify(['paired-csv-v1',actorId,await sha256(text),source.mapping,
    contactRows.rows,companyRows.rows,[...existing],[...plan.links]]));
  return {source,plan,existing,review,result:{created,skipped,paired},errors};
}

export async function previewPortablePairedImport(db:PostgresJsDatabase,actor:RecordAccessActor,text:string,mapping?:string[]):Promise<RecordImportPreview>{
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actor.userId));
    const {source,plan,existing,review,result,errors}=await reviewPairedRows(tx,actor.userId,workspace?.id,text,mapping);
    const companyRows=previewRows(plan.companyRows,[]).map(row=>({...row,object:'Company' as const,row:plan.companies.sourceRows[row.row-2][0]}));
    const contacts=previewRows(plan.contactRows,[]).map(row=>{
      const target=plan.links.get(row.row-2),company=target===undefined?undefined:plan.companyRows.rows[target];
      const label=company?.state==='create'?company.data.name:company?existing.get(company.row)?.name:undefined;
      return {...row,...(row.state==='create'&&label?{company:label}:{}),object:'Contact' as const,row:plan.contacts.sourceRows[row.row-2][0]};
    });
    const companyIds=new Set([...existing.values()].map(company=>company.id));
    await recordAccess(tx,actor,'companies','import_preview',[...companyIds],workspace?.id);
    return {...result,review,errors,rows:[...companyRows,...contacts],
      columns:source.headers.map((header,index)=>({header,field:source.fields.get(source.mapping[index])??null}))};
  },{isolationLevel:'repeatable read'});
}

export async function commitPortablePairedImport(db:PostgresJsDatabase,actorId:string,input:RecordImportCommit){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(403,'Open your own workspace to import records.');
    const requestHash=await sha256(JSON.stringify(['paired-csv-v1',input.csv,input.mapping??null,input.review]));
    const [receipt]=await tx.select().from(contactImportReceipts)
      .where(and(eq(contactImportReceipts.workspaceId,workspaceId),eq(contactImportReceipts.requestId,input.requestId)));
    if(receipt){
      if(receipt.requestHash!==requestHash)throw new ApiError(409,'This request ID was already used for a different import.');
      return {result:receipt.result,replayed:true};
    }
    const {plan,existing,result,review,errors}=await reviewPairedRows(tx,actorId,workspaceId,input.csv,input.mapping);
    if(review!==input.review)throw new ApiError(409,'The CSV or its Company matches changed. Review the import again.');
    if(errors||!result.created)throw new ApiError(400,'Correct the CSV and review at least one new record before importing.');
    const createdCompanies=result.paired.companies?await insertRows(tx,workspaceId,actorId,plan.companyRows):undefined;
    if(result.paired.contacts){
      plan.contactRows.rows=plan.contactRows.rows.map(row=>{
        const target=plan.links.get(row.row-2);
        if(row.state!=='create'||target===undefined)return row;
        const company=plan.companyRows.rows[target];
        const match=company.state==='create'?{id:createdCompanies?.get(company.row),name:company.data.name}:existing.get(company.row);
        if(!match?.id)throw new ApiError(409,'A primary company could not be matched. Review the import again.');
        return {...row,data:{...row.data,importCompany:{id:match.id,name:match.name}}};
      });
      await insertRows(tx,workspaceId,actorId,plan.contactRows);
    }
    await tx.insert(contactImportReceipts).values({workspaceId,requestId:input.requestId,requestHash,result,createdAt:new Date().toISOString()});
    return {result,replayed:false};
  });
}
