import {and,eq,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableCustomPropertyKind} from '../../lib/portable-custom-properties';
import {restrictedStandardFields,type PortableStandardAccess,type PortableStandardAccessWrite} from '../../lib/portable-standard-property-access';
import {portableStandardPropertyAccess as rules} from './custom-property-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceViewers as members} from './workspace-viewer-schema';
import {recordCatalogScope} from './workspace-viewer-store';

export function standardPropertyVisibleTo(actorId:string|null){
  if(!actorId)return sql`NOT ${rules.restricted}`;
  return sql`(NOT ${rules.restricted} OR EXISTS (SELECT 1 FROM ${members}
    WHERE ${members.workspaceId}=${rules.workspaceId} AND ${members.viewerId}=${actorId}
    AND ${members.teamId}=${rules.visibleTeamId}))`;
}

export function hiddenStandardFields(workspaceId:string|SQLWrapper,kind:string|SQLWrapper,actorId:string|null){
  return sql`SELECT ${rules.id} FROM ${rules} WHERE ${rules.workspaceId}=${workspaceId}
    AND ${rules.kind}=${kind} AND ${rules.id}<>'stage' AND NOT (${standardPropertyVisibleTo(actorId)})`;
}

// Stage is always readable. Its audience controls movement between pipeline stages.
export async function canMovePortableDeal(db:PostgresJsDatabase,workspaceId:string,actorId:string|null){
  const [denied]=await db.select({id:rules.id}).from(rules).where(and(eq(rules.workspaceId,workspaceId),
    eq(rules.kind,'deals'),eq(rules.id,'stage'),sql`NOT (${standardPropertyVisibleTo(actorId)})`));
  return !denied;
}

export async function listPortableStandardAccess(db:PostgresJsDatabase,actorId:string,kind:PortableCustomPropertyKind,workspaceId?:string):Promise<PortableStandardAccess[]>{
  const rows=await db.select({id:rules.id,restricted:rules.restricted,visibleTeamId:rules.visibleTeamId,
    revision:rules.revision,visible:workspaceId?sql<boolean>`${standardPropertyVisibleTo(actorId)}`:sql<boolean>`true`})
    .from(privateWorkspaces).leftJoin(rules,and(eq(privateWorkspaces.id,rules.workspaceId),eq(rules.kind,kind)))
    .where(recordCatalogScope(db,actorId,workspaceId));
  if(workspaceId&&!rows.length)return [];
  const byId=new Map(rows.map(row=>[row.id,row]));
  const fields=kind==='deals'?[...restrictedStandardFields.deals,'stage']:restrictedStandardFields[kind];
  return fields.flatMap(id=>{
    const row=byId.get(id);
    if(row&&!row.visible)return [];
    return [{id,audience:row?.restricted?row.visibleTeamId??'owner':'workspace',revision:row?.revision??0}];
  });
}

export function savePortableStandardAccess(db:PostgresJsDatabase,actorId:string,input:PortableStandardAccessWrite):Promise<PortableStandardAccess>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workspace not found.');
    const {kind,id,audience}=input;
    const target=and(eq(rules.workspaceId,workspaceId),eq(rules.kind,kind),eq(rules.id,id));
    const [current]=await tx.select().from(rules).where(target);
    const revision=current?.revision??0;
    if(revision!==input.expectedRevision)throw new ApiError(409,'This property changed. Reload it before saving.');
    const restricted=audience!=='workspace',visibleTeamId=restricted&&audience!=='owner'?audience:null;
    if((current?.restricted??false)===restricted&&(current?.visibleTeamId??null)===visibleTeamId)return {id,audience,revision};
    if(visibleTeamId){
      const [team]=await tx.select({id:workspaceTeams.id}).from(workspaceTeams)
        .where(and(eq(workspaceTeams.workspaceId,workspaceId),eq(workspaceTeams.id,visibleTeamId)));
      if(!team)throw new ApiError(400,'Choose a team in this workspace.');
    }
    const next={restricted,visibleTeamId,revision:revision+1};
    if(current)await tx.update(rules).set(next).where(target);
    else await tx.insert(rules).values({workspaceId,kind,id,...next});
    return {id,audience,revision:next.revision};
  });
}
