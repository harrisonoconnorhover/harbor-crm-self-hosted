import {z} from 'zod';
import {ApiError} from '../api-error';
import {scheduledInstants,validTimeZone} from '../email/schedule';

const wallTime=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
export const calendarSuggestionInput=z.object({
  mode:z.literal('suggest'),startLocal:wallTime,endLocal:wallTime,
  timeZone:z.string().min(1).max(100).refine(validTimeZone),
  durationMinutes:z.number().int().min(15).max(120).multipleOf(15),
}).strict();
export type CalendarSuggestion=z.output<typeof calendarSuggestionInput>;
export type CalendarSlot={start:string;end:string};
export type CalendarSuggestions={slots:CalendarSlot[];checkedAt:string};

const minute=60_000,step=15*minute;
export function calendarSuggestionWindow(input:CalendarSuggestion,now=Date.now()){
  const starts=scheduledInstants(input.startLocal,input.timeZone),ends=scheduledInstants(input.endLocal,input.timeZone);
  if(starts.length!==1||ends.length!==1)
    throw new ApiError(400,'Choose start and end times that occur once in the selected time zone.');
  const [start]=starts,[end]=ends,from=Date.parse(start),to=Date.parse(end),duration=input.durationMinutes*minute;
  if(to-from<duration||to-from>8*60*minute||to<=now||to>now+366*24*60*minute)
    throw new ApiError(400,'Choose a window that fits the meeting, lasts at most eight hours and ends within the next year.');
  const slots:CalendarSlot[]=[];
  for(let time=from;time+duration<=to;time+=step){
    if(time>now)slots.push({start:new Date(time).toISOString(),end:new Date(time+duration).toISOString()});
  }
  return {start,end,slots};
}

export function slotsOutsideGoogleBusy(slots:CalendarSlot[],busy:CalendarSlot[]){
  const intervals=busy.map(({start,end})=>[Date.parse(start),Date.parse(end)]);
  if(intervals.some(([start,end])=>!Number.isFinite(start)||!Number.isFinite(end)||end<=start))
    throw new ApiError(503,'Google returned incomplete availability. Try again shortly.');
  return slots.filter(({start,end})=>!intervals.some(([from,to])=>from<Date.parse(end)&&to>Date.parse(start)));
}
