import {effectiveMemberToolPolicy} from '../../lib/portable-tool-permissions';
import {and,asc,eq,inArray,isNull,notExists,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {builtinPipeline} from '../../lib/portable-deal-pipelines';
import {dealPipelineStages} from './deal-pipeline-schema';
import {deals} from './deal-schema';
import {activeDeal} from './deal-visibility';
import {activeTask,portableTasks} from './task-schema';
import {privateWorkspaces} from './workspace-schema';
import {hiddenStandardFields} from './standard-property-access';
import {recordWorkspaceScope,sharedWorkspaceGrant} from './workspace-viewer-store';

const openBuiltinStages=builtinPipeline.stages.filter(stage=>stage.outcome==='open').map(stage=>stage.id);

async function followUpRows(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  const stageName=sql<string>`coalesce(${dealPipelineStages.name}, ${deals.data}->>'stage')`;
  const incompleteTask=db.select({id:portableTasks.id}).from(portableTasks)
    .where(and(eq(portableTasks.workspaceId,deals.workspaceId),eq(portableTasks.dealId,deals.id),activeTask,isNull(portableTasks.completedAt)));
  const rows=await db.select({id:deals.id,name:sql<string>`${deals.data}->>'name'`,stage:stageName,createdAt:deals.createdAt})
    .from(deals).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,deals.workspaceId))
    .leftJoin(dealPipelineStages,and(eq(dealPipelineStages.workspaceId,deals.workspaceId),
      eq(dealPipelineStages.pipelineId,deals.pipelineId),eq(dealPipelineStages.id,deals.stageId)))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),activeDeal,
      or(eq(dealPipelineStages.outcome,'open'),and(isNull(deals.pipelineId),inArray(sql<string>`${deals.data}->>'stage'`,openBuiltinStages))),
      sql`NOT coalesce(jsonb_typeof(${deals.data}->'nextStep')='string' AND (${deals.data}->>'nextStep') ~ '[^[:space:]]', false)`,
      notExists(incompleteTask)))
    .orderBy(asc(deals.createdAt),asc(deals.id)).limit(6);
  return {items:rows.slice(0,5),hasMore:rows.length>5};
}

export type DealsWithoutFollowUp=Awaited<ReturnType<typeof followUpRows>>;

export function readDealsWithoutFollowUp(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  if(!workspaceId)return followUpRows(db,actorId);
  // Being on this list tells a teammate that Next step is empty.
  return db.transaction(async tx=>{
    const grant=await sharedWorkspaceGrant(tx,actorId,workspaceId,true);
    if(!grant||effectiveMemberToolPolicy(grant,'deals').view!=='all'||effectiveMemberToolPolicy(grant,'tasks').view!=='all')return undefined;
    const hidden=await tx.execute<{id:string}>(hiddenStandardFields(workspaceId,'deals',actorId));
    if(hidden.some(row=>row.id==='nextStep'))return undefined;
    return followUpRows(tx,actorId,workspaceId);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
