import {z} from 'zod';

export const reminderChoices=[
  {minutes:0,label:'At the due time'},
  {minutes:5,label:'5 minutes before'},
  {minutes:15,label:'15 minutes before'},
  {minutes:60,label:'1 hour before'},
] as const;
export const reminderMinutes=z.union([z.literal(0),z.literal(5),z.literal(15),z.literal(60)]);
export const reminderQuery=z.object({workspaceId:z.string().guid().optional()}).strict();
export const reminderDismissal=z.object({id:z.string().guid(),expectedRevision:z.number().int().positive()}).strict();
export const reminderPageSize=5;
export type TaskReminder={id:string;revision:number;name:string;dueAt:string;remindAt:string};
export type TaskReminders={items:TaskReminder[];more:boolean;nextAt:string|null;serverNow:string};

export function taskReminderInstant(task:{dueAt?:string;reminderMinutes?:number|null}){
  return task.dueAt&&task.reminderMinutes!=null
    ?new Date(Date.parse(task.dueAt)-task.reminderMinutes*60_000).toISOString():null;
}
