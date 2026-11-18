import { z } from "zod";
import { localDateTime, scheduledInstants, validTimeZone } from "./email/schedule";
import { normalizeTaskDeadline, type TaskDeadline } from "./task-deadline";

export const taskRepeatSchema = z.object({
  every: z.number().int().min(1).max(365),
  unit: z.enum(["days", "weeks", "months", "years"]),
  timeZone: z.string().max(100).refine(validTimeZone, "Choose a valid repeat time zone."),
}).strict();
export type TaskRepeat = z.infer<typeof taskRepeatSchema>;
export type RepeatingTask = Partial<TaskDeadline> & { repeat?: TaskRepeat | null; repeatAnchorDate?: string; repeatAnchorTime?:string; repeatOccurrence?:"earlier"|"later"; repeatDueAt?: string };
const dayMs = 86400000;
const date = (text: string) => new Date(text + "T12:00:00Z");
const iso = (value: Date) => value.toISOString().slice(0, 10);
function invalid(message: string): never { throw new z.ZodError([{code:"custom",path:["repeat"],message}]); }
// Move a missing clock time to the first valid minute that day; repeated hours
// use the task's chosen occurrence, or the earlier occurrence for future dates.
function firstTimeOnDate(day: string, time: string, zone: string, later = false) {
  const start = Number(time.slice(0,2))*60 + Number(time.slice(3));
  for (let minute=start; minute<1440; minute++) {
    const clock=String(Math.floor(minute/60)).padStart(2,"0")+":"+String(minute%60).padStart(2,"0");
    const values=scheduledInstants(day+"T"+clock,zone);
    if(values.length)return {clock, value:values[later?values.length-1:0]};
  }
}
export function normalizeTaskRepeat<T extends RepeatingTask>(input:T, previous?:RepeatingTask):T {
  const result={...input};
  delete result.repeatAnchorDate; delete result.repeatAnchorTime; delete result.repeatOccurrence; delete result.repeatDueAt;
  if(!result.repeat){delete result.repeat;return result;}
  result.repeat=taskRepeatSchema.parse(result.repeat);
  if(!result.dueDate)invalid("Repeating tasks need a due date. Turn off repeat before clearing it.");
  const unchanged=previous?.dueDate===result.dueDate && JSON.stringify(previous.repeat)===JSON.stringify(result.repeat);
  result.repeatAnchorDate=unchanged&&previous?.repeatAnchorDate?previous.repeatAnchorDate:result.dueDate;
  if(result.dueTime)result.repeatAnchorTime=unchanged&&previous?.dueTime===result.dueTime?previous.repeatAnchorTime||result.dueTime:result.dueTime;
  if(result.dueTime)result.repeatOccurrence=result.dueTimeOccurrence||(unchanged?previous?.repeatOccurrence:undefined)||"earlier";
  const zone=result.dueTime?result.dueTimeZone!:result.repeat.timeZone;
  if(result.dueTime)result.repeat={...result.repeat,timeZone:zone};
  // A date-only occurrence becomes overdue at the start of the following local day.
  const nextDay=date(result.dueDate);nextDay.setUTCDate(nextDay.getUTCDate()+1);
  if(result.dueTime)result.repeatDueAt=result.dueAt;
  else {
    const startOfNextDay=firstTimeOnDate(iso(nextDay),"00:00",zone);
    if(!startOfNextDay)invalid("No valid time on the next repeat date. Choose another due date or zone.");
    result.repeatDueAt=startOfNextDay.value;
  }
  return result;
}
function occurrence(anchor:string,repeat:TaskRepeat,n:number) {
  const original=date(anchor), result=date(anchor), step=repeat.every*n;
  if(repeat.unit==='days'||repeat.unit==='weeks')result.setUTCDate(result.getUTCDate()+step*(repeat.unit==='weeks'?7:1));
  else {
    result.setUTCDate(1);
    if(repeat.unit==='months')result.setUTCMonth(result.getUTCMonth()+step);
    else result.setUTCFullYear(result.getUTCFullYear()+step);
    const end=new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0)).getUTCDate();
    result.setUTCDate(Math.min(original.getUTCDate(),end));
  }
  if(result.getUTCFullYear()>9999)invalid("The next repeat is beyond the supported date range. Turn off repeat.");
  return iso(result);
}
export function nextTaskOccurrence<T extends RepeatingTask>(task:T,now:string):T {
  const repeat=task.repeat;if(!repeat||!task.dueDate)invalid("This task is not set to repeat.");
  const anchor=task.repeatAnchorDate||task.dueDate;
  const zone=task.dueTime?task.dueTimeZone!:repeat.timeZone;
  const today=localDateTime(new Date(now),zone).slice(0,10), threshold=task.dueDate>today?task.dueDate:today;
  const a=date(anchor), b=date(threshold);
  let n=Math.max(1,repeat.unit==='days'||repeat.unit==='weeks'
    ? Math.floor((b.getTime()-a.getTime())/dayMs/(repeat.every*(repeat.unit==='weeks'?7:1)))
    : Math.floor(((b.getUTCFullYear()-a.getUTCFullYear())*12+b.getUTCMonth()-a.getUTCMonth())/(repeat.every*(repeat.unit==='years'?12:1))));
  // Start near the threshold, then advance to a later occurrence, skipping missed
  // intervals instead of flooding the list with backdated tasks.
  for(let attempts=0;attempts<4;attempts++,n++) {
    const dueDate=occurrence(anchor,repeat,n);
    if(dueDate<=task.dueDate)continue;
    let deadline:TaskDeadline={dueDate};
    if(task.dueTime){
      const occurrencePreference=task.repeatOccurrence||task.dueTimeOccurrence||'earlier';
      const resolved=firstTimeOnDate(dueDate,task.repeatAnchorTime||task.dueTime,zone,occurrencePreference==='later');
      // If a clock jump leaves no valid time on this date, keep the original cadence.
      if(!resolved)continue;
      deadline={dueDate,dueTime:resolved.clock,dueTimeZone:zone,dueTimeOccurrence:occurrencePreference};
    }
    deadline=normalizeTaskDeadline(deadline);
    if(deadline.dueAt?deadline.dueAt<=now:dueDate<today)continue;
    const next=normalizeTaskRepeat({...task,...deadline,dueTime:deadline.dueTime,dueTimeZone:deadline.dueTimeZone,dueTimeOccurrence:deadline.dueTimeOccurrence,dueAt:deadline.dueAt});
    next.repeatAnchorDate=anchor;
    if(task.dueTime){next.repeatAnchorTime=task.repeatAnchorTime||task.dueTime;next.repeatOccurrence=task.repeatOccurrence||task.dueTimeOccurrence||"earlier";}
    return next;
  }
  invalid("Could not calculate the next repeat. Review the task's due date.");
}
export const taskRepeatLabel=(task:RepeatingTask)=>task.repeat?`Repeats every ${task.repeat.every} ${task.repeat.every===1?task.repeat.unit.slice(0,-1):task.repeat.unit}`:"";
