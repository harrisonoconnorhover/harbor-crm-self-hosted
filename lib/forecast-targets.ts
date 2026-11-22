import {z} from 'zod';
import {forecastSettingsSchema,fiscalStartMonthSchema} from './sales-forecast';
export const forecastTargetScope=forecastSettingsSchema.pick({month:true,period:true,pipelineId:true}).extend({workspaceId:z.string().guid("Invalid uuid"),fiscalStartMonth:fiscalStartMonthSchema});
export const forecastTargetQuery=forecastTargetScope.extend({includeNested:z.enum(['true','false']).default('false'),after:z.string().max(200).default(''),teamId:z.union([z.string().guid("Invalid uuid"),z.literal('unassigned')]).optional()}).strict();
export const forecastTargetSave=forecastTargetScope.extend({memberId:z.string().min(1).max(200),revision:z.number().int().nonnegative(),amountCents:z.number().int().min(0).max(100000000000000).nullable()}).strict();
export type ForecastTargetQuery=z.infer<typeof forecastTargetQuery>;
export type ForecastTargetSave=z.infer<typeof forecastTargetSave>;
export type ForecastTargetRow={id:string;name:string;status:string;amountCents:number|null;revision:number;wonAmount:number;openAmount:number;weightedOpen:number;submissionAmountCents:number|null;submissionRevision:number;submittedAt:string|null;canSubmit:boolean};
export type ForecastTargetPage={canEdit:boolean;items:ForecastTargetRow[];next:string|null};
export function targetProgress(amountCents:number|null,wonAmount:number){
 const target=amountCents===null?null:amountCents/100;
 return {remaining:target===null?null:Math.max(0,Math.round((target-wonAmount)*100)/100),percent:target===null||target===0?null:Math.round(wonAmount/target*1000)/10};
}

export function parseTargetCents(value:string):number|null{
 const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());if(!match)return null;
 const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents<=100000000000000?cents:null;
}
