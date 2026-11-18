import type {GoogleConnectionSetup} from '../google-connection-setup';
import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {validTimeZone,localDateTime} from '../email/schedule';
import {emailAddress} from '../email/message';
export const calendarWindow=z.object({start:utcDateTime,end:utcDateTime,timeZone:z.string().max(100).refine(validTimeZone)}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=86400000,'Choose an end time after the start, within 24 hours.');
export const meetingInput=z.object({id:z.string().guid("Invalid uuid"),connectionId:z.string().guid("Invalid uuid"),recordId:z.string().min(1).max(150),recordCreatedAt:z.string().min(1).max(50),title:z.string().trim().min(1).max(200),description:z.string().max(10000).default(''),location:z.string().trim().max(500).default(''),attendees:z.array(emailAddress).min(1).max(25).transform(v=>[...new Set(v.map(e=>e.toLowerCase()))]),start:utcDateTime,end:utcDateTime,timeZone:z.string().max(100).refine(validTimeZone),workspaceId:z.string().guid("Invalid uuid").optional(),draftRevision:z.number().int().positive().optional()}).strict();
export type MeetingInput=z.infer<typeof meetingInput>;
export type CalendarStatus={configured:boolean;connected:boolean;id:string;email:string;needsReconnect:boolean;setup?:GoogleConnectionSetup};
export type MeetingRow={id:string;recordId:string;recordCreatedAt:string;title:string;state:string;start:string;end:string;timeZone:string;email:string;error:string;eventUrl:string;checkedAt:string;pendingChange?:{id:string;kind:string;state:string;error:string}};
export type MeetingPage={results:MeetingRow[];next:{at:string;id:string}|null};
export function validateMeeting(v:MeetingInput,now=Date.now()){calendarWindow.parse({start:v.start,end:v.end,timeZone:v.timeZone});if(Date.parse(v.start)<=now||Date.parse(v.start)>now+366*86400000)throw Error('Choose a future meeting within one year.');}

// Prefer the selected future day; for today/past days choose the next half-hour.
export function meetingDraftStart(date:string|undefined,timeZone:string,now=new Date()){
 const next=new Date(Math.ceil((now.getTime()+60000)/1800000)*1800000),local=localDateTime(next,timeZone);
 return date&&date>localDateTime(now,timeZone).slice(0,10)?date+'T09:00':local;
}
