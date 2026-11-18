import {and,eq,exists,sql,type SQL,type SQLWrapper} from 'drizzle-orm';
import type {PgTable} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {privateWorkspaces} from './workspace-schema';

// The Recycle Bin belongs to the owner and to editors holding the named grant.
// Viewers can't list, archive or restore records.
export function archiveWorkspaceScope(db:Pick<PostgresJsDatabase,'select'>,actorId:string,shared?:SharedRecordWriteScope):SQL{
  if(!shared)return eq(privateWorkspaces.ownerId,actorId);
  const editor=db.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(
    eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.id,shared.grantId),
    eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.role,'editor')));
  return and(eq(privateWorkspaces.id,shared.workspaceId),exists(editor))!;
}

// An archived record can't be edited, so its current revision is the archive event.
type ArchiveEvents=PgTable&{workspaceId:SQLWrapper;revision:SQLWrapper;actorId:SQLWrapper};
export function archivedByLabel(events:ArchiveEvents,eventRecordId:SQLWrapper,recordId:SQLWrapper,workspaceId:SQLWrapper,revision:SQLWrapper){
  return sql<string|null>`(SELECT coalesce(nullif(${loginIdentities.fullName},''),${loginIdentities.email})
    FROM ${events} JOIN ${loginIdentities} ON ${loginIdentities.id}=${events.actorId}
    WHERE ${events.workspaceId}=${workspaceId} AND ${eventRecordId}=${recordId} AND ${events.revision}=${revision} LIMIT 1)`;
}

export const archiveAccessError='Editor access to this workspace is required.';
