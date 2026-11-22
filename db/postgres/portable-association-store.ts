import {recordPreviewAccess,type RecordAccessActor} from './record-access-store';
import {and,asc,eq,exists,gt,inArray,ne,or,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableAssociationAction,PortableAssociationQuery} from '../../lib/portable-associations';
import {portableRecordKind,type PortableRecordKind} from '../../lib/portable-records';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {deals} from './deal-schema';
import {portableAssociations as links} from './portable-association-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {ownedRecordScope} from './record-ownership-scope';
import {recordWorkspaceScope,sharedWorkspaceGrant} from './workspace-viewer-store';

type Db=PostgresJsDatabase;
type Endpoint={kind:PortableRecordKind;id:string};
const tables={companies,contacts,deals};
const endpointKey=(endpoint:Endpoint)=>endpoint.kind+'/'+endpoint.id;
const matchesFirst=({kind,id}:Endpoint)=>and(eq(links.firstKind,kind),eq(links.firstId,id));
const matchesSecond=({kind,id}:Endpoint)=>and(eq(links.secondKind,kind),eq(links.secondId,id));
const touches=(endpoint:Endpoint)=>or(matchesFirst(endpoint),matchesSecond(endpoint));
const pageSize=25;
const activeRecord={contacts:activeContact,companies:activeCompany,deals:activeDeal};
type MemberScope={actorId:string;workspaceId:string};
const activeEndpoint=(db:Db,kind:SQLWrapper,id:SQLWrapper,member?:MemberScope)=>and(or(ne(kind,'contacts'),exists(
  db.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,links.workspaceId),eq(contacts.id,id),activeContact,member?ownedRecordScope(db,member.actorId,member.workspaceId,contacts):undefined)),
)),or(ne(kind,'companies'),exists(
  db.select({id:companies.id}).from(companies).where(and(eq(companies.workspaceId,links.workspaceId),eq(companies.id,id),activeCompany,member?ownedRecordScope(db,member.actorId,member.workspaceId,companies):undefined)),
)),or(ne(kind,'deals'),exists(
  db.select({id:deals.id}).from(deals).where(and(eq(deals.workspaceId,links.workspaceId),eq(deals.id,id),activeDeal,member?ownedRecordScope(db,member.actorId,member.workspaceId,deals):undefined)),
)));
const activeLink=(db:Db,member?:MemberScope)=>sql<boolean>`(${activeEndpoint(db,links.firstKind,links.firstId,member)}) AND (${activeEndpoint(db,links.secondKind,links.secondId,member)})`;

async function names(db:Db,workspaceId:string,kind:PortableRecordKind,ids:string[],member?:MemberScope,mode:'view'|'edit'='view',includeEdit=false){
  if(!ids.length)return [];
  const table=tables[kind];
  return db.select({id:table.id,name:sql<string>`${table.data}->>'name'`,
    editable:includeEdit&&member?sql<boolean>`${ownedRecordScope(db,member.actorId,workspaceId,table,'edit')}`:sql<boolean>`true`}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),inArray(table.id,ids),activeRecord[kind],member?ownedRecordScope(db,member.actorId,workspaceId,table,mode):undefined));
}

export function readPortableAssociations(db:Db,actor:RecordAccessActor,source:PortableAssociationQuery,includeBody:boolean){
  const actorId=actor.userId;
  return db.transaction(async tx=>{
    const member=source.workspaceId?{actorId,workspaceId:source.workspaceId}:undefined;
    const grant=member?await sharedWorkspaceGrant(tx,actorId,member.workspaceId,true):undefined;
    if(member&&!grant)return null;
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(member?eq(privateWorkspaces.id,member.workspaceId):recordWorkspaceScope(tx,actorId)).limit(1);
    if(!workspace||!(await names(tx,workspace.id,source.kind,[source.id],member)).length)return null;
    const rows=await tx.select().from(links).where(and(eq(links.workspaceId,workspace.id),touches(source),activeLink(tx,member),
      source.after?gt(links.id,source.after):undefined)).orderBy(asc(links.id)).limit(pageSize+1);
    const page=rows.slice(0,pageSize).map(row=>{
      const target=row.firstKind===source.kind&&row.firstId===source.id
        ?{kind:row.secondKind,id:row.secondId}:{kind:row.firstKind,id:row.firstId};
      return {id:row.id,target,labels:row.labels};
    });
    const limitedEdit=grant?.role==='editor'&&(grant.editScope!=='all'||Object.keys(grant.toolPolicies).length>0);
    const targets=new Map<string,{name:string;editable:boolean}>();
    await Promise.all(portableRecordKind.options.map(async kind=>{
      const matches=await names(tx,workspace.id,kind,page.filter(row=>row.target.kind===kind).map(row=>row.target.id),member,'view',limitedEdit);
      for(const {id,name,editable} of matches)targets.set(endpointKey({kind,id}),{name,editable});
    }));
    const items=page.flatMap(row=>{
      const target=targets.get(endpointKey(row.target));
      return target?[{...row,target:{...row.target,name:target.name},...(!target.editable?{readOnly:true}:{})}]:[];
    });
    if(includeBody)await recordPreviewAccess(tx,actor,'related',items.map(item=>item.target),workspace.id);
    return {items,next:rows.length>pageSize?page.at(-1)!.id:null};
  },{isolationLevel:'repeatable read'});
}

export function changePortableAssociation(db:Db,actorId:string,source:Endpoint,action:PortableAssociationAction,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    // Serialize pair creation and removal, including identical retries in either direction.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true,true);
    if(!workspaceId)return shared?'access':'missing';
    const member=shared?{actorId,workspaceId}:undefined;
    const writable=async (endpoint:Endpoint)=>(await names(tx,workspaceId,endpoint.kind,[endpoint.id],member,'edit')).length>0;
    if(!await writable(source))return 'missing';
    if(action.action!=='link'){
      const scope=and(eq(links.workspaceId,workspaceId),eq(links.id,action.linkId),touches(source));
      const [existing]=await tx.select().from(links).where(scope).limit(1).for('update');
      if(existing){
        const other=existing.firstKind===source.kind&&existing.firstId===source.id
          ?{kind:existing.secondKind,id:existing.secondId}:{kind:existing.firstKind,id:existing.firstId};
        if(!await writable(other))return 'missing';
        if(action.expectedLabels&&JSON.stringify(existing.labels)!==JSON.stringify(action.expectedLabels))return 'stale';
        if(action.action==='relabel'){
          await tx.update(links).set({labels:action.labels}).where(scope);
          return 'relabeled';
        }
        await tx.delete(links).where(scope);
      }
      return action.action==='unlink'?'removed':'stale';
    }
    const {target,labels}=action,sourceKey=endpointKey(source),targetKey=endpointKey(target);
    if(sourceKey===targetKey)return 'self';
    if(!await writable(target))return 'missing';
    const [first,second]=sourceKey<targetKey?[source,target]:[target,source];
    const [existing]=await tx.select({labels:links.labels}).from(links)
      .where(and(eq(links.workspaceId,workspaceId),matchesFirst(first),matchesSecond(second)));
    if(existing)return JSON.stringify(existing.labels)===JSON.stringify(labels)?'linked':'conflict';
    await tx.insert(links).values({workspaceId,id:crypto.randomUUID(),firstKind:first.kind,firstId:first.id,
      secondKind:second.kind,secondId:second.id,labels});
    return 'linked';
  });
}
