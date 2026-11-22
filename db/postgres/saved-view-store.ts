import {hiddenPropertyIds,propertyVisibleTo} from './record-property-access';
import {hiddenStandardFields} from './standard-property-access';
import {isRestrictableStandardField} from '../../lib/portable-standard-property-access';
import {and,count,eq,inArray,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordKind} from '../../lib/portable-records';
import {portableSavedViewLimit,type PortableSavedView,type PortableSavedViewWrite} from '../../lib/portable-saved-views';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableCustomColumnId,portableLastContactedColumn} from '../../lib/portable-record-list-columns';
import {portableCustomProperties as properties} from './custom-property-schema';
import {savedViews} from './saved-view-schema';
import {loginIdentities} from './identity-schema';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {privateWorkspaces} from './workspace-schema';
import {recordCatalogScope} from './workspace-viewer-store';

const fields={id:savedViews.id,kind:savedViews.kind,name:savedViews.name,filters:savedViews.filters,columns:savedViews.columns,shared:savedViews.shared,revision:savedViews.revision};
function viewFields(kind:PortableRecordKind,viewerId:string,workspaceId?:string){
  if(!workspaceId)return fields;
  const columns=sql<string[]|null>`CASE WHEN ${savedViews.columns} IS NOT NULL THEN
    (SELECT coalesce(jsonb_agg(col ORDER BY position),'[]'::jsonb)
      FROM jsonb_array_elements_text(${savedViews.columns}) WITH ORDINALITY AS entries(col,position)
      WHERE col NOT IN (${hiddenStandardFields(workspaceId,kind,viewerId)})
        AND coalesce(lower(substring(col from '^custom:(.*)$')),'') NOT IN (${hiddenPropertyIds(workspaceId,kind,viewerId)})) END`;
  return {...fields,columns};
}
const kindScope=(workspaceId:string,kind:PortableRecordKind)=>
  and(eq(savedViews.workspaceId,workspaceId),eq(savedViews.kind,kind));

function publicView({columns,...view}:Omit<PortableSavedView,'columns'>&{columns:string[]|null}):PortableSavedView{
  return columns?{...view,columns}:view;
}
const author=sql<string|null>`(SELECT coalesce(nullif(trim(${loginIdentities.fullName}),''),'Workspace member') FROM ${loginIdentities}
  WHERE ${loginIdentities.id}=${savedViews.authorId})`;

export async function listPortableSavedViews(db:PostgresJsDatabase,actorId:string,kind:PortableRecordKind,workspaceId?:string){
  const canReadOutreach=workspaceId&&kind==='contacts'
    ?sql<boolean>`(${recordCatalogScope(db,actorId,workspaceId,'contactOutreach')})`:sql<boolean>`true`;
  // In a shared workspace an editor manages the views they created; the owner manages all of them.
  const mine=workspaceId?sql<boolean>`coalesce(${savedViews.authorId}=${actorId},false)`:sql<boolean>`false`;
  const rows=await db.select({...viewFields(kind,actorId,workspaceId),canReadOutreach,author,mine}).from(savedViews).innerJoin(privateWorkspaces,eq(savedViews.workspaceId,privateWorkspaces.id))
    .where(and(recordCatalogScope(db,actorId,workspaceId),eq(savedViews.kind,kind),workspaceId?eq(savedViews.shared,true):undefined,
      workspaceId&&kind==='deals'?sql`(NOT (${savedViews.filters} ? 'closeMonth') OR 'closeDate' NOT IN (${hiddenStandardFields(workspaceId,kind,actorId)}))`:undefined))
    .orderBy(sql`lower(${savedViews.name})`,savedViews.id).limit(portableSavedViewLimit);
  // Only an editor's own shared views are marked, so other responses keep their shape.
  return rows.map(({canReadOutreach,author,mine,...row})=>publicView({...(!canReadOutreach&&row.columns
    ?{...row,columns:row.columns.filter(id=>id!==portableLastContactedColumn.id)}:row),...(author?{author}:{}),...(mine?{mine:true}:{})}));
}

