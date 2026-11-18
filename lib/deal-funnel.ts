import {memberOwnerFilterSchema} from './record-owner';
import {defaultPipelineId} from './pipeline-default';
import type { ConversionTime } from './funnel-timing';
import { lifecycles } from './crm';
import { reportPeriodIds, reportPeriods, reportDateRange } from './report-date-range';
import { z } from 'zod';
import { isPipelineSettings, pipelineFor, stageOutcome, type DealStageSource } from './forecast';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, 'Choose a valid UTC date.');
export const historyStageSchema = z.object({
  pipelineId: z.string().min(1).max(100),
  stages: z.array(z.string().min(1).max(80)).min(1).max(10),
  optionalStages: z.array(z.string().min(1).max(80)).max(8).default([]),
  period: z.enum(reportPeriodIds).default('custom'),
  from: z.string().max(10).default(''), to: z.string().max(10).default(''),
  ownerMode: z.enum(["all", "named", "member", "unassigned"]).default('all'),
  ownerMember: memberOwnerFilterSchema.optional(),
  owner: z.string().trim().max(160).default(''),
}).superRefine((f,c) => {
  if(f.period==='custom'&&(!day.safeParse(f.from).success||!day.safeParse(f.to).success))c.addIssue({code:'custom',message:'Choose valid custom UTC dates.'});
  if(f.period==='custom'&&f.from>f.to)c.addIssue({code:'custom',message:'The end date must follow the start date.'});
  if(new Set(f.stages).size!==f.stages.length)c.addIssue({code:'custom',message:'Choose each stage once.'});
  if(new Set(f.optionalStages).size!==f.optionalStages.length||f.optionalStages.some(s=>!f.stages.includes(s)))c.addIssue({code:'custom',message:'Optional stages must be unique selected stages.'});
  if(f.optionalStages.includes(f.stages[0])||f.optionalStages.includes(f.stages.at(-1)!))c.addIssue({code:'custom',message:'The first and last funnel stages must be required.'});
  if(f.ownerMode==="member"&&!f.ownerMember)c.addIssue({code:"custom",message:"Choose a workspace member."});
  if(f.ownerMode!=="member"&&f.ownerMember)c.addIssue({code:"custom",message:"Member selection requires member owner mode."});
  if(f.ownerMode==='named' &&!f.owner)c.addIssue({code:'custom',message:'Enter a current record owner.'});
}).transform(f=>f.period==='custom'?f:{...f,from:'',to:''});
export const dealFunnelSchema = historyStageSchema.refine(f=>f.stages.length>=2,'Choose at least two funnel stages.');
export type DealFunnel = z.infer<typeof dealFunnelSchema>;
export type FunnelKind = 'deals'|'contacts'|'companies';
export type FunnelOwnerGroup={key:string;label:string;identity:string|null;rows:import('./reporting').ReportRow[];timing:{overall:ConversionTime;cutoff:string}};
export type FunnelCoverage = { ownerBreakdown?:{grouping:'member'|'name';groups:FunnelOwnerGroup[]}; timing?:{overall:ConversionTime;cutoff:string}; kind?:FunnelKind; populationCount?:number; excludedMerged: number; ambiguousDeals: number; withoutCreation: number; pipelineName:string; from:string; to:string; rangeLabel:string; ownerLabel:string };
export function validateDealFunnel(f:DealFunnel,source:DealStageSource,kind:FunnelKind='deals') {
  dealFunnelSchema.parse(f);
  if(kind!=='deals') {
    if(f.pipelineId!=='default')throw Error('Lifecycle funnels do not use deal pipelines.');
    let previous=-1;
    for(const stage of f.stages){const index=(lifecycles as readonly string[]).indexOf(stage);if(stage==='Other'||index<0||index<=previous)throw Error('Choose current lifecycle stages in order.');previous=index;}
    return;
  }
  const pipeline=isPipelineSettings(source)?pipelineFor(source,f.pipelineId):f.pipelineId==='default'?{stageOrder:[...source]}:undefined;
  if(!pipeline)throw Error('This funnel pipeline is unavailable. Choose another pipeline.');
  let previous=-1;
  for(const stage of f.stages){
    const index=pipeline.stageOrder.indexOf(stage);
    if(index<0)throw Error('A funnel stage is unavailable. Choose current stages.');
    if(index<=previous)throw Error('Choose funnel stages in pipeline order.');
    if(stageOutcome(source,stage,f.pipelineId)==='lost')throw Error('Lost stages cannot be funnel steps.');
    previous=index;
  }
}
export function defaultFunnel(source:DealStageSource,kind:FunnelKind='deals'):DealFunnel {
  if(kind!=='deals')return {pipelineId:'default',stages:lifecycles.slice(1,6),optionalStages:[],period:'last30',from:'',to:'',ownerMode:'all',owner:''};
  const id=defaultPipelineId("deals",source);
  const pipeline=isPipelineSettings(source)?pipelineFor(source,id):undefined;
  const stages=pipeline?.stageOrder ?? (isPipelineSettings(source)?source.stageOrder:[...source]);
  return {pipelineId:id,optionalStages:[],period:'last30',stages:stages.filter(s=>stageOutcome(source,s,id)!=='lost').slice(0,10),from:'',to:'',ownerMode:'all',owner:''};
}
export type FunnelRole = {optional:boolean;previousRequired:number|null;nextRequired:number|null};
export function funnelRoles(f:Pick<DealFunnel,'stages'|'optionalStages'>):FunnelRole[] {
  const optional=new Set(f.optionalStages||[]);
  return f.stages.map((stage,i)=>({optional:optional.has(stage),
    previousRequired:f.stages.slice(0,i).map((s,n)=>!optional.has(s)?n:-1).filter(n=>n>=0).at(-1)??null,
    nextRequired:f.stages.map((s,n)=>n>i&&!optional.has(s)?n:-1).find(n=>n>=0)??null}));
}
export function resolveFunnelDates(f:DealFunnel,now=new Date(),fiscalStartMonth?:number) {
  const range=reportDateRange({period:f.period||'custom',from:f.from,to:f.to},now,fiscalStartMonth);
  return {...f,from:range?.from||'',to:range?.to||''};
}
export function funnelRangeLabel(f:DealFunnel) {
  return f.period==='all'?'All recorded dates':`${reportPeriods[f.period||'custom']} (${f.from} to ${f.to}, UTC)`;
}
export function funnelSemantics(f:DealFunnel,kind:FunnelKind='deals') {
  const singular=kind==='companies'?'company':kind==='contacts'?'contact':'deal';
  return `${funnelRangeLabel(f)}. Required stages must be entered in order within this range. Progress after the end date is excluded, so recent entrants have less time to convert. Each ${singular} counts once per required step, using strictly later timestamps. Optional stages never change required counts or conversion denominators. An optional visit counts after the previous required match and before the earliest next required match, or while that next match is absent. Optional stages within the same window are independent; later visits after that window do not count. Skipped means the next required stage was reached without a visit to this optional stage. New ${singular} creation and import record only their initial ${kind==='deals'?'stage':'lifecycle stage'} from the creation-history release for this object onward. Earlier starting stages and missing history are not inferred. Merged ${kind} are excluded; deleted ${kind} are absent. Restored history is retained, but restoration itself is not an entry. Owner means the current ${singular} owner. Same-time entries cannot prove order. Not reaching the next required step means no qualifying entry within the range, not necessarily ${kind==='deals'?'a lost deal':'a lost customer'}.`;
}
// Semantic reference: required anchors first, independent optional visits inside
// their anchor window. Never let an optional visit delay a required transition.
export function funnelPrefixTimes(events:{stage:string;at:number}[],stages:string[],optionalStages:string[]=[]) {
  const roles=funnelRoles({stages,optionalStages}),times:(number|null)[]=stages.map(()=>null);
  const earliest=(stage:string,after:number,before=Infinity)=>{
    const time=events.filter(e=>e.stage===stage&&Number.isFinite(e.at)&&e.at>after&&e.at<before).reduce((min,e)=>Math.min(min,e.at),Infinity);
    return Number.isFinite(time)?time:null;
  };
  let after=-Infinity;
  stages.forEach((stage,i)=>{if(!roles[i].optional){times[i]=earliest(stage,after);after=times[i]??Infinity;}});
  stages.forEach((stage,i)=>{const role=roles[i];if(role.optional){const prior=times[role.previousRequired!];times[i]=prior===null?null:earliest(stage,prior,times[role.nextRequired!]??Infinity);}});
  return times;
}
