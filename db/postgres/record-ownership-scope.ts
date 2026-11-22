import type {MemberTool} from '../../lib/portable-tool-permissions';
import {columnTool,toolLevel} from './member-tool-access';
import type {WorkspacePermission} from '../../lib/portable-workspace-access';
import {and,eq,exists,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {workspaceViewers as members} from './workspace-viewer-schema';
import {workspaceTeams as teams} from './workspace-team-schema';

type Reader=Pick<PostgresJsDatabase,'select'>;
export type RecordOwnership={workspaceId:SQLWrapper;data:SQLWrapper}|{workspaceId:SQLWrapper;assigneeId:SQLWrapper};
export function ownedRecordScope(db:Reader,actorId:string|SQLWrapper,workspaceId:string|SQLWrapper,record:RecordOwnership,mode:'view'|'edit'='view',permission?:WorkspacePermission,grantId?:string,tool?:MemberTool){
  const level=toolLevel(tool??columnTool('data' in record?record.data:record.assigneeId)??columnTool(record.workspaceId),mode);
  const storedOwner='data' in record?sql`${record.data}->'recordOwner'`:undefined;
  const ownerWorkspace=storedOwner?sql`${storedOwner}->>'workspaceId'`:sql`${record.workspaceId}::text`;
  const assignee='data' in record?sql`${storedOwner}->>'userId'`:record.assigneeId;
  // The nested query starts at the reader's assigned team. No team means own records only.
  const permitted=sql`(${level} = 'all' OR (
    ${level}<>'none' AND ${ownerWorkspace} = ${members.workspaceId}::text AND
    (${assignee} = ${members.viewerId} OR (${level} = 'team' AND EXISTS (
      WITH RECURSIVE branch(id) AS (
        SELECT ${members.teamId} WHERE ${members.teamId} IS NOT NULL
        UNION SELECT child.id FROM ${teams} child JOIN branch ON child.parent_id=branch.id
          WHERE child.workspace_id=${members.workspaceId}
      )
      SELECT 1 FROM ${members} assigned JOIN branch ON branch.id=assigned.team_id
      WHERE assigned.workspace_id=${members.workspaceId} AND assigned.viewer_id=${assignee} AND assigned.role='editor'
    )))
  ))`;
  return exists(db.select({id:members.id}).from(members).where(and(eq(members.viewerId,actorId),
    eq(members.workspaceId,workspaceId),grantId?eq(members.id,grantId):undefined,sql`${record.workspaceId}=${members.workspaceId}`,
    mode==='edit'?eq(members.role,'editor'):undefined,permission?eq(members[permission],true):undefined,
    permission==='contactFiles'?sql`${toolLevel('files','view')}<>'none'`:undefined,permitted)));
}

export function sharedCoreRecordScope(db:Reader,actorId:string,workspaceId:string|undefined,record:RecordOwnership){
  return workspaceId?ownedRecordScope(db,actorId,workspaceId,record):undefined;
}
