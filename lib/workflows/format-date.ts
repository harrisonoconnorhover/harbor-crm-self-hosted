import {z} from 'zod';
import {propertyDateTimeSchema} from '../property-datetime';
export type DateFormat = {mode:'date';amount:number;unit:'days'|'months'|'years';timeZone:string}|{mode:'datetime';hours:number};
const dateSchema=z.string().date('Use a valid YYYY-MM-DD date.');
// Date-only values are calendar labels, never UTC instants. Month/year shifts
// clamp to the final day of the target month instead of overflowing into March.
export function formatWorkflowDate(input:unknown,format:DateFormat,whenEmpty:'fail'|'empty'){
 if(input===undefined||input===null||input===''){
  if(whenEmpty==='empty')return '';
  throw Error('The source date is empty. Set a date or choose Return empty value.');
 }
 if(typeof input!=='string')throw Error('Expected a date or an ISO date/time with a time zone.');
 if(format.mode==='datetime'){
  const value=propertyDateTimeSchema.parse(input);
  return propertyDateTimeSchema.parse(new Date(Date.parse(value)+format.hours*3600000).toISOString());
 }
 let day:string;
 if(dateSchema.safeParse(input).success)day=input;
 else {
  const instant=propertyDateTimeSchema.parse(input);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:format.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  day=`${part('year').padStart(4,'0')}-${part('month')}-${part('day')}`;
 }
 const date=new Date(day+'T00:00:00.000Z');
 if(format.unit==='days')date.setUTCDate(date.getUTCDate()+format.amount);
 else {
  const originalDay=date.getUTCDate();date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth()+format.amount*(format.unit==='years'?12:1));
  const end=new Date(date);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  date.setUTCDate(Math.min(originalDay,end.getUTCDate()));
 }
 const result=date.toISOString();
 if(!/^\d{4}-/.test(result))throw Error('The calculated date is outside the supported year range.');
 return dateSchema.parse(result.slice(0,10));
}
