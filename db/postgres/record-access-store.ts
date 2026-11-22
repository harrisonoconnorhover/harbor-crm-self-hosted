import {and,arrayContains,desc,eq,gte,inArray,lt,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {portableApiTokens} from './portable-api-token-schema';
import {portableExternalRecordKind,type PortableExternalRecordKind} from '../../lib/portable-api-tokens';
import {commerceAccessKinds,type CommerceAccessKind,integrationOperations,type IntegrationOperation,recordAccessActions,recordAccessEvents as events} from './record-access-schema';
import {objectTypes} from './custom-object-schema';
import {privateWorkspaces} from './workspace-schema';
import {portableRecordReaders} from './portable-record-readers';
import type {CompanyRecord,ContactRecord,DealRecord,PortableRecordKind,PortableRecordQuery} from '../../lib/portable-records';

export type RecordAccessActor={userId:string;email:string};
type Action=Exclude<typeof events.$inferSelect.action,'integration'>;
export const accessKind=z.enum([...portableExternalRecordKind.options,...commerceAccessKinds,'custom-objects']);
export const accessQuery=z.object({
  view:z.literal('record-access'),actor:z.string().min(1).max(256).optional(),kind:accessKind.optional(),token:z.string().guid().optional(),
  objectId:z.string().guid().optional(),
  email:z.string().trim().max(254).email().toLowerCase().optional(),from:z.iso.date().optional(),through:z.iso.date().optional(),
  operation:z.enum(integrationOperations).optional(),file:z.string().guid().optional(),event:z.string().guid().optional(),action:z.enum(recordAccessActions).optional(),record:z.string().guid().optional(),
  afterAt:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),afterId:z.string().guid().optional(),
}).strict().refine(q=>(q.afterAt===undefined)===(q.afterId===undefined));
export type AccessQuery=z.output<typeof accessQuery>;

type RecordPage={recordIds:string[]}&({kind:PortableExternalRecordKind|CommerceAccessKind}|{kind:'custom-objects';customObjectId:string});

async function recordAccessPages(db:PostgresJsDatabase,actor:RecordAccessActor,action:Action,
  pages:RecordPage[],workspaceId?:string){
  if(!pages.length)return;
  if(!workspaceId){
    const [owned]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actor.userId));
    if(!owned)throw Error('Record workspace unavailable.');
    workspaceId=owned.id;
  }
  const workspace=workspaceId;
  await db.insert(events).values(pages.map(page=>({...page,workspaceId:workspace,actorId:actor.userId,actorEmail:actor.email,action})));
}

export async function recordIntegrationAccess(db:PostgresJsDatabase,token:{workspaceId:string;ownerId:string;email:string;id:string},
  kind:PortableExternalRecordKind,integrationOperation:IntegrationOperation,recordIds:string[]){
  if(recordIds.length)await db.insert(events).values({workspaceId:token.workspaceId,actorId:token.ownerId,actorEmail:token.email,
    tokenId:token.id,action:'integration',kind,integrationOperation,recordIds});
}

export function recordContactFileDownload(db:PostgresJsDatabase,actor:RecordAccessActor,
  version:{workspaceId:string;contactId:string;fileId:string;versionId:string;revision:number}){
  return db.insert(events).values({workspaceId:version.workspaceId,actorId:actor.userId,actorEmail:actor.email,
    action:'document',kind:'contacts',recordIds:[version.contactId],fileId:version.fileId,fileVersionId:version.versionId,fileRevision:version.revision});
}

export async function recordAccess(db:PostgresJsDatabase,actor:RecordAccessActor,kind:PortableExternalRecordKind,action:Action,
  recordIds:string[],workspaceId?:string){
  if(recordIds.length)await recordAccessPages(db,actor,action,[{kind,recordIds}],workspaceId);
}

// Record exactly the objects returned, in the same snapshot as the read.
export function readCommerceResult<T>(db:PostgresJsDatabase,actor:RecordAccessActor,kind:CommerceAccessKind,
  action:'detail'|'list'|'document'|false,read:(tx:PostgresJsDatabase)=>Promise<T>,ids:(result:T)=>string[]){
  return db.transaction(async tx=>{
    const result=await read(tx);
    if(action){
      const recordIds=[...new Set(ids(result))];
      if(recordIds.length)await recordAccessPages(tx,actor,action,[{kind,recordIds}]);
    }
    return result;
  },{isolationLevel:'repeatable read',accessMode:action?'read write':'read only'});
}

