import {and,eq,inArray} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {stages} from '../../lib/crm';
import {missingDealStageMessage} from '../../lib/portable-deal-pipelines';
import {portableBulkExcludedFields,type PortableRecordOwnerBatch,type PortableRecordOwnerResult,type PortableRecordPropertyBatch} from '../../lib/portable-record-bulk';
import {portableCompanyFields,portableContactFields,portableDealFields,type CompanyWrite,type ContactWrite,type DealWrite} from '../../lib/portable-records';
import {saveCompany} from './company-store';
import {saveContact} from './contact-store';
import {readPortableCustomDefinition} from './custom-property-store';
import {saveDealInTransaction} from './deal-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {companyEvents,companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {contactEvents,contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {dealEvents,deals} from './deal-schema';
import {activeDeal} from './deal-visibility';
import {lockRecordWorkspace} from './private-workspace-store';
import {resolvePortableRecordOwner} from './workspace-assignee-store';
import {captureWorkflowEntry} from './workflow-store';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Owner=Awaited<ReturnType<typeof resolvePortableRecordOwner>>;

// All selected records change together or none do. Each changed record gains
// an attributed revision, so an older editor can't restore the former owner.
export function assignPortableRecordOwners(db:PostgresJsDatabase,actorId:string,input:PortableRecordOwnerBatch,
  shared?:SharedRecordWriteScope):Promise<PortableRecordOwnerResult>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)return {error:shared?'access':'records_missing'};
    const owner=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId);
    if(owner===false)return {error:'assignee_missing'};
    const requested=new Map(input.records.map(row=>[row.id,row.expectedRevision]));
    const ids=[...requested.keys()],now=new Date().toISOString();
    const write=input.kind==='contacts'?assignContacts:input.kind==='companies'?assignCompanies:assignDeals;
    return write(tx,workspaceId,actorId,ids,requested,owner,now);
  });
}

function changes<T extends {id:string;revision:number;data:{recordOwner?:{userId:string}}}>(rows:T[],requested:Map<string,number>,owner:Owner):
  {error:'records_missing'|'records_stale'}|{pending:T[]}{
  if(rows.length!==requested.size)return {error:'records_missing'};
  if(rows.some(row=>row.revision!==requested.get(row.id)))return {error:'records_stale'};
  return {pending:rows.filter(row=>row.data.recordOwner?.userId!==(owner||undefined)?.userId)};
}
const withOwner=<T extends {recordOwner?:unknown}>(data:T,owner:Owner):T=>{
  const next={...data};
  delete next.recordOwner;
  return owner?{...next,recordOwner:owner}:next;
};

async function assignContacts(tx:Tx,workspaceId:string,actorId:string,ids:string[],requested:Map<string,number>,owner:Owner,now:string){
  const scope=and(eq(contacts.workspaceId,workspaceId),activeContact);
  const result=changes(await tx.select().from(contacts).where(and(scope,inArray(contacts.id,ids))).for('update'),requested,owner);
  if(!('pending' in result))return result;
  for(const row of result.pending){
    const data=withOwner(row.data,owner),revision=row.revision+1;
    await tx.update(contacts).set({data,revision,updatedAt:now}).where(and(scope,eq(contacts.id,row.id)));
    await tx.insert(contactEvents).values({workspaceId,contactId:row.id,revision,actorId,previous:row.data,data,
      previousPrimaryCompanyId:row.primaryCompanyId,primaryCompanyId:row.primaryCompanyId,occurredAt:now});
    // Same trigger as a single Contact save that assigns a new owner.
    if(owner)await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'contact_owner_assigned',id:row.id,revision,lifecycle:data.lifecycle});
  }
  return {changed:result.pending.length};
}

async function assignCompanies(tx:Tx,workspaceId:string,actorId:string,ids:string[],requested:Map<string,number>,owner:Owner,now:string){
  const scope=and(eq(companies.workspaceId,workspaceId),activeCompany);
  const result=changes(await tx.select().from(companies).where(and(scope,inArray(companies.id,ids))).for('update'),requested,owner);
  if(!('pending' in result))return result;
  for(const row of result.pending){
    const data=withOwner(row.data,owner),revision=row.revision+1;
    await tx.update(companies).set({data,revision,updatedAt:now}).where(and(scope,eq(companies.id,row.id)));
    await tx.insert(companyEvents).values({workspaceId,companyId:row.id,revision,actorId,previous:row.data,data,occurredAt:now});
  }
  return {changed:result.pending.length};
}

