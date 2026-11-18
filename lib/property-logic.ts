import {z} from 'zod';
import {stageRuleConditionSchema,stagePropertyItemsSchema,stageConditionMatches} from './stage-property-rules';
import {editableProperties,propertyValue} from './record-properties';
import {samePropertyValue} from './property-values';
import {InputError,type Property} from './workspace';
import type {PipelineSettings} from './forecast';
import type {Data,Kind} from './crm';
import {normalizePropertyCondition} from './property-logic-conditions';
export const propertyLogicKinds=['contacts','companies'] as const;
export type PropertyLogicKind=typeof propertyLogicKinds[number];
export const isPropertyLogicKind=(kind:Kind):kind is PropertyLogicKind=>kind==='contacts'||kind==='companies';
export const propertyLogicRulesSchema=z.array(z.object({id:z.string().guid("Invalid uuid"),conditions:z.array(stageRuleConditionSchema).min(1).max(5),properties:stagePropertyItemsSchema.refine(v=>v.length>0,'Add a dependent property.')})).max(20).superRefine((rules,ctx)=>{
 if(new Set(rules.map(r=>r.id)).size!==rules.length)ctx.addIssue({code:'custom',message:'Use unique rule IDs.'});
 if(new Set(rules.flatMap(r=>[...r.conditions,...r.properties].map(p=>p.field))).size>20)ctx.addIssue({code:'custom',message:'Use at most 20 different controlling and dependent properties per object.'});
});
export type PropertyLogicRules=z.infer<typeof propertyLogicRulesSchema>;
export type PropertyLogicCatalog=Partial<Record<PropertyLogicKind,{revision:number;rules:PropertyLogicRules}>>;
export const propertyLogicInput=z.object({kind:z.enum(propertyLogicKinds),revision:z.number().int().min(0),rules:propertyLogicRulesSchema}).strict();
export function objectLogic(catalog:PipelineSettings,kind:Kind){return isPropertyLogicKind(kind)?catalog.propertyLogic?.[kind] ?? {revision:0,rules:[]}: {revision:0,rules:[]};}
export function propertyLogicFields(properties:Property[],kind:PropertyLogicKind):Property[]{
 return editableProperties(kind,properties).filter(f=>f.id!=='name').map(f=>{
  const custom=f.id.startsWith('custom:')?properties.find(p=>p.id===f.id.slice(7)&&p.kind===kind):undefined;
  return {...custom,id:f.id,kind,label:f.label,type:custom?.type??f.type,options:[...(f.options??[])]};
 });
}
export function validatePropertyLogic(rules:PropertyLogicRules,properties:Property[],kind:PropertyLogicKind){
 propertyLogicRulesSchema.parse(rules);const fields=propertyLogicFields(properties,kind);
 for(const rule of rules){
  if(rule.properties.some(p=>!fields.some(f=>f.id===p.field)))throw new InputError('Choose available editable dependent properties.');
 }
 return rules.map(rule=>({...rule,conditions:rule.conditions.map(c=>normalizePropertyCondition(c,fields))}));
}
export function objectLogicProperties(rules:PropertyLogicRules,data:Data){
 const items=new Map<string,{field:string;required:boolean}>();
 for(const rule of rules)if(rule.conditions.every(c=>stageConditionMatches(c,data)))for(const p of rule.properties)items.set(p.field,{field:p.field,required:p.required||items.get(p.field)?.required||false});
 return [...items.values()];
}
export function objectLogicPrompt(rules:PropertyLogicRules,data:Data){
 const items=new Map<string,{field:string;required:boolean}>(rules.flatMap(r=>r.conditions.map(c=>[c.field,{field:c.field,required:false}] as const)));
 for(const p of objectLogicProperties(rules,data))items.set(p.field,p);return [...items.values()];
}
export function objectLogicFields(rules:PropertyLogicRules){return [...new Set(rules.flatMap(r=>[...r.conditions,...r.properties].map(p=>p.field)))];}
export function assertManualPropertyLogic(kind:Kind,after:Data,before:Data|undefined,catalog:PipelineSettings,properties:Property[]){
 if(!isPropertyLogicKind(kind))return;const {rules}=objectLogic(catalog,kind),items=objectLogicProperties(rules,after);
 const changed=!before||rules.some(r=>r.conditions.some(c=>!samePropertyValue(propertyValue(before,c.field),propertyValue(after,c.field))))||items.some(p=>p.required&&!samePropertyValue(propertyValue(before,p.field),propertyValue(after,p.field)));
 if(!changed)return;
 const fields=propertyLogicFields(properties,kind),missing=items.filter(p=>{const v=propertyValue(after,p.field);return p.required&&(v==null||typeof v==='string'&&!v.trim()||Array.isArray(v)&&!v.length)}).map(p=>fields.find(f=>f.id===p.field)?.label??p.field);
 if(missing.length)throw new InputError('Complete required properties: '+missing.join(', ')+'.');
}
