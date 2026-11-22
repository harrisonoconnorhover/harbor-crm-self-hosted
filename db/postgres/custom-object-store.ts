import {effectiveMemberToolPolicy} from '../../lib/portable-tool-permissions';
import {sharedToolAllowed} from './shared-tool-permission';
import {and,asc,desc,eq,exists,gt,isNotNull,isNull,lte,ne,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {dealWorkflowRuns} from './workflow-schema';
import {recordPreviewAccess,recordCustomAccess} from './record-access-store';
import {activeTask,portableTasks,taskOwnership} from './task-schema';
import {type ObjectExport,isReportField,objectSumField,objectValues,validateDefinitionChange,type ObjectAction,type ObjectRead} from '../../lib/portable-custom-objects';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import type {PortableRecordKind} from '../../lib/portable-records';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {objectTypes as types,objectRecords as records,objectLinks as links,customRecordLinks as peers} from './custom-object-schema';
import {captureRecordWorkflowTasks} from './record-task-workflow-store';
import {privateWorkspaces} from './workspace-schema';
import {recordCatalogScope,sharedWorkspaceGrant} from './workspace-viewer-store';
import {ownedRecordScope} from './record-ownership-scope';
import {resolveCoreRecordOwner} from './workspace-assignee-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {unavailableRecordOwner} from './record-search';
import {customRecordMatches} from './custom-object-search';

type Db=PostgresJsDatabase;
type Transaction=Parameters<Parameters<Db['transaction']>[0]>[0];
const tables={contacts,companies,deals};
const targetColumns={contacts:links.contactId,companies:links.companyId,deals:links.dealId};
const missing=()=>new ApiError(404,'Record or object unavailable.');
const stale=()=>new ApiError(409,'This record or its properties changed. Reload before saving.');
function page<T extends {id:string}>(rows:T[],size=25){
  return {items:rows.slice(0,size),next:rows.length>size?rows[size-1].id:null};
}
function corePredicate(db:Db,actor:string,workspace:string,kind:PortableRecordKind,shared:boolean,mode:'view'|'edit'='view'){
  const t=tables[kind];
  return and(eq(t.workspaceId,workspace),isNull(t.archivedAt),shared?ownedRecordScope(db,actor,workspace,t,mode):undefined);
}
async function coreAvailable(db:Db,actor:string,workspace:string,kind:PortableRecordKind,id:string,shared:boolean,mode:'view'|'edit'){
  const t=tables[kind];
  const [row]=await db.select({id:t.id}).from(t).where(and(eq(t.id,id),corePredicate(db,actor,workspace,kind,shared,mode)));
  return !!row;
}
export async function summarizeCustomObjectRecords(db:Db,actor:string,workspace:string,objectId:string,shared:boolean,fieldId?:string,sumId?:string){
  const value=fieldId?sql<string|null>`${records.data}->'values'->>${fieldId}::text`:sql<null>`NULL`;
  const count=sql<number>`count(*)`.mapWith(Number);
  const scoped=and(eq(records.workspaceId,workspace),eq(records.objectId,objectId),isNull(records.archivedAt),
    shared?ownedRecordScope(db,actor,workspace,records):undefined);
  const measure=sql`SUM((${records.data}->'values'->>${sumId??null}::text)::numeric)`;
  const rows=await db.select({value,count,...(sumId?{sum:sql<string|null>`${measure}::text`,
    overall:sql<string|null>`sum(${measure}) OVER ()::text`}:{})})
    .from(records).where(scoped).groupBy(...(fieldId?[sql`1`]:[])).orderBy(...(fieldId?[sql`1 NULLS LAST`]:[]));
  return {groups:rows.map(({value,count,sum})=>({value,count,...(sumId?{sum}: {})})),
    total:rows.reduce((n,row)=>n+row.count,0),...(sumId?{sum:rows[0]?.overall??null}:{})};
}

function listFilters(db:Db,workspaceOwner:string,q:Pick<ObjectRead,'archived'|'search'|'value'|'owner'>,groupId?:string){
  const value=groupId?sql<string|null>`${records.data}->'values'->>${groupId}::text`:undefined;
  return and(q.archived?isNotNull(records.archivedAt):isNull(records.archivedAt),
    q.search?customRecordMatches(q.search):undefined,
    q.owner?unavailableRecordOwner(db,records.data,records.workspaceId,sql`${workspaceOwner}::text`):undefined,
    value&&q.value!==undefined?(q.value===''?isNull(value):eq(value,q.value)):undefined);
}

type ExportCursor={workspace:string;revision:number;after:string;through:string};
const exportBatchSize=100;
export async function customExportBatch(db:Db,actor:PostgresSessionActor,q:ObjectExport,head:boolean,cursor?:ExportCursor){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to export these records.');
    const [type]=await tx.select({workspace:types.workspaceId,revision:types.revision,definition:types.definition}).from(types)
      .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,types.workspaceId))
      .where(and(eq(privateWorkspaces.ownerId,actor.userId),eq(types.id,q.objectId)));
    if(!type)throw missing();
    if(cursor&&(cursor.workspace!==type.workspace||cursor.revision!==type.revision))throw stale();
    const group=q.by?type.definition.fields.find(f=>f.id===q.by&&isReportField(f)):undefined;
    if(q.by&&!group)throw missing();
    const fields=type.definition.fields;
    const scope=and(eq(records.workspaceId,type.workspace),eq(records.objectId,q.objectId));
    // Capture an upper bound once so later batches cannot extend the end of the scan.
    const through=cursor?.through??(!head?(await tx.select({id:records.id}).from(records).where(scope)
      .orderBy(desc(records.id)).limit(1))[0]?.id:undefined);
    const batch=through?await tx.select({id:records.id,name:records.name,data:records.data,archivedAt:records.archivedAt})
      .from(records).where(and(scope,listFilters(tx,actor.userId,q,group?.id),cursor?gt(records.id,cursor.after):undefined,
        lte(records.id,through))).orderBy(asc(records.id)).limit(exportBatchSize+1):[];
    const rows=batch.slice(0,exportBatchSize);
    const next:ExportCursor|undefined=through&&batch.length>rows.length?
      {workspace:type.workspace,revision:type.revision,through,after:rows[rows.length-1].id}:undefined;
    if(rows.length)await recordCustomAccess(tx,actor,'csv',rows.map(row=>({id:row.id,objectId:q.objectId})),type.workspace);
    return {fields,rows,next};
  },{isolationLevel:'repeatable read'});
}

