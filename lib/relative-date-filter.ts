import {reportDateRange,isFiscalReportPeriod} from './report-date-range';
import {z} from 'zod';
import {validTimeZone} from './email/schedule';
export const relativeDatePeriods={today:'Today',yesterday:'Yesterday',tomorrow:'Tomorrow',lastDays:'Within the last N days',nextDays:'Within the next N days',olderThan:'More than N days ago',laterThan:'More than N days from now',thisWeek:'This week',lastWeek:'Last week',nextWeek:'Next week',thisMonth:'This month',lastMonth:'Last month',nextMonth:'Next month',thisQuarter:'This quarter',lastQuarter:'Last quarter',nextQuarter:'Next quarter',thisYear:'This year',lastYear:'Last year',nextYear:'Next year',thisFiscalQuarter:'This fiscal quarter',lastFiscalQuarter:'Last fiscal quarter',nextFiscalQuarter:'Next fiscal quarter',fiscalQuarterToDate:'This fiscal quarter so far',thisFiscalYear:'This fiscal year',lastFiscalYear:'Last fiscal year',nextFiscalYear:'Next fiscal year',fiscalYearToDate:'This fiscal year so far'} as const;
export type RelativeDatePeriod=keyof typeof relativeDatePeriods;
export const relativeDateNeedsDays=(period:string)=>['lastDays','nextDays','olderThan','laterThan'].includes(period);
export const relativeDateSchema=z.object({period:z.enum(Object.keys(relativeDatePeriods) as [RelativeDatePeriod,...RelativeDatePeriod[]]),days:z.number().int().min(0).max(36500).optional(),timeZone:z.string().min(1).max(100).refine(validTimeZone,'Choose a valid time zone.')}).strict().superRefine((v,c)=>{if(relativeDateNeedsDays(v.period)&&v.days===undefined)c.addIssue({code:'custom',message:'Enter a whole number of days from 0 to 36500.'});});
export type RelativeDate=z.infer<typeof relativeDateSchema>;
const formats=new Map<string,Intl.DateTimeFormat>();
export function relativeCalendarDay(at:Date,zone:string){
 let f=formats.get(zone);if(!f){f=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});if(formats.size>=64)formats.clear();formats.set(zone,f);}
 const parts=f.formatToParts(at),get=(t:string)=>parts.find(p=>p.type===t)!.value;return `${get('year')}-${get('month')}-${get('day')}`;
}
const shift=(day:string,n:number)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export type RelativeDateWindow={from:string|null;until:string|null};
const windows=new Map<string,RelativeDateWindow>();
// Calendar-day bounds are inclusive at the start, exclusive at the end.
export function relativeDateWindow(rule:RelativeDate,now=new Date(),fiscalStartMonth?:number):RelativeDateWindow{
 const today=relativeCalendarDay(now,rule.timeZone),key=JSON.stringify([today,rule,fiscalStartMonth]);const cached=windows.get(key);if(cached)return cached;
 const days=rule.days||0;let from:string|null=today,until:string|null=shift(today,1);
 if(isFiscalReportPeriod(rule.period)){
  const range=reportDateRange({period:rule.period as Parameters<typeof reportDateRange>[0]['period']},new Date(today+'T12:00:00Z'),fiscalStartMonth)!;
  from=range.from;until=shift(range.to,1);
 }else switch(rule.period){
  case 'yesterday':from=shift(today,-1);until=today;break;
  case 'tomorrow':from=shift(today,1);until=shift(today,2);break;
  case 'lastDays':from=shift(today,-days);break;
  case 'nextDays':until=shift(today,days+1);break;
  case 'olderThan':from=null;until=shift(today,-days);break;
  case 'laterThan':from=shift(today,days+1);until=null;break;
  default:{
   const offset=rule.period.startsWith('last')?-1:rule.period.startsWith('next')?1:0;
   const d=new Date(today+'T12:00:00Z');
   if(rule.period.endsWith('Week')){from=shift(today,-(d.getUTCDay()+6)%7+offset*7);until=shift(from,7);}
   else if(rule.period.endsWith('Month')||rule.period.endsWith('Quarter')||rule.period.endsWith('Year')){
    const months=rule.period.endsWith('Year')?12:rule.period.endsWith('Quarter')?3:1;
    d.setUTCDate(1);d.setUTCMonth(Math.floor(d.getUTCMonth()/months)*months+offset*months);from=d.toISOString().slice(0,10);d.setUTCMonth(d.getUTCMonth()+months);until=d.toISOString().slice(0,10);
   }
  }
 }
 const value={from,until};if(windows.size>=128)windows.clear();windows.set(key,value);return value;
}
export function matchesRelativeDate(value:unknown,rule:RelativeDate,now=new Date(),fiscalStartMonth?:number){
 const {from,until}=relativeDateWindow(rule,now,fiscalStartMonth);
 if(typeof value!=='string'||!value)return false;
 let day=value;
 if(value.length!==10){const at=new Date(value);if(!Number.isFinite(+at))return false;day=relativeCalendarDay(at,rule.timeZone);}
 if(!z.string().date().safeParse(day).success)return false;
 return (!from||day>=from)&&(!until||day<until);
}
// Find the first instant of a local calendar day, including midnight clock jumps
// and skipped dates. Binary search avoids assuming every day lasts 24 hours.
export function relativeDayStart(day:string,zone:string){
 const guess=Date.parse(day+'T00:00:00Z');let low=guess-36*3600000,high=guess+36*3600000;
 while(low<high){const middle=Math.floor((low+high)/2);if(relativeCalendarDay(new Date(middle),zone)<day)low=middle+1;else high=middle;}
 return new Date(low).toISOString();
}
export function relativeDateSummary(rule:RelativeDate){return relativeDatePeriods[rule.period].replace('N',String(rule.days??0))+' · '+rule.timeZone;}
