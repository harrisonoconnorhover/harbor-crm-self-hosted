import {canEditAssignedRecord,toolLevel} from './member-tool-access';
import {and,asc,eq,inArray,isNull,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {offsetForecastMonth,quarterMonths,type ForecastScope,type GoalWrite} from '../../lib/portable-forecast';
import {listPortableStandardAccess} from './standard-property-access';
import {deals} from './deal-schema';
import {activeDeal} from './deal-visibility';
import {ownedRecordScope} from './record-ownership-scope';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {dealPipelines,forecastGoals as goals} from './deal-pipeline-schema';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {activeWorkspaceAssignee} from './workspace-assignee-store';

export async function canReadSharedForecast(db:PostgresJsDatabase,actorId:string,workspaceId:string){
  const [grant]=await db.select({view:toolLevel('deals','view')}).from(workspaceViewers).where(and(eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.workspaceId,workspaceId)));
  if(!grant||grant.view==='none')return false;
  const fields=await listPortableStandardAccess(db,actorId,'deals',workspaceId);
  return ['amount','closeDate'].every(id=>fields.some(field=>field.id===id));
}

// Shared readers choose among current owners on deals their grant actually exposes.
export function visibleForecastOwners(db:PostgresJsDatabase,actorId:string,workspaceId:string){
  const id=sql<string>`${deals.data}->'recordOwner'->>'userId'`;
  const label=sql<string>`max(${deals.data}->'recordOwner'->>'label')`;
  const editors=db.select({id:workspaceViewers.viewerId}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.role,'editor'),canEditAssignedRecord('deals')));
  return db.select({id,label}).from(deals).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,deals.workspaceId))
    .where(and(eq(deals.workspaceId,workspaceId),activeDeal,ownedRecordScope(db,actorId,workspaceId,deals),
      or(eq(id,privateWorkspaces.ownerId),inArray(id,editors))))
    .groupBy(id).orderBy(asc(label),asc(id));
}

function key(workspaceId:string,actorId:string,scope:ForecastScope){
  return {workspaceId,month:scope.month,period:scope.period,pipelineId:scope.pipelineId==='default'?null:scope.pipelineId,
    ownerId:scope.owner==='all'?null:scope.owner==='mine'?actorId:scope.owner};
}
export async function readForecastGoal(db:PostgresJsDatabase,workspaceId:string,actorId:string,scope:ForecastScope,includeOverlaps=false){
  const k=key(workspaceId,actorId,scope);
  // Only four other three-month windows can overlap the selected quarter.
  const months=includeOverlaps&&scope.period==='quarter'?[-2,-1,0,1,2].map(n=>offsetForecastMonth(k.month,n)):[k.month];
  const rows=await db.select({month:goals.month,amountCents:goals.amountCents,revision:goals.revision}).from(goals)
    .where(and(eq(goals.workspaceId,workspaceId),inArray(goals.month,months),eq(goals.period,k.period),k.pipelineId?eq(goals.pipelineId,k.pipelineId):isNull(goals.pipelineId),
      k.ownerId?eq(goals.ownerId,k.ownerId):isNull(goals.ownerId))).orderBy(asc(goals.month));
  const current=rows.find(row=>row.month===k.month);
  return {amountCents:current?.amountCents??null,revision:current?.revision??0,
    overlappingGoals:rows.flatMap(row=>row.month!==k.month&&row.amountCents!==null?
      [{from:row.month,through:offsetForecastMonth(row.month,2),amountCents:row.amountCents}]:[])};
}
export async function forecastCalendar(db:PostgresJsDatabase,workspaceId:string){
  const [workspace]=await db.select({start:privateWorkspaces.fiscalStartMonth}).from(privateWorkspaces).where(eq(privateWorkspaces.id,workspaceId));
  if(!workspace)throw new ApiError(404,'Workspace unavailable.');
  return workspace.start;
}

export function setForecastCalendar(db:PostgresJsDatabase,actor:PostgresSessionActor,start:number,expectedStart:number){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    const id=await lockRecordWorkspace(tx,actor.userId,true,undefined,undefined,true);
    if(!id)throw new ApiError(403,'Workspace unavailable.');
    const [row]=await tx.update(privateWorkspaces).set({fiscalStartMonth:start})
      .where(and(eq(privateWorkspaces.id,id),eq(privateWorkspaces.fiscalStartMonth,expectedStart)))
      .returning({start:privateWorkspaces.fiscalStartMonth});
    if(!row)throw new ApiError(409,'The fiscal calendar changed. Reload before saving.');
    return row;
  });
}

export function saveForecastGoal(db:PostgresJsDatabase,actor:PostgresSessionActor,input:GoalWrite){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    const workspaceId=await lockRecordWorkspace(tx,actor.userId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(403,'Workspace unavailable.');
    let scope:ForecastScope=input;
    if(input.period==='quarter'){
      const start=String(await forecastCalendar(tx,workspaceId));
      if(start!==input.fiscalStartMonth)throw new ApiError(409,'The fiscal calendar changed. Reload before saving the quarter goal.');
      scope={...input,month:quarterMonths(input.month,start).months[0]};
    }
    const k=key(workspaceId,actor.userId,scope);
    if(k.pipelineId){
      const [pipeline]=await tx.select({id:dealPipelines.id}).from(dealPipelines)
        .where(and(eq(dealPipelines.workspaceId,workspaceId),eq(dealPipelines.id,k.pipelineId)));
      if(!pipeline)throw new ApiError(404,'Pipeline unavailable.');
    }
    if(k.ownerId&&!await activeWorkspaceAssignee(tx,workspaceId,k.ownerId,{tool:'deals'}))throw new ApiError(404,'Deal owner unavailable.');
    const previous=await readForecastGoal(tx,workspaceId,actor.userId,scope);
    if(previous.revision!==input.revision)throw new ApiError(409,'The goal changed. Reload to see the saved amount.');
    const values={amountCents:input.amountCents,revision:previous.revision+1};
    await tx.insert(goals).values({...k,...values}).onConflictDoUpdate({
      target:[goals.workspaceId,goals.month,goals.period,goals.pipelineId,goals.ownerId],set:values,
    });
    return values;
  });
}