async function assignDeals(tx:Tx,workspaceId:string,actorId:string,ids:string[],requested:Map<string,number>,owner:Owner,now:string){
  const scope=and(eq(deals.workspaceId,workspaceId),activeDeal);
  const result=changes(await tx.select().from(deals).where(and(scope,inArray(deals.id,ids))).for('update'),requested,owner);
  if(!('pending' in result))return result;
  for(const row of result.pending){
    const data=withOwner(row.data,owner),revision=row.revision+1;
    await tx.update(deals).set({data,revision,updatedAt:now}).where(and(scope,eq(deals.id,row.id)));
    await tx.insert(dealEvents).values({workspaceId,dealId:row.id,revision,actorId,previous:row.data,data,
      previousPipelineId:row.pipelineId,pipelineId:row.pipelineId,previousStageId:row.stageId,stageId:row.stageId,
      previousCompanyId:row.companyId,companyId:row.companyId,
      previousPrimaryContactId:row.primaryContactId,primaryContactId:row.primaryContactId,occurredAt:now});
  }
  return {changed:result.pending.length};
}

// Bulk property edits replay the ordinary single-record save for each selected
// row inside one transaction, so validation, history, retained links and deal
// stage rules match a normal save. Any failure rolls back every row.
const standardSchemas={contacts:portableContactFields,companies:portableCompanyFields,deals:portableDealFields};
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bulkFailure=(name:string,message:string,status=400)=>new ApiError(status,`No records were updated. ${name}: ${message}`);
type SaveFailure={error:string;stageName?:string;fields?:Parameters<typeof missingDealStageMessage>[1]};
function dealFailure(name:string,result:SaveFailure){
  if(result.error==='stage_required')return bulkFailure(name,missingDealStageMessage(result.stageName!,result.fields!));
  if(result.error==='stage_missing'||result.error==='stage_invalid')return bulkFailure(name,'Choose a stage in this deal’s pipeline.');
  if(result.error==='access')return new ApiError(403,'You no longer have edit access for this workspace. Refresh before trying again.');
  if(result.error==='missing')return bulkFailure(name,'This record is no longer available.',404);
  if(result.error==='stale')return bulkFailure(name,'This record changed. Refresh and select again.',409);
  return bulkFailure(name,'Check this record and try again.',409);
}

function standardValue(kind:PortableRecordPropertyBatch['kind'],field:string,mode:PortableRecordPropertyBatch['mode'],value:unknown){
  const schema=(standardSchemas[kind].shape as Record<string,z.ZodTypeAny>)[field];
  // A cleared value is stored the way the record editor stores an emptied field.
  const candidates=mode==='clear'?['',null]:[value];
  for(const candidate of candidates){
    const parsed=schema.safeParse(candidate);
    if(parsed.success&&(mode==='clear'||parsed.data!==undefined))return parsed.data;
  }
  throw new ApiError(400,mode==='clear'?'This property can’t be cleared.':'Enter a valid value for this property.');
}

function pipelineTarget(mode:PortableRecordPropertyBatch['mode'],value:unknown){
  const [pipeline,stage,...rest]=typeof value==='string'?value.split('/'):[];
  const valid=mode==='replace'&&!rest.length&&!!stage&&(pipeline==='default'?(stages as readonly string[]).includes(stage):
    uuidPattern.test(pipeline??'')&&uuidPattern.test(stage));
  if(!valid)throw new ApiError(400,'Choose the pipeline and stage to move the selected deals to.');
  return pipeline==='default'?{pipelineId:null,stage}:{pipelineId:pipeline!.toLowerCase(),stage:stage.toLowerCase()};
}

function customListValue(previous:unknown,mode:'append'|'remove',value:unknown){
  if(!Array.isArray(value)||!value.length||value.some(option=>typeof option!=='string'))throw new ApiError(400,'Choose options to add or remove.');
  const current=Array.isArray(previous)?previous.filter((option):option is string=>typeof option==='string'):[];
  return mode==='append'?[...new Set([...current,...value])]:current.filter(option=>!value.includes(option));
}

