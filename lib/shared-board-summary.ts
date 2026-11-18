import {z} from 'zod';
import type {BoardAmounts} from './shared-board-amounts';
export const boardSummaryMetrics=[{id:'count',label:'Record count'},{id:'total',label:'Total amount'},{id:'weighted',label:'Weighted amount'},{id:'average',label:'Average amount'}] as const;
export const boardSummaryMetric=z.union([z.enum(['count','total','weighted','average']),z.string().regex(/^custom:[a-zA-Z0-9_-]{1,100}:(sum|average|min|max)$/)]);
export function customBoardMetric(id:string){const match=/^custom:([a-zA-Z0-9_-]{1,100}):(sum|average|min|max)$/.exec(id);return match?{propertyId:match[1],aggregation:match[2] as 'sum'|'average'|'min'|'max'}:null}
export type CustomBoardMetricDefinition={id:string;label:string;unavailable:boolean};
export type CustomBoardMetricValue={value:number|null;valued:number;missing:number};
export const boardSummarySettings=z.object({show:z.boolean().default(true),metrics:z.array(boardSummaryMetric).min(1).max(3).refine(ids=>new Set(ids).size===ids.length,'Choose unique metrics.'),location:z.enum(['top','bottom']).default('top'),abbreviate:z.boolean().default(false)}).strict();
export type BoardSummarySettings=z.infer<typeof boardSummarySettings>;
export function defaultBoardSummary(kind:string):BoardSummarySettings{return {show:true,metrics:kind==='deals'?['total','weighted','average']:['count'],location:'top',abbreviate:false}}
export function validBoardSummary(kind:string,value:BoardSummarySettings){return ['deals','tickets','leads'].includes(kind)&&(kind==='deals'||value.metrics.every(id=>id==='count'||!!customBoardMetric(id)))}
export function boardSummaryValues(count:number,amounts:BoardAmounts|undefined,settings:BoardSummarySettings,custom:Record<string,CustomBoardMetricValue>={},definitions:CustomBoardMetricDefinition[]=[]){return settings.metrics.map(id=>{
 const metric=customBoardMetric(id);
 if(metric){const def=definitions.find(m=>m.id===id),value=custom[id],label=def?.label||'Unavailable custom metric',empty=value?.valued===0&&metric.aggregation!=='sum',text=def?.unavailable||!value?'Unavailable':empty?'—':value.value===null?'Unavailable':new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(value.value);return {id,label,text,exact:value?.value!==null&&value?.value!==undefined?String(value.value):text,detail:value?`${value.valued.toLocaleString()} with value · ${value.missing.toLocaleString()} missing or invalid`:undefined}}
 const value=id==='count'?count:amounts?.[id as 'total'|'weighted'|'average']??null;
 const text=value===null?id==='average'&&amounts?.valued===0?'—':'Unavailable':id==='count'?value.toLocaleString('en-US'):new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:settings.abbreviate?'compact':'standard',maximumFractionDigits:settings.abbreviate?1:2}).format(value);
 const exact=value===null?text:id==='count'?text:new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
 return {id,label:boardSummaryMetrics.find(m=>m.id===id)!.label,text,exact};
})}