export async function readObjects(db:Db,actor:string,q:ObjectRead,auditEmail?:string,editorPage=false){
  return db.transaction(async tx=>{
    const shared=!!q.workspaceId;
    if(q.summary&&!await sharedToolAllowed(tx,actor,q.workspaceId,'reports'))throw missing();
    const grant=q.workspaceId?await sharedWorkspaceGrant(tx,actor,q.workspaceId,true):undefined;
    const policy=grant&&effectiveMemberToolPolicy(grant,'custom-objects');
    if(shared&&(!policy||policy.view==='none'))throw missing();
    const [space]=await tx.select({id:privateWorkspaces.id,owner:privateWorkspaces.ownerId}).from(privateWorkspaces).where(recordCatalogScope(tx,actor,q.workspaceId));
    const workspace=space?.id;
    if(!workspace){
      if(q.objectId||q.kind)throw missing();
      return {view:'types' as const,...page<{id:string;name:string}>([])};
    }
    const reader=auditEmail?{userId:actor,email:auditEmail}:undefined;
    const allowed=shared?ownedRecordScope(tx,actor,workspace,records):undefined;
    const editable=shared?ownedRecordScope(tx,actor,workspace,records,'edit'):sql<boolean>`true`;
    if(q.kind&&q.target){
      if(!await coreAvailable(tx,actor,workspace,q.kind,q.target,shared,'view'))throw missing();
      const size=q.preview?3:25;
      const rows=await tx.select({id:links.id,recordId:records.id,objectId:records.objectId,name:records.name,
        typeName:sql<string>`${types.definition}->>'name'`}).from(links)
        .innerJoin(records,and(eq(records.workspaceId,links.workspaceId),eq(records.objectId,links.objectId),eq(records.id,links.recordId)))
        .innerJoin(types,and(eq(types.workspaceId,records.workspaceId),eq(types.id,records.objectId)))
        .where(and(eq(links.workspaceId,workspace),eq(targetColumns[q.kind],q.target),isNull(records.archivedAt),allowed,q.after?gt(links.id,q.after):undefined))
        .orderBy(asc(links.id)).limit(size+1);
      const linked=page(rows,size);
      if(reader)await recordCustomAccess(tx,reader,'related',linked.items.map(row=>({objectId:row.objectId,id:row.recordId})),workspace);
      return {view:'related' as const,...linked};
    }
    if(!q.objectId){
      const rows=await tx.select({id:types.id,name:sql<string>`${types.definition}->>'name'`}).from(types)
        .where(and(eq(types.workspaceId,workspace),q.owner?exists(tx.select({id:records.id}).from(records).where(and(
          eq(records.workspaceId,workspace),eq(records.objectId,types.id),allowed,listFilters(tx,space.owner,q)))):undefined,q.after?gt(types.id,q.after):undefined)).orderBy(asc(types.id)).limit(26);
      return {view:'types' as const,...page(rows)};
    }
    const [type]=await tx.select({id:types.id,revision:types.revision,definition:types.definition}).from(types)
      .where(and(eq(types.workspaceId,workspace),eq(types.id,q.objectId)));
    if(!type)throw missing();
    const inObject=and(eq(records.workspaceId,workspace),eq(records.objectId,type.id),allowed);
    const group=q.by?type.definition.fields.find(f=>f.id===q.by&&isReportField(f)):undefined;
    if(q.by&&!group)throw missing();
    if(q.sum&&!objectSumField(type.definition,q.sum))throw missing();
    if(q.summary){
      return {view:'summary' as const,type,...await summarizeCustomObjectRecords(tx,actor,workspace,type.id,shared,group?.id,q.sum)};
    }
    if(!q.record){
      const rows=await tx.select({id:records.id,name:records.name}).from(records).where(and(inObject,listFilters(tx,space.owner,q,group?.id),
        q.after?gt(records.id,q.after):undefined)).orderBy(asc(records.id)).limit(26);
      const visible=page(rows);
      if(reader)await recordCustomAccess(tx,reader,q.search?'search':'list',visible.items.map(row=>({objectId:type.id,id:row.id})),workspace);
      return {view:'list' as const,type,canCreate:!shared||policy?.create===true,...visible};
    }
    const [record]=await tx.select({id:records.id,name:records.name,data:records.data,revision:records.revision,
      archivedAt:records.archivedAt,editable:sql<boolean>`${editable}`}).from(records).where(and(inObject,eq(records.id,q.record)));
    if(!record)throw missing();
    // Editing a link changes both records. A visible CRM record can still be read-only.
    const canUnlink=!record.editable?sql<boolean>`false`:!shared?sql<boolean>`true`:sql<boolean>`CASE
      WHEN ${contacts.id} IS NOT NULL THEN ${ownedRecordScope(tx,actor,workspace,contacts,'edit')}
      WHEN ${companies.id} IS NOT NULL THEN ${ownedRecordScope(tx,actor,workspace,companies,'edit')}
      ELSE ${ownedRecordScope(tx,actor,workspace,deals,'edit')} END`;
    const related=await tx.select({id:links.id,canUnlink,contactId:contacts.id,companyId:companies.id,dealId:deals.id,
      name:sql<string>`coalesce(${contacts.data}->>'name',${companies.data}->>'name',${deals.data}->>'name')`}).from(links)
      .leftJoin(contacts,and(eq(contacts.id,links.contactId),corePredicate(tx,actor,workspace,'contacts',shared)))
      .leftJoin(companies,and(eq(companies.id,links.companyId),corePredicate(tx,actor,workspace,'companies',shared)))
      .leftJoin(deals,and(eq(deals.id,links.dealId),corePredicate(tx,actor,workspace,'deals',shared)))
      .where(and(eq(links.workspaceId,workspace),eq(links.objectId,type.id),eq(links.recordId,record.id),
        or(isNotNull(contacts.id),isNotNull(companies.id),isNotNull(deals.id)),q.after?gt(links.id,q.after):undefined))
      .orderBy(asc(links.id)).limit(26);
    const sourceOnLeft=and(eq(peers.leftObjectId,type.id),eq(peers.leftRecordId,record.id));
    const sourceOnRight=and(eq(peers.rightObjectId,type.id),eq(peers.rightRecordId,record.id));
    const customLinks=page(await tx.select({
      id:peers.id,objectId:records.objectId,recordId:records.id,name:records.name,
      typeName:sql<string>`${types.definition}->>'name'`,canUnlink:record.editable?sql<boolean>`${editable}`:sql<boolean>`false`,
    }).from(peers)
      .innerJoin(records,and(eq(records.workspaceId,peers.workspaceId),or(
        and(sourceOnLeft,eq(records.objectId,peers.rightObjectId),eq(records.id,peers.rightRecordId)),
        and(sourceOnRight,eq(records.objectId,peers.leftObjectId),eq(records.id,peers.leftRecordId)))))
      .innerJoin(types,and(eq(types.workspaceId,records.workspaceId),eq(types.id,records.objectId)))
      .where(and(eq(peers.workspaceId,workspace),or(sourceOnLeft,sourceOnRight),isNull(records.archivedAt),allowed,
        q.afterCustom?gt(peers.id,q.afterCustom):undefined))
      .orderBy(asc(peers.id)).limit(26));
    if(reader&&!editorPage)await recordCustomAccess(tx,reader,'related',customLinks.items.map(row=>({objectId:row.objectId,id:row.recordId})),workspace);
    const taskPageSize=20;
    const taskRows=await tx.select({
      id:portableTasks.id,at:dealWorkflowRuns.createdAt,name:sql<string>`${portableTasks.data}->>'name'`,completedAt:portableTasks.completedAt,
    }).from(dealWorkflowRuns)
      .innerJoin(portableTasks,and(eq(portableTasks.workspaceId,dealWorkflowRuns.workspaceId),eq(portableTasks.id,dealWorkflowRuns.customTaskId),activeTask))
      .where(and(eq(dealWorkflowRuns.workspaceId,workspace),eq(dealWorkflowRuns.customObjectId,type.id),eq(dealWorkflowRuns.customRecordId,record.id),
        q.afterTask?sql`(${dealWorkflowRuns.createdAt},${dealWorkflowRuns.id}) < (${q.afterTaskAt},${q.afterTask}::uuid)`:undefined,
        shared?ownedRecordScope(tx,actor,workspace,taskOwnership):undefined))
      .orderBy(desc(dealWorkflowRuns.createdAt),desc(dealWorkflowRuns.id)).limit(taskPageSize+1);
    const followUps=taskRows.slice(0,taskPageSize).map(({id,name,completedAt})=>({id,name,completedAt}));
    const last=taskRows[taskPageSize-1];
    const nextTasks=taskRows.length>taskPageSize?{at:last.at,id:last.id}:null;
    const linkedPage=page(related.map(row=>({id:row.id,name:row.name,canUnlink:row.canUnlink,
      kind:(row.contactId?'contacts':row.companyId?'companies':'deals') as PortableRecordKind,target:(row.contactId??row.companyId??row.dealId)!})));
    if(reader&&(!editorPage||record.editable&&!record.archivedAt))
      await recordCustomAccess(tx,reader,'detail',[{objectId:type.id,id:record.id}],workspace);
    if(reader&&!editorPage)await recordPreviewAccess(tx,reader,'related',[
      ...linkedPage.items.map(row=>({kind:row.kind,id:row.target})),...followUps.map(row=>({kind:'tasks',id:row.id})),
    ],workspace);
    return {view:'record' as const,type,record,followUps,nextTasks,customLinks,...linkedPage};
  },{isolationLevel:'repeatable read',accessMode:auditEmail?'read write':'read only'});
}
export type ObjectResult=Awaited<ReturnType<typeof readObjects>>;

