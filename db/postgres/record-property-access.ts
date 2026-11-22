import {sql,type SQLWrapper} from 'drizzle-orm';
import {portableCustomProperties as properties} from './custom-property-schema';
import type {PgColumn} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableCustomPatch,PortableCustomValues} from '../../lib/portable-custom-properties';
import {hiddenStandardFields} from './standard-property-access';
import {workspaceViewers as members} from './workspace-viewer-schema';

// Record access is checked by the caller. API tokens have no team membership.
export function propertyVisibleTo(actorId:string|null){
  if(!actorId)return sql`NOT ${properties.restricted}`;
  return sql`(NOT ${properties.restricted} OR EXISTS (SELECT 1 FROM ${members}
    WHERE ${members.workspaceId}=${properties.workspaceId} AND ${members.viewerId}=${actorId}
      AND ${members.teamId}=${properties.visibleTeamId}))`;
}

export function hiddenPropertyIds(workspaceId:string|SQLWrapper,kind:string|SQLWrapper,actorId:string|null){
  return sql`SELECT ${properties.id}::text FROM ${properties} WHERE ${properties.workspaceId}=${workspaceId}
    AND ${properties.kind}=${kind} AND NOT (${propertyVisibleTo(actorId)})`;
}

export function visibleRecordData<T extends PgColumn>(column:T,workspaceId:string|SQLWrapper,kind:string,actorId:string|null){
  const bag=sql`((${column}->'custom') - ARRAY(${hiddenPropertyIds(workspaceId,kind,actorId)}))`;
  return sql<T['_']['data']>`((${column} - 'custom' - ARRAY(${hiddenStandardFields(workspaceId,kind,actorId)})) ||
    jsonb_strip_nulls(jsonb_build_object('custom',nullif(${bag},'{}'::jsonb))))`;
}

export async function checkFieldWrite(db:PostgresJsDatabase,workspaceId:string,kind:string,actorId:string|null,patch?:PortableCustomPatch,standard?:object){
  const hidden=new Set((await db.execute<{id:string}>(sql`${hiddenPropertyIds(workspaceId,kind,actorId)}
    UNION ALL ${hiddenStandardFields(workspaceId,kind,actorId)}`)).map(row=>row.id));
  if(Object.keys(patch??{}).some(id=>hidden.has(id.toLowerCase()))||Object.keys(standard??{}).some(key=>hidden.has(key)))throw new ApiError(403,'You cannot edit this property.');
  return hidden;
}

// Merging archives a source and resolves every property, including blank values.
export async function requireMergeFieldAccess(db:PostgresJsDatabase,workspaceId:string,kind:string,actorId:string){
  const [row]=await db.execute(sql`${hiddenPropertyIds(workspaceId,kind,actorId)} UNION ALL ${hiddenStandardFields(workspaceId,kind,actorId)} LIMIT 1`);
  if(row)throw new ApiError(403,'Merging requires access to all properties on this record type.');
}

export function redactRecord<T extends {data:{custom?:PortableCustomValues}}>(record:T,hidden?:Set<string>):T{
  if(!hidden?.size)return record;
  const data={...record.data};
  for(const key of hidden)Reflect.deleteProperty(data,key);
  if(data.custom){
    const visible=Object.entries(data.custom).filter(([id])=>!hidden.has(id.toLowerCase()));
    if(visible.length)data.custom=Object.fromEntries(visible);
    else delete data.custom;
  }
  return {...record,data};
}
