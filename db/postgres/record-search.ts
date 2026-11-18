import {and,eq,isNull,ne,notExists,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordQuery} from '../../lib/portable-records';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';

// Treat PostgreSQL LIKE metacharacters as literal search text.
export function recordSearchPattern(search:string|undefined){
  return search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':undefined;
}

export function recordOwnerFilter(db:PostgresJsDatabase,data:SQLWrapper,actorId:string,owner:PortableRecordQuery['owner']){
  if(!owner)return undefined;
  const assignment=sql`${data}->'recordOwner'`;
  const assignee=sql<string>`${assignment}->>'userId'`;
  if(owner==='unavailable'){
    const editorGrant=db.select({id:workspaceViewers.viewerId}).from(workspaceViewers).where(and(
      eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.viewerId,assignee),eq(workspaceViewers.role,'editor'),
    ));
    return and(
      sql`${assignment}->>'workspaceId'=${privateWorkspaces.id}::text`,
      sql`jsonb_typeof(${assignment}->'userId')='string' AND char_length(${assignee}) BETWEEN 1 AND 200`,
      sql`jsonb_typeof(${assignment}->'label')='string' AND char_length(${assignment}->>'label') BETWEEN 1 AND 100`,
      ne(assignee,privateWorkspaces.ownerId),notExists(editorGrant),
    );
  }
  return owner==='unassigned'?isNull(assignee):eq(assignee,owner==='mine'?actorId:owner);
}
