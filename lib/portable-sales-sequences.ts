import {z} from 'zod';
import {emailContent} from './email/message';
import {suppressedAddress} from './email/suppression';
import {reminderMinutes} from './portable-task-reminders';
import {portableTaskFields} from './portable-tasks';

const uuid=z.string().guid().transform(value=>value.toLowerCase());
const revision=z.number().int().min(0).max(2147483646);
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!value.includes('\0'));
const stepBase={id:uuid,delayDays:z.number().int().min(0).max(90)};
export const maxSequenceTaskMinutes=90*24*60;
const taskTiming=z.object({dueAfterMinutes:z.number().int().min(0).max(maxSequenceTaskMinutes),
  reminderMinutes:reminderMinutes.optional()}).strict().refine(
  timing=>timing.reminderMinutes===undefined||timing.reminderMinutes<=timing.dueAfterMinutes,
  'Choose a reminder that falls on or after task assignment.');
const step=z.discriminatedUnion('type',[
  z.object({...stepBase,type:z.literal('email'),subject:z.string().min(1).max(200),body:z.string().min(1).max(8000).refine(value=>!value.includes('\0'))}).strict(),
  z.object({...stepBase,type:z.literal('task'),taskType:z.enum(['Call','LinkedIn','To-do']),
    title:portableTaskFields.shape.name,notes:z.string().max(2000),timing:taskTiming.optional()}).strict(),
]).refine(step=>step.type==='email'?
  emailContent.safeParse({to:['validation@example.test'],subject:step.subject,body:step.body}).success:
  !step.notes.includes('\0')&&!step.title.includes('\0'),'Check the step content.');
const steps=z.array(step).min(1).max(20).refine(items=>new Set(items.map(item=>item.id)).size===items.length,'Each step must have its own ID.');
export const salesSequenceCommand=z.discriminatedUnion('action',[
  z.object({action:z.literal('save'),id:uuid,expectedRevision:revision,name:text(120),steps}).strict(),
  z.object({action:z.literal('enroll'),id:uuid,sequenceId:uuid,expectedRevision:revision.min(1),contactId:uuid,startStepId:uuid.optional(),
    assigneeId:text(200),recipient:suppressedAddress.nullable()}).strict(),
  z.object({action:z.literal('stop'),id:uuid}).strict(),
]);
export const salesEnrollmentStates=['attention','active','completed','stopped'] as const;
const enrollmentState=z.enum(salesEnrollmentStates);
export const openEnrollmentState=(state:SalesEnrollmentState|undefined)=>state==='active'||state==='attention';
const assigneeFilter=z.literal('unavailable').optional();
export const sequencePageQuery=z.union([
  z.object({view:z.literal('sequences')}).strict(),
  z.object({view:z.literal('sequences'),section:z.literal('enrollments'),state:enrollmentState.default('attention'),
    after:uuid.optional(),enrollmentId:uuid.optional(),bookingId:uuid.optional(),assignee:assigneeFilter}).strict()
    .refine(q=>!q.assignee||(openEnrollmentState(q.state)&&!q.bookingId)),
]);
export type EnrollmentPageQuery=Extract<z.output<typeof sequencePageQuery>,{section:'enrollments'}>;
export function enrollmentUrl(state:SalesEnrollmentState,options:Partial<Pick<EnrollmentPageQuery,'after'|'enrollmentId'|'bookingId'|'assignee'>>={}){
  const params=new URLSearchParams({view:'sequences',section:'enrollments',state});
  for(const [key,value] of Object.entries(options))if(value)params.set(key,value);
  return '/?'+params;
}
export const salesSequenceQuery=z.object({
  view:z.enum(['enrollments','assignees']).optional(),sequenceId:uuid.optional(),enrollmentId:uuid.optional(),
  emailOnly:z.literal('true').optional(),assignee:assigneeFilter,state:enrollmentState.optional(),bookingId:uuid.optional(),contactId:uuid.optional(),after:uuid.optional(),page:z.coerce.number().int().min(0).max(1000000).optional(),
}).strict().refine(q=>{
  if([q.view,q.sequenceId,q.enrollmentId,q.view==='assignees'?undefined:q.contactId].filter(Boolean).length>1)return false;
  if(q.assignee&&!(q.view==='enrollments'&&openEnrollmentState(q.state)&&!q.bookingId))return false;
  if(q.emailOnly&&!(q.view==='assignees'&&q.contactId))return false;
  if(q.state&&q.view!=='enrollments')return false;
  if(q.bookingId&&!(q.view==='enrollments'&&q.state))return false;
  if(q.page!==undefined&&q.view!=='assignees')return false;
  return !q.after||!(q.sequenceId||q.enrollmentId||q.view==='assignees');
});
export type SalesSequenceStep=z.output<typeof step>;
export type SalesSequenceCommand=z.output<typeof salesSequenceCommand>;
export type SalesSequenceQuery=z.output<typeof salesSequenceQuery>;
export type SalesSequenceSummary={id:string;name:string;revision:number;stepCount:number;createdAt:number;updatedAt:number};
export type SalesSequence=SalesSequenceSummary&{steps:SalesSequenceStep[]};
export type SalesEnrollmentState=typeof salesEnrollmentStates[number];
export type SalesStepState='waiting'|'ready'|'queued'|'completed'|'stopped'|'attention';
export type SalesEnrollment={id:string;sequenceId:string;sequenceRevision:number;sequenceName:string;contactId:string;contactName:string;contactAvailable:boolean;
  actorId:string;sender:string;recipient:string|null;assigneeId:string;assigneeLabel:string;state:SalesEnrollmentState;
  activeActivation:boolean;bookingStopPending:boolean;issue:string|null;createdAt:number;finishedAt:number|null};
export type SalesEnrollmentStep={id:string;position:number;definition:SalesSequenceStep;state:SalesStepState;dueAt:number|null;
  jobId:string|null;taskId:string|null;finishedAt:number|null;issue:string|null;jobState:string|null;dispatchStartedAt:number|null};
