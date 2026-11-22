import {effectiveMemberToolPolicy} from '../../lib/portable-tool-permissions';
import {sharedToolAllowed} from './shared-tool-permission';
import {portableReportKinds} from '../../lib/portable-reports';
import type {RecordAccessActor} from './record-access-store';
import {hiddenStandardFields} from './standard-property-access';
import {hiddenPropertyIds} from './record-property-access';
import {and,asc,eq,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {summarizeCustomObjectRecords} from './custom-object-store';
import {objectTypes} from './custom-object-schema';
import {isReportField,objectSumField,reportValueLabel,type ObjectDefinition} from '../../lib/portable-custom-objects';
import {dashboardCardKey,filteredDashboardReport,type PortableDashboardFilters} from '../../lib/portable-dashboards';
import type {PortableDashboard,PortableDashboardDetail,PortableDashboardRead,PortableDashboardWrite} from '../../lib/portable-dashboards';
import {portableDashboards as dashboards} from './portable-dashboard-schema';
import {portableReports as reports} from './portable-report-schema';
import {evaluatePortableReport,readPortableReportRecords} from './portable-report-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordCatalogScope,sharedWorkspaceGrant} from './workspace-viewer-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

const dashboardKey=(workspaceId:string,id:string)=>and(eq(dashboards.workspaceId,workspaceId),eq(dashboards.id,id));
const fields={id:dashboards.id,revision:dashboards.revision,definition:dashboards.definition,teamVisible:dashboards.teamVisible,updatedAt:dashboards.updatedAt};
function dashboardScope(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  return and(recordCatalogScope(db,actorId,workspaceId),workspaceId?eq(dashboards.teamVisible,true):undefined);
}
async function visibleReport(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  if(!workspaceId)return undefined;
  const grant=await sharedWorkspaceGrant(db,actorId,workspaceId,true);
  if(!grant||effectiveMemberToolPolicy(grant,'reports').view==='none')return sql`false`;
  const readable=portableReportKinds.filter(kind=>effectiveMemberToolPolicy(grant,kind).view!=='none');
  if(!readable.length)return sql`false`;
  return sql`${reports.definition}->>'kind' IN (${sql.join(readable.map(kind=>sql`${kind}::text`),sql`,`)})
    AND (${reports.definition}->>'metric' <> 'sum' OR 'amount' NOT IN (${hiddenStandardFields(workspaceId,'deals',actorId)}))
    AND coalesce(${reports.definition}->>'groupBy','') NOT IN (
      SELECT 'associated:' || id FROM (${hiddenStandardFields(workspaceId,'companies',actorId)}) AS hidden(id))
    AND coalesce(${reports.definition}->'filter'->>'field','') NOT IN (${hiddenStandardFields(workspaceId,sql`${reports.definition}->>'kind'`,actorId)})
    AND lower(coalesce(${reports.definition}->'customFilter'->>'propertyId','')) NOT IN (${hiddenPropertyIds(workspaceId,sql`${reports.definition}->>'kind'`,actorId)})`;
}

export async function listPortableDashboards(db:PostgresJsDatabase,actorId:string,query:Extract<PortableDashboardRead,{view:'dashboards'}>){
  if(!await sharedToolAllowed(db,actorId,query.workspaceId,'dashboards'))return null;
  const titleMatch=query.search?sql`strpos(lower((${dashboards.definition}->>'name') COLLATE pg_catalog.pg_unicode_fast),
    lower(${query.search}::text COLLATE pg_catalog.pg_unicode_fast))>0`:undefined;
  const rows=await db.select(fields).from(dashboards).innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
    .where(and(dashboardScope(db,actorId,query.workspaceId),titleMatch,query.after?gt(dashboards.id,query.after):undefined))
    .orderBy(asc(dashboards.id)).limit(query.limit+1);
  const canSeeCards=await sharedToolAllowed(db,actorId,query.workspaceId,'reports');
  const items=rows.slice(0,query.limit).map(row=>canSeeCards?row:{...row,definition:{...row.definition,cards:[]}});
  return {items,next:rows.length>query.limit?items.at(-1)!.id:null};
}

export async function listSharedReports(db:PostgresJsDatabase,actorId:string,workspaceId:string,
  query:{after?:string;search?:string;limit:number}){
  if(!await sharedToolAllowed(db,actorId,workspaceId,'reports'))return null;
  if(!await sharedToolAllowed(db,actorId,workspaceId,'dashboards'))return {items:[],next:null};
  const title=sql<string>`${reports.definition}->>'name'`;
  const matches=query.search?sql`strpos(lower((${title}) COLLATE pg_catalog.pg_unicode_fast),
    lower(${query.search}::text COLLATE pg_catalog.pg_unicode_fast))>0`:undefined;
  const rows=await db.selectDistinctOn([reports.id],{id:reports.id,name:title,dashboardId:dashboards.id,
    dashboardName:sql<string>`${dashboards.definition}->>'name'`}).from(dashboards)
    .innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
    .innerJoin(sql`lateral jsonb_array_elements(${dashboards.definition}->'cards') as card(value)`,sql`true`)
    .innerJoin(reports,and(eq(reports.workspaceId,dashboards.workspaceId),sql`${reports.id}=(card.value->>'reportId')::uuid`))
    .where(and(dashboardScope(db,actorId,workspaceId),await visibleReport(db,actorId,workspaceId),matches,
      query.after?gt(reports.id,query.after):undefined))
    .orderBy(asc(reports.id),asc(dashboards.id)).limit(query.limit+1);
  const items=rows.slice(0,query.limit);
  return {items,next:rows.length>query.limit?items.at(-1)!.id:null};
}

function groupField(def:ObjectDefinition,id:string|undefined){
  return id?def.fields.find(f=>f.id===id&&isReportField(f)):undefined;
}
export function readPortableDashboard(db:PostgresJsDatabase,actorId:string,id:string,sharedWorkspaceId?:string,filters:PortableDashboardFilters={}):Promise<PortableDashboardDetail|null>{
  return db.transaction(async tx=>{
    if(!await sharedToolAllowed(tx,actorId,sharedWorkspaceId,'dashboards'))return null;
    const [found]=await tx.select({item:fields,workspaceId:dashboards.workspaceId}).from(dashboards)
      .innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
      .where(and(dashboardScope(tx,actorId,sharedWorkspaceId),eq(dashboards.id,id))).limit(1);
    if(!found)return null;
    const {item,workspaceId}=found;
    if(!await sharedToolAllowed(tx,actorId,sharedWorkspaceId,'reports'))return {item:{...item,definition:{...item.definition,cards:[]}},cards:[]};
    const ids=item.definition.cards.flatMap(card=>'reportId' in card?[card.reportId]:[]);
    const objectIds=item.definition.cards.flatMap(card=>'objectId' in card?[card.objectId]:[]);
    const grant=sharedWorkspaceId&&objectIds.length?await sharedWorkspaceGrant(tx,actorId,sharedWorkspaceId,true):undefined;
    const canReadObjects=!sharedWorkspaceId||!!grant&&effectiveMemberToolPolicy(grant,'custom-objects').view!=='none';
    const objects=objectIds.length&&canReadObjects?await tx.select().from(objectTypes).where(and(eq(objectTypes.workspaceId,workspaceId),inArray(objectTypes.id,objectIds))):[];
    const saved=ids.length?await tx.select({id:reports.id,definition:reports.definition}).from(reports)
      .innerJoin(workspaces,eq(workspaces.id,reports.workspaceId))
      .where(and(eq(reports.workspaceId,workspaceId),inArray(reports.id,ids),await visibleReport(tx,actorId,sharedWorkspaceId))):[];
    const byId=new Map(saved.map(report=>[report.id,report.definition]));
    const cards:PortableDashboardDetail['cards']=[];
    for(const card of item.definition.cards){
      if('objectId' in card){
        const object=objects.find(o=>o.id===card.objectId);
        const field=object&&groupField(object.definition,card.by);
        const measure=object&&objectSumField(object.definition,card.sum);
        if(!object||card.by&&!field||card.sum&&!measure){cards.push({...card,missing:true});continue;}
        const summary=await summarizeCustomObjectRecords(tx,actorId,workspaceId,card.objectId,!!sharedWorkspaceId,field?.id,measure?.id);
        cards.push({...card,missing:false,custom:{name:object.definition.name,fieldLabel:field?.label,total:summary.total,...(measure?{sumLabel:measure.label,sum:summary.sum}:{}),
          groups:field?summary.groups.map(row=>({...row,label:reportValueLabel(field,row.value)})):[]}});
        continue;
      }
      const definition=byId.get(card.reportId);
      if(!definition){cards.push({...card,missing:true});continue;}
      const scoped=filteredDashboardReport(definition,filters);
      const result=scoped?await evaluatePortableReport(tx,actorId,scoped,undefined,sharedWorkspaceId):
        {count:'0',total:definition.metric==='count'?'0':null,rows:[],truncated:false};
      cards.push({...card,missing:false,definition,result});
    }
    return {item,cards};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function readDashboardRecords(db:PostgresJsDatabase,actor:RecordAccessActor,query:Extract<PortableDashboardRead,{view:'dashboardRecords'}>,includeBody:boolean){
  const actorId=actor.userId;
  return db.transaction(async tx=>{
    if(!await sharedToolAllowed(tx,actorId,query.workspaceId,'dashboards'))return null;
    const [found]=await tx.select({definition:reports.definition}).from(dashboards)
      .innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
      .innerJoin(reports,and(eq(reports.workspaceId,dashboards.workspaceId),eq(reports.id,query.reportId)))
      .where(and(dashboardScope(tx,actorId,query.workspaceId),eq(dashboards.id,query.id),await visibleReport(tx,actorId,query.workspaceId),
        sql`(${dashboards.definition}->'cards') @> jsonb_build_array(jsonb_build_object('reportId',${query.reportId}::text))`)).limit(1);
    if(!found||(query.group!==undefined&&!found.definition.groupBy))return null;
    const scoped=filteredDashboardReport(found.definition,query);
    return scoped?readPortableReportRecords(tx,actor,scoped,query,includeBody):{kind:found.definition.kind,records:[],next:null};
  },{isolationLevel:'repeatable read'});
}

type MutationResult={item:PortableDashboard}|{deleted:true}|{error:'missing'|'stale'|'report_missing'};
export function writePortableDashboard(db:PostgresJsDatabase,actorId:string,input:PortableDashboardWrite):Promise<MutationResult>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,!('id' in input));
    if(!workspaceId)return {error:'missing'};
    const scope='id' in input?dashboardKey(workspaceId,input.id):undefined;
    const [current]=scope?await tx.select(fields).from(dashboards).where(scope).for('update'):[];
    if('id' in input){
      if(!current)return {error:'missing'};
      if(current.revision!==input.revision)return {error:'stale'};
    }
    if(input.action==='deleteDashboard'){
      await tx.delete(dashboards).where(dashboardKey(workspaceId,input.id));
      return {deleted:true};
    }

    // Missing old cards can remain until the owner removes them. A new card
    // must refer to a report in this workspace when the write commits.
    const previous=new Set(current?.definition.cards.map(dashboardCardKey));
    const additions=input.definition.cards.filter(card=>!previous.has(dashboardCardKey(card)));
    const custom=additions.filter(card=>'objectId' in card);
    if(custom.length){
      const types=await tx.select().from(objectTypes).where(and(eq(objectTypes.workspaceId,workspaceId),
        inArray(objectTypes.id,custom.map(card=>card.objectId)))).for('share');
      for(const card of custom){
        const type=types.find(t=>t.id===card.objectId);
        if(!type||card.by&&!groupField(type.definition,card.by)||card.sum&&!objectSumField(type.definition,card.sum))return {error:'report_missing'};
      }
    }
    const added=additions.flatMap(card=>'reportId' in card?[card.reportId]:[]);
    if(added.length){
      const attached=await tx.select({id:reports.id}).from(reports)
        .where(and(eq(reports.workspaceId,workspaceId),inArray(reports.id,added))).orderBy(asc(reports.id)).for('key share');
      if(attached.length!==added.length)return {error:'report_missing'};
    }
    const updatedAt=new Date().toISOString();
    if(current){
      const [item]=await tx.update(dashboards).set({definition:input.definition,teamVisible:input.teamVisible,revision:current.revision+1,updatedAt})
        .where(dashboardKey(workspaceId,current.id)).returning(fields);
      return {item};
    }
    const [item]=await tx.insert(dashboards).values({workspaceId,id:crypto.randomUUID(),revision:1,definition:input.definition,teamVisible:input.teamVisible,updatedAt})
      .returning(fields);
    return {item};
  });
}
