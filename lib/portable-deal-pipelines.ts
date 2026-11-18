import {z} from 'zod';
import {stages} from './crm';
import {defaultProbabilities,legacyStageOutcome,type StageOutcome} from './forecast';
import {samePropertyValue} from './property-values';
import {missingRequiredStageItems,stagePropertyItemsSchema,type StagePropertyItems} from './stage-property-rules';
import {standardFields} from './standard-properties';
import type {PortableCustomProperty} from './portable-custom-properties';
import type {DealFields} from './portable-records';

const name=z.string().trim().min(1).max(80);
export const pipelineKey=z.union([z.literal('default'),z.string().guid("Invalid uuid")]);
const portableStageRequiredFields=[
  {id:'closeDate',label:'Close date'},
  ...standardFields('deals').map(({id,label})=>({id,label})),
];
const requiredFields=new Map(portableStageRequiredFields.map(({id,label})=>[id,label]));
export type PortableDealStageCustomField=Pick<PortableCustomProperty,'id'|'label'>;
const customFieldPrefix='custom:';
export function portableStageCustomId(field:string){
  return field.startsWith(customFieldPrefix)?field.slice(customFieldPrefix.length):undefined;
}
export function portableDealStageFields(custom:PortableDealStageCustomField[]){
  return [...portableStageRequiredFields,...custom.map(({id,label})=>({id:customFieldPrefix+id,label}))];
}
const propertyId=z.string().guid("Invalid uuid");
const requiredProperties=stagePropertyItemsSchema.refine(items=>items.every(({field,required})=>
  required&&(requiredFields.has(field)||propertyId.safeParse(portableStageCustomId(field)).success)),
  'Choose supported editable Deal properties for this stage.');
const stageInput=z.object({id:z.string().guid("Invalid uuid").optional(),name,outcome:z.enum(['open','won','lost']),
  probability:z.number().int().min(0).max(100).optional(),requiredProperties:requiredProperties.optional()}).strict()
  .refine(({outcome,probability})=>probability===undefined||outcome==='open'||probability===portableStageProbability(outcome),
    'Won stages use 100% probability and lost stages use 0%.');
export const maxPipelineStages=20;
const fields={
  name:name.refine(value=>value.toLowerCase()!=='sales pipeline','Choose a different pipeline name.'),
  stages:z.array(stageInput).min(3).max(maxPipelineStages).refine(items=>
    items[0]?.outcome==='open'&&items.some(item=>item.outcome==='won')&&items.some(item=>item.outcome==='lost')&&
    new Set(items.map(item=>item.name.toLowerCase())).size===items.length&&
    new Set(items.flatMap(item=>item.id?[item.id]:[])).size===items.filter(item=>item.id).length,
  'Use unique names, start with an open stage, and include a won and lost stage.'),
};
export const portablePipelineWrite=z.union([
  z.object(fields).strict(),
  z.object({...fields,id:z.string().guid("Invalid uuid"),expectedRevision:z.number().int().min(1).max(2147483646)}).strict(),
]);
export type PipelineWrite=z.output<typeof portablePipelineWrite>;
export type PipelineStage={id:string;name:string;outcome:StageOutcome;probability:number;requiredProperties?:StagePropertyItems};
export function portableStageProbability(outcome:StageOutcome,saved?:number|null){
  return outcome==='won'?100:outcome==='lost'?0:saved??50;
}
export type DealPipeline={id:string;name:string;revision:number;stages:PipelineStage[]};
export const builtinPipeline:DealPipeline={id:'default',name:'Sales pipeline',revision:0,
  stages:stages.map(stage=>({id:stage,name:stage,outcome:legacyStageOutcome(stage),probability:defaultProbabilities[stage]}))};

export type MissingDealStageField={field:string;label:string};
export function missingPortableDealStageFields(items:StagePropertyItems|undefined,after:DealFields,before?:DealFields,custom:PortableDealStageCustomField[]=[]):MissingDealStageField[]{
  const rules=items??[];
  const read=(data:DealFields,field:string)=>{
    const id=portableStageCustomId(field);
    return id?data.custom?.[id]:data[field as keyof DealFields];
  };
  // Like native Harbor, new requirements don't block unrelated edits on a
  // deal already in the stage. Recheck when entering or changing a required value.
  if(before&&!rules.some(rule=>!samePropertyValue(read(before,rule.field),read(after,rule.field))))return [];
  return missingRequiredStageItems(rules,field=>read(after,field))
    .map(({field})=>({field,label:requiredFields.get(field)??custom.find(definition=>definition.id===portableStageCustomId(field))?.label??'Required Deal property'}));
}
export function missingDealStageMessage(stage:string,fields:MissingDealStageField[]){
  return 'Complete required properties for '+stage+': '+fields.map(field=>field.label).join(', ')+'.';
}
