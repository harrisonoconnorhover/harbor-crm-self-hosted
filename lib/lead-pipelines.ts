import {z} from 'zod';
import {leadStages,lifecycles,type Data,type Kind} from './crm';
import type {DealStageSource} from './forecast';
export type LeadStage={id:string;label:string;outcome:'open'|'qualified'|'disqualified'};
export type LeadEditAccess={stages:string[];scope:'owner'|'members';members:{id:string;label:string}[]};
export type LeadMovementRule='all'|string[];
export type LeadPipeline={id:string;name:string;isDefault?:boolean;requireDealOnQualification?:boolean;editAccess?:LeadEditAccess;creationRule?:{stages:string[];defaultStage:string};restrictSkip?:LeadMovementRule;restrictBackward?:LeadMovementRule;autoAttempt?:boolean;autoConnect?:boolean;createOnLifecycle?:string[];followUp?:{reasons:string[];leadType:string};stages:LeadStage[]};
export const initialLeadPipelines:LeadPipeline[]=[{id:'default',name:'Lead pipeline',isDefault:true,stages:leadStages.map(id=>({id,label:id,outcome:id==='Qualified'?'qualified':id==='Disqualified'?'disqualified':'open'}))}];
export const followUpRule=z.object({reasons:z.array(z.string().trim().min(1).max(80)).min(1).max(50).refine(v=>new Set(v).size===v.length,'Choose each reason once.'),leadType:z.string().trim().min(1).max(80)}).strict();
const identifier=z.string().trim().min(1).max(100).refine(v=>!['__proto__','constructor','prototype'].includes(v),'Choose another identifier.');
const movementRule=z.union([z.literal('all'),z.array(identifier).min(1).max(50).refine(v=>new Set(v).size===v.length,'Choose each restricted stage once.')]);
const editAccessRule=z.object({stages:z.array(identifier).min(1).max(50).refine(v=>new Set(v).size===v.length,'Choose each restricted stage once.'),scope:z.enum(['owner','members']),members:z.array(z.object({id:z.string().min(1).max(200),label:z.string().trim().min(1).max(100)}).strict()).max(100)}).strict().superRefine((r,ctx)=>{
 if(new Set(r.members.map(m=>m.id)).size!==r.members.length)ctx.addIssue({code:'custom',message:'Choose each member once.'});
 if(r.scope==='owner'&&r.members.length||r.scope==='members'&&!r.members.length)ctx.addIssue({code:'custom',message:'Choose at least one member, or restrict editing to the workspace owner.'});
});
export const leadCatalogInput=z.object({revision:z.number().int().min(0),pipelines:z.array(z.object({id:identifier,name:z.string().trim().min(1).max(80),isDefault:z.boolean().optional(),requireDealOnQualification:z.boolean().optional(),editAccess:editAccessRule.optional(),creationRule:z.object({stages:z.array(identifier).min(1).max(50).refine(v=>new Set(v).size===v.length,'Choose each creation stage once.'),defaultStage:identifier}).strict().optional(),restrictSkip:movementRule.optional(),restrictBackward:movementRule.optional(),autoAttempt:z.boolean().optional(),autoConnect:z.boolean().optional(),createOnLifecycle:z.array(z.enum(lifecycles)).max(lifecycles.length).refine(v=>new Set(v).size===v.length,'Choose each lifecycle stage once.').optional(),followUp:followUpRule.optional(),stages:z.array(z.object({id:identifier,label:z.string().trim().min(1).max(80),outcome:z.enum(['open','qualified','disqualified'])}).strict()).min(3).max(50)}).strict()).min(1).max(20)}).strict().superRefine((c,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(c.pipelines.filter(p=>p.isDefault).length!==1)fail('Choose one default lead pipeline.');
 if(new Set(c.pipelines.map(p=>p.id)).size!==c.pipelines.length||new Set(c.pipelines.map(p=>p.name.toLowerCase())).size!==c.pipelines.length)fail('Use unique pipeline identifiers and names.');
 const ids=c.pipelines.flatMap(p=>p.stages.map(s=>s.id));if(new Set(ids).size!==ids.length)fail('Use unique stage identifiers across lead pipelines.');
 for(const p of c.pipelines){if(p.editAccess?.stages.some(id=>!p.stages.some(s=>s.id===id)))fail('Editing access must reference available stages. Clear a stage from its editing rule before removing it.');if(p.creationRule&&(p.creationRule.stages.some(id=>!p.stages.some(s=>s.id===id))||!p.creationRule.stages.includes(p.creationRule.defaultStage)))fail('Choose available creation stages and a default within them. Clear a stage from its creation rule before removing it.');for(const rule of [p.restrictSkip,p.restrictBackward])if(Array.isArray(rule)&&rule.some(id=>!p.stages.some(s=>s.id===id&&s.outcome==='open')))fail('Movement rules must reference available open stages in their pipeline. Clear a stage from its rule before removing it or changing its outcome.');if(p.autoAttempt||p.autoConnect){const positions=["New","Attempting","Connected"].map(id=>p.stages.findIndex(s=>s.id===id&&s.outcome==='open'));if(p.id!=='default'||positions.some(i=>i<0)||!(positions[0]<positions[1]&&positions[1]<positions[2]))fail('Automatic progression needs the original New, Attempting and Connected stages, in that order, in the original Lead pipeline.');}if(new Set(p.stages.map(s=>s.label.toLowerCase())).size!==p.stages.length)fail('Use unique stage names within a pipeline.');if(p.stages[0].outcome!=='open'||!p.stages.some(s=>s.outcome==='qualified')||!p.stages.some(s=>s.outcome==='disqualified'))fail('Start with an open stage and include qualified and disqualified stages.');}
});
export function leadPipelines(source?:DealStageSource):LeadPipeline[]{return source&&!Array.isArray(source)&&'leadPipelines' in source&&source.leadPipelines?source.leadPipelines:initialLeadPipelines;}
export function leadPipelineFor(source?:DealStageSource,id='default'){return leadPipelines(source).find(p=>p.id===id);}
export function leadStageFor(source:DealStageSource|undefined,data:Pick<Data,'leadPipelineId'|'leadStage'>){return leadPipelineFor(source,data.leadPipelineId)?.stages.find(s=>s.id===data.leadStage);}
export function leadStageOptions(source?:DealStageSource,pipelineId?:string){return leadPipelines(source).filter(p=>pipelineId===undefined||p.id===pipelineId).flatMap(p=>p.stages.map(s=>s.id));}
export function leadStageLabels(source?:DealStageSource,pipelineId?:string){return Object.fromEntries(leadPipelines(source).filter(p=>pipelineId===undefined||p.id===pipelineId).flatMap(p=>p.stages.map(s=>[s.id,s.label])));}
export function moveLeadPipeline(data:Data,id:string,source?:DealStageSource):Data{const p=leadPipelineFor(source,id);if(!p)throw Error('Choose an available lead pipeline.');return {...data,leadPipelineId:id,leadStage:p.stages.some(s=>s.id===data.leadStage)?data.leadStage:p.stages[0].id};}
export function cloneLeadPipeline(p:LeadPipeline):LeadPipeline{
 const stages=p.stages.map(s=>({...s,id:crypto.randomUUID()})),remap=(rule:LeadMovementRule|undefined)=>Array.isArray(rule)?rule.flatMap(id=>{const stage=stages[p.stages.findIndex(s=>s.id===id)];return stage?[stage.id]:[]}):rule;
 return {id:crypto.randomUUID(),name:p.name.slice(0,75)+' copy',requireDealOnQualification:p.requireDealOnQualification,editAccess:p.editAccess?{...p.editAccess,stages:remap(p.editAccess.stages) as string[],members:p.editAccess.members.map(m=>({...m}))}:undefined,creationRule:p.creationRule?{stages:remap(p.creationRule.stages) as string[],defaultStage:stages[p.stages.findIndex(s=>s.id===p.creationRule!.defaultStage)]?.id||''}:undefined,restrictSkip:remap(p.restrictSkip),restrictBackward:remap(p.restrictBackward),stages};
}