export function readCommerceCsv<T extends {id:string;dealId?:string|null;quoteId?:string|null}>(db:PostgresJsDatabase,
  actor:RecordAccessActor,kind:CommerceAccessKind,method:string,read:(tx:PostgresJsDatabase)=>Promise<T[]|null>){
  if(method==='HEAD')return read(db);
  return db.transaction(async tx=>{
    const rows=await read(tx);
    if(rows?.length){
      const pages:RecordPage[]=[{kind,recordIds:rows.map(row=>row.id)}];
      const deals=new Set<string>(),quotes=new Set<string>();
      for(const row of rows){
        if(row.dealId)deals.add(row.dealId);
        if(row.quoteId)quotes.add(row.quoteId);
      }
      if(deals.size)pages.push({kind:'deals',recordIds:[...deals]});
      if(quotes.size)pages.push({kind:'quotes',recordIds:[...quotes]});
      await recordAccessPages(tx,actor,'csv',pages);
    }
    return rows;
  },{isolationLevel:'repeatable read'});
}

export function readHistoryResponse<T extends {items:unknown[]}>(db:PostgresJsDatabase,actor:RecordAccessActor,
  method:string,workspaceId:string|undefined,read:(db:PostgresJsDatabase)=>Promise<T|null>,pages:(result:T)=>RecordPage[]){
  if(method==='HEAD')return read(db);
  return db.transaction(async tx=>{
    const result=await read(tx);
    if(result?.items.length)await recordAccessPages(tx,actor,'history',pages(result),workspaceId);
    return result;
  },{isolationLevel:'repeatable read'});
}

export function recordPreviewAccess(db:PostgresJsDatabase,actor:RecordAccessActor,action:'search'|'related'|'csv',
  results:{kind:string;id:string}[],workspaceId?:string){
  const pages=portableExternalRecordKind.options.map(kind=>({kind,recordIds:[...new Set(results.filter(row=>row.kind===kind).map(row=>row.id))]}));
  return recordAccessPages(db,actor,action,pages.filter(page=>page.recordIds.length),workspaceId);
}

export function recordCustomAccess(db:PostgresJsDatabase,actor:RecordAccessActor,action:'detail'|'list'|'search'|'related'|'csv',
  results:{objectId:string;id:string}[],workspaceId?:string){
  const groups=new Map<string,Set<string>>();
  for(const {objectId,id} of results){
    const ids=groups.get(objectId);
    if(ids)ids.add(id);
    else groups.set(objectId,new Set([id]));
  }
  return recordAccessPages(db,actor,action,Array.from(groups,([customObjectId,ids])=>({
    kind:'custom-objects',customObjectId,recordIds:[...ids],
  })),workspaceId);
}

export function recordPrimaryLinks(db:PostgresJsDatabase,actor:RecordAccessActor,rows:(ContactRecord|CompanyRecord|DealRecord)[],
  workspaceId?:string,csvColumns?:string[]){
  const includesLink=(id:string,name:string)=>!csvColumns||csvColumns.includes(id)||csvColumns.includes(name);
  const targets:{kind:PortableRecordKind;id:string}[]=[];
  for(const row of rows){
    if('primaryCompanyId' in row&&row.primaryCompanyId&&includesLink('primaryCompanyId','primaryCompanyName'))targets.push({kind:'companies',id:row.primaryCompanyId});
    if('companyId' in row&&row.companyId&&includesLink('companyId','companyName'))targets.push({kind:'companies',id:row.companyId});
    if('primaryContactId' in row&&row.primaryContactId&&includesLink('primaryContactId','primaryContactName'))targets.push({kind:'contacts',id:row.primaryContactId});
  }
  return recordPreviewAccess(db,actor,csvColumns?'csv':'related',targets,workspaceId);
}

type WorkItemKind='tasks'|'leads'|'tickets';
type WorkItemRow={id:string;contactId:string|null;companyId:string|null;dealId?:string|null};
type WorkItemResult=WorkItemRow|{records:WorkItemRow[]};

// Use the filtered rows sent to the client. Stored foreign keys can name records hidden from the teammate.
export async function recordWorkItemAccess(db:PostgresJsDatabase,actor:RecordAccessActor,kind:WorkItemKind,
  result:WorkItemResult,workspaceId?:string,selected?:WorkItemRow,related:{kind:PortableExternalRecordKind;id:string}[]=[]){
  const rows='records' in result?result.records:[result];
  await recordAccess(db,actor,kind,'records' in result?'list':'detail',rows.map(row=>row.id),workspaceId);
  if(selected)await recordAccess(db,actor,kind,'detail',[selected.id],workspaceId);
  const links=[...related];
  for(const row of selected?[...rows,selected]:rows){
    if(row.contactId)links.push({kind:'contacts',id:row.contactId});
    if(row.companyId)links.push({kind:'companies',id:row.companyId});
    if(row.dealId)links.push({kind:'deals',id:row.dealId});
  }
  await recordPreviewAccess(db,actor,'related',links,workspaceId);
}

