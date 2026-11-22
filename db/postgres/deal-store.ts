import {canChangePrimaryLink} from './primary-link-access';
import {ApiError} from '../../lib/api-error';
import {canMovePortableDeal,hiddenStandardFields} from './standard-property-access';
import {checkFieldWrite,redactRecord,visibleRecordData} from './record-property-access';
import {portableStageCustomId} from '../../lib/portable-deal-pipelines';
import {samePropertyValue} from '../../lib/property-values';
import {ownedRecordScope,sharedCoreRecordScope} from './record-ownership-scope';
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
import {workspaceViewers} from './workspace-viewer-schema';
import {workspaceTeams} from './workspace-team-schema';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {lockRecordWorkspace} from './private-workspace-store';
import {resolveCoreRecordOwner} from './workspace-assignee-store';
import {captureWorkflowEntry} from './workflow-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {recordOwnerFilter,recordSearchPattern} from './record-search';

const columns={id:deals.id,revision:deals.revision,data:deals.data,createdAt:deals.createdAt,updatedAt:deals.updatedAt,
  companyId:deals.companyId,primaryContactId:deals.primaryContactId,pipelineId:deals.pipelineId,stageId:deals.stageId};
const companyName=sql<string|null>`${companies.data}->>'name'`;
const primaryContactName=sql<string|null>`${contacts.data}->>'name'`;

