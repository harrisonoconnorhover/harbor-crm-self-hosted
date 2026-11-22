import type {PortableApiPrimaryLinks} from '../../lib/portable-api-tokens';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {missingDealStageMessage} from '../../lib/portable-deal-pipelines';
import {portableCompanyFields,portableContactFields,portableDealFields,portableRecordWrite,type PortableRecordKind} from '../../lib/portable-records';
import {samePropertyValue} from '../../lib/property-values';
import {companies} from './company-schema';
import {saveCompany} from './company-store';
import {activeCompany} from './company-visibility';
import {contacts} from './contact-schema';
import {saveContact} from './contact-store';
import {activeContact} from './contact-visibility';
import {mergePortableCustomValues} from './custom-property-store';
import {dealPipelineStages} from './deal-pipeline-schema';
import {deals} from './deal-schema';
import {saveDeal} from './deal-store';
import {activeDeal} from './deal-visibility';
import {changePortableCompanyArchive} from './portable-company-archive-store';
import {changePortableContactArchive} from './portable-contact-archive-store';
import {changePortableDealArchive} from './portable-deal-archive-store';
import {checkFieldWrite} from './record-property-access';

const tables={contacts,companies,deals};
const active={contacts:activeContact,companies:activeCompany,deals:activeDeal};
const fields={contacts:portableContactFields.shape,companies:portableCompanyFields.shape,deals:portableDealFields.shape};
const archive={contacts:changePortableContactArchive,companies:changePortableCompanyArchive,deals:changePortableDealArchive};

// The caller owns the workspace/record lock and the token check for the whole transaction.
// The ordinary stores write the same history and workflow entries as a browser edit.
export async function mutateExternalCore(db:PostgresJsDatabase,ownerId:string,workspaceId:string,kind:PortableRecordKind,
  id:string|undefined,action:'create'|'patch'|'archive',properties:Record<string,unknown>,revision:number|undefined,primary?:PortableApiPrimaryLinks):Promise<{id:string}>{
  if(!id)throw new ApiError(400,'A record ID is required.');
  if(action!=='create'&&revision===undefined)throw new ApiError(428,'Read the record before editing.');
  if(action==='archive'){
    await archive[kind](db,ownerId,{kind,id,action,expectedRevision:revision!,requestId:crypto.randomUUID()});
    return {id};
  }
  const table=tables[kind];
  const [current]=action==='patch'?await db.select({data:table.data,revision:table.revision,
    companyId:kind==='contacts'?contacts.primaryCompanyId:kind==='deals'?deals.companyId:sql<null>`null`,
    contactId:kind==='deals'?deals.primaryContactId:sql<null>`null`}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),eq(table.id,id),active[kind])):[];
  if(action==='patch'&&!current)throw new ApiError(404,'Record not found.');
  if(current&&current.revision!==revision)throw new ApiError(412,'This record changed. Read it again.');

  const shape=fields[kind];
  for(const key of Object.keys(properties)){
    if(key!=='custom'&&!Object.hasOwn(shape,key))throw new ApiError(400,'Unknown or read-only record property.');
  }
  const hidden=await checkFieldWrite(db,workspaceId,kind,null,undefined,properties);
  // Only visible standard stored values seed a PATCH. Passing the stored custom bag to the
  // write validator could revalidate or overwrite unrelated, restricted values.
  const old:Record<string,unknown>=current?.data??{};
  const standard=Object.fromEntries(Object.entries(old).filter(([key])=>Object.hasOwn(shape,key)&&!hidden.has(key)));
  const parsed=portableRecordWrite.safeParse({kind,action:'save',...current&&{id,expectedRevision:current.revision},data:{...standard,...properties}});
  if(!parsed.success)throw new ApiError(400,'Check the supplied record properties.');
  const input=parsed.data,custom=input.data.custom;
  if(input.kind==='contacts')input.primaryCompanyId=primary?.companyId;
  if(input.kind==='deals'){input.companyId=primary?.companyId;input.primaryContactId=primary?.contactId;}
  if(Object.keys(custom??{}).some(key=>hidden.has(key.toLowerCase())))throw new ApiError(403,'You cannot edit this property.');
  if(current){
    const data:Record<string,unknown>=input.data;
    const sameStandard=Object.keys(properties).every(key=>key==='custom'||samePropertyValue(old[key],data[key]));
    if(sameStandard&&(primary?.companyId===undefined||primary.companyId===current.companyId)
      &&(primary?.contactId===undefined||primary.contactId===current.contactId)){
      // An explicit same-ID assignment still requires an active target.
      if(primary?.companyId&&!await resolvePortableCompanyLink(db,workspaceId,current.companyId,primary.companyId)
        ||primary?.contactId&&!await resolvePortableContactLink(db,workspaceId,current.contactId,primary.contactId))
        throw new ApiError(404,'Linked record not found.');
      const merged=await mergePortableCustomValues(db,workspaceId,kind,custom,current.data.custom);
      if(Object.keys(custom??{}).every(key=>samePropertyValue(current.data.custom?.[key],merged?.[key])))return {id};
    }
  }

  const createId=action==='create'?id:undefined;
  if(input.kind==='deals'&&current&&Object.hasOwn(properties,'stage')&&input.data.stage!==undefined&&input.data.stage!==old.stage){
    const [deal]=await db.select({pipelineId:deals.pipelineId}).from(deals)
      .where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,id)));
    if(deal?.pipelineId){
      const matches=await db.select({id:dealPipelineStages.id}).from(dealPipelineStages).where(and(
        eq(dealPipelineStages.workspaceId,workspaceId),eq(dealPipelineStages.pipelineId,deal.pipelineId),
        eq(dealPipelineStages.name,input.data.stage))).limit(2);
      if(matches.length!==1)throw new ApiError(400,'Choose an unambiguous stage from the current pipeline.');
      input.stageId=matches[0].id;
    }
  }
  const result=input.kind==='contacts'?await saveContact(db,ownerId,input,undefined,{createId}):
    input.kind==='companies'?await saveCompany(db,ownerId,input,undefined,{createId}):
      await saveDeal(db,ownerId,input,undefined,{createId,hiddenFields:hidden});
  if('record' in result)return {id:result.record.id};
  if(result.error==='stale')throw new ApiError(412,'This record changed. Read it again.');
  if(primary&&(result.error==='contact_missing'||result.error==='company_missing'))throw new ApiError(404,'Linked record not found.');
  if(result.error==='missing')throw new ApiError(404,'Record not found.');
  if(result.error==='access')throw new ApiError(403,'Record access changed.');
  if(result.error==='stage_required')throw new ApiError(400,missingDealStageMessage(result.stageName,result.fields));
  if(result.error==='stage_invalid'||result.error==='stage_missing')throw new ApiError(400,'Choose a valid stage for this pipeline.');
  throw new ApiError(409,'A related record or assignee is unavailable.');
}
