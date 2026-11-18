import {defaultPipelineId} from './pipeline-default';
import {lifecycles} from './crm';
import {isPipelineSettings,pipelineFor,type DealStageSource} from './forecast';
import {historyStageSchema,type DealFunnel,type FunnelKind} from './deal-funnel';
export type StageTimeStats={completedCount:number;medianDays:number|null;meanDays:number|null;medianVisits:number|null;openCount:number;medianOpenDays:number|null};
export type StageTimeCoverage={kind:FunnelKind;pipelineName:string;rangeLabel:string;ownerLabel:string;cutoff:string;withoutCreation:number;merged:number;ambiguous:number;invalidDates:number;interrupted:number;unverified:number;ownerBreakdown?:{grouping:'member'|'name';overall:(StageTimeStats&{step:number;stage:string})[]}};
export type StageTimeDrill={stage:string;mode:'completed'|'open';cutoff:string;ownerLabel?:string;ownerIdentity?:string|null};
export function defaultStageTime(source:DealStageSource,kind:FunnelKind='deals'):DealFunnel {
  const id=defaultPipelineId(kind,source);
  const stages=kind!=='deals'?[...lifecycles]:isPipelineSettings(source)?pipelineFor(source,id)!.stageOrder:[...source];
  return {pipelineId:id,stages:stages.slice(0,10),optionalStages:[],period:'all',from:'',to:'',ownerMode:'all',owner:''};
}
export function validateStageTime(f:DealFunnel,source:DealStageSource,kind:FunnelKind) {
  historyStageSchema.parse(f);
  if(f.optionalStages.length)throw Error('Time-in-stage reports measure independent stages; optional steps do not apply.');
  const pipeline=kind==='deals'&&isPipelineSettings(source)?pipelineFor(source,f.pipelineId):undefined;
  if((kind!=='deals'||!isPipelineSettings(source))&&f.pipelineId!=='default'||kind==='deals'&&isPipelineSettings(source)&&!pipeline)throw Error('Choose an available pipeline.');
  const stages=kind!=='deals'?[...lifecycles]:pipeline?.stageOrder||source as readonly string[];
  if(f.stages.some(s=>!stages.includes(s)))throw Error('A time-in-stage report stage is unavailable. Choose current stages.');
}