export function leadCreationStageOptions(source?:DealStageSource,pipelineId='default'){
 const pipeline=leadPipelineFor(source,pipelineId);return pipeline?.stages.filter(s=>!pipeline.creationRule||pipeline.creationRule.stages.includes(s.id)).map(s=>s.id)||[];
}
export function leadCreationDefault(source?:DealStageSource,pipelineId='default'){
 const pipeline=leadPipelineFor(source,pipelineId);return pipeline?.creationRule?.defaultStage||pipeline?.stages[0]?.id;
}
// Only manual creation callers use this default. Explicit stage choices still
// pass through ordinary parsing and creation-rule validation without coercion.
export function manualLeadCreationInput(kind:Kind,input:unknown,source:DealStageSource):unknown{
 if(kind!=='leads'||!input||typeof input!=='object'||Array.isArray(input))return input;
 const data=input as Record<string,unknown>;if(data.leadStage!==undefined)return input;
 const id=data.leadPipelineId??leadPipelines(source).find(p=>p.isDefault)?.id??'default';
 const pipeline=typeof id==='string'?leadPipelineFor(source,id):undefined;
 return pipeline?.creationRule?{...data,leadStage:pipeline.creationRule.defaultStage}:input;
}
// Creation forms can reset an inherited clone/pipeline stage before the user
// reviews it. Saving an explicitly disallowed stage is always rejected.
export function leadCreationDraft(data:Data,source?:DealStageSource):Data{
 return leadCreationStageOptions(source,data.leadPipelineId).includes(data.leadStage||'')?data:{...data,leadStage:leadCreationDefault(source,data.leadPipelineId)};
}

// Stage access restricts an existing record's properties, not its visibility,
// activities or associations. Entering a restricted stage is still allowed.
export function leadEditAccessError(actor:{role:string;actorId:string},kind:Kind,data:Data,source?:DealStageSource):string|undefined{
 if(kind!=='leads'||actor.role==='owner')return;
 const pipeline=leadPipelineFor(source,data.leadPipelineId),rule=pipeline?.editAccess;
 if(!rule?.stages.includes(data.leadStage||''))return;
 if(actor.role==='editor'&&rule.scope==='members'&&rule.members.some(m=>m.id===actor.actorId))return;
 const stage=pipeline?.stages.find(s=>s.id===data.leadStage)?.label||'this stage';
 return `Lead properties are locked in ${stage}. Only the workspace owner${rule.scope==='members'?' or selected editors':''} can edit properties or move this lead. Activities and associations remain available with your workspace permissions.`;
}
