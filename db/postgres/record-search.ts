import {canEditAssignedRecord,columnTool} from './member-tool-access';
import {ownedRecordScope} from './record-ownership-scope';
import {and,eq,ilike,isNull,notExists,or,sql,type SQL,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordQuery} from '../../lib/portable-records';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';

// Treat PostgreSQL LIKE metacharacters as literal search text.
export function recordSearchPattern(search:string|undefined){
  return search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':undefined;
}

// Match the two expressions in contacts_list_search. Empty email is a display
// fallback; wrapping the searched email in coalesce would prevent an index scan.
export function matchesContactNameOrEmail(data:SQLWrapper,pattern:string|undefined){
  return pattern?or(ilike(sql`${data}->>'name'`,pattern),ilike(sql`${data}->>'email'`,pattern)):undefined;
}

// An assignment remains on a record after the editor is demoted or removed.
export function unavailableWorkspaceAssignee(db:PostgresJsDatabase,workspaceId:SQLWrapper,assignee:SQLWrapper,owner:SQLWrapper,canWork?:SQL){
  const editor=db.select({id:workspaceViewers.viewerId}).from(workspaceViewers).where(and(
    eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,assignee),eq(workspaceViewers.role,'editor'),canWork,
  ));
  // A null (unassigned) value also fails this comparison.
  return and(sql`${assignee} <> ${owner}`,notExists(editor));
}

export function unavailableRecordOwner(db:PostgresJsDatabase,data:SQLWrapper,workspaceId:SQLWrapper,workspaceOwner:SQLWrapper){
  const assignment=sql`${data}->'recordOwner'`;
  const assignee=sql<string>`${assignment}->>'userId'`;
  const tool=columnTool(data);
  return and(
    sql`${assignment}->>'workspaceId'=${workspaceId}::text`,
    sql`jsonb_typeof(${assignment}->'userId')='string' AND char_length(${assignee}) BETWEEN 1 AND 200`,
    sql`jsonb_typeof(${assignment}->'label')='string' AND char_length(${assignment}->>'label') BETWEEN 1 AND 100`,
    unavailableWorkspaceAssignee(db,workspaceId,assignee,workspaceOwner,tool?canEditAssignedRecord(tool):undefined),
  );
}

export function recordOwnerFilter(db:PostgresJsDatabase,data:SQLWrapper,actorId:string,owner:PortableRecordQuery['owner']){
  if(!owner)return undefined;
  if(owner==='editable'){
    const workspaceId=privateWorkspaces.id;
    return or(eq(privateWorkspaces.ownerId,actorId),ownedRecordScope(db,actorId,workspaceId,{workspaceId,data},'edit'));
  }
  const assignment=sql`${data}->'recordOwner'`;
  const assignee=sql<string>`${assignment}->>'userId'`;
  if(owner==='unavailable')return unavailableRecordOwner(db,data,privateWorkspaces.id,privateWorkspaces.ownerId);
  return owner==='unassigned'?isNull(assignee):eq(assignee,owner==='mine'?actorId:owner);
}