export function readWorkItemResponse<T extends WorkItemResult|null>(db:PostgresJsDatabase,actor:RecordAccessActor,
  kind:WorkItemKind,workspaceId:string|undefined,method:string,read:(db:PostgresJsDatabase)=>Promise<T>){
  if(method==='HEAD')return read(db);
  return db.transaction(async tx=>{
    const result=await read(tx);
    if(result)await recordWorkItemAccess(tx,actor,kind,result,workspaceId);
    return result;
  },{isolationLevel:'repeatable read'});
}

export function readAuditedRecords(db:PostgresJsDatabase,actor:RecordAccessActor,kind:PortableRecordKind,query:Omit<PortableRecordQuery,'kind'>,includeBody=true){
  if(!includeBody)return portableRecordReaders[kind](db,actor.userId,query);
  return db.transaction(async tx=>{
    const row=await portableRecordReaders[kind](tx,actor.userId,query);
    if(row&&'data' in row)await recordAccess(tx,actor,kind,'detail',[row.id],query.workspaceId);
    else if(row)await recordAccess(tx,actor,kind,'list',row.records.map(item=>item.id),query.workspaceId);
    if(row)await recordPrimaryLinks(tx,actor,'data' in row?[row]:row.records,query.workspaceId);
    return row;
  },{isolationLevel:'repeatable read'});
}

export const accessExportLimit=500;
export const accessPartNumber=z.string().regex(/^[1-9][0-9]{0,8}$/).transform(Number);
function accessHistoryScope(ownerId:string,query:AccessQuery,ids?:string[]){
  return and(eq(privateWorkspaces.ownerId,ownerId),query.token?eq(events.tokenId,query.token):undefined,
      query.actor?eq(events.actorId,query.actor):undefined,
      query.objectId?eq(events.customObjectId,query.objectId):undefined,
      query.email?sql`lower(${events.actorEmail})=${query.email}`:undefined,
      query.from?gte(events.occurredAt,Date.parse(query.from)):undefined,
      query.through?lt(events.occurredAt,Date.parse(query.through)+86_400_000):undefined,
      ids?inArray(events.id,ids):undefined,
      query.event?eq(events.id,query.event):undefined,query.kind&&eq(events.kind,query.kind),query.action&&eq(events.action,query.action),
      query.operation?eq(events.integrationOperation,query.operation):undefined,
      query.file?eq(events.fileId,query.file):undefined,query.record?arrayContains(events.recordIds,[query.record]):undefined,
      query.afterAt!==undefined?sql`(${events.occurredAt},${events.id}) < (${query.afterAt},${query.afterId})`:undefined);
}

export async function accessExportPart(db:PostgresJsDatabase,ownerId:string,query:AccessQuery){
  const rows=await db.select({id:events.id,at:events.occurredAt}).from(events)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,events.workspaceId))
    .where(accessHistoryScope(ownerId,query)).orderBy(desc(events.occurredAt),desc(events.id)).limit(accessExportLimit+1);
  return {events:rows.slice(0,accessExportLimit),more:rows.length>accessExportLimit};
}

export async function accessHistory(db:PostgresJsDatabase,ownerId:string,query:AccessQuery,download?:{eventIds?:string[]}){
  const limit=download?accessExportLimit:25;
  const rows=await db.select({id:events.id,email:events.actorEmail,actorId:events.actorId,at:events.occurredAt,
    action:events.action,operation:events.integrationOperation,kind:events.kind,fileId:events.fileId,fileVersionId:events.fileVersionId,fileRevision:events.fileRevision,customObjectId:events.customObjectId,customName:sql<string|null>`${objectTypes.definition}->>'name'`,count:sql<number>`cardinality(${events.recordIds})`,
    ids:download||query.event?events.recordIds:sql<string[]>`${events.recordIds}[1:1]`,token:events.tokenId,tokenName:portableApiTokens.name})
    .from(events).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,events.workspaceId))
    .leftJoin(objectTypes,and(eq(objectTypes.workspaceId,events.workspaceId),eq(objectTypes.id,events.customObjectId)))
    .leftJoin(portableApiTokens,and(eq(portableApiTokens.workspaceId,events.workspaceId),eq(portableApiTokens.id,events.tokenId)))
    .where(accessHistoryScope(ownerId,query,download?.eventIds))
    .orderBy(desc(events.occurredAt),desc(events.id)).limit(limit+1);
  return {items:rows.slice(0,limit),more:rows.length>limit};
}
