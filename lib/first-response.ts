import {z} from 'zod';
import {validTimeZone} from './email/schedule';
import {closeSlaTargets,slaPriorities} from './ticket-sla';

const shift=z.object({open:z.number().int().min(0).max(1439),close:z.number().int().min(1).max(2879)}).strict()
  .refine(day=>day.close>day.open&&(day.close<=1440||day.close-day.open<1440),
    'Enter different opening and closing times, or midnight to midnight for a full day.');
const hours=shift.safeExtend({second:shift.optional()})
  .refine(day=>!day.second||day.second.open>=day.close,'Start the second shift after the first shift ends.');
type SupportDay=z.infer<typeof hours>;
function shifts(day:SupportDay){return day.second?[day,day.second]:[day];}
// Clip shifts to one local date. A handoff can overlap the end of yesterday's
// coverage, but those staffed minutes only count once toward a response target.
function staffedIntervals(today:SupportDay|null,yesterday:SupportDay|null){
  const intervals:{open:number;close:number}[]=[];
  const carry=yesterday?Math.max(...shifts(yesterday).map(shift=>shift.close))-1440:0;
  if(carry>0)intervals.push({open:0,close:carry});
  for(const shift of today?shifts(today):[]){
    const close=Math.min(shift.close,1440);
    const last=intervals.at(-1);
    if(last&&last.close>=shift.open)last.close=Math.max(last.close,close);
    else intervals.push({open:shift.open,close});
  }
  return intervals;
}
export const workingCalendar=z.object({
  zone:z.string().min(1).max(100).refine(validTimeZone,'Choose a valid time zone.'),
  week:z.array(hours.nullable()).length(7).refine(days=>days.some(Boolean),'Open at least one day each week.'),
  holidays:z.array(z.iso.date()).max(366).refine(days=>new Set(days).size===days.length,'List each holiday once.'),
  specialHours:z.array(z.object({date:z.iso.date(),hours}).strict()).max(366).optional(),
}).strict().superRefine((calendar,ctx)=>{
  const dates=new Set(calendar.holidays);
  for(const entry of calendar.specialHours??[]){
    if(dates.has(entry.date))ctx.addIssue({code:'custom',message:'Choose each date only once across holiday closures and special hours.'});
    dates.add(entry.date);
  }
});
export type WorkingCalendar=z.infer<typeof workingCalendar>;
export const responsePolicyInput=z.object({revision:z.number().int().min(0).max(2147483646),enabled:z.boolean(),
  targets:closeSlaTargets,calendar:workingCalendar}).strict().superRefine((policy,ctx)=>{
  const weekly=policy.calendar.week.flatMap((today,i,week)=>staffedIntervals(today,week[(i+6)%7])).reduce((minutes,shift)=>minutes+shift.close-shift.open,0);
  if(policy.enabled&&!slaPriorities.some(p=>policy.targets[p]!==null))ctx.addIssue({code:'custom',message:'Choose at least one priority target.'});
  if(slaPriorities.some(p=>(policy.targets[p]??0)>weekly*52))ctx.addIssue({code:'custom',message:'Targets must fit within 52 working weeks.'});
});
export type ResponsePolicy=z.infer<typeof responsePolicyInput>;
export const defaultResponsePolicy:ResponsePolicy={revision:0,enabled:false,targets:{Urgent:30,High:60,Medium:240,Low:480},
  calendar:{zone:'UTC',week:[null,...Array.from({length:5},()=>({open:540,close:1020})),null],holidays:[]}};
export const responseLabels={waiting:'Awaiting first response',overdue:'First response overdue',met:'Responded on time',late:'Responded late'} as const;
export const firstResponseOutcomes=['waiting','overdue','met','late','no_target'] as const;
export const firstResponseOutcomeLabels={...responseLabels,no_target:'No first-response target'} as const;
export const responseChannels=['Email','Phone','Chat'] as const;
export const logFirstResponse=z.object({action:z.literal('first_response'),id:z.string().guid(),expectedRevision:z.number().int().positive(),
  at:z.iso.datetime().optional(),channel:z.enum(responseChannels),summary:z.string().trim().min(1).max(1000)}).strict();
export const logInboxResponse=logFirstResponse.pick({id:true,expectedRevision:true}).extend({
  action:z.literal('inbox_first_response'),replyId:z.string().guid(),
}).strict();
export type FirstResponse={dueAt:string;targetMinutes:number;policyRevision:number;respondedAt:string|null;workingMs:number|null;
  inboxConversationId?:string|null;inboxReplyId?:string|null;channel:string|null;summary:string|null;actorId:string|null;recordedBy:string|null};
export function firstResponseStatus(receipt:FirstResponse,now:number){
  if(receipt.respondedAt)return Date.parse(receipt.respondedAt)<=Date.parse(receipt.dueAt)?'met':'late';
  return now>Date.parse(receipt.dueAt)?'overdue':'waiting';
}

const minute=60000,day=1440*minute;
// Work in elapsed UTC time. A clock change splits the day into constant-offset pieces,
// so skipped local minutes count zero times and repeated working minutes count twice.
function* workIntervals(calendar:WorkingCalendar,start:number,end=Infinity){
  const formatter=new Intl.DateTimeFormat('en',{timeZone:calendar.zone,timeZoneName:'longOffset'});
  const holidays=new Set(calendar.holidays);
  const specialHours=new Map(calendar.specialHours?.map(entry=>[entry.date,entry.hours]));
  function dayHours(at:number){
    const date=new Date(at),key=date.toISOString().slice(0,10);
    if(holidays.has(key))return null;
    return specialHours.get(key)??calendar.week[date.getUTCDay()];
  }
  function offset(at:number){
    const text=formatter.formatToParts(at).find(p=>p.type==='timeZoneName')!.value;
    if(text==='GMT')return 0;
    const match=/^GMT([+-])(\d\d):(\d\d)$/.exec(text);
    if(!match)throw Error('Unsupported calendar offset.');
    return (match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]))*minute;
  }
  let cursor=Math.floor(start/day)*day;
  let current=offset(cursor);
  while(cursor<end){
    const next=(Math.floor(cursor/day)+1)*day,atEnd=offset(next-1);
    let boundary=next;
    if(current!==atEnd){
      let left=cursor/minute,right=next/minute-1;
      while(right-left>1){
        const middle=Math.floor((left+right)/2);
        if(offset(middle*minute)===current)left=middle;else right=middle;
      }
      boundary=right*minute;
    }
    for(let date=Math.floor((cursor+current)/day)*day;date<boundary+current;date+=day){
      const localDate=new Date(date).toISOString().slice(0,10);
      if(holidays.has(localDate))continue;
      const yesterday=specialHours.has(localDate)?null:dayHours(date-day);
      for(const shift of staffedIntervals(dayHours(date),yesterday)){
        const from=Math.max(start,cursor,date+shift.open*minute-current);
        const until=Math.min(end,boundary,date+shift.close*minute-current);
        if(until>from)yield {from,until};
      }
    }
    cursor=boundary;
    current=boundary===next?offset(next):atEnd;
  }
}
export function responseDeadline(calendar:WorkingCalendar,start:number,minutes:number){
  let left=minutes*minute;
  for(const {from,until} of workIntervals(calendar,start)){
    if(left<=until-from)return new Date(from+left).toISOString();
    left-=until-from;
  }
  throw Error('No working hours for this target.');
}
export function responseWorkingMs(calendar:WorkingCalendar,start:number,end:number){
  let duration=0;
  for(const {from,until} of workIntervals(calendar,start,end))duration+=until-from;
  return duration;
}
