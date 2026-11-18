import {z} from 'zod';
export const memberOwnerFilterSchema=z.object({workspaceId:z.string().guid("Invalid uuid"),userId:z.string().min(1).max(200),label:z.string().max(100)}).strict();
import {taskAssignee, type TaskAssignee} from './task-assignee';
import type {CRMRecord,Data} from './crm';
export type RecordOwner = TaskAssignee;
// Assignment never grants access. Reuse the task identity contract, including
// its captured-label check, so older text edits cannot silently route by name.
export function recordOwner(data: {owner?: unknown;recordOwner?: unknown}, workspaceId?: string): RecordOwner | null {
  return taskAssignee({owner: data.owner, taskAssignee: data.recordOwner}, workspaceId);
}
export function recordMemberOwner(record: Pick<CRMRecord, 'kind' | 'data'>, workspaceId?: string): RecordOwner | null {
  return record.kind === 'tasks' ? taskAssignee(record.data, workspaceId) : recordOwner(record.data, workspaceId);
}

export function matchesMemberOwner(record: Pick<CRMRecord, 'kind' | 'data'>, legacyName: string, actor?: {userId: string;workspaceId: string}): boolean {
  const member = recordMemberOwner(record);
  return member && actor ? member.workspaceId === actor.workspaceId && member.userId === actor.userId : record.data.owner === legacyName;
}

// Related and completion-created tasks retain a known member identity; an older
// stored name stays text until the user explicitly chooses a workspace member.
export function taskOwnerDraft(record:Pick<CRMRecord,'kind'|'data'>,workspaceId:string):Pick<Data,'owner'|'taskAssignee'>{
  const assignment=recordMemberOwner(record,workspaceId);
  return {owner:record.data.owner,...(assignment?{taskAssignee:assignment}:{})};
}
