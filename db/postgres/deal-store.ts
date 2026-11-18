import {listDealStageCustomFields,mergePortableCustomValues} from './custom-property-store';
import {and,asc,count,eq,gt,ilike,sql} from 'drizzle-orm';
import {unionAll} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {DealRecord,DealStageTotals,DealWrite,PortableDealLane,PortableRecordQuery} from '../../lib/portable-records';
import {stages} from '../../lib/crm';
import {builtinPipeline,missingPortableDealStageFields,type DealPipeline,type MissingDealStageField} from '../../lib/portable-deal-pipelines';
import type {StagePropertyItems} from '../../lib/stage-property-rules';
import {dealPipelines,dealPipelineStages} from './deal-pipeline-schema';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {activeDeal} from './deal-visibility';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {dealEvents,dealPipelineScope,deals} from './deal-schema';
import {privateWorkspaces} from './workspace-schema';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {lockRecordWorkspace} from './private-workspace-store';
import {resolvePortableRecordOwner} from './workspace-assignee-store';
import {captureWorkflowEntry} from './workflow-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {recordOwnerFilter,recordSearchPattern} from './record-search';

const columns={id:deals.id,revision:deals.revision,data:deals.data,createdAt:deals.createdAt,updatedAt:deals.updatedAt,
  companyId:deals.companyId,primaryContactId:deals.primaryContactId,pipelineId:deals.pipelineId,stageId:deals.stageId};
const companyName=sql<string|null>`${companies.data}->>'name'`;
const primaryContactName=sql<string|null>`${contacts.data}->>'name'`;

function dealSelection(db:PostgresJsDatabase){
  return db.select({...columns,companyId:sql<string|null>`${companies.id}`,primaryContactId:sql<string|null>`${contacts.id}`,companyName,primaryContactName,
    pipelineName:sql<string>`coalesce(${dealPipelines.name},${builtinPipeline.name})`,
    stageName:sql<string>`coalesce(${dealPipelineStages.name},${deals.data}->>'stage')`}).from(deals)
    .innerJoin(privateWorkspaces,eq(deals.workspaceId,privateWorkspaces.id))
    .leftJoin(companies,and(eq(companies.workspaceId,deals.workspaceId),eq(companies.id,deals.companyId),activeCompany))
    .leftJoin(contacts,and(eq(contacts.workspaceId,deals.workspaceId),eq(contacts.id,deals.primaryContactId),activeContact))
    .leftJoin(dealPipelines,and(eq(dealPipelines.workspaceId,deals.workspaceId),eq(dealPipelines.id,deals.pipelineId)))
    .leftJoin(dealPipelineStages,and(eq(dealPipelineStages.workspaceId,deals.workspaceId),
      eq(dealPipelineStages.pipelineId,deals.pipelineId),eq(dealPipelineStages.id,deals.stageId)));
}

function dealStageScope(pipelineId?:string,stageId?:string){
  const custom=pipelineId==='default'?undefined:pipelineId;
  const pipeline=pipelineId||stageId?dealPipelineScope(pipelineId||'default'):undefined;
  const stage=stageId?(custom?eq(deals.stageId,stageId):sql`${deals.data}->>'stage'=${stageId}`):undefined;
  return and(pipeline,stage);
}

function dealCloseScope(closeMonth?:string){
  if(!closeMonth)return undefined;
  const closeDate=sql`${deals.data}->>'closeDate'`;
  return closeMonth==='undated'?sql`coalesce(${closeDate},'')=''`:sql`left(${closeDate},7)=${closeMonth}`;
}

type DealFilters=Pick<PortableRecordQuery,'search'|'owner'|'closeMonth'>;

function dealFilters(db:PostgresJsDatabase,actorId:string,filters:DealFilters){
  const pattern=recordSearchPattern(filters.search);
  return and(pattern?ilike(sql`${deals.data}->>'name'`,pattern):undefined,
    recordOwnerFilter(db,deals.data,actorId,filters.owner),dealCloseScope(filters.closeMonth));
}

