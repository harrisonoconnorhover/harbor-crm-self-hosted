import {and,eq,exists,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {contacts} from './contact-schema';
import {salesSequenceExitCandidate} from './sales-sequence-exit';
import {salesEnrollments as enrollments,salesSequenceActivations as activations,salesSequenceSteps as steps} from './sales-sequence-schema';
import {portableTasks as tasks} from './task-schema';
import {activeContact} from './contact-visibility';
import {ownedRecordScope} from './record-ownership-scope';

import {workspaceViewers} from './workspace-viewer-schema';
import {canWorkTask} from './workspace-assignee-store';

export function sequenceRepCanWorkTasks(db:Pick<PostgresJsDatabase,'select'>,rep:string|SQLWrapper,workspace:string|SQLWrapper){
  return exists(db.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(
    eq(workspaceViewers.workspaceId,workspace),eq(workspaceViewers.viewerId,rep),eq(workspaceViewers.role,'editor'),canWorkTask)));
}

// The picker, enrollment and workers must agree about the assigned rep's current contact access.
export function sequenceRepCanEditContact(db:Pick<PostgresJsDatabase,'select'>,rep:string|SQLWrapper,
  workspace:string|SQLWrapper,contact:string|SQLWrapper){
  return exists(db.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,workspace),
    eq(contacts.id,contact),activeContact,ownedRecordScope(db,rep,workspace,contacts,'edit'))));
}

// Only live contacts can be handed to another rep. A task already finished by
// its assignee needs no handoff even if the worker has yet to advance the step.
export function unavailableSequenceAssignee(db:Pick<PostgresJsDatabase,'select'>,owner:string){
  return sql`${enrollments.assigneeId}<>${owner}
    AND EXISTS (SELECT 1 FROM ${contacts} WHERE ${contacts.workspaceId}=${enrollments.workspaceId}
      AND ${contacts.id}=${enrollments.contactId} AND ${activeContact})
    AND (NOT ${sequenceRepCanEditContact(db,enrollments.assigneeId,enrollments.workspaceId,enrollments.contactId)}
      OR (NOT ${sequenceRepCanWorkTasks(db,enrollments.assigneeId,enrollments.workspaceId)} AND EXISTS (
        SELECT 1 FROM ${steps} s LEFT JOIN ${tasks} t ON (t.workspace_id,t.id)=(s.workspace_id,s.task_id)
        WHERE s.workspace_id=${enrollments.workspaceId} AND s.enrollment_id=${enrollments.id}
          AND s.definition->>'type'='task' AND s.state NOT IN ('completed','stopped') AND t.completed_at IS NULL)))`;
}

// A created task stays in record history after its sequence releases it.
// The unique workspace/task index finds the linked step without scanning enrollments.
export const inactiveSequenceTask=sql<boolean>`EXISTS (
  SELECT 1 FROM ${steps} s JOIN ${enrollments} e
    ON (e.workspace_id,e.id)=(s.workspace_id,s.enrollment_id)
  LEFT JOIN ${activations} a
    ON (a.workspace_id,a.enrollment_id)=(s.workspace_id,s.enrollment_id)
  WHERE s.workspace_id=${tasks}.workspace_id AND s.task_id=${tasks}.id
    AND (s.state<>'queued' OR a.enrollment_id IS NULL OR (${salesSequenceExitCandidate}) IS NOT NULL))`;
