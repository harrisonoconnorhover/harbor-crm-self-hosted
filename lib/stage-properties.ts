import {assertManualPropertyLogic} from "./property-logic";
import { missingRequiredStageItems, resolvedStageProperties, stageRuleMatchesStage, type StagePropertyRules } from "./stage-property-rules";
import { ticketStageProperties, ticketStageLabels, ticketPipelineFor } from "./ticket-pipelines";
import { propertyValueSchema, samePropertyValue } from "./property-values";
import { standardFields } from "./standard-properties";
import { z } from "zod";
import { pipelineFor, stageLabel, type PipelineSettings, type StageProperties } from "./forecast";
import { InputError, type Property } from "./workspace";
import { propertyValue } from "./record-properties";
import type { Data, Kind } from "./crm";
import {normalizePropertyCondition} from './property-logic-conditions';

export function stagePropertyFields(properties: Property[], kind: "deals" | "tickets" = "deals"): Property[] {
  if (kind === "tickets") return [
    {id:"owner",kind,label:"Ticket owner",type:"text",options:[]},
    {id:"ticketPriority",kind,label:"Priority",type:"select",options:["Low","Medium","High","Urgent"]},
    ...standardFields(kind,properties).map(f=>({id:f.id,kind,label:f.label,type:f.type,options:[...(f.options || [])]})),
    ...properties.filter(p=>!p.standardField&&p.kind===kind).map(p=>({...p,id:`custom:${p.id}`})),
  ];
  return [
    { id: "amount", kind: "deals", label: "Amount (USD)", type: "number", options: [] },
    { id: "closeDate", kind: "deals", label: "Close date", type: "date", options: [] },
    { id: "owner", kind: "deals", label: "Deal owner", type: "text", options: [] },
    ...standardFields("deals", properties).map(f => ({ id: f.id, kind: "deals" as const, label: f.label, type: f.type, options: [...(f.options ?? [])] })),
    ...properties.filter(p => !p.standardField && p.kind === "deals").map(p => ({ ...p, id: `custom:${p.id}` })),
  ];
}
export function validateStageProperties(config: StageProperties | undefined, properties: Property[], rules: StagePropertyRules = []) {
  const fields = stagePropertyFields(properties);
  const normalized=validateStageRuleConditions(rules,fields);
  if ([...Object.values(config ?? {}), ...rules.map(rule => rule.properties)].some(items => items.some(item => !fields.some(f => f.id === item.field))))
    throw new InputError("Choose available editable deal properties for each stage.");
  return normalized;
}
export function stagePropertiesFor(catalog: PipelineSettings, data: Data) {
  if (data.ticketStatus !== undefined) return ticketStageProperties(catalog,data);
  const pipeline = pipelineFor(catalog, data.pipelineId || "default");
  return pipeline ? resolvedStageProperties(pipeline, data.stage || "",data) : [];
}
export function stageConditionsFor(catalog:PipelineSettings,data:Data) {
  const ticket=data.ticketStatus!==undefined,stage=(ticket?data.ticketStatus:data.stage)||"";
  const pipeline=ticket?ticketPipelineFor(catalog,data.ticketPipelineId):pipelineFor(catalog,data.pipelineId||"default");
  return (pipeline?.stagePropertyRules ?? []).filter(r=>stageRuleMatchesStage(r,stage)).flatMap(r=>r.conditions ?? []);
}
export function stagePromptProperties(catalog:PipelineSettings,data:Data) {
  const items=new Map(stageConditionsFor(catalog,data).map(c=>[c.field,{field:c.field,required:false}]));
  for(const item of stagePropertiesFor(catalog,data))items.set(item.field,item);
  return [...items.values()];
}
export function stagePotentialProperties(catalog:PipelineSettings,data:Data) {
  const ticket=data.ticketStatus!==undefined,stage=(ticket?data.ticketStatus:data.stage)||"";
  const pipeline=ticket?ticketPipelineFor(catalog,data.ticketPipelineId):pipelineFor(catalog,data.pipelineId||"default");
  return [...new Set([...stagePromptProperties(catalog,data).map(p=>p.field),...(pipeline?.stagePropertyRules ?? []).filter(r=>stageRuleMatchesStage(r,stage)).flatMap(r=>r.properties.map(p=>p.field))])];
}
export function stagePropertyDraft(data:Data,values:Record<string,unknown>):Data {
  const next={...data,custom:{...data.custom}};
  for(const [field,value] of Object.entries(values))if(field.startsWith('custom:'))next.custom[field.slice(7)]=value as string;else (next as Record<string,unknown>)[field]=value;
  return next;
}
export function stageConditionFields(properties:Property[],kind:"deals"|"tickets"="deals") {
  return stagePropertyFields(properties,kind).filter(p=>["select","multiselect","checkbox","date","datetime"].includes(p.type));
}
export function validateStageRuleConditions(rules:StagePropertyRules,fields:Property[]) {
  return rules.map(rule=>({...rule,...(rule.conditions?{conditions:rule.conditions.map(c=>normalizePropertyCondition(c,fields))}:{})}));
}
export function missingStageProperties(catalog: PipelineSettings, data: Data, properties: Property[]) {
  const fields = stagePropertyFields(properties, data.ticketStatus !== undefined ? "tickets" : "deals");
  return missingRequiredStageItems(stagePropertiesFor(catalog,data),field=>propertyValue(data,field))
    .map(item=>fields.find(field=>field.id===item.field)?.label??item.field);
}
export function assertManualStageProperties(kind: Kind, after: Data, before: Data | undefined, catalog: PipelineSettings, properties: Property[]) {
  assertManualPropertyLogic(kind,after,before,catalog,properties);
  if (kind !== "deals" && kind !== "tickets") return;
  const entered = !before || (kind === "tickets" ? (before.ticketPipelineId || "default") !== (after.ticketPipelineId || "default") || before.ticketStatus !== after.ticketStatus : (before.pipelineId || "default") !== (after.pipelineId || "default") || before.stage !== after.stage);
  const changedRequired = !!before && stagePropertiesFor(catalog, after).some(item => item.required && !samePropertyValue(propertyValue(before, item.field), propertyValue(after, item.field)));
  const changedCondition=!!before&&stageConditionsFor(catalog,after).some(c=>!samePropertyValue(propertyValue(before,c.field),propertyValue(after,c.field)));
  if (!entered && !changedRequired && !changedCondition) return;
  const missing = missingStageProperties(catalog, after, properties);
  if (missing.length) throw new InputError(`Complete required properties for ${kind === "tickets" ? ticketStageLabels(catalog,after.ticketPipelineId || "default")[after.ticketStatus || ""] : stageLabel(catalog, after.stage || "", after.pipelineId || "default")}: ${missing.join(", ")}.`);
}
export const transitionDealInput = z.object({
  action: z.literal("transitionDeal"), id: z.string().min(1),
  pipelineId: z.string().min(1).max(100), stage: z.string().min(1).max(80),
  revision: z.number().int().min(0), expectedPipelineId: z.string(), expectedStage: z.string(),
  assigneeId: z.string().max(200).optional(),
  expectedUpdatedAt: z.string().min(1).optional(),
  values: z.record(z.string(), propertyValueSchema).prefault({}),
  expected: z.record(z.string(), propertyValueSchema).prefault({}),
});

export const transitionTicketInput = transitionDealInput.extend({action:z.literal("transitionTicket"),stage:z.string().min(1).max(100)});