export function readDealSummary(db:PostgresJsDatabase,actorId:string,pipeline:DealPipeline,closeMonth?:string,workspaceId?:string):Promise<DealStageTotals[]>{
  const stageId=sql<string|null>`coalesce(${deals.stageId}::text,${deals.data}->>'stage')`;
  const amount=sql`(${deals.data}->>'amount')::numeric`;
  const weights=pipeline.stages.map(({id,outcome,probability})=>({id,outcome,probability}));
  return db.select({stageId,dealCount:count(),amount:sql<`${number}`>`coalesce(sum(${amount}),0)::text`,
    weightedOpen:sql<`${number}`>`round(coalesce(sum(${amount} * stage_weight.probability / 100)
      FILTER (WHERE stage_weight.outcome='open'),0),2)::text`})
    .from(deals).innerJoin(privateWorkspaces,eq(deals.workspaceId,privateWorkspaces.id))
    .leftJoin(sql`jsonb_to_recordset(${JSON.stringify(weights)}::jsonb) AS stage_weight(id text, outcome text, probability integer)`,
      sql`stage_weight.id=${stageId}`)
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),activeDeal,dealStageScope(pipeline.id),dealCloseScope(closeMonth)))
    .groupBy(sql`rollup(${stageId})`);
}

export async function readDeals(db:PostgresJsDatabase,actorId:string,query:Pick<PortableRecordQuery,'id'|'after'|'limit'|'search'|'owner'|'stage'|'pipelineId'|'closeMonth'|'workspaceId'|'companyId'|'primaryContactId'>){
  const scope=and(recordWorkspaceScope(db,actorId,query.workspaceId),activeDeal);
  const owned=dealSelection(db);
  if(query.id){
    const [record]=await owned.where(and(scope,eq(deals.id,query.id))).limit(1);
    return record??null;
  }
  const rows=await owned.where(and(scope,dealFilters(db,actorId,query),dealStageScope(query.pipelineId,query.stage),
    query.companyId?eq(companies.id,query.companyId):undefined,
    query.primaryContactId?eq(contacts.id,query.primaryContactId):undefined,query.after?gt(deals.id,query.after):undefined))
    .orderBy(asc(deals.id)).limit(query.limit+1);
  const records=rows.slice(0,query.limit);
  return {records,next:rows.length>query.limit?records.at(-1)!.id:null};
}

const cardsPerStage=8;

export async function readDealBoard(db:PostgresJsDatabase,actorId:string,pipeline:DealPipeline,filters:DealFilters&{workspaceId?:string}):Promise<PortableDealLane[]>{
  const scope=and(recordWorkspaceScope(db,actorId,filters.workspaceId),activeDeal,dealFilters(db,actorId,filters));
  const [first,second,...rest]=pipeline.stages.map(stage=>dealSelection(db)
    .where(and(scope,dealStageScope(pipeline.id,stage.id))).orderBy(asc(deals.id)).limit(cardsPerStage+1));
  if(!first)return [];
  // One statement gives all stage queries the same snapshot, even while another user moves a deal.
  const rows=await (second?unionAll(first,second,...rest):first);
  const byStage=new Map<string,DealRecord[]>();
  for(const row of rows){
    const stageId=row.stageId??row.data.stage;
    const lane=byStage.get(stageId);
    if(lane)lane.push(row);
    else byStage.set(stageId,[row]);
  }
  return pipeline.stages.map(stage=>{
    const cards=byStage.get(stage.id)??[];
    cards.sort((left,right)=>left.id.localeCompare(right.id));
    return {stage,cards:cards.slice(0,cardsPerStage),more:cards.length>cardsPerStage};
  });
}

type SaveResult={record:DealRecord}|{error:'missing'|'stale'|'access'|'company_missing'|'contact_missing'|'stage_missing'|'stage_invalid'|'assignee_missing'}|
  {error:'stage_required';stageName:string;fields:MissingDealStageField[]};

