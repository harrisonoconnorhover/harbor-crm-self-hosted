import { z } from "zod";
import { stagePropertyRulesSchema, resolvedStageProperties, validateStagePropertyRules, preserveStageRuleConditions, type StagePropertyRules } from "./stage-property-rules";
import { ticketStatuses, type Data } from "./crm";
import type { DealStageSource, StageProperties } from "./forecast";

export type TicketStage = { id: string; label: string; outcome: "open" | "closed"; properties: { field: string; required: boolean }[] };
export type TicketPipeline = { isDefault?:boolean; id: string; name: string; stages: TicketStage[]; stagePropertyRules?: StagePropertyRules };
export type TicketCatalog = { revision: number; pipelines: TicketPipeline[] };
export const initialTicketCatalog: TicketCatalog = { revision: 0, pipelines: [{
  id: "default", name: "Support pipeline", stages: ticketStatuses.map(id => ({ id, label: id, outcome: id === "Closed" ? "closed" : "open", properties: [] })),
}] };
const identifier = z.string().trim().min(1).max(100).refine(v => !["__proto__", "constructor", "prototype"].includes(v), "Choose another identifier.");
export const ticketStageSchema = z.object({
  id: identifier, label: z.string().trim().min(1).max(80), outcome: z.enum(["open", "closed"]),
  properties: z.array(z.object({ field: z.string().min(1).max(150), required: z.boolean() })).max(20).default([]),
}).strict();
export const ticketPipelineSchema = z.object({
  isDefault:z.boolean().optional(),
  stagePropertyRules: stagePropertyRulesSchema.optional(),
  id: identifier, name: z.string().trim().min(1).max(80), stages: z.array(ticketStageSchema).min(2).max(50),
}).strict().superRefine((p, ctx) => {
  try { validateStagePropertyRules(ticketRuleSource(p)); } catch(error) { ctx.addIssue({code:"custom",message:error instanceof Error?error.message:"Check status property rules."}); }
  if (new Set(p.stages.map(s=>s.id)).size !== p.stages.length || new Set(p.stages.map(s=>s.label.toLowerCase())).size !== p.stages.length)
    ctx.addIssue({code:"custom",message:"Use unique status IDs and names within a pipeline."});
  if (p.stages[0].outcome !== "open" || !p.stages.some(s=>s.outcome === "closed"))
    ctx.addIssue({code:"custom",message:"Start with an open status and include a closed status."});
  if (p.stages.some(s=>new Set(s.properties.map(p=>p.field)).size!==s.properties.length))
    ctx.addIssue({code:"custom",message:"Choose each status property once."});
});
export const ticketCatalogInput = z.object({
  revision: z.number().int().min(0), pipelines: z.array(ticketPipelineSchema).min(1).max(20),
}).strict().superRefine((c,ctx)=>{
  if(c.pipelines.filter(p=>p.isDefault).length>1)ctx.addIssue({code:'custom',message:'Choose only one default pipeline.'});
  const statusIds=c.pipelines.flatMap(p=>p.stages.map(s=>s.id));
  if(new Set(statusIds).size!==statusIds.length) ctx.addIssue({code:"custom",message:"Use unique status IDs across ticket pipelines."});
  if (new Set(c.pipelines.map(p=>p.id)).size!==c.pipelines.length || new Set(c.pipelines.map(p=>p.name.toLowerCase())).size!==c.pipelines.length)
    ctx.addIssue({code:"custom",message:"Use unique pipeline IDs and names."});
});
export function ticketCatalog(source?: DealStageSource): TicketCatalog {
  return source && !Array.isArray(source) && "tickets" in source && source.tickets ? source.tickets : initialTicketCatalog;
}
export function ticketPipelineFor(source: DealStageSource | undefined, id = "default") {
  return ticketCatalog(source).pipelines.find(p=>p.id===id);
}
export function ticketStageFor(source: DealStageSource | undefined, data: Pick<Data,"ticketPipelineId"|"ticketStatus">) {
  return ticketPipelineFor(source, data.ticketPipelineId)?.stages.find(s=>s.id===data.ticketStatus);
}
export function ticketStageOptions(source?: DealStageSource, pipelineId?: string) {
  return pipelineId === undefined ? [...new Set(ticketCatalog(source).pipelines.flatMap(p=>p.stages.map(s=>s.id)))]
    : ticketPipelineFor(source,pipelineId)?.stages.map(s=>s.id) ?? [];
}
export function ticketStageLabels(source?: DealStageSource, pipelineId?: string) {
  const pipelines = ticketCatalog(source).pipelines.filter(p=>pipelineId===undefined||p.id===pipelineId);
  return Object.fromEntries(ticketStageOptions(source,pipelineId).map(id=>[id,[...new Set(pipelines.flatMap(p=>p.stages.filter(s=>s.id===id).map(s=>s.label)))].join(" / ")]));
}
export function moveTicketPipeline(data: Data, id: string, source?: DealStageSource): Data {
  const pipeline=ticketPipelineFor(source,id);
  if (!pipeline) throw new Error("Choose an available ticket pipeline.");
  return {...data,ticketPipelineId:id,ticketStatus:pipeline.stages.some(s=>s.id===data.ticketStatus) ? data.ticketStatus : pipeline.stages[0].id};
}
export function ticketStageProperties(source: DealStageSource | undefined, data: Data): StageProperties[string] {
  const pipeline=ticketPipelineFor(source,data.ticketPipelineId);
  return pipeline ? resolvedStageProperties(ticketRuleSource(pipeline),data.ticketStatus || "",data) : [];
}

function ticketRuleSource(pipeline: TicketPipeline) {
  return {stageOrder:pipeline.stages.map(s=>s.id),stageProperties:Object.fromEntries(pipeline.stages.map(s=>[s.id,s.properties])),stagePropertyRules:pipeline.stagePropertyRules};
}
export function preserveTicketStageRules(next: TicketCatalog, current: TicketCatalog): TicketCatalog {
  const selected=current.pipelines.find(p=>p.isDefault)?.id ?? "default";
  if(!next.pipelines.some(p=>p.id===selected))throw Error('Choose another default before removing this pipeline.');
  return ticketCatalogInput.parse({...next,pipelines:next.pipelines.map(p=>({...p,isDefault:current.pipelines.find(prior=>prior.id===p.id)?.isDefault,stagePropertyRules:preserveStageRuleConditions(p.stagePropertyRules ?? current.pipelines.find(prior=>prior.id===p.id)?.stagePropertyRules ?? [],current.pipelines.find(prior=>prior.id===p.id)?.stagePropertyRules)}))});
}
export function cloneTicketPipeline(source: TicketPipeline): TicketPipeline {
  const ids=new Map(source.stages.map(s=>[s.id,crypto.randomUUID()]));
  return {id:crypto.randomUUID(),name:`${source.name.slice(0,75)} copy`,
    stages:source.stages.map(s=>({...s,id:ids.get(s.id)!,properties:s.properties.map(p=>({...p}))})),
    stagePropertyRules:(source.stagePropertyRules ?? []).map(rule=>({...rule,...(rule.conditions?{conditions:rule.conditions.map(c=>({...c,values:[...c.values]}))}:{}),id:crypto.randomUUID(),stages:rule.stages.map(id=>ids.get(id) ?? id),properties:rule.properties.map(p=>({...p}))})),
  };
}
