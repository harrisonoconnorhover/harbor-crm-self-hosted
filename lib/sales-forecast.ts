import {z} from 'zod';

export const forecastBuckets=['all','open','won','lost','unavailable','undated'] as const;
export const forecastBucketLabels={all:'All dated deals',open:'Open pipeline',won:'Closed won',lost:'Closed lost',unavailable:'Unavailable stages',undated:'Missing or invalid close date'};
const month=z.string().regex(/^(19\d{2}|2\d{3})-(0[1-9]|1[0-2])$/);
export const forecastSettingsSchema=z.object({
 month,period:z.enum(['month','quarter']).default('month'),pipelineId:z.string().max(100).default(''),
 forecastCategory:z.union([z.literal(''),z.literal('unset'),z.literal('unavailable'),z.string().startsWith('value:').min(7).max(86)]).default(''),
 owner:z.string().max(700).default(''),bucket:z.enum(forecastBuckets).default('all'),
 after:z.string().max(200).default(''),ownerAfter:z.string().max(700).default(''),
});
export type ForecastSettings=z.infer<typeof forecastSettingsSchema>;
export const forecastQuerySchema=forecastSettingsSchema.extend({workspaceId:z.string().guid("Invalid uuid"),operation:z.literal('forecast')}).strict();
export type ForecastQuery=z.infer<typeof forecastQuerySchema>;
export function forecastSettings(params:URLSearchParams,now=new Date()):ForecastSettings{
 const fallback=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
 const input=Object.fromEntries(Object.keys(forecastSettingsSchema.shape).map(k=>[k,params.get(k)||undefined]));
 const parsed=forecastSettingsSchema.safeParse({...input,month:input.month||fallback});
 return parsed.success?parsed.data:forecastSettingsSchema.parse({month:fallback});
}
// A saved quarter is identified by its actual start date, independent of fiscal labels.
export function forecastPeriod(value:Pick<ForecastSettings,'month'|'period'>&{fiscalStartMonth?:string}){
 const [year,month]=value.month.split('-').map(Number),fiscalStart=Number(value.fiscalStartMonth||1)-1;
 const fiscalYear=month-1<fiscalStart?year-1:year,offset=(month-1-fiscalStart+12)%12,quarter=Math.floor(offset/3)+1;
 const startMonth=value.period==='quarter'?fiscalStart+(quarter-1)*3:month-1,startYear=value.period==='quarter'?fiscalYear:year;
 const from=new Date(Date.UTC(startYear,startMonth,1)).toISOString().slice(0,10),until=new Date(Date.UTC(startYear,startMonth+(value.period==='quarter'?3:1),1)).toISOString().slice(0,10);
 const label=value.period==='quarter'?(fiscalStart===0?`Q${quarter} ${fiscalYear}`:`FQ${quarter} FY ${fiscalYear}–${fiscalYear+1}`):new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(from+'T00:00:00Z'));
 return {from,until,label};
}
export function savedForecastPeriodLabel(period:string,from:string){
 if(period!=='quarter')return from.slice(0,7);
 const [y,m]=from.split('-').map(Number),end=new Date(Date.UTC(y,m+2,0)).toISOString().slice(0,10);
 return `Quarter ${from} through ${end}`;
}
export const fiscalStartMonthSchema=z.string().regex(/^(?:[1-9]|1[0-2])$/).default('1');
export type ForecastTotals={count:number;amount:number;openCount:number;openAmount:number;weightedOpen:number;wonCount:number;wonAmount:number;lostCount:number;lostAmount:number;unavailableCount:number};
export function forecastCategoryLabel(key:string){return key==='unset'?'Uncategorized':key==='unavailable'?'Unavailable categories':key.startsWith('value:')?key.slice(6):'All categories'}
export type ForecastResult={fiscalStartMonth:string;period:ReturnType<typeof forecastPeriod>;asOf:string;pipelines:{id:string;name:string}[];totals:ForecastTotals;undated:number;categoryOptions:string[];categories:(ForecastTotals&{key:string})[];
 owners:(ForecastTotals&{key:string;name:string;member:boolean})[];ownerNext:string|null;ownerCount:number;
 items:{id:string;name:string;owner:string;ownerKey:string;closeDate:string;amount:number;weighted:number;forecastCategory:string;categoryKey:string;stage:string;pipeline:string;outcome:string;unavailable:number}[];total:number;next:string|null};