export function saveDeal(db:PostgresJsDatabase,actorId:string,input:DealWrite,shared?:SharedRecordWriteScope):Promise<SaveResult>{
  return db.transaction(tx=>saveDealInTransaction(tx,actorId,input,shared));
}

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export async function saveDealInTransaction(tx:Transaction,actorId:string,input:DealWrite,shared?:SharedRecordWriteScope,
  {captureWorkflows=true}:{captureWorkflows?:boolean}={}):Promise<SaveResult>{
  const creating=!('id' in input);
  const workspaceId=await lockRecordWorkspace(tx,actorId,creating&&!input.companyId&&!input.primaryContactId&&!input.pipelineId,shared,undefined,true);
  if(!workspaceId)return {error:shared?'access':creating?(input.pipelineId?'stage_missing':input.companyId?'company_missing':'contact_missing'):'missing'};
  const target='id' in input?and(eq(deals.workspaceId,workspaceId),eq(deals.id,input.id),activeDeal):undefined;
  const current=target?(await tx.select(columns).from(deals).where(target).for('update'))[0]:undefined;
  if('id' in input){
    if(!current)return {error:'missing'};
    if(current.revision!==input.expectedRevision)return {error:'stale'};
  }
  const pipelineId=input.pipelineId===undefined?current?.pipelineId??null:input.pipelineId;
  const stageId=input.stageId===undefined?current?.stageId??null:input.stageId;
  if(!!pipelineId!==!!stageId)return {error:'stage_invalid'};
  let pipelineName=builtinPipeline.name,stageName=input.data.stage;
  let requiredProperties:StagePropertyItems|undefined;
  if(pipelineId&&stageId){
    const [stage]=await tx.select({pipelineName:dealPipelines.name,stageName:dealPipelineStages.name,
      requiredProperties:dealPipelineStages.requiredProperties}).from(dealPipelineStages)
      .innerJoin(dealPipelines,and(eq(dealPipelines.workspaceId,dealPipelineStages.workspaceId),eq(dealPipelines.id,dealPipelineStages.pipelineId)))
      .where(and(eq(dealPipelineStages.workspaceId,workspaceId),eq(dealPipelineStages.pipelineId,pipelineId),eq(dealPipelineStages.id,stageId)));
    if(!stage)return {error:'stage_missing'};
    ({pipelineName,stageName,requiredProperties}=stage);
  }else if(!stages.some(stage=>stage===stageName))return {error:'stage_invalid'};
  const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.companyId);
  if(!company)return {error:'company_missing'};
  const companyId=company.id;
  const contact=await resolvePortableContactLink(tx,workspaceId,current?.primaryContactId??null,input.primaryContactId);
  if(!contact)return {error:'contact_missing'};
  const primaryContactId=contact.id;
  const recordOwner=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId,current?.data.recordOwner);
  if(recordOwner===false)return {error:'assignee_missing'};
  const now=new Date().toISOString();
  const {custom,...patch}=input.data;
  const customValues=await mergePortableCustomValues(tx,workspaceId,'deals',custom,current?.data.custom);
  const values={data:{...current?.data,...patch,recordOwner,stage:stageName,custom:customValues},companyId,primaryContactId,pipelineId,stageId,updatedAt:now};
  const sameStage=current&&current.pipelineId===pipelineId&&(current.stageId??current.data.stage)===(stageId??stageName);
  const stageCustomFields=requiredProperties?await listDealStageCustomFields(tx,workspaceId,requiredProperties):[];
  const missing=missingPortableDealStageFields(requiredProperties,values.data,sameStage?current.data:undefined,stageCustomFields);
  if(missing.length)return {error:'stage_required',stageName,fields:missing};
  const [saved]=current
    ?await tx.update(deals).set({...values,revision:current.revision+1}).where(target).returning(columns)
    :await tx.insert(deals).values({...values,workspaceId,id:crypto.randomUUID(),revision:1,createdAt:now}).returning(columns);
  await tx.insert(dealEvents).values({
    workspaceId,dealId:saved.id,revision:saved.revision,actorId,previous:current?.data??null,data:saved.data,
    previousPipelineId:current?.pipelineId??null,pipelineId,previousStageId:current?.stageId??null,stageId,
    previousCompanyId:current?.companyId??null,companyId,
    previousPrimaryContactId:current?.primaryContactId??null,primaryContactId,occurredAt:saved.updatedAt,
  });
  const stageKey=stageId??stageName;
  if(captureWorkflows&&current&&(current.pipelineId!==pipelineId||(current.stageId??current.data.stage)!==stageKey)){
    await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'deal',id:saved.id,revision:saved.revision,
      pipelineId:pipelineId??'default',stageId:stageKey,primaryContactId:contact.visibleId,lifecycle:contact.lifecycle});
  }
  return {record:{...saved,companyId:company.visibleId,companyName:company.name,primaryContactId:contact.visibleId,primaryContactName:contact.name,pipelineName,stageName}};
}
