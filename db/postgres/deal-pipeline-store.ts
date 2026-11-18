import {and,asc,count,eq,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableStageCustomId,portableStageProbability,type DealPipeline,type PipelineStage,type PipelineWrite} from '../../lib/portable-deal-pipelines';
import {dealPipelines as pipelines,dealPipelineStages as stages} from './deal-pipeline-schema';
import {privateWorkspaces} from './workspace-schema';
import {listDealStageCustomFields} from './custom-property-store';
import {recordWorkspaceScope} from './workspace-viewer-store';

const stageFields={id:stages.id,name:stages.name,outcome:stages.outcome,probability:stages.probability,requiredProperties:stages.requiredProperties};
type StoredStage=Pick<typeof stages.$inferSelect,keyof typeof stageFields>;
function displayStage({requiredProperties,probability,...stage}:StoredStage):PipelineStage{
  return {...stage,probability:portableStageProbability(stage.outcome,probability),...(requiredProperties.length?{requiredProperties}:{})};
}
const pipelineFields={id:pipelines.id,name:pipelines.name,revision:pipelines.revision};

export async function readDealPipelines(db:PostgresJsDatabase,actorId:string,workspaceId?:string){
  const rows=await db.select({pipeline:pipelineFields,stage:stageFields}).from(pipelines)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,pipelines.workspaceId))
    .innerJoin(stages,and(eq(stages.workspaceId,pipelines.workspaceId),eq(stages.pipelineId,pipelines.id)))
    .where(recordWorkspaceScope(db,actorId,workspaceId))
    .orderBy(asc(pipelines.name),asc(pipelines.id),asc(stages.position)).limit(200);
  const results=new Map<string,DealPipeline>();
  for(const {pipeline,stage} of rows){
    let entry=results.get(pipeline.id);
    if(!entry){entry={...pipeline,stages:[]};results.set(pipeline.id,entry);}
    entry.stages.push(displayStage(stage));
  }
  return [...results.values()];
}

type SaveResult={pipeline:DealPipeline}|{error:'missing'|'stale'|'duplicate'|'limit'|'stages'|'properties'};

export function saveDealPipeline(db:PostgresJsDatabase,actorId:string,input:PipelineWrite):Promise<SaveResult>{
  return db.transaction(async tx=>{
    const updating='id' in input;
    if(!updating){
      if(input.stages.some(stage=>stage.id))return {error:'stages'};
      await tx.insert(privateWorkspaces).values({id:crypto.randomUUID(),ownerId:actorId})
        .onConflictDoNothing({target:privateWorkspaces.ownerId});
    }
    // The workspace lock serializes the name/cap checks across concurrent settings changes.
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.ownerId,actorId)).for('no key update');
    if(!workspace)return {error:'missing'};
    const scope=eq(pipelines.workspaceId,workspace.id);
    const pipelineId=updating?input.id:crypto.randomUUID();
    const target=and(scope,eq(pipelines.id,pipelineId));
    const stageScope=and(eq(stages.workspaceId,workspace.id),eq(stages.pipelineId,pipelineId));
    const previousStages=new Map<string,StoredStage>();
    if(updating){
      const [current]=await tx.select({revision:pipelines.revision}).from(pipelines).where(target);
      if(!current)return {error:'missing'};
      if(current.revision!==input.expectedRevision)return {error:'stale'};
      const existing=await tx.select(stageFields).from(stages).where(stageScope);
      for(const stage of existing)previousStages.set(stage.id,stage);
      const supplied=new Set(input.stages.flatMap(stage=>stage.id?[stage.id]:[]));
      if(existing.length!==supplied.size||existing.some(stage=>!supplied.has(stage.id)))return {error:'stages'};
    }else{
      const [total]=await tx.select({count:count()}).from(pipelines).where(scope);
      if(total.count>=10)return {error:'limit'};
    }
    const [duplicate]=await tx.select({id:pipelines.id}).from(pipelines)
      .where(and(scope,ne(pipelines.id,pipelineId),sql`lower(${pipelines.name})=lower(${input.name})`)).limit(1);
    if(duplicate)return {error:'duplicate'};
    const suppliedRules=input.stages.flatMap(stage=>stage.requiredProperties??[]);
    const customFields=await listDealStageCustomFields(tx,workspace.id,suppliedRules);
    const customIds=new Set(customFields.map(field=>field.id));
    if(suppliedRules.some(({field})=>{
      const id=portableStageCustomId(field);
      return id&&!customIds.has(id);
    }))return {error:'properties'};
    const revision=updating?input.expectedRevision+1:1;
    if(updating)await tx.update(pipelines).set({name:input.name,revision}).where(target);
    else await tx.insert(pipelines).values({workspaceId:workspace.id,id:pipelineId,name:input.name,revision});
    const saved=[];
    for(const [position,stage] of input.stages.entries()){
      const id=stage.id??crypto.randomUUID();
      const previous=previousStages.get(id);
      const requiredProperties=stage.requiredProperties??previous?.requiredProperties??[];
      const probability=portableStageProbability(stage.outcome,stage.probability??(previous?.outcome===stage.outcome?previous.probability:null));
      const values={name:stage.name,outcome:stage.outcome,position,probability,requiredProperties};
      if(stage.id)await tx.update(stages).set(values).where(and(stageScope,eq(stages.id,id)));
      else await tx.insert(stages).values({...values,id,workspaceId:workspace.id,pipelineId});
      saved.push(displayStage({id,name:stage.name,outcome:stage.outcome,probability,requiredProperties}));
    }
    return {pipeline:{id:pipelineId,name:input.name,revision,stages:saved}};
  });
}