type WriteResult={view:PortableSavedView}|{deleted:true}|{error:'missing'|'stale'|'duplicate'|'limit'|'columns'|'access'|'author'};

export function writePortableSavedView(db:PostgresJsDatabase,actorId:string,input:PortableSavedViewWrite,shared?:SharedRecordWriteScope):Promise<WriteResult>{
  return db.transaction(async tx=>{
    // Serialize the per-kind name and count checks with other writes in this workspace.
    // An editor can order or show by Last contacted only with the shared outreach permission.
    const outreach=!!shared&&(input.action==='create'||input.action==='update')&&input.kind==='contacts'&&
      (!!input.filters.sort||!!input.columns?.includes(portableLastContactedColumn.id));
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.action==='create'&&!shared,shared,outreach?'contactOutreach':undefined,true);
    if(!workspaceId)return {error:shared?'access':'missing'} as const;
    const scope=kindScope(workspaceId,input.kind);
    const id=input.action==='create'?undefined:input.id;
    if(input.action!=='create'){
      const [current]=await tx.select({revision:savedViews.revision,authorId:savedViews.authorId,shared:savedViews.shared}).from(savedViews)
        .where(and(scope,eq(savedViews.id,input.id)));
      if(!current||shared&&!current.shared)return {error:'missing'} as const;
      // Editors change only their own views; sharing stays with the owner, and editors' views stay shared.
      if(shared&&(current.authorId!==actorId||input.action==='setSharing'))return {error:'author'} as const;
      if(!shared&&input.action==='setSharing'&&current.authorId&&!input.shared)return {error:'author'} as const;
      if(current.revision!==input.expectedRevision)return {error:'stale'} as const;
      if(input.action==='delete'){
        await tx.delete(savedViews).where(and(scope,eq(savedViews.id,input.id)));
        return {deleted:true} as const;
      }
      if(input.action==='setSharing'){
        const [view]=await tx.update(savedViews).set({shared:input.shared,revision:input.expectedRevision+1})
          .where(and(scope,eq(savedViews.id,input.id))).returning(fields);
        return {view:publicView(view)} as const;
      }
    }
    if(shared&&(input.filters.closeMonth||input.columns?.some(id=>isRestrictableStandardField(input.kind,id)))){
      const hidden=await tx.execute<{id:string}>(hiddenStandardFields(workspaceId,input.kind,actorId));
      const selected=new Set(input.columns);
      if(input.filters.closeMonth)selected.add('closeDate');
      if(hidden.some(row=>selected.has(row.id)))return {error:'columns'} as const;
    }
    const customIds=input.columns?.map(portableCustomColumnId).filter((id):id is string=>id!==undefined)??[];
    if(customIds.length){
      const found=await tx.select({id:properties.id}).from(properties).where(and(
        eq(properties.workspaceId,workspaceId),eq(properties.kind,input.kind),inArray(properties.id,customIds),shared?propertyVisibleTo(actorId):undefined));
      if(found.length!==customIds.length)return {error:'columns'} as const;
    }
    const [duplicate]=await tx.select({id:savedViews.id}).from(savedViews)
      .where(and(scope,sql`lower(${savedViews.name})=lower(${input.name})`,id?ne(savedViews.id,id):undefined)).limit(1);
    if(duplicate)return {error:'duplicate'} as const;
    if(input.action==='update'){
      const [view]=await tx.update(savedViews).set({name:input.name,filters:input.filters,columns:input.columns,revision:input.expectedRevision+1})
        .where(and(scope,eq(savedViews.id,input.id))).returning(viewFields(input.kind,actorId,shared?.workspaceId));
      return {view:publicView(view)} as const;
    }
    const [total]=await tx.select({count:count()}).from(savedViews).where(scope);
    if(total.count>=portableSavedViewLimit)return {error:'limit'} as const;
    const [view]=await tx.insert(savedViews).values({
      workspaceId,id:crypto.randomUUID(),kind:input.kind,name:input.name,filters:input.filters,columns:input.columns,revision:1,
      ...(shared?{shared:true,authorId:actorId}:{}),
    }).returning(fields);
    return {view:publicView(view)} as const;
  });
}
