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
import {recordWorkspaceScope} from './workspace-viewer-store';

type Db=PostgresJsDatabase;
type Endpoint={kind:PortableRecordKind;id:string};
const tables={companies,contacts,deals};
const endpointKey=(endpoint:Endpoint)=>endpoint.kind+'/'+endpoint.id;
const matchesFirst=({kind,id}:Endpoint)=>and(eq(links.firstKind,kind),eq(links.firstId,id));
const matchesSecond=({kind,id}:Endpoint)=>and(eq(links.secondKind,kind),eq(links.secondId,id));
const touches=(endpoint:Endpoint)=>or(matchesFirst(endpoint),matchesSecond(endpoint));
const pageSize=25;
const activeRecord={contacts:activeContact,companies:activeCompany,deals:activeDeal};
const activeEndpoint=(db:Db,kind:SQLWrapper,id:SQLWrapper)=>and(or(ne(kind,'contacts'),exists(
  db.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,links.workspaceId),eq(contacts.id,id),activeContact)),
)),or(ne(kind,'companies'),exists(
  db.select({id:companies.id}).from(companies).where(and(eq(companies.workspaceId,links.workspaceId),eq(companies.id,id),activeCompany)),
)),or(ne(kind,'deals'),exists(
  db.select({id:deals.id}).from(deals).where(and(eq(deals.workspaceId,links.workspaceId),eq(deals.id,id),activeDeal)),
)));
const activeLink=(db:Db)=>sql<boolean>`(${activeEndpoint(db,links.firstKind,links.firstId)}) AND (${activeEndpoint(db,links.secondKind,links.secondId)})`;

async function names(db:Db,workspaceId:string,kind:PortableRecordKind,ids:string[],activeOnly=false){
  if(!ids.length)return [];
  const table=tables[kind];
  return db.select({id:table.id,name:sql<string>`${table.data}->>'name'`}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),inArray(table.id,ids),activeOnly?activeRecord[kind]:undefined));
}

export function readPortableAssociations(db:Db,actorId:string,source:PortableAssociationQuery){
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(recordWorkspaceScope(tx,actorId,source.workspaceId)).limit(1);
    if(!workspace||!(await names(tx,workspace.id,source.kind,[source.id],true)).length)return null;
    const rows=await tx.select().from(links).where(and(eq(links.workspaceId,workspace.id),touches(source),activeLink(tx),
      source.after?gt(links.id,source.after):undefined)).orderBy(asc(links.id)).limit(pageSize+1);
    const page=rows.slice(0,pageSize).map(row=>{
      const target=row.firstKind===source.kind&&row.firstId===source.id
        ?{kind:row.secondKind,id:row.secondId}:{kind:row.firstKind,id:row.firstId};
      return {id:row.id,target,labels:row.labels};
    });
    const targets=new Map<string,string>();
    await Promise.all(portableRecordKind.options.map(async kind=>{
      const matches=await names(tx,workspace.id,kind,page.filter(row=>row.target.kind===kind).map(row=>row.target.id));
      for(const {id,name} of matches)targets.set(endpointKey({kind,id}),name);
    }));
    const items=page.flatMap(row=>{
      const name=targets.get(endpointKey(row.target));
      return name===undefined?[]:[{...row,target:{...row.target,name}}];
    });
    return {items,next:rows.length>pageSize?page.at(-1)!.id:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function changePortableAssociation(db:Db,actorId:string,source:Endpoint,action:PortableAssociationAction,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    // Serialize pair creation and removal, including identical retries in either direction.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)return shared?'access':'missing';
    if(!(await names(tx,workspaceId,source.kind,[source.id],true)).length)return 'missing';
    if(action.action==='unlink'){
      const scope=and(eq(links.workspaceId,workspaceId),eq(links.id,action.linkId),touches(source));
      const [existing]=await tx.select({active:activeLink(tx)}).from(links).where(scope).limit(1);
      if(existing&&!existing.active)return 'missing';
      if(existing)await tx.delete(links).where(scope);
      return 'removed';
    }
    const {target,labels}=action,sourceKey=endpointKey(source),targetKey=endpointKey(target);
    if(sourceKey===targetKey)return 'self';
    if(!(await names(tx,workspaceId,target.kind,[target.id],true)).length)return 'missing';
    const [first,second]=sourceKey<targetKey?[source,target]:[target,source];
    const [existing]=await tx.select({labels:links.labels}).from(links)
      .where(and(eq(links.workspaceId,workspaceId),matchesFirst(first),matchesSecond(second)));
    if(existing)return JSON.stringify(existing.labels)===JSON.stringify(labels)?'linked':'conflict';
    await tx.insert(links).values({workspaceId,id:crypto.randomUUID(),firstKind:first.kind,firstId:first.id,
      secondKind:second.kind,secondId:second.id,labels});
    return 'linked';
  });
}