// Both the editor and CSV importer hold the workspace write lock and validate the definition first.
export async function persistCustomRecord(tx:Transaction,actorId:string,type:typeof types.$inferSelect,
  next:typeof records.$inferInsert,previousOwnerId?:string){
  const {workspaceId,objectId,id,name,data,revision}=next;
  const created=revision===1;
  const saved=created?await tx.insert(records).values(next).onConflictDoNothing().returning({id:records.id}):
    await tx.update(records).set({name,data,revision}).where(and(eq(records.workspaceId,workspaceId),eq(records.objectId,objectId),
      eq(records.id,id),eq(records.revision,revision-1),isNull(records.archivedAt))).returning({id:records.id});
  if(!saved.length)throw stale();
  if(created||(data.recordOwner&&previousOwnerId!==data.recordOwner.userId)){
    await captureRecordWorkflowTasks(tx,workspaceId,actorId,{trigger:created?'custom_record_created':'custom_record_owner_assigned',
      objectId,objectName:type.definition.name,record:{id,recordOwner:data.recordOwner},recordRevision:revision,recordName:name},new Date().toISOString());
  }
}

export function writeObject(db:Db,actor:PostgresSessionActor,input:ObjectAction,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    if(shared&&input.action==='define')throw new ApiError(403,'The workspace owner manages object definitions.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,input.action==='define',shared,undefined,true,true,['custom-objects',input.action==='archive'?'delete':input.action==='save'&&input.revision===0?'create':'edit']);
    if(!workspace)throw new ApiError(403,'Workspace edit access unavailable.');
    const typeId=input.action==='define'?input.id:input.objectId;
    const typeKey=and(eq(types.workspaceId,workspace),eq(types.id,typeId));
    const [type]=await tx.select().from(types).where(typeKey);
    if(input.action==='define'){
      if((type?.revision??0)!==input.revision)throw stale();
      const [duplicate]=await tx.select({id:types.id}).from(types).where(and(eq(types.workspaceId,workspace),ne(types.id,typeId),
        sql`lower(${types.definition}->>'name')=lower(${input.definition.name})`));
      if(duplicate)throw new ApiError(409,'An object already uses that name.');
      if(type){
        const [existing]=await tx.select({id:records.id}).from(records).where(and(eq(records.workspaceId,workspace),eq(records.objectId,type.id))).limit(1);
        validateDefinitionChange(type.definition,input.definition,!!existing);
        await tx.update(types).set({definition:input.definition,revision:type.revision+1}).where(typeKey);
      }else await tx.insert(types).values({workspaceId:workspace,id:typeId,definition:input.definition,revision:1});
      return {id:typeId,revision:input.revision+1};
    }
    if(!type)throw missing();
    const key=and(eq(records.workspaceId,workspace),eq(records.objectId,typeId),eq(records.id,input.id),
      shared?ownedRecordScope(tx,actor.userId,workspace,records,'edit',undefined,shared.grantId):undefined);
    const [record]=await tx.select().from(records).where(key).for('update');
    if(!record&&(input.action!=='save'||input.revision!==0))throw missing();
    if((record?.revision??0)!==input.revision)throw stale();
    const revision=input.revision+1;
    if(input.action==='archive'){
      if(!!record.archivedAt===input.archived)return {id:input.id,revision:input.revision};
      await tx.update(records).set({revision,archivedAt:input.archived?sql`now()`:null}).where(key);
    }else if(record?.archivedAt)throw new ApiError(409,'Restore this record before editing.');
    else if(input.action==='save'){
      if(type.revision!==input.schemaRevision)throw stale();
      if(input.handoff){
        if(!record||!input.assigneeId||input.assigneeId===record.data.recordOwner?.userId)throw new ApiError(400,'Choose a new record owner.');
        const [needsOwner]=await tx.select({id:records.id}).from(records).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,records.workspaceId))
          .where(and(key,unavailableRecordOwner(tx,records.data,records.workspaceId,privateWorkspaces.ownerId)));
        if(!needsOwner)throw new ApiError(409,'The current owner can edit this record again. Refresh the unavailable owners list.');
      }
      const owner=await resolveCoreRecordOwner(tx,workspace,actor.userId,!!shared,'custom-objects',input.assigneeId,record?.data.recordOwner,!record);
      if(owner===false)throw new ApiError(400,'Choose an available record owner.');
      const data={values:objectValues(type.definition,input.values,record?.data.values),recordOwner:owner};
      await persistCustomRecord(tx,actor.userId,type,{workspaceId:workspace,objectId:type.id,id:input.id,name:input.name,data,revision},
        record?.data.recordOwner?.userId);
    }else if('targetObjectId' in input){
      const peerKey=and(eq(records.workspaceId,workspace),eq(records.objectId,input.targetObjectId),eq(records.id,input.target),
        isNull(records.archivedAt),shared?ownedRecordScope(tx,actor.userId,workspace,records,'edit',undefined,shared.grantId):undefined);
      const [peer]=await tx.select({id:records.id,objectId:records.objectId}).from(records).where(peerKey).for('update');
      if(!peer)throw missing();
      if(peer.objectId===record.objectId&&peer.id===record.id)throw new ApiError(400,'Choose a different record to link.');
      const sourceFirst=record.objectId<peer.objectId||(record.objectId===peer.objectId&&record.id<peer.id);
      const [left,right]=sourceFirst?[record,peer]:[peer,record];
      const pair={workspaceId:workspace,leftObjectId:left.objectId,leftRecordId:left.id,rightObjectId:right.objectId,rightRecordId:right.id};
      const changed=input.action==='linkCustom'
        ?await tx.insert(peers).values({...pair,id:crypto.randomUUID()}).onConflictDoNothing().returning({id:peers.id})
        :await tx.delete(peers).where(and(eq(peers.workspaceId,workspace),eq(peers.leftObjectId,left.objectId),eq(peers.leftRecordId,left.id),
          eq(peers.rightObjectId,right.objectId),eq(peers.rightRecordId,right.id))).returning({id:peers.id});
      if(!changed.length)return {id:input.id,revision:input.revision};
      await tx.update(records).set({revision:sql`${records.revision}+1`}).where(or(key,peerKey));
    }else{
      if(!await coreAvailable(tx,actor.userId,workspace,input.kind,input.target,!!shared,'edit'))throw missing();
      const column=targetColumns[input.kind];
      const result=input.action==='link'?await tx.insert(links).values({workspaceId:workspace,objectId:typeId,recordId:input.id,id:crypto.randomUUID(),
        contactId:input.kind==='contacts'?input.target:null,companyId:input.kind==='companies'?input.target:null,dealId:input.kind==='deals'?input.target:null})
        .onConflictDoNothing().returning({id:links.id}):await tx.delete(links).where(and(eq(links.workspaceId,workspace),eq(links.objectId,typeId),
          eq(links.recordId,input.id),eq(column,input.target))).returning({id:links.id});
      if(!result.length)return {id:input.id,revision:input.revision};
      await tx.update(records).set({revision}).where(key);
    }
    return {id:input.id,revision};
  });
}