function dealSelection(db:PostgresJsDatabase,actorId:string,workspaceId?:string,external=false){
  const data=workspaceId?visibleRecordData(deals.data,workspaceId,'deals',actorId):external?visibleRecordData(deals.data,deals.workspaceId,'deals',null):deals.data;
  return db.select({...columns,data,companyId:sql<string|null>`${companies.id}`,primaryContactId:sql<string|null>`${contacts.id}`,companyName,primaryContactName,
    pipelineName:sql<string>`coalesce(${dealPipelines.name},${builtinPipeline.name})`,
    stageName:sql<string>`coalesce(${dealPipelineStages.name},${deals.data}->>'stage')`}).from(deals)
    .innerJoin(privateWorkspaces,eq(deals.workspaceId,privateWorkspaces.id))
    .leftJoin(companies,and(eq(companies.workspaceId,deals.workspaceId),eq(companies.id,deals.companyId),activeCompany,sharedCoreRecordScope(db,actorId,workspaceId,companies)))
    .leftJoin(contacts,and(eq(contacts.workspaceId,deals.workspaceId),eq(contacts.id,deals.primaryContactId),activeContact,sharedCoreRecordScope(db,actorId,workspaceId,contacts)))
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

function dealCloseScope(closeMonth:string|string[]|undefined,workspaceId:string|undefined,actorId:string){
  if(!closeMonth)return undefined;
  const closeDate=sql`${deals.data}->>'closeDate'`;
  const visible=workspaceId?sql`'closeDate' NOT IN (${hiddenStandardFields(workspaceId,'deals',actorId)})`:undefined;
  if(Array.isArray(closeMonth))return and(visible,sql`left(${closeDate},7) IN (${sql.join(closeMonth.map(month=>sql`${month}`),sql`, `)})`);
  return and(visible,closeMonth==='undated'?sql`coalesce(${closeDate},'')=''`:sql`left(${closeDate},7)=${closeMonth}`);
}

type DealFilters=Pick<PortableRecordQuery,'search'|'owner'|'closeMonth'|'workspaceId'>;

function dealFilters(db:PostgresJsDatabase,actorId:string,filters:DealFilters){
  const pattern=recordSearchPattern(filters.search);
  return and(pattern?ilike(sql`${deals.data}->>'name'`,pattern):undefined,
    recordOwnerFilter(db,deals.data,actorId,filters.owner),dealCloseScope(filters.closeMonth,filters.workspaceId,actorId));
}

export function readDealSummary(db:PostgresJsDatabase,actorId:string,pipeline:DealPipeline,closeMonth?:string|string[],workspaceId?:string,owner?:PortableRecordQuery['owner'],forecastOwnerIds?:string[]):Promise<(DealStageTotals & {ownerBucket?:string|null;teamBucket?:string|null;teamName?:string|null})[]>{
  const stageId=sql<string|null>`coalesce(${deals.stageId}::text,${deals.data}->>'stage')`;
  const amount=sql`(${deals.data}->>'amount')::numeric`;
  const showAmount=workspaceId?sql`'amount' NOT IN (${hiddenStandardFields(workspaceId,'deals',actorId)})`:sql`true`;
  const month=sql<string|null>`left(${deals.data}->>'closeDate',7)`;
  const byMonth=Array.isArray(closeMonth);
  const weights=pipeline.stages.map(({id,outcome,probability})=>({id,outcome,probability}));
  const assignee=sql`${deals.data}->'recordOwner'->>'userId'`;
  const ownerBucket=sql<string|null>`CASE WHEN ${assignee} IS NULL THEN 'unassigned' ELSE coalesce(forecast_owner.id,'unavailable') END`;
  const teamBucket=sql<string|null>`CASE WHEN ${assignee} IS NULL THEN 'unassigned' WHEN forecast_owner.id IS NULL THEN 'unavailable'
    ELSE coalesce(${workspaceTeams.id}::text,'no-team') END`;
  const query=db.select({stageId,...(forecastOwnerIds?{ownerBucket,teamBucket,teamName:workspaceTeams.name}:{}),...(byMonth?{month}:{}),dealCount:count(),amount:sql<`${number}`|null>`CASE WHEN ${showAmount} THEN coalesce(sum(${amount}),0)::text END`,
    wonAmount:sql<`${number}`|null>`CASE WHEN ${showAmount} THEN round(coalesce(sum(${amount}) FILTER (WHERE stage_weight.outcome='won'),0),2)::text END`,
    weightedOpen:sql<`${number}`|null>`CASE WHEN ${showAmount} THEN round(coalesce(sum(${amount} * stage_weight.probability / 100)
      FILTER (WHERE stage_weight.outcome='open'),0),2)::text END`})
    .from(deals).innerJoin(privateWorkspaces,eq(deals.workspaceId,privateWorkspaces.id))
    .leftJoin(sql`jsonb_to_recordset(${JSON.stringify(weights)}::jsonb) AS stage_weight(id text, outcome text, probability integer)`,
      sql`stage_weight.id=${stageId}`).$dynamic();
  if(forecastOwnerIds)query.leftJoin(sql`jsonb_array_elements_text(${JSON.stringify(forecastOwnerIds)}::jsonb) AS forecast_owner(id)`,sql`forecast_owner.id=${assignee}`)
    .leftJoin(workspaceViewers,and(eq(workspaceViewers.workspaceId,deals.workspaceId),eq(workspaceViewers.viewerId,sql`forecast_owner.id`)))
    .leftJoin(workspaceTeams,and(eq(workspaceTeams.workspaceId,deals.workspaceId),eq(workspaceTeams.id,workspaceViewers.teamId)));
  const groups=[sql`()`,sql`(${stageId})`];
  if(byMonth)groups.push(sql`(${stageId},${month})`);
  // Sum the underlying deal amounts before rounding each team's weighted pipeline.
  if(forecastOwnerIds)groups.push(sql`(${ownerBucket},${teamBucket},${workspaceTeams.name})`,sql`(${teamBucket},${workspaceTeams.name})`);
  return query.where(and(sharedCoreRecordScope(db,actorId,workspaceId,deals)??recordWorkspaceScope(db,actorId,workspaceId),activeDeal,dealStageScope(pipeline.id),dealCloseScope(closeMonth,workspaceId,actorId),recordOwnerFilter(db,deals.data,actorId,owner)))
    .groupBy(sql`GROUPING SETS (${sql.join(groups,sql`, `)})`);
}

export async function readDeals(db:PostgresJsDatabase,actorId:string,query:Pick<PortableRecordQuery,'id'|'after'|'limit'|'search'|'owner'|'stage'|'pipelineId'|'closeMonth'|'workspaceId'|'companyId'|'primaryContactId'>,external=false){
  const scope=and(sharedCoreRecordScope(db,actorId,query.workspaceId,deals)??recordWorkspaceScope(db,actorId,query.workspaceId),activeDeal);
  const owned=dealSelection(db,actorId,query.workspaceId,external);
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

export async function readDealBoard(db:PostgresJsDatabase,actorId:string,pipeline:DealPipeline,filters:DealFilters):Promise<PortableDealLane[]>{
  const scope=and(sharedCoreRecordScope(db,actorId,filters.workspaceId,deals)??recordWorkspaceScope(db,actorId,filters.workspaceId),activeDeal,dealFilters(db,actorId,filters));
  const [first,second,...rest]=pipeline.stages.map(stage=>dealSelection(db,actorId,filters.workspaceId)
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

type DealSaveOptions={captureWorkflows?:boolean;createId?:string;hiddenFields?:Set<string>};

export function saveDeal(db:PostgresJsDatabase,actorId:string,input:DealWrite,shared?:SharedRecordWriteScope,options?:DealSaveOptions):Promise<SaveResult>{
  return db.transaction(tx=>saveDealInTransaction(tx,actorId,input,shared,options));
}

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export async function saveDealInTransaction(tx:Transaction,actorId:string,input:DealWrite,shared?:SharedRecordWriteScope,
  {captureWorkflows=true,createId,hiddenFields}:DealSaveOptions={}):Promise<SaveResult>{
  const creating=!('id' in input);
  const workspaceId=await lockRecordWorkspace(tx,actorId,creating&&!input.companyId&&!input.primaryContactId&&!input.pipelineId,shared,undefined,true,true,['deals','id' in input?'edit':'create']);
  if(!workspaceId)return {error:shared?'access':creating?(input.pipelineId?'stage_missing':input.companyId?'company_missing':'contact_missing'):'missing'};
  const target='id' in input?and(eq(deals.workspaceId,workspaceId),eq(deals.id,input.id),activeDeal,
      shared?ownedRecordScope(tx,actorId,workspaceId,deals,'edit'):undefined):undefined;
  const current=target?(await tx.select(columns).from(deals).where(target).for('update'))[0]:undefined;
  if('id' in input){
    if(!current)return {error:'missing'};
    if(current.revision!==input.expectedRevision)return {error:'stale'};
  }
  const pipelineId=input.pipelineId===undefined?current?.pipelineId??null:input.pipelineId;
  const stageId=input.stageId===undefined?current?.stageId??null:input.stageId;
  if(!!pipelineId!==!!stageId)return {error:'stage_invalid'};
  let pipelineName=builtinPipeline.name,stageName=input.data.stage??(current&&!current.pipelineId?current.data.stage:stages[0]);
  let entryStage=stageName===stages[0];
  let requiredProperties:StagePropertyItems|undefined;
  if(pipelineId&&stageId){
    const [stage]=await tx.select({pipelineName:dealPipelines.name,stageName:dealPipelineStages.name,
      position:dealPipelineStages.position,requiredProperties:dealPipelineStages.requiredProperties}).from(dealPipelineStages)
      .innerJoin(dealPipelines,and(eq(dealPipelines.workspaceId,dealPipelineStages.workspaceId),eq(dealPipelines.id,dealPipelineStages.pipelineId)))
      .where(and(eq(dealPipelineStages.workspaceId,workspaceId),eq(dealPipelineStages.pipelineId,pipelineId),eq(dealPipelineStages.id,stageId)));
    if(!stage)return {error:'stage_missing'};
    ({pipelineName,stageName,requiredProperties}=stage);
    entryStage=stage.position===0;
  }else if(!stages.some(stage=>stage===stageName))return {error:'stage_invalid'};
  const sameStage=current&&current.pipelineId===pipelineId&&(current.stageId??current.data.stage)===(stageId??stageName);
  if((shared||hiddenFields)&&(current?!sameStage:!entryStage)&&!await canMovePortableDeal(tx,workspaceId,shared?actorId:null))
    throw new ApiError(403,'You can create deals in the first stage, but cannot move deals between stages or pipelines.');
  if(shared&&!await canChangePrimaryLink(tx,actorId,workspaceId,companies,current?.companyId??null,input.companyId))return {error:'company_missing'};
  const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.companyId,shared?actorId:undefined);
  if(!company)return {error:'company_missing'};
  const companyId=company.id;
  if(shared&&!await canChangePrimaryLink(tx,actorId,workspaceId,contacts,current?.primaryContactId??null,input.primaryContactId))return {error:'contact_missing'};
  const contact=await resolvePortableContactLink(tx,workspaceId,current?.primaryContactId??null,input.primaryContactId,shared?actorId:undefined);
  if(!contact)return {error:'contact_missing'};
  const primaryContactId=contact.id;
  const recordOwner=await resolveCoreRecordOwner(tx,workspaceId,actorId,!!shared,'deals',input.assigneeId,current?.data.recordOwner,creating);
  if(recordOwner===false)return {error:'assignee_missing'};
  const now=new Date().toISOString();
  const {custom,...patch}=input.data;
  const hidden=shared?await checkFieldWrite(tx,workspaceId,'deals',actorId,custom,patch):hiddenFields;
  const customValues=await mergePortableCustomValues(tx,workspaceId,'deals',custom,current?.data.custom);
  const values={data:{...current?.data,...patch,closeDate:patch.closeDate??current?.data.closeDate??'',amount:patch.amount??current?.data.amount??0,recordOwner,stage:stageName,custom:customValues},companyId,primaryContactId,pipelineId,stageId,updatedAt:now};
  if(hidden&&requiredProperties?.some(rule=>rule.required&&hidden.has(portableStageCustomId(rule.field)??rule.field))){
    const requiredValue=(data:DealRecord['data'],field:string)=>{
      const id=portableStageCustomId(field);
      return id?data.custom?.[id]:data[field as keyof DealRecord['data']];
    };
    if(!sameStage||requiredProperties.some(rule=>!samePropertyValue(requiredValue(current.data,rule.field),requiredValue(values.data,rule.field))))
      throw new ApiError(403,'Ask someone with access to all required properties to make this stage change.');
  }
  const stageCustomFields=requiredProperties?await listDealStageCustomFields(tx,workspaceId,requiredProperties):[];
  const missing=missingPortableDealStageFields(requiredProperties,values.data,sameStage?current.data:undefined,stageCustomFields);
  if(missing.length)return {error:'stage_required',stageName,fields:missing};
  const [saved]=current
    ?await tx.update(deals).set({...values,revision:current.revision+1}).where(target).returning(columns)
    :await tx.insert(deals).values({...values,workspaceId,id:createId??crypto.randomUUID(),revision:1,createdAt:now}).returning(columns);
  await tx.insert(dealEvents).values({
    workspaceId,dealId:saved.id,revision:saved.revision,actorId,previous:current?.data??null,data:saved.data,
    previousPipelineId:current?.pipelineId??null,pipelineId,previousStageId:current?.stageId??null,stageId,
    previousCompanyId:current?.companyId??null,companyId,
    previousPrimaryContactId:current?.primaryContactId??null,primaryContactId,occurredAt:saved.updatedAt,
  });
  const stageKey=stageId??stageName;
  if(captureWorkflows&&current&&(current.pipelineId!==pipelineId||(current.stageId??current.data.stage)!==stageKey)){
    await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'deal',id:saved.id,revision:saved.revision,properties:saved.data,
      pipelineId:pipelineId??'default',stageId:stageKey,primaryContactId:contact.visibleId,lifecycle:contact.lifecycle});
  }

  return {record:{...redactRecord(saved,hidden),companyId:company.visibleId,companyName:company.name,primaryContactId:contact.visibleId,primaryContactName:contact.name,pipelineName,stageName}};
}
