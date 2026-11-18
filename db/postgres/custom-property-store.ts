import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {portableCustomPropertyLimit,portableCustomTextLimit,type PortableCustomPatch,type PortableCustomProperty,type PortableCustomPropertyKind,
  type PortableCustomPropertyWrite,type PortableCustomValues} from '../../lib/portable-custom-properties';
import {portableStageCustomId} from '../../lib/portable-deal-pipelines';
import type {StagePropertyItems} from '../../lib/stage-property-rules';
import {customValue,propertyInput} from '../../lib/workspace';
import {portableCustomProperties as properties} from './custom-property-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';

const columns={id:properties.id,kind:properties.kind,label:properties.label,type:properties.type,
  options:properties.options,revision:properties.revision};
const scope=(workspaceId:string,kind:PortableCustomPropertyKind)=>and(eq(properties.workspaceId,workspaceId),eq(properties.kind,kind));

export async function listPortableCustomProperties(db:PostgresJsDatabase,actorId:string,kind:PortableCustomPropertyKind,workspaceId?:string){
  return db.select(columns).from(properties).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,properties.workspaceId))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),eq(properties.kind,kind)))
    .orderBy(asc(properties.label),asc(properties.id)).limit(portableCustomPropertyLimit);
}

export async function listDealStageCustomFields(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,rules:StagePropertyItems){
  const ids=[...new Set(rules.flatMap(({field})=>portableStageCustomId(field)??[]))];
  return ids.length?db.select({id:properties.id,label:properties.label}).from(properties)
    .where(and(scope(workspaceId,'deals'),inArray(properties.id,ids))):[];
}

export async function savePortableCustomProperty(db:PostgresJsDatabase,actorId:string,input:PortableCustomPropertyWrite):Promise<PortableCustomProperty>{
  return db.transaction(async tx=>{
    if(input.action==='create'){
      const definition=propertyInput.safeParse(input);
      if(!definition.success)throw new ApiError(400,definition.error.issues[0].message);
      if(input.type!=='select'&&input.type!=='multiselect'&&input.options.length)
        throw new ApiError(400,'Only dropdown and multi-select properties use options.');
    }
    // Only definitions use an exclusive workspace lock. Their type and options
    // stay fixed, so normal record writes can validate values without taking it.
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.action==='create',undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Custom property not found.');
    const owned=scope(workspaceId,input.kind);
    const target=input.action==='rename'?and(owned,eq(properties.id,input.id)):undefined;
    const [current]=target?await tx.select(columns).from(properties).where(target):[];
    if(input.action==='rename'){
      if(!current)throw new ApiError(404,'Custom property not found.');
      if(current.revision!==input.expectedRevision)throw new ApiError(409,'This property changed. Reload it before renaming.');
    }
    const [duplicate]=await tx.select({id:properties.id}).from(properties)
      .where(and(owned,sql`lower(${properties.label})=lower(${input.label})`)).limit(1);
    if(duplicate&&duplicate.id!==current?.id)throw new ApiError(409,'A custom property already uses that name.');
    if(current){
      if(current.label===input.label)return current;
      const [updated]=await tx.update(properties).set({label:input.label,revision:current.revision+1}).where(target).returning(columns);
      return updated;
    }
    if(input.action!=='create')throw new ApiError(404,'Custom property not found.');
    const count=await tx.select({id:properties.id}).from(properties).where(owned).limit(portableCustomPropertyLimit);
    if(count.length>=portableCustomPropertyLimit)throw new ApiError(409,`Use up to ${portableCustomPropertyLimit} custom properties per record type.`);
    const [saved]=await tx.insert(properties).values({
      workspaceId,kind:input.kind,id:crypto.randomUUID(),label:input.label,type:input.type,options:input.options,revision:1,
    }).returning(columns);
    return saved;
  });
}

export async function mergePortableCustomValues(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,kind:PortableCustomPropertyKind,
  patch:PortableCustomPatch|undefined,previous:PortableCustomValues|undefined):Promise<PortableCustomValues|undefined>{
  const entries=Object.entries(patch??{});
  if(!entries.length)return previous;
  const definitions=await db.select(columns).from(properties)
    .where(and(scope(workspaceId,kind),inArray(properties.id,entries.map(([id])=>id))));
  const byId=new Map(definitions.map(definition=>[definition.id,definition]));
  const values={...previous};
  for(const [id,value] of entries){
    const definition=byId.get(id);
    if(!definition)throw new ApiError(400,'Choose a custom property on this record type and workspace.');
    if(definition.type==='text'&&typeof value==='string'&&value.length>portableCustomTextLimit)
      throw new ApiError(400,`Use up to ${portableCustomTextLimit} characters for ${definition.label}.`);
    try{
      const parsed=customValue(definition,value,{previous:values[id]});
      if(parsed===undefined)delete values[id];
      else values[id]=parsed;
    }catch{throw new ApiError(400,`Enter a valid value for ${definition.label}.`);}
  }
  return Object.keys(values).length?values:undefined;
}

export async function readPortableCustomDefinition(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,kind:PortableCustomPropertyKind,id:string){
  const [definition]=await db.select(columns).from(properties).where(and(scope(workspaceId,kind),eq(properties.id,id))).limit(1);
  return definition;
}
