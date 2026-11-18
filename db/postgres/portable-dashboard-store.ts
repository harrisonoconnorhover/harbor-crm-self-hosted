import {and,asc,eq,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableDashboard,PortableDashboardDetail,PortableDashboardRead,PortableDashboardWrite} from '../../lib/portable-dashboards';
import {portableDashboards as dashboards} from './portable-dashboard-schema';
import {portableReports as reports} from './portable-report-schema';
import {evaluatePortableReport,readPortableReportRecords} from './portable-report-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordWorkspaceScope,sharedWorkspaceGrant} from './workspace-viewer-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

const dashboardKey=(workspaceId:string,id:string)=>and(eq(dashboards.workspaceId,workspaceId),eq(dashboards.id,id));
const fields={id:dashboards.id,revision:dashboards.revision,definition:dashboards.definition,teamVisible:dashboards.teamVisible,updatedAt:dashboards.updatedAt};
function dashboardScope(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  return and(recordWorkspaceScope(db,actorId,workspaceId),workspaceId?eq(dashboards.teamVisible,true):undefined);
}
export async function listPortableDashboards(db:PostgresJsDatabase,actorId:string,query:Extract<PortableDashboardRead,{view:'dashboards'}>){
  if(query.workspaceId&&!await sharedWorkspaceGrant(db,actorId,query.workspaceId))return null;
  const titleMatch=query.search?sql`strpos(lower((${dashboards.definition}->>'name') COLLATE pg_catalog.pg_unicode_fast),
    lower(${query.search}::text COLLATE pg_catalog.pg_unicode_fast))>0`:undefined;
  const rows=await db.select(fields).from(dashboards).innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
    .where(and(dashboardScope(db,actorId,query.workspaceId),titleMatch,query.after?gt(dashboards.id,query.after):undefined))
    .orderBy(asc(dashboards.id)).limit(query.limit+1);
  const items=rows.slice(0,query.limit);
  return {items,next:rows.length>query.limit?items.at(-1)!.id:null};
}

export function readPortableDashboard(db:PostgresJsDatabase,actorId:string,id:string,sharedWorkspaceId?:string):Promise<PortableDashboardDetail|null>{
  return db.transaction(async tx=>{
    const [found]=await tx.select({item:fields,workspaceId:dashboards.workspaceId}).from(dashboards)
      .innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
      .where(and(dashboardScope(tx,actorId,sharedWorkspaceId),eq(dashboards.id,id))).limit(1);
    if(!found)return null;
    const {item,workspaceId}=found;
    const ids=item.definition.cards.map(card=>card.reportId);
    const saved=ids.length?await tx.select({id:reports.id,definition:reports.definition}).from(reports)
      .where(and(eq(reports.workspaceId,workspaceId),inArray(reports.id,ids))):[];
    const byId=new Map(saved.map(report=>[report.id,report.definition]));
    const cards:PortableDashboardDetail['cards']=[];
    for(const card of item.definition.cards){
      const definition=byId.get(card.reportId);
      cards.push(definition?{...card,missing:false,definition,result:await evaluatePortableReport(tx,actorId,definition,undefined,sharedWorkspaceId)}:
        {...card,missing:true});
    }
    return {item,cards};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function readDashboardRecords(db:PostgresJsDatabase,actorId:string,query:Extract<PortableDashboardRead,{view:'dashboardRecords'}>){
  return db.transaction(async tx=>{
    const [found]=await tx.select({definition:reports.definition}).from(dashboards)
      .innerJoin(workspaces,eq(workspaces.id,dashboards.workspaceId))
      .innerJoin(reports,and(eq(reports.workspaceId,dashboards.workspaceId),eq(reports.id,query.reportId)))
      .where(and(dashboardScope(tx,actorId,query.workspaceId),eq(dashboards.id,query.id),
        sql`(${dashboards.definition}->'cards') @> jsonb_build_array(jsonb_build_object('reportId',${query.reportId}::text))`)).limit(1);
    if(!found||(query.group!==undefined&&!found.definition.groupBy))return null;
    return readPortableReportRecords(tx,actorId,found.definition,query);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
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
    const previous=new Set(current?.definition.cards.map(card=>card.reportId));
    const added=input.definition.cards.map(card=>card.reportId).filter(id=>!previous.has(id));
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
