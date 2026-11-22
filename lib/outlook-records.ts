import {z} from 'zod';

export const outlookRecordProvider=z.enum(['outlook-mail','outlook-calendar']);
export type OutlookRecordProvider=z.infer<typeof outlookRecordProvider>;
export const outlookLookup=z.object({
  recordId:z.string().guid(),provider:outlookRecordProvider,through:z.iso.date(),days:z.union([z.literal(1),z.literal(7)]),
}).strict();
export const outlookLog=outlookLookup.extend({
  selection:z.string().regex(/^[A-Za-z0-9_-]{43}$/),attended:z.literal(true).optional(),
}).strict().refine(input=>input.provider==='outlook-calendar'?input.attended===true:input.attended===undefined);
export type OutlookLookup=z.infer<typeof outlookLookup>;
export type OutlookRecordPreview={selection:string;subject:string;occurredAt:number;excerpt?:string;logged:boolean;canConfirmReply?:boolean};
export type OutlookItem={id:string;subject:string;occurredAt:number;participants:string[];excerpt?:string};
export type OutlookRecordResults={items:OutlookRecordPreview[];limited:boolean};
export function outlookDateWindow({through,days}:Pick<OutlookLookup,'through'|'days'>,now:number){
  const day=86_400_000,today=Math.floor(now/day)*day,endDay=Date.parse(through+'T00:00:00Z');
  if(!Number.isFinite(endDay)||endDay>today||endDay-(days-1)*day<today-365*day)return null;
  return {start:endDay-(days-1)*day,end:Math.min(endDay+day,now+1)};
}
