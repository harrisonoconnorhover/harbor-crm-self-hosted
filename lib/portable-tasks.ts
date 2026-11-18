import {z} from 'zod';
import {schemas} from './crm';
import {validTimeZone} from './email/schedule';
import {portableRecordKind,recordSearchLimit,writeSchema,type PortableRecordKind} from './portable-records';
import {NO_QUEUE} from './task-queues';
import {extensionSchemas} from './standard-properties';
import type {TaskDeadline} from './task-deadline';
import {taskRepeatSchema,type RepeatingTask} from './task-repeat';
import {reminderMinutes} from './portable-task-reminders';

export const portableTaskStatuses=schemas.tasks.shape.status.removeDefault().options;
export const portableTaskPriorities=schemas.tasks.shape.priority.removeDefault().options;
export const portableTaskTypes=schemas.tasks.shape.taskType.removeDefault().options;
export const portableTaskDateViews=['today','overdue','upcoming'] as const;
export type PortableTaskDateView=(typeof portableTaskDateViews)[number];
export const isPortableTaskDateView=(view?:string|null):view is PortableTaskDateView=>
  portableTaskDateViews.some(item=>item===view);
export const portableTaskFields=z.object({
  ...schemas.tasks.pick({name:true,taskType:true,dueTime:true,dueTimeZone:true,dueTimeOccurrence:true,status:true,priority:true}).shape,
  dueDate:schemas.tasks.shape.dueDate.removeDefault().optional(),
  notes:extensionSchemas.tasks.notes as z.ZodOptional<z.ZodString>,
  repeat:taskRepeatSchema.nullable().optional(),
  reminderMinutes:reminderMinutes.nullable().optional(),
}).strict();
const uuid=z.string().guid("Invalid uuid");
export const portableTaskWrite=writeSchema(z.object({action:z.literal('save'),kind:z.literal('tasks'),data:portableTaskFields,
  assigneeId:z.string().min(1).max(200).nullable().optional(),contactId:uuid.nullable().optional(),
  queueId:uuid.nullable().optional(),
  related:z.object({kind:portableRecordKind,id:uuid}).strict().nullable().optional(),
})).refine(input=>input.related===undefined||input.contactId===undefined);
export const taskLinkFields={contacts:'contactId',companies:'companyId',deals:'dealId'} as const;
type TaskLinkField=(typeof taskLinkFields)[PortableRecordKind];
export function taskLinkTarget(links:Partial<Record<TaskLinkField,string|null>>){
  for(const kind of portableRecordKind.options){
    const id=links[taskLinkFields[kind]];
    if(id)return {kind,id};
  }
}

export const portableTaskRead=z.object({
  kind:z.literal('tasks'),id:uuid.optional(),after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  search:z.string().trim().max(recordSearchLimit).refine(value=>!value.includes('\0')).transform(value=>value||undefined).optional(),
  workspaceId:uuid.optional(),status:z.enum(portableTaskStatuses).optional(),
  taskPriority:z.enum(portableTaskPriorities).optional(),taskType:z.enum(portableTaskTypes).optional(),
  taskView:z.enum(['mine','unavailable-assignee',...portableTaskDateViews]).optional(),
  taskZone:z.string().min(1).max(100).refine(validTimeZone).optional(),
  taskAssignee:z.literal('me').optional(),
  contactId:uuid.optional(),companyId:uuid.optional(),dealId:uuid.optional(),
  queueId:z.union([uuid,z.literal(NO_QUEUE)]).optional(),
}).strict().refine(input=>[input.contactId,input.companyId,input.dealId].filter(Boolean).length<=1&&
  !(input.workspaceId&&input.queueId)&&!(input.taskView&&input.status)&&
  ((input.taskZone===undefined&&input.taskAssignee===undefined)||isPortableTaskDateView(input.taskView))&&
  !(input.id&&(input.after||input.search||input.status||input.taskPriority||input.taskType||input.taskView||input.queueId||taskLinkTarget(input))));
export const portableTaskCompletionRead=z.object({
  kind:z.literal('tasks'),completionHistoryFor:uuid,workspaceId:uuid.optional(),
  limit:z.coerce.number().int().min(1).max(25).default(25),
  afterAt:z.string().datetime({precision:3}).refine(value=>!value.startsWith('0000-')).optional(),afterId:uuid.optional(),
  afterRevision:z.coerce.number().int().min(1).max(2147483647).optional(),
}).strict().refine(input=>[input.afterAt,input.afterId,input.afterRevision].every(value=>value===undefined)||
  [input.afterAt,input.afterId,input.afterRevision].every(value=>value!==undefined));
export type PortableTaskCompletionQuery=z.output<typeof portableTaskCompletionRead>;
export type PortableTaskCompletionPage={
  items:{id:string;revision:number;occurredAt:string;name:string;actorName:string|null}[];
  next:{at:string;id:string;revision:number}|null;
};
export type PortableTaskFields=z.output<typeof portableTaskFields>&Pick<TaskDeadline,'dueDate'|'dueAt'>&
  Pick<RepeatingTask,'repeatAnchorDate'|'repeatAnchorTime'|'repeatOccurrence'|'repeatDueAt'>;
export type PortableTaskWrite=z.output<typeof portableTaskWrite>;
export type PortableTaskQuery=z.output<typeof portableTaskRead>;
export type PortableTaskRecord={
  id:string;revision:number;data:PortableTaskFields;assigneeId:string|null;assigneeLabel:string|null;
  contactId:string|null;contactName:string|null;companyId:string|null;companyName:string|null;
  dealId:string|null;dealName:string|null;queueId:string|null;completedAt:string|null;createdAt:string;updatedAt:string;
};
