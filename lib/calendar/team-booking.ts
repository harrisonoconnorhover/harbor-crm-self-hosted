import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {emailAddress} from '../email/message';

const id=z.string().guid().transform(value=>value.toLowerCase());
const instant=utcDateTime.transform(value=>new Date(value).toISOString());
const window=z.object({start:instant,end:instant,liveGoogle:z.literal(true).optional()}).strict().refine(({start,end})=>{
  const span=Date.parse(end)-Date.parse(start);
  return span>=900_000&&span<=8*3_600_000;
});
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const weeklyHours=z.object({
  days:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days=>new Set(days).size===days.length),
  timeZone:z.string().trim().min(1).max(100),
  start:clock,end:clock,liveGoogle:z.boolean().default(false),
}).strict().refine(hours=>{
  const minutes=(clock:string)=>Number(clock.slice(0,2))*60+Number(clock.slice(3));
  const span=(minutes(hours.end)-minutes(hours.start)+1440)%1440;
  return span>=15&&span<=480;
},'Choose a weekly window between 15 minutes and eight hours.');
export type WeeklyHours=z.output<typeof weeklyHours>;
const calendarDate=z.iso.date().refine(date=>!date.startsWith('0000'));
const timeOff=z.object({from:calendarDate,through:calendarDate,timeZone:z.string().trim().min(1).max(100),
  startTime:clock.optional(),endTime:clock.optional(),pauseLeadRouting:z.boolean().optional()})
  .strict().refine(period=>period.from<=period.through,'Choose a last day on or after the first day.')
  .refine(period=>Boolean(period.startTime)===Boolean(period.endTime),'Enter both a start and an end time.')
  .refine(p=>!p.startTime||!p.endTime||p.from!==p.through||p.endTime>p.startTime,'Choose an end after the start.');
export type TeamTimeOff=z.infer<typeof timeOff>;
const roster=z.array(id).min(1).max(12).refine(ids=>new Set(ids).size===ids.length);
const rosterPreview=z.object({booked:roster,calendar:roster}).strict();
export type RescheduleRoster=z.infer<typeof rosterPreview>;
export const teamBookingChange=z.discriminatedUnion('action',[
  z.object({action:z.literal('offer'),revision:z.number().int().nonnegative(),windows:z.array(window).max(12)}).strict(),
  z.object({action:z.literal('weekly'),revision:z.number().int().nonnegative(),hours:weeklyHours.nullable()}).strict(),
  z.object({action:z.literal('timeOff'),revision:z.number().int().nonnegative(),operation:z.enum(['add','remove']),period:timeOff}).strict(),
  z.object({action:z.literal('create'),id,title:z.string().trim().min(1).max(100),
    publicEnabled:z.boolean().default(false),mode:z.enum(['collective','rotation']),duration:z.union([z.literal(15),z.literal(30),z.literal(60)]),
    hosts:roster}).strict(),
  z.object({action:z.literal('changeHosts'),id,hosts:roster,expectedHosts:roster}).strict(),
  z.object({action:z.literal('close'),id}).strict(),
  z.object({action:z.literal('book'),id,pageId:id,start:instant,email:emailAddress.transform(value=>value.toLowerCase())}).strict(),
  z.object({action:z.literal('reschedule'),id,start:instant,expectedStart:instant,roster:rosterPreview.optional()}).strict(),
  z.object({action:z.literal('useCalendarHosts'),id,expectedStart:instant,expectedHosts:roster,calendarHosts:roster}).strict(),
  z.object({action:z.literal('replaceHost'),id,expectedStart:instant,expectedHost:id,host:id}).strict(),
  z.object({action:z.literal('cancel'),id,expectedStart:instant.optional()}).strict(),
]);
export type TeamChange=z.infer<typeof teamBookingChange>;
export type TeamCalendar={id:string;title:string;mode:'collective'|'rotation';publicEnabled:boolean;duration:number;hosts:string[]};
export type TeamWindow={start:string;end:string;liveGoogle?:true};
export type BookingReviewFilter='mine'|'team'|'formerHosts'|'outsideHours';
export type TeamBookingCursor={start:string;id:string};
export type BookingHost={id:string;label:string};
export type CollectiveRosterPreview={start:string;booked:BookingHost[];proposed:BookingHost[];calendarHosts:string[];changed:boolean;available:boolean};
export type BookingHostOptions={expectedHost:string;start:string;hosts:BookingHost[]};
export type HostCursor={email:string;id:string};
export type HostSearch={query:string;after?:HostCursor};
export type CalendarHostIssue='former'|'access'|'hours';
export type TeamSchedule={
  nextBookings:TeamBookingCursor|null;
  owner:boolean;canEditAvailability:boolean;publicBooking:boolean;liveGoogle:boolean;revision:number;windows:TeamWindow[];weekly:WeeklyHours|null;timeOff:TeamTimeOff[];
  hosts:BookingHost[];nextHosts:HostCursor|null;pages:(TeamCalendar&{hostLabels:Record<string,string>;hostIssues:{id:string;reason:CalendarHostIssue}[]})[];
  meetings:{id:string;pageId?:string;multipleContacts?:boolean;canReschedule:boolean;title:string;email:string;start:string;end:string;awayHostNames?:string[];formerHostNames?:string[];outsideHoursHostNames?:string[];hostNames:string[]}[];
};
