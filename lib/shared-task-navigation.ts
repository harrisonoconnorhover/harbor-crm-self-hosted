import {z} from 'zod';
import {defaultSharedTaskFilters} from './shared-task-filters';
import {taskColumnsSchema} from './shared-task-columns';
export const standardTaskViews={open:'All tasks',today:'Due today',overdue:'Overdue',upcoming:'Upcoming',completed:'Completed',mine:'My tasks'} as const;
export type StandardTaskView=keyof typeof standardTaskViews;
export const isStandardTaskView=(key:string):key is StandardTaskView=>Object.hasOwn(standardTaskViews,key);
export const standardTaskViewKeys=Object.keys(standardTaskViews) as StandardTaskView[];
export const taskTabSchema=z.union([z.enum(['open','today','overdue','upcoming','completed','mine']),z.string().guid("Invalid uuid")]);
export const taskNavigationFields=z.object({
 pinned:z.array(taskTabSchema).min(1,'Keep at least one task tab.').max(20,'You can pin up to 20 task views.').refine(v=>new Set(v).size===v.length,'Choose each tab once.'),
 builtinColumns:z.object({open:taskColumnsSchema.optional(),today:taskColumnsSchema.optional(),overdue:taskColumnsSchema.optional(),upcoming:taskColumnsSchema.optional(),completed:taskColumnsSchema.optional(),mine:taskColumnsSchema.optional()}).strict().prefault({}),
}).strict();
export const taskNavigationInput=taskNavigationFields.extend({workspaceId:z.string().guid("Invalid uuid"),revision:z.number().int().min(0)}).strict();
export type TaskNavigationConfig=z.infer<typeof taskNavigationFields>;
export type TaskNavigation=TaskNavigationConfig & {revision:number;tabs:{key:string;label:string;available:boolean}[]};
export function standardTaskFilters(key:StandardTaskView,timeZone:string){return {...defaultSharedTaskFilters(timeZone),assignee:key==='mine'?'me' as const:'all' as const,status:key==='completed'?'completed' as const:'open' as const,taskScope:['today','overdue','upcoming'].includes(key)?key as 'today'|'overdue'|'upcoming':'all' as const};}
export function moveTaskTab(keys:string[],from:string,to:string){const next=[...keys],index=next.indexOf(from),target=next.indexOf(to);if(index<0||target<0)return next;next.splice(index,1);next.splice(target,0,from);return next;}
