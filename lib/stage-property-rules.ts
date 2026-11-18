import { z } from "zod";
import type { Data } from "./crm";
import { propertyDateTimeSchema } from "./property-datetime";

export const stagePropertyItemsSchema = z.array(z.object({ field: z.string().min(1).max(150), required: z.boolean() })).max(20)
  .refine(items => new Set(items.map(i => i.field)).size === items.length, "Choose each property once.");
export const stageRuleConditionSchema = z.object({
  field:z.string().min(1).max(150), operator:z.enum(["anyOf","noneOf","known","unknown","before","after"]),
  values:z.array(z.union([z.string().min(1).max(2000),z.boolean()])).max(50),
  valueType:z.literal("datetime").optional(),
}).strict().superRefine((c,ctx)=>{
  if (new Set(c.values).size!==c.values.length || (["known","unknown"].includes(c.operator)?c.values.length!==0:["before","after"].includes(c.operator)?c.values.length!==1:c.values.length===0))
    ctx.addIssue({code:"custom",message:"Choose distinct condition values, or no values for known/unknown."});
});
export type StageRuleCondition=z.infer<typeof stageRuleConditionSchema>;
export const stagePropertyRulesSchema = z.array(z.object({
  id: z.string().guid("Invalid uuid"),
  operator: z.enum(["anyOf", "noneOf", "known"]),
  stages: z.array(z.string().min(1).max(100)).max(50),
  conditions:z.array(stageRuleConditionSchema).max(5).optional(),
  properties: stagePropertyItemsSchema.refine(items => items.length > 0, "Add at least one dependent property."),
}).strict().superRefine((rule, ctx) => {
  if (new Set(rule.stages).size !== rule.stages.length || (rule.operator === "known" ? rule.stages.length !== 0 : rule.stages.length === 0))
    ctx.addIssue({code:"custom",message:"Choose distinct stages, or use any stage with no stage selection."});
})).max(20).refine(rules => new Set(rules.map(r => r.id)).size === rules.length, "Each stage rule needs its own identifier.");
export type StagePropertyRules = z.infer<typeof stagePropertyRulesSchema>;
export type StagePropertyItems = z.infer<typeof stagePropertyItemsSchema>;
type Items = StagePropertyItems;

export function missingRequiredStageItems(items:StagePropertyItems,readValue:(field:string)=>unknown){
  return items.filter(item=>{
    if(!item.required)return false;
    const value=readValue(item.field);
    return value===null||value===undefined||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length;
  });
}
type Pipeline = {stageOrder: string[]; stageProperties?: Record<string, Items>; stagePropertyRules?: StagePropertyRules};

export function stageRuleMatchesStage(rule:StagePropertyRules[number],stage:string) {
  return rule.operator === "known" || (rule.operator === "anyOf" ? rule.stages.includes(stage) : !rule.stages.includes(stage));
}
export function stageConditionMatches(condition:StageRuleCondition,data:Data) {
  const value=condition.field.startsWith("custom:")?data.custom?.[condition.field.slice(7)]:data[condition.field as keyof Data];
  const known=value!==undefined&&value!==null&&value!==""&&(!Array.isArray(value)||value.length>0);
  if(condition.operator==="known")return known;
  if(condition.operator==="unknown")return !known;
  if(!known)return false;
  // Only explicitly typed date-time conditions compare instants. Dropdowns that
  // happen to contain ISO-looking strings retain their exact option semantics.
  if(condition.valueType === "datetime") {
    const actual=propertyDateTimeSchema.safeParse(value);
    const expected=condition.values.map(v=>propertyDateTimeSchema.safeParse(v));
    if(!actual.success || expected.some(v=>!v.success))return false;
    const at=Date.parse(actual.data), values=expected.map(v=>Date.parse(v.data!));
    if(condition.operator==="before")return at<values[0];
    if(condition.operator==="after")return at>values[0];
    const matches=values.includes(at);
    return condition.operator==="anyOf"?matches:!matches;
  }
  if(condition.operator==="before"||condition.operator==="after")return typeof value==="string"&&typeof condition.values[0]==="string"&&(condition.operator==="before"?value<condition.values[0]:value>condition.values[0]);
  const selected=Array.isArray(value)?value:[value];
  const match=selected.some(v=>condition.values.some(expected=>expected===v));
  return condition.operator==="anyOf"?match:!match;
}
export function preserveStageRuleConditions(next:StagePropertyRules,current:StagePropertyRules=[]) {
  return next.map(rule=>({...rule,...(rule.conditions===undefined&&current.find(r=>r.id===rule.id)?.conditions?{conditions:current.find(r=>r.id===rule.id)!.conditions}: {})}));
}
export function resolvedStageProperties(pipeline: Pipeline, stage: string, data?:Data): Items {
  if (!pipeline.stageOrder.includes(stage)) return [];
  const items = new Map<string, Items[number]>();
  const groups = [pipeline.stageProperties?.[stage] ?? [], ...(pipeline.stagePropertyRules ?? [])
    .filter(rule => stageRuleMatchesStage(rule,stage) && (!data || (rule.conditions ?? []).every(c=>stageConditionMatches(c,data))))
    .map(rule => rule.properties)];
  for (const group of groups) for (const item of group) {
    const previous = items.get(item.field);
    items.set(item.field, {field:item.field, required:!!previous?.required || item.required});
  }
  return [...items.values()];
}

export function validateStagePropertyRules(pipeline: Pipeline) {
  stagePropertyRulesSchema.parse(pipeline.stagePropertyRules ?? []);
  if (pipeline.stagePropertyRules?.some(rule => rule.stages.some(stage => !pipeline.stageOrder.includes(stage))))
    throw Error("A stage logic rule uses an unavailable stage. Update its stage selection before removing the stage.");
  if (pipeline.stageOrder.some(stage => new Set([...resolvedStageProperties(pipeline,stage).map(p=>p.field),...(pipeline.stagePropertyRules ?? []).filter(r=>stageRuleMatchesStage(r,stage)).flatMap(r=>(r.conditions ?? []).map(c=>c.field))]).size > 20))
    throw Error("Overlapping stage rules can show at most 20 different properties (including controlling fields) in each stage.");
}