export function editPortableRecordProperty(db:PostgresJsDatabase,actorId:string,input:PortableRecordPropertyBatch,
  shared?:SharedRecordWriteScope):Promise<{changed:number}>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)throw shared?new ApiError(403,'You no longer have edit access for this workspace. Refresh before trying again.'):
      new ApiError(404,'Some selected records are no longer available. Refresh and select again.');
    const {kind,field,mode}=input;
    const customId=field.startsWith('custom:')?field.slice(7):undefined;
    const definition=customId?await readPortableCustomDefinition(tx,workspaceId,kind,customId):undefined;
    // Deals can also move to a stage in another pipeline: value "<pipeline>/<stage>".
    const pipelineMove=kind==='deals'&&field==='pipeline';
    if(customId?!definition:!pipelineMove&&((portableBulkExcludedFields[kind] as readonly string[]).includes(field)||!Object.hasOwn(standardSchemas[kind].shape,field))){
      throw new ApiError(400,'Choose a property that can be edited in bulk.');
    }
    if((mode==='append'||mode==='remove')&&definition?.type!=='multiselect'){
      throw new ApiError(400,'Add and remove are only available for multiple-choice properties.');
    }
    const stageMove=kind==='deals'&&field==='stage';
    if(stageMove&&(mode!=='replace'||typeof input.value!=='string'||!input.value))throw new ApiError(400,'Choose the stage to move the selected deals to.');
    const target=pipelineMove?pipelineTarget(mode,input.value):undefined;
    const fixed=customId||stageMove||pipelineMove?undefined:standardValue(kind,field,mode,input.value);
    const table={contacts,companies,deals}[kind],active={contacts:activeContact,companies:activeCompany,deals:activeDeal}[kind];
    const requested=new Map(input.records.map(row=>[row.id,row.expectedRevision]));
    const rows=await tx.select({id:table.id,revision:table.revision,data:table.data}).from(table)
      .where(and(eq(table.workspaceId,workspaceId),active,inArray(table.id,[...requested.keys()]))).for('update');
    if(rows.length!==requested.size)throw new ApiError(404,'Some selected records are no longer available. Refresh and select again.');
    if(rows.some(row=>row.revision!==requested.get(row.id)))throw new ApiError(409,'Some selected records changed. Refresh and select again. No records were updated.');
    const placement=new Map<string,{pipelineId:string|null;stageId:string|null}>();
    let targetStage:string|undefined;
    if(stageMove){
      for(const row of await tx.select({id:deals.id,pipelineId:deals.pipelineId,stageId:deals.stageId}).from(deals)
        .where(and(eq(deals.workspaceId,workspaceId),inArray(deals.id,[...requested.keys()]))))placement.set(row.id,row);
      if(new Set([...placement.values()].map(row=>row.pipelineId)).size>1)throw new ApiError(400,'Selected deals belong to different pipelines. Filter to one pipeline before moving their stage.');
      // Custom stages are UUIDs and built-in stages are names; check the shape before it reaches a UUID column.
      const custom=[...placement.values()][0]?.pipelineId;
      const requestedStage=input.value as string;
      if(custom?!uuidPattern.test(requestedStage):!(stages as readonly string[]).includes(requestedStage)){
        throw new ApiError(400,'Choose a stage in the selected deals’ pipeline.');
      }
      targetStage=custom?requestedStage.toLowerCase():requestedStage;
    }
    // Native shared edits capture workflows, while private bulk property edits only save records.
    const workflowOptions={captureWorkflows:!!shared};
    // A nested transaction is a savepoint inside this one.
    const nested=tx as unknown as PostgresJsDatabase;
    let changed=0;
    if(pipelineMove){
      for(const row of await tx.select({id:deals.id,pipelineId:deals.pipelineId,stageId:deals.stageId}).from(deals)
        .where(and(eq(deals.workspaceId,workspaceId),inArray(deals.id,[...requested.keys()]))))placement.set(row.id,row);
    }
    for(const row of rows){
      if(target){
        const {pipelineId,stageId}=placement.get(row.id)!,stage=(row.data as {stage:string}).stage;
        if(pipelineId===target.pipelineId&&(pipelineId?stageId:stage)===target.stage)continue;
        // Built-in deals store the stage name; custom-pipeline deals store the stage ID.
        const result=await saveDealInTransaction(tx,actorId,{action:'save',kind:'deals',id:row.id,expectedRevision:row.revision,
          data:{stage:target.pipelineId?stage:target.stage},pipelineId:target.pipelineId,stageId:target.pipelineId?target.stage:null} as DealWrite,shared,workflowOptions);
        if('error' in result)throw dealFailure(String(row.data.name||row.id),result);
        changed++;
        continue;
      }
      if(targetStage!==undefined){
        const {pipelineId,stageId}=placement.get(row.id)!;
        // Built-in deals store the stage name; custom-pipeline deals store the stage ID.
        if((pipelineId?stageId:(row.data as {stage:string}).stage)===targetStage)continue;
        const result=await saveDealInTransaction(tx,actorId,{action:'save',kind:'deals',id:row.id,expectedRevision:row.revision,
          data:{stage:pipelineId?(row.data as {stage:string}).stage:targetStage},...(pipelineId?{pipelineId,stageId:targetStage}:{})} as DealWrite,shared,workflowOptions);
        if('error' in result)throw dealFailure(String(row.data.name||row.id),result);
        changed++;
        continue;
      }
      const previous=customId?row.data.custom?.[customId]:(row.data as Record<string,unknown>)[field];
      const next=customId?mode==='clear'?null:mode==='replace'?input.value:customListValue(previous,mode,input.value):fixed;
      if(JSON.stringify(previous??null)===JSON.stringify(next??null))continue;
      const data:Record<string,unknown>=customId?{custom:{[customId]:next}}:{[field]:next};
      const base={action:'save' as const,id:row.id,expectedRevision:row.revision};
      const result=kind==='contacts'?await saveContact(nested,actorId,{...base,kind,data} as ContactWrite,shared,workflowOptions):
        kind==='companies'?await saveCompany(nested,actorId,{...base,kind,data} as CompanyWrite,shared):
        // Keep each deal in its current stage; the stage field itself isn't bulk-editable.
        await saveDealInTransaction(tx,actorId,{...base,kind,data:{...data,stage:(row.data as {stage:string}).stage}} as DealWrite,shared,workflowOptions);
      if('error' in result)throw dealFailure(String(row.data.name||row.id),result);
      changed++;
    }
    return {changed};
  });
}
