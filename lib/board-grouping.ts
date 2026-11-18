import type { LaneMetric } from "./board-summary";
import { z } from "zod";
import type { Property } from "./workspace";
import type { CRMRecord, Data } from "./crm";
import { standardFields } from "./standard-properties";
import { pipelineForecast, weightedAmount, type DealPipeline } from "./forecast";

const laneIds = z.array(z.string().min(1).max(200)).max(52).refine(ids => new Set(ids).size === ids.length, "Choose each lane once.");
const standardGroups: Property[] = standardFields("deals")
  .filter(p => p.type === "select" || p.type === "checkbox")
  .map(p => ({ id: p.id, kind: "deals", label: p.label, type: p.type, options: [...(p.options ?? [])] }));
export const boardGroupingSchema = z.object({
  field: z.string().max(150).refine(value => value === "stage" || standardGroups.some(p => p.id === value) || /^custom:.+/.test(value), "Choose a grouping property.").default("stage"),
  values: laneIds.nullable().default(null),
  showEmpty: z.boolean().default(true),
  collapsed: laneIds.default([]),
}).prefault({});
export type BoardGrouping = z.infer<typeof boardGroupingSchema>;
export type BoardLane = { id: string; label: string; value: string | boolean | null; count: number; amount: number; weighted: number; unavailable?: boolean; metrics?: LaneMetric[] };
export function boardGroupProperties(properties: Property[]) {
  return [...standardGroups.map(p => ({ ...p, options: [...(standardFields("deals", properties).find(f => f.id === p.id)?.options ?? p.options)] })), ...properties
    .filter(p => !p.standardField && p.kind === "deals" && (p.type === "select" || p.type === "checkbox"))
    .map(p => ({ ...p, id: "custom:" + p.id }))];
}
export function boardGroupProperty(field: string, properties: Property[]) {
  return boardGroupProperties(properties).find(p => p.id === field);
}
// Optional standard dropdowns use an empty string; custom fields clear with null.
export function boardLaneValue(field: string, value: BoardLane["value"]) {
  return value === null && !field.startsWith("custom:") ? "" : value;
}
export function boardLanePrefill(field: string, value: BoardLane["value"]): Partial<Data> {
  if (value === null) return {};
  return field.startsWith("custom:") ? { custom: { [field.slice(7)]: value } } : { [field]: value };
}
export function boardGroupOptions(property: Property) {
  return (property.type === "checkbox" ? [true, false] : property.options).map(value => ({
    id: JSON.stringify(value), value, label: typeof value === "boolean" ? value ? "Yes" : "No" : value,
  }));
}
export function boardLaneId(record: CRMRecord, grouping: BoardGrouping, property?: Property) {
  if (grouping.field === "stage") return record.data.stage ?? "";
  const value = grouping.field.startsWith("custom:")
    ? record.data.custom?.[grouping.field.slice(7)] : record.data[grouping.field as keyof Data];
  if (value === undefined || value === null || value === "") return "null";
  const valid = property?.type === "checkbox" ? typeof value === "boolean" : typeof value === "string" && property?.options.includes(value);
  return valid ? JSON.stringify(value) : "unavailable";
}
export function dealBoardLanes(rows: CRMRecord[], pipeline: DealPipeline, grouping: BoardGrouping, properties: Property[]): BoardLane[] {
  if (grouping.field === "stage") return pipelineForecast(rows, pipeline.probabilities, pipeline.stageOrder, pipeline.stageOutcomes).byStage.map(s => ({
    id: s.stage, label: pipeline.stageLabels?.[s.stage] ?? s.stage, value: s.stage, count: s.count, amount: s.amount, weighted: s.weighted,
  }));
  const property = boardGroupProperty(grouping.field, properties);
  if (!property) throw new Error("The board grouping property is unavailable. Open Board settings to choose another property.");
  const options = boardGroupOptions(property);
  const ordered = grouping.values === null ? options : grouping.values.flatMap(id => options.filter(option => option.id === id));
  const lanes: {id:string;label:string;value:string|boolean|null;unavailable?:boolean}[] = [...ordered];
  if (grouping.showEmpty) lanes.push({id:"null",label:`No ${property.label}`,value:null});
  if (rows.some(r => boardLaneId(r, grouping, property) === "unavailable")) lanes.push({id:"unavailable",label:"Unavailable value",value:null,unavailable:true});
  const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const totals = new Map<string, {count:number;amount:number;weighted:number}>();
  for (const record of rows) {
    const id = boardLaneId(record, grouping, property);
    const total = totals.get(id) ?? {count:0,amount:0,weighted:0};
    total.count++; total.amount += record.data.amount || 0; total.weighted += weightedAmount(record, pipeline.probabilities);
    totals.set(id,total);
  }
  return lanes.map(lane => {
    const total = totals.get(lane.id) ?? {count:0,amount:0,weighted:0};
    return {...lane,count:total.count,amount:round(total.amount),weighted:round(total.weighted)};
  });
}
