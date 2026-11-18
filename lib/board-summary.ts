import { z } from "zod";
import type { CRMRecord } from "./crm";
import type { Property } from "./workspace";
import { boardGroupProperty, boardLaneId, type BoardGrouping, type BoardLane } from "./board-grouping";
import { weightedAmount, type DealPipeline } from "./forecast";

export const metricAggregations = ["sum", "average", "min", "max"] as const;
export const metricAggregationLabels = {sum:"Sum",average:"Average",min:"Minimum",max:"Maximum"};
const metricSchema = z.object({
  field: z.string().min(1).max(150),
  aggregation: z.enum(metricAggregations).default("sum"),
}).refine(m => m.field !== "count" || m.aggregation === "sum", "Record count has no aggregation choice.");
export const boardSummarySchema = z.object({
  show: z.boolean().default(true),
  metrics: z.array(metricSchema).max(3).refine(ms => new Set(ms.map(m=>`${m.field}:${m.aggregation}`)).size === ms.length, "Choose each metric once.")
    .default([{field:"amount",aggregation:"sum"},{field:"weighted",aggregation:"sum"}]),
  location: z.enum(["top", "bottom"]).default("top"),
  abbreviate: z.boolean().default(false),
}).prefault({});
export type BoardSummary = z.infer<typeof boardSummarySchema>;
export type BoardMetric = BoardSummary["metrics"][number];
export type LaneMetric = { label: string; value: number | null; currency: boolean };
export function boardMetricFields(properties: Property[]) {
  return [{id:"count",label:"Record count",currency:false},{id:"amount",label:"Amount",currency:true},{id:"weighted",label:"Weighted amount",currency:true},
    ...properties.filter(p=>p.kind === "deals" && p.type === "number").map(p=>({id:`custom:${p.id}`,label:p.label,currency:false}))];
}
export function validBoardSummary(settings: BoardSummary, properties: Property[]) {
  const fields = boardMetricFields(properties);
  return settings.metrics.every(m=>fields.some(f=>f.id === m.field));
}
// Aggregate complete matching rows before card pagination. Missing values do not become zero observations.
export function summarizeBoardLanes(rows: CRMRecord[], lanes: BoardLane[], pipeline: DealPipeline, grouping: BoardGrouping, properties: Property[], settings: BoardSummary): BoardLane[] {
  if (!validBoardSummary(settings, properties)) throw new Error("A lane summary property is unavailable. Open Board settings to choose another metric.");
  if (!settings.show) return lanes;
  const fields = boardMetricFields(properties), property = boardGroupProperty(grouping.field, properties);
  const totals = new Map(lanes.map(lane=>[lane.id,settings.metrics.map(()=>({sum:0,count:0,min:Infinity,max:-Infinity}))]));
  for (const row of rows) {
    const stats = totals.get(boardLaneId(row,grouping,property));
    if (!stats) continue;
    settings.metrics.forEach((metric,index)=>{
      const raw = metric.field === "count" ? 1 : metric.field === "amount" ? row.data.amount : metric.field === "weighted" ?
        (typeof row.data.amount === "number" ? weightedAmount(row,pipeline.probabilities) : undefined) : row.data.custom?.[metric.field.slice(7)];
      if (typeof raw !== "number" || !Number.isFinite(raw)) return;
      const stat=stats[index];stat.sum+=raw;stat.count++;stat.min=Math.min(stat.min,raw);stat.max=Math.max(stat.max,raw);
    });
  }
  return lanes.map(lane=>({...lane,metrics:settings.metrics.map((metric,index)=>{
    const field=fields.find(f=>f.id===metric.field)!,stat=totals.get(lane.id)![index];
    const value=metric.aggregation === "sum" ? stat.sum : !stat.count ? null : metric.aggregation === "average" ? stat.sum/stat.count : stat[metric.aggregation];
    return {label:metric.field === "count" ? field.label : `${metricAggregationLabels[metric.aggregation]} of ${field.label}`,value:value === null ? null : Math.round((value+Number.EPSILON)*100)/100,currency:field.currency};
  })}));
}
export function formatLaneMetric(metric: LaneMetric, abbreviate: boolean) {
  if (metric.value === null) return "—";
  return new Intl.NumberFormat("en-US", { ...(metric.currency ? {style:"currency",currency:"USD"} : {}),
    ...(metric.currency && abbreviate ? {notation:"compact",maximumFractionDigits:1} : {maximumFractionDigits:2}) }).format(metric.value);
}
