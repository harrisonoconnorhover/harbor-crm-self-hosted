import {z} from 'zod';
import {groupsSchema} from './filters';
import {taskColumnsSchema,type TaskColumn} from './shared-task-columns';
import {validTimeZone} from './email/schedule';
import {NO_QUEUE} from './task-queues';
export const sharedTaskFilterFields={
 groups:groupsSchema.refine(v=>v.flat().length<=20,'Use at most 20 advanced conditions.'),
 query:z.string().trim().max(160).default(''),queueId:z.union([z.literal(''),z.literal(NO_QUEUE),z.string().guid("Invalid uuid")]).default(''),
 status:z.enum(['all','open','completed']).default('open'),taskType:z.enum(['','To-do','Call','Email']).default(''),priority:z.enum(['','Low','Medium','High']).default(''),
 assignee:z.enum(['all','unassigned','named','me','member']).default('all'),owner:z.string().trim().max(200).default(''),assigneeId:z.string().max(200).default(''),
 taskScope:z.enum(['all','today','overdue','upcoming','none']).default('all'),timeZone:z.string().max(100).refine(validTimeZone,'Choose a valid time zone.').default('UTC'),
};
export function validateTaskAssignee(v:{assignee:string;owner:string;assigneeId?:string},c:z.RefinementCtx){if(v.assignee==='named'&&!v.owner)c.addIssue({code:'custom',message:'Enter the assigned person’s name.'});if(v.assignee==='member'&&!v.assigneeId)c.addIssue({code:'custom',message:'Choose a workspace member.'})}
export const sharedTaskFiltersSchema=z.object(sharedTaskFilterFields).strict().superRefine(validateTaskAssignee);
export type SharedTaskFilters=z.infer<typeof sharedTaskFiltersSchema>;
export const defaultSharedTaskFilters=(timeZone='UTC'):SharedTaskFilters=>sharedTaskFiltersSchema.parse({timeZone});
export const sameSharedTaskFilters=(a:SharedTaskFilters,b:SharedTaskFilters)=>JSON.stringify(sharedTaskFiltersSchema.parse(a))===JSON.stringify(sharedTaskFiltersSchema.parse(b));
export type SharedTaskView={id:string;name:string;shared:boolean;creatorName:string;revision:number;updatedAt:string;config:SharedTaskFilters;columns:TaskColumn[];canManage:boolean;canMakePrivate:boolean;queueName:string|null;queueAvailable:boolean};
export const sharedTaskViewInput=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),workspaceId:z.string().guid("Invalid uuid"),id:z.string().guid("Invalid uuid"),revision:z.number().int().positive().optional(),name:z.string().trim().min(1,'Enter a view name.').max(100),shared:z.boolean().default(false),config:sharedTaskFiltersSchema,columns:taskColumnsSchema.optional()}).strict(),
 z.object({action:z.literal('delete'),workspaceId:z.string().guid("Invalid uuid"),id:z.string().guid("Invalid uuid"),revision:z.number().int().positive()}).strict(),
]);
