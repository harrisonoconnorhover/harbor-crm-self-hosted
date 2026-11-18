import {z} from 'zod';
import {offsetDateTime} from './iso-date-time';

// Calendar-day comparison, not elapsed 24-hour periods: DST days can be 23/25h.
// Date-only values retain their written day; timestamps use the viewer's zone.
export function relativeDateText(value:unknown,now=new Date(),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC') {
 if(typeof value!=='string'||!value||!Number.isFinite(now.getTime()))return '';
 const day=(date:Date)=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value;
  return `${get('year')!.padStart(4,'0')}-${get('month')}-${get('day')}`;
 };
 let target:string;
 if(/^\d{4}-\d{2}-\d{2}$/.test(value)){if(!z.string().date().safeParse(value).success)return '';target=value;}
 else {if(!offsetDateTime.safeParse(value).success)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';target=day(date);}
 const delta=Math.round((Date.parse(target+'T00:00:00Z')-Date.parse(day(now)+'T00:00:00Z'))/86_400_000);
 if(!Number.isFinite(delta))return '';
 return delta===0?'Today':delta<0?`${Math.abs(delta)} day${delta===-1?'':'s'} ago`:`${delta} day${delta===1?'':'s'} from today`;
}
export function withRelativeDate(text:string,value:unknown,enabled?:boolean,now?:Date,timeZone?:string){
 const relative=enabled?relativeDateText(value,now,timeZone):'';
 return relative?`${text} (${relative})`:text;
}
