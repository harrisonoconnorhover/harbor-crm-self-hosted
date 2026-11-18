import {isFiscalReportPeriod} from "./report-date-range";
import { z } from "zod";
import { assertFiscalFilterContext, filterFields, groupsSchema, matchesFilters, validateFilters } from "./filters";
import { pipelineFor, type PipelineSettings } from "./forecast";
import type { CRMRecord } from "./crm";
import type { Property } from "./workspace";
import { stageColorsSchema } from "./stage-colors";

export const dealTagSchema = z.object({
  id: z.string().guid("Invalid uuid"), name: z.string().trim().min(1).max(50), description: z.string().trim().max(250).default(""),
  color: stageColorsSchema.valueType.default("gray"),
  pipelineIds: z.array(z.string().min(1).max(100)).max(20).default([]),
  groups: groupsSchema.refine(groups => groups.length > 0, "Add at least one tag condition."),
  timeZone: z.string().max(100).refine(zone => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } }, "Choose a valid time zone.").default("UTC"),
});
export const dealTagCatalogSchema = z.object({
  revision: z.number().int().min(0),
  tags: z.array(dealTagSchema).max(50).refine(tags => new Set(tags.map(t => t.id)).size === tags.length && new Set(tags.map(t => t.name.toLowerCase())).size === tags.length, "Use unique tag names and IDs."),
});
export type DealTag = z.infer<typeof dealTagSchema>;
export type DealTagCatalog = z.infer<typeof dealTagCatalogSchema>;
export type DealTagBadge = Pick<DealTag, "id" | "name" | "color" | "description">;
export function dealTagIssue(tag: DealTag, properties: Property[], pipeline: PipelineSettings,fiscalStartMonth?:number): string | undefined {
  try {
    dealTagSchema.parse(tag);
    if (tag.pipelineIds.some(id => !pipelineFor(pipeline, id))) throw Error("A selected pipeline is unavailable.");
    validateFilters(tag.groups, "deals", properties, pipeline,fiscalStartMonth);
  } catch (e) { return e instanceof Error ? e.message : "A tag condition is unavailable."; }
}
export function applyDealTags(rows: CRMRecord[], references: CRMRecord[], catalog: DealTagCatalog, properties: Property[], pipeline: PipelineSettings,context:{fiscalStartMonth?:number;now?:Date}={}): CRMRecord[] {
  const now=context.now??new Date();
  for (const tag of catalog.tags) assertFiscalFilterContext(tag.groups,filterFields("deals",properties,pipeline,context.fiscalStartMonth));
  const tags = catalog.tags.filter(tag => !dealTagIssue(tag, properties, pipeline,context.fiscalStartMonth));
  const all = [...rows, ...references];
  return rows.map(record => record.kind !== "deals" ? record : { ...record, tags: tags.filter(tag =>
    (!tag.pipelineIds.length || tag.pipelineIds.includes(record.data.pipelineId || "default")) && matchesFilters(record, all, tag.groups, properties, tag.timeZone,now,context.fiscalStartMonth))
    .map(({ id, name, color, description }) => ({ id, name, color, description })) });
}
export function validateTagFilter(id: string, kind: string, catalog: DealTagCatalog, properties: Property[], pipeline: PipelineSettings,fiscalStartMonth?:number) {
  if (!id) return;
  const tag = catalog.tags.find(t => t.id === id);
  if (kind !== "deals" || !tag || dealTagIssue(tag, properties, pipeline,fiscalStartMonth)) throw Error("This deal tag is unavailable. Clear the tag filter or repair its conditions in Manage tags.");
}

export const fiscalDealTags=(catalog:DealTagCatalog)=>catalog.tags.some(t=>t.groups.some(g=>g.some(r=>r.operator==='relativeDate'&&isFiscalReportPeriod(r.relativeDate?.period))));
