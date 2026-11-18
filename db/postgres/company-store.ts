import {mergePortableCustomValues} from './custom-property-store';
import {and,asc,eq,gt,ilike,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {CompanyRecord,CompanyWrite,PortableRecordQuery} from '../../lib/portable-records';
import {companyEvents,companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {privateWorkspaces} from './contact-schema';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {lockRecordWorkspace} from './private-workspace-store';
import {resolvePortableRecordOwner} from './workspace-assignee-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {recordOwnerFilter,recordSearchPattern} from './record-search';

const columns={id:companies.id,revision:companies.revision,data:companies.data,createdAt:companies.createdAt,updatedAt:companies.updatedAt};

export async function readCompanies(db:PostgresJsDatabase,actorId:string,query:Pick<PortableRecordQuery,'id'|'after'|'limit'|'search'|'owner'|'workspaceId'>){
  const scope=and(recordWorkspaceScope(db,actorId,query.workspaceId),activeCompany);
  const owned=db.select(columns).from(companies).innerJoin(privateWorkspaces,eq(companies.workspaceId,privateWorkspaces.id));
  if(query.id){
    const [record]=await owned.where(and(scope,eq(companies.id,query.id))).limit(1);
    return record??null;
  }
  const pattern=recordSearchPattern(query.search);
  const match=pattern?or(ilike(sql`${companies.data}->>'name'`,pattern),ilike(sql`${companies.data}->>'domain'`,pattern)):undefined;
  const rows=await owned.where(and(scope,match,recordOwnerFilter(db,companies.data,actorId,query.owner),query.after?gt(companies.id,query.after):undefined))
    .orderBy(asc(companies.id)).limit(query.limit+1);
  const records=rows.slice(0,query.limit);
  return {records,next:rows.length>query.limit?records.at(-1)!.id:null};
}

export function saveCompany(db:PostgresJsDatabase,actorId:string,input:CompanyWrite,shared?:SharedRecordWriteScope):Promise<{record:CompanyRecord}|{error:'missing'|'stale'|'access'|'assignee_missing'}>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,!('id' in input),shared,undefined,true);
    if(!workspaceId)return {error:shared?'access':'missing'};
    const {custom,...patch}=input.data;
    let record:CompanyRecord,previous=null;
    if('id' in input){
      const target=and(eq(companies.workspaceId,workspaceId),eq(companies.id,input.id),activeCompany);
      const [current]=await tx.select(columns).from(companies).where(target).for('update');
      if(!current)return {error:'missing'};
      if(current.revision!==input.expectedRevision)return {error:'stale'};
      const recordOwner=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId,current.data.recordOwner);
      if(recordOwner===false)return {error:'assignee_missing'};
      const data={...current.data,...patch,recordOwner,custom:await mergePortableCustomValues(tx,workspaceId,'companies',custom,current.data.custom)};
      [record]=await tx.update(companies).set({data,revision:current.revision+1,updatedAt:new Date().toISOString()})
        .where(target).returning(columns);
      previous=current.data;
    }else{
      const now=new Date().toISOString();
      const recordOwner=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId);
      if(recordOwner===false)return {error:'assignee_missing'};
      const data={...patch,recordOwner,custom:await mergePortableCustomValues(tx,workspaceId,'companies',custom,undefined)};
      [record]=await tx.insert(companies).values({workspaceId,id:crypto.randomUUID(),revision:1,data,createdAt:now,updatedAt:now})
        .returning(columns);
    }
    await tx.insert(companyEvents).values({
      workspaceId,companyId:record.id,revision:record.revision,actorId,previous,data:record.data,occurredAt:record.updatedAt,
    });
    return {record};
  });
}
