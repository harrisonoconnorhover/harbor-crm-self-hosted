import {resolvedStageProperties,stageRuleMatchesStage,type StagePropertyRules} from './stage-property-rules';
import type {Data} from './crm';
export type StageMoveKind='deals'|'tickets'|'leads';
export const stageMoveFields={deals:{stage:'stage',pipeline:'pipelineId'},tickets:{stage:'ticketStatus',pipeline:'ticketPipelineId'},leads:{stage:'leadStage',pipeline:'leadPipelineId'}} as const;
export type SharedStageContext={pipelineId:string;stageOrder:string[];labels:Record<string,string>;stageProperties:Record<string,{field:string;required:boolean}[]>;stagePropertyRules:StagePropertyRules};
export type SharedStageMove={kind:StageMoveKind;pipelineId:string;fromStage:string;toStage?:string;updatedAt:string};
export function stageMoveProblem(move:SharedStageMove,record:{kind:string;updatedAt:string;fields:{id:string;value:unknown}[];stageContext?:SharedStageContext}){
 const keys=stageMoveFields[move.kind],values=Object.fromEntries(record.fields.map(f=>[f.id,f.value])),context=record.stageContext;
 if(record.kind!==move.kind||record.updatedAt!==move.updatedAt||String(values[keys.pipeline]||'default')!==move.pipelineId||String(values[keys.stage]??'')!==move.fromStage)return 'This card changed. Close this form and refresh the board before moving it.';
 if(!context||context.pipelineId!==move.pipelineId)return 'This pipeline is unavailable. Close this form and refresh the board.';
 if(move.toStage!==undefined&&!context.stageOrder.includes(move.toStage))return 'This destination stage is unavailable. Close this form and refresh the board.';
 return '';
}
export function stageMovePrompt(context:SharedStageContext,stage:string,values:Record<string,unknown>){
 const data:Data={name:'',owner:'',custom:{}};for(const [id,value] of Object.entries(values))if(id.startsWith('custom:'))data.custom![id.slice(7)]=value as string;else (data as Record<string,unknown>)[id]=value;
 const properties=resolvedStageProperties(context,stage,data),controllers=[...new Set(context.stagePropertyRules.filter(r=>stageRuleMatchesStage(r,stage)).flatMap(r=>(r.conditions||[]).map(c=>c.field)))];
 const missing=properties.filter(p=>{const value=values[p.field];return p.required&&(value==null||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length)}).map(p=>p.field);
 return {properties,controllers,missing};
}

// A table cell contains a display label, not a stage ID. Derive move context only
// from the fresh editor payload so each pipeline keeps its own stage options.
export function stageMoveForField(field:string|undefined,record:{kind:string;updatedAt:string;fields:{id:string;value:unknown}[]}):SharedStageMove|undefined{
 if(!['deals','tickets','leads'].includes(record.kind))return;
 const kind=record.kind as StageMoveKind,keys=stageMoveFields[kind];if(field!==keys.stage)return;
 const values=Object.fromEntries(record.fields.map(f=>[f.id,f.value]));
 return {kind,pipelineId:String(values[keys.pipeline]||'default'),fromStage:String(values[keys.stage]??''),updatedAt:record.updatedAt};
}
