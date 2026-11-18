import {datedActivityTypes} from './activity-date-policy';
import {isTicketSlaStatusField} from './ticket-sla-properties';
import {closeSlaLabels,type CloseSlaStatus} from './ticket-sla';
import {leadPipelineFor,leadStageLabels} from './lead-pipelines';
import {ownerReportGroup,labelOwnerReportGroups} from './owner-report-groups';
import type {RecordOwner} from './record-owner';
import {memberOwnerFilterSchema} from './record-owner';
import {activityRecordFields,activityMeasureFields} from './activity-report-properties';
import {defaultStageTime,validateStageTime,type StageTimeStats,type StageTimeCoverage} from './stage-time-report';
import type { FunnelStepTiming } from './funnel-timing';
import { reportPeriodIds } from './report-date-range';
import { historyStageSchema, defaultFunnel, validateDealFunnel, type FunnelCoverage, type FunnelKind } from './deal-funnel';
import {commerceSourceLabel,isCommerceReport,commerceReportFields} from './commerce-reporting';
import { ticketPipelineFor, ticketStageLabels } from "./ticket-pipelines";
import { reportFormulaSchema, compileReportFormulas, evaluateFormula } from "./report-formulas";
import { relatedRecordsByRecord } from "./associated-conditions";
import { associationPair, directlyLinked, type Association } from "./associations";
import { segmentConditionsSchema, validateSegmentConditions, matchesSegmentConditions, type SegmentMembership } from "./segment-conditions";
import { defaultActivityOptions, type ActivityOptions } from "./activity-options";
import { callOutcomes, meetingOutcomes } from "./activity-options";
import { type DealStageSource, pipelineLabel, stageLabel } from "./forecast";
import { z } from "zod";
import { stages, kinds, csvCell, type CRMRecord } from "./crm";
import {
  readFilterValue,
  filterFields,
  groupsSchema,
  matchesFilterGroups,
  validateFilters,
  validateFilterFields,
  type FilterField,
  type FilterRule,
} from "./filters";
import type { Property } from "./workspace";

export const reportKinds = [...kinds, "activities", "invoices", "payments", "quotes", "products", "line_items", "quote_lines", "invoice_lines"] as const;
export const activityReportFields: FilterField[] = [
  { id: "assignedTo", label: "Activity assigned to", type: "text" },
  { id: "createdByName", label: "Activity created by", type: "text" },
  { id: "activityType", label: "Call and meeting type", type: "select", options: [] },
  { id: "outcome", label: "Activity outcome", type: "select", options: [...callOutcomes, ...meetingOutcomes] },
  { id: "direction", label: "Call/email direction", type: "select", options: ["Inbound", "Outbound"] },
  { id: "durationSeconds", label: "Duration (seconds)", type: "number" },
  { id: "type", label: "Activity type", type: "select", options: [...datedActivityTypes] },
  { id: "occurredAt", label: "Activity date", type: "date" },
  { id: "createdAt", label: "Log created date", type: "date" },
  { id: "recordKind", label: "Home record object", type: "select", options: kinds },
  { id: "recordName", label: "Home record name", type: "text" },
  { id: "recordOwner", label: "Home record owner", type: "text", memberOwner:true },
  { id: "recordId", label: "Linked record ID", type: "text" },
];
export function reportFields(kind: typeof reportKinds[number], properties: Property[], dealStages: DealStageSource = stages, options: ActivityOptions = defaultActivityOptions) {
  const activityFields = activityReportFields.map(f => f.id === "activityType" ? { ...f, options: options.types.map(o => o.label) } : f.id === "outcome" ? { ...f, options: [...new Set([...options.callOutcomes, ...options.meetingOutcomes].map(o => o.label))] } : f);
  return isCommerceReport(kind) ? commerceReportFields[kind] : kind === "activities" ? activityFields : filterFields(kind, properties, dealStages);
}
const metricSchema = z.enum(["count", "sum", "average", "min", "max"]);
export const additionalMetricSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).refine(id=>id!=="primary", "Choose a unique metric ID."),
  label: z.string().trim().max(80).default(""),
  metric: metricSchema,
  measure: z.string().max(150).default(""),
  countSource: z.enum(["primary", "associated"]).default("primary"),
});
export const reportSchema = z.object({
  funnel: historyStageSchema.optional(),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(reportKinds),
  activityRecordKind: z.enum(kinds).optional(),
  commercePopulation: z.enum(["active", "all"]).optional(),
  metric: metricSchema.default("count"),
  metricLabel: z.string().trim().max(80).optional(),
  additionalMetrics: z.array(additionalMetricSchema).max(3).refine(items=>new Set(items.map(m=>m.id)).size===items.length, "Each metric needs a unique ID.").optional(),
  sortMetric: z.string().max(80).optional(),
  metricScale: z.enum(["shared", "separate"]).optional(),
  formulas: z.array(reportFormulaSchema).max(4).refine(items=>new Set(items.map(f=>f.id)).size===items.length, "Each formula needs a unique ID.").optional(),
  measure: z.string().max(150).default(""),
  groupBy: z.string().max(150).default(""),
  ownerGrouping:z.enum(["member","name"]).optional(),
  breakdown: z.object({
    field: z.string().min(1).max(150),
    interval: z.enum(["day", "month", "quarter", "year"]).default("month"),
    ownerGrouping: z.enum(["member", "name"]).optional(),
  }).optional(),
  interval: z.enum(["day", "month", "quarter", "year"]).default("month"),
  chart: z.enum(["bar", "line", "table", "number", "funnel", "stageTime"]).default("bar"),
  sort: z.enum(["label", "value-desc", "value-asc"]).default("value-desc"),
  groups: groupsSchema,
  segmentConditions: segmentConditionsSchema.optional(),
  segmentKind: z.enum(kinds).optional(),
  association: z.object({
    kind: z.enum(kinds),
    join: z.enum(["all", "matched"]).default("all"),
    selection: z.enum(["all", "primary", "label"]).default("all"),
    label: z.string().trim().max(60).default(""),
    aggregation: z.enum(["rows", "distinctRecords"]).default("rows"),
    countSource: z.enum(["primary", "associated"]).default("primary"),
  }).optional(),
});
export type ReportDefinition = z.infer<typeof reportSchema>;
export function reportSourceFields(d: ReportDefinition, properties: Property[], dealStages: DealStageSource = stages, options: ActivityOptions = defaultActivityOptions) {
  const primary = reportFields(d.kind, properties, dealStages, options).map(f => d.kind === "activities" && d.activityRecordKind && f.id.startsWith("record") ? {...f,label:f.label.replace("Home record", "Associated record").replace("Linked record", "Associated record")} : f);
  if (d.kind === "activities") return [...primary,...activityRecordFields(d.activityRecordKind,properties,dealStages)];
  if (!d.association) return primary;
  return [...primary.map(f => ({...f, label:`${d.kind} · ${f.label}`})),
    ...reportFields(d.association.kind, properties, dealStages, options).map(f => ({...f, id:`associated:${f.id}`, label:`Associated ${d.association!.kind} · ${f.label}`}))];
}
export function reportDefinitionFields(d: ReportDefinition, properties: Property[], dealStages: DealStageSource = stages, options: ActivityOptions = defaultActivityOptions, fiscalStartMonth?:number): FilterField[] {
  return [...reportSourceFields(d,properties,dealStages,options).map(f => fiscalStartMonth !== undefined && (f.type === "date" || f.type === "datetime") ? {...f,fiscalStartMonth} : f),...(d.formulas || []).map(f=>({id:`formula:${f.id}`,label:`Formula · ${f.label}`,type:"number" as const}))];
}
export const supportsReportBreakdown = (d: Pick<ReportDefinition,"kind"|"association"|"funnel">) =>
  !d.funnel;
export const reportSegmentKind = (d: ReportDefinition) => d.kind === "activities" ? d.activityRecordKind || d.segmentKind || "contacts" : isCommerceReport(d.kind) ? "contacts" : d.kind;
export function activityReportNote(d: ReportDefinition) {
  const context = d.activityRecordKind
    ? `Includes activities linked to current ${d.activityRecordKind}, through either home or secondary links. Record filters and segment membership must match the same associated record. Each activity counts once per ${d.breakdown ? "combination" : "group"} and once in the overall total, including duration calculations. An activity can appear in several groups, so group totals may overlap. Drilldowns show one matching record per activity; open its Associations to see all links.`
    : "Each activity counts once. Record fields and segment filters use its home record, shown in activity associations.";
  return `${context}${d.activityRecordKind ? " Associated properties reflect current values, not values at the activity date, and are available for grouping and filtering. Activity metrics and formulas measure the activity itself." : ""} Activity dates use occurrence time (creation time for older logs), in UTC. Assigned person, log author and record owner are separate. Missing durations are excluded; durations use seconds. Tasks remain a separate source.`;
}
export type SavedReport = ReportDefinition & {
  id: string;
  revision: number;
  updatedAt: string;
};
export const dashboardFiltersSchema = z.object({
  period: z.enum(reportPeriodIds).default("all"),
  from: z.string().default(""),
  to: z.string().default(""),
  ownerMode: z.enum(["all", "named", "member", "unassigned"]).default("all"),
  ownerMember: memberOwnerFilterSchema.optional(),
  owner: z.string().trim().max(160).default(""),
  activityAssigneeMode: z.enum(["all", "named", "member", "unassigned"]).default("all"),
  activityAssignee: z.string().trim().max(160).default(""),
}).superRefine((value, ctx) => {
  if (value.period === "custom" && (!z.string().date().safeParse(value.from).success || !z.string().date().safeParse(value.to).success || value.from > value.to))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a valid start and end date in order." });
  if (value.ownerMode === "member" && !value.ownerMember) ctx.addIssue({code:"custom",message:"Choose a workspace member."});
  if (value.ownerMode !== "member" && value.ownerMember) ctx.addIssue({code:"custom",message:"Member selection requires member owner mode."});
  if (value.ownerMode === "named" && !value.owner)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the owner name." });
  if (value.activityAssigneeMode === "named" && !value.activityAssignee)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the activity assignee name." });
});
export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;
export const dashboardScopeSchema = z.object({
  filters: dashboardFiltersSchema,
  dateField: z.string().min(1).max(150).optional(),
  filterOwner: z.boolean().optional(),
  filterActivityAssignee: z.boolean().optional(),
});
export type DashboardScope = z.infer<typeof dashboardScopeSchema>;
export function dashboardCardsSchema<Card extends z.ZodType<{reportId: string}>>(card: Card) {
  return z.array(card).max(20).refine(
    items => new Set(items.map(item => item.reportId)).size === items.length,
    "A report can appear once per dashboard.",
  );
}
export const dashboardSchema = z.object({
  filters: dashboardFiltersSchema.optional(),
  name: z.string().trim().min(1).max(100),
  cards: dashboardCardsSchema(z.object({
    reportId: z.string().min(1),
    wide: z.boolean().default(false),
    dateField: z.string().min(1).max(150).optional(),
    filterOwner: z.boolean().optional(),
    filterActivityAssignee: z.boolean().optional(),
  })),
});
export type DashboardDefinition = z.infer<typeof dashboardSchema>;
export type Dashboard = DashboardDefinition & {
  id: string;
  revision: number;
  updatedAt: string;
};
export const metricNames = {
  count: "Record count",
  sum: "Sum",
  average: "Average",
  min: "Minimum",
  max: "Maximum",
};
export type ReportMetric = z.infer<typeof additionalMetricSchema>;
export function reportMetrics(d: ReportDefinition): ReportMetric[] {
  return [{id:"primary",label:d.metricLabel || "",metric:d.metric,measure:d.measure,countSource:d.association?.countSource || "primary"}, ...(d.additionalMetrics || [])];
}
export function reportMetricLabel(d: ReportDefinition, m: ReportMetric, fields: FilterField[]) {
  return m.label || (m.metric === "count" ? `${m.countSource === "associated" ? d.association?.kind || "Associated record" : d.kind === "activities" ? "Activity" : commerceSourceLabel(d.kind)} count` : `${metricNames[m.metric]} of ${fields.find(f=>f.id===m.measure)?.label || m.measure}`);
}
function metricDefinition(d: ReportDefinition, m: ReportMetric): ReportDefinition {
  return {...d,metric:m.metric,measure:m.measure,metricLabel:m.label,additionalMetrics:undefined,sortMetric:undefined,
    association:d.association?{...d.association,countSource:m.countSource}:undefined};
}
export type ReportMetricValue = {id:string;value:number|null;measured:number};
export function sortReportRows(rows: ReportRow[], d: ReportDefinition, groupField?: FilterField, breakdownField?:FilterField) {
  const value = (r:ReportRow) => d.sortMetric && d.sortMetric!=="primary" ? r.metrics?.find(m=>m.id===d.sortMetric)?.value ?? null : r.value;
  const labelOrder = (a: ReportRow, b: ReportRow) => {
    if(a.dimensions && b.dimensions) {
      for(const [i,field] of [groupField,breakdownField].entries()) {
        const av=a.dimensions[i],bv=b.dimensions[i];
        const order=av.key==="missing" ? bv.key==="missing"?0:1 : bv.key==="missing" ? -1 :
          field?.type==="number" ? Number(av.label)-Number(bv.label) : av.label.localeCompare(bv.label,undefined,{numeric:true});
        if(order)return order;
      }
      return a.key.localeCompare(b.key);
    }
    if (groupField?.type !== "number") return a.label.localeCompare(b.label, undefined, { numeric: true });
    if (a.key === "missing") return b.key === "missing" ? 0 : 1;
    if (b.key === "missing") return -1;
    return Number(a.label) - Number(b.label);
  };
  const tie=(a:ReportRow,b:ReportRow)=>a.label.localeCompare(b.label)||(d.breakdown?a.key.localeCompare(b.key):0);
  rows.sort((a,b)=>{const av=value(a),bv=value(b);return d.sort === "label" ? labelOrder(a,b) : av===null ? bv===null?tie(a,b):1 : bv===null ? -1 : (d.sort === "value-desc" ? bv-av : av-bv) || tie(a,b);});
  return rows;
}
export function validateReport(
  d: ReportDefinition,
  properties: Property[],
  dealStages: DealStageSource = stages,
  options: ActivityOptions = defaultActivityOptions,
  fiscalStartMonth?:number,
) {
  if (d.activityRecordKind && d.kind !== "activities") throw Error("Activity record context applies only to activity reports.");
  if (d.activityRecordKind && d.segmentKind && d.segmentKind !== d.activityRecordKind) throw Error("Segment object must match the associated activity object.");
  if (d.chart === "funnel" || d.chart === "stageTime" || d.funnel) {
    if (!["funnel","stageTime"].includes(d.chart) || !["deals","contacts","companies"].includes(d.kind) || !d.funnel) throw Error("Stage reports require Contacts, Companies or Deals and stage settings.");
    if (d.metric !== "count" || d.measure || d.groupBy || d.ownerGrouping || d.association || d.additionalMetrics?.length || d.formulas?.length || d.segmentKind || d.commercePopulation || d.metricLabel || d.sortMetric)
      throw Error("Use the report's stage settings and current-record filters. Summary metrics and joins do not apply.");
    if(d.breakdown&&d.breakdown.field!=='owner')throw Error('Stage report breakdowns use the current record owner. Other stage breakdowns are not available.');
    if(d.chart==='stageTime')validateStageTime(d.funnel,dealStages,d.kind as FunnelKind);
    else validateDealFunnel(d.funnel, dealStages,d.kind as FunnelKind);
    validateFilters(d.groups,d.kind as FunnelKind,properties,dealStages,fiscalStartMonth);
    if(d.segmentConditions)segmentConditionsSchema.parse(d.segmentConditions);
    return;
  }
  if (isCommerceReport(d.kind) && (d.association || d.segmentConditions?.length || d.segmentKind)) throw Error("Commerce reports do not support record associations or segment filters yet.");
  if (!isCommerceReport(d.kind) && d.commercePopulation) throw Error("Commerce population applies only to commerce reports.");
  if (d.segmentConditions) segmentConditionsSchema.parse(d.segmentConditions);
  if (d.association) {
    if (d.kind === "activities") throw Error("Choose a record object as the primary source for an association report.");
    if (d.association.selection === "label" && !d.association.label) throw Error("Enter an association label.");
    if (d.association.selection === "primary" && !(d.kind === "tasks" || (d.kind === "contacts" && d.association.kind === "companies") || (["deals", "tickets", "leads"].includes(d.kind) && ["contacts", "companies"].includes(d.association.kind))))
      throw Error("This source does not have a primary relationship in that direction.");
  }
  const fields = reportDefinitionFields(d, properties, dealStages, options,fiscalStartMonth);
  if(d.ownerGrouping && !fields.some(f=>f.id===d.groupBy&&f.memberOwner))throw Error("Owner grouping requires a record owner property.");
  if(d.breakdown) {
    if(!supportsReportBreakdown(d))throw Error("Breakdowns require a current-values summary report.");
    if(!d.groupBy || d.breakdown.field===d.groupBy)throw Error("Choose two different grouping properties for a breakdown.");
    if(!["bar","table","line"].includes(d.chart))throw Error("Breakdowns use a bar chart, date-based line chart or summary table.");
    const second=fields.find(f=>f.id===d.breakdown!.field);
    if(!second || second.type==="multiselect")throw Error("Choose an available single-value breakdown property.");
    if(d.breakdown.ownerGrouping && !second.memberOwner)throw Error("Owner grouping requires an owner breakdown property.");
  }
  if (d.chart === "line" && d.sort !== "label")
    throw new Error("Line charts must use chronological sorting.");
  if (d.kind === "activities" || isCommerceReport(d.kind) || d.association || d.formulas?.length) {
    validateFilterFields(d.groups, fields);
  } else validateFilters(d.groups, d.kind, properties, dealStages,fiscalStartMonth);
  if (d.formulas) reportSchema.shape.formulas.parse(d.formulas);
  compileReportFormulas(d.formulas,activityMeasureFields(d.kind,reportSourceFields(d,properties,dealStages,options)));
  const metrics = reportMetrics(d);
  if (d.additionalMetrics) reportSchema.shape.additionalMetrics.parse(d.additionalMetrics);
  if (d.sortMetric && !metrics.some(m=>m.id===d.sortMetric)) throw Error("Choose an available metric for sorting.");
  for (const metric of metrics) {
    if (d.kind === "activities" && metric.metric !== "count" && metric.measure.startsWith("record:")) throw Error("Associated properties group and filter activities. Choose an activity measurement, or use a record report to measure record values.");
    if (metric.metric !== "count" && !fields.some(f=>f.id===metric.measure && f.type === "number"))
      throw Error("Choose an available numeric property for each metric.");
    if (metric.metric === "count" && metric.countSource === "associated" && !d.association)
      throw Error("Add an associated data source before counting associated records.");
  }
  if (fields.some(f => f.id === d.groupBy && f.type === "multiselect"))
    throw new Error("Multiple-checkbox grouping is not supported yet. Use the property as a filter.");
  if (d.groupBy && !fields.some((f) => f.id === d.groupBy))
    throw new Error(
      "The grouping property is unavailable. Choose another property.",
    );
  if (
    d.chart === "line" &&
    !fields.some((f) => f.id === d.groupBy && (f.type === "date" || f.type === "datetime"))
  )
    throw new Error("Line charts need a date grouping.");
}
export type ReportDimension = {key:string;label:string;groupIdentity?:string|null};
export type ReportRow = {
  dimensions?: [ReportDimension,ReportDimension];
  stageTime?:StageTimeStats;
  funnelStep?: {timing?:FunnelStepTiming;optional:boolean;previousRequired:number|null;nextRequired:number|null;skipped:number};
  groupIdentity?:string|null;
  metrics?: ReportMetricValue[];
  key: string;
  label: string;
  value: number | null;
  count: number;
  measured: number;
  recordIds: string[];
};
export type ReportPair = { primaryId: string; associatedId?: string; groupKey: string };
export type ReportResult = {
  stageTime?:StageTimeCoverage;
  funnel?: FunnelCoverage;
  groupIdentityLabel?:string;
  dimensionIdentityLabels?:[string|null,string|null];
  metrics?: ReportMetricValue[];
  semantics?: string;
  asOf?: string;
  pairs?: ReportPair[];
  joined?: { rows: number; associatedRecords: number; aggregation: "rows" | "distinctRecords" };
  rows: ReportRow[];
  total: number | null;
  count: number;
  measured: number;
  recordIds: string[];
};
// Reports use UTC calendar dates for timestamp properties. Date-only properties stay unchanged.
function utcRecord(r: CRMRecord): CRMRecord {
  const day = (v: string | undefined) =>
    v ? new Date(v).toISOString().slice(0, 10) : undefined;
  return {
    ...r,
    createdAt: day(r.createdAt)!,
    updatedAt: day(r.updatedAt)!,
    lastContacted: day(r.lastContacted),
    lastActivity: day(r.lastActivity),
  };
}
function readReportValue(record: CRMRecord, field: string, records: CRMRecord[],relative=false) {
  return readFilterValue(relative || field === "timeToCloseHours" ? record : utcRecord(record), field, records);
}
function aggregate(
  metric: ReportDefinition["metric"],
  values: number[],
  count: number,
) {
  if (metric === "count") return count;
  if (!values.length) return null;
  const result =
    metric === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : metric === "average"
        ? values.reduce((a, b) => a + b, 0) / values.length
        : values.reduce((a, b) =>
            metric === "min" ? Math.min(a, b) : Math.max(a, b),
          );
  if (!Number.isFinite(result))
    throw new Error("The numeric result is too large to display.");
  return result;
}
export function evaluateReport(
  d: ReportDefinition,
  records: CRMRecord[],
  properties: Property[],
  dealStages: DealStageSource = stages,
  scopeRules: FilterRule[] = [],
  membership?: SegmentMembership,
  associations: Association[] = [],
  now = new Date(),
  fiscalStartMonth?:number,
): ReportResult {
  validateReport(d, properties, dealStages,undefined,fiscalStartMonth);
  if (d.kind === "activities" || isCommerceReport(d.kind)) throw new Error("Activity and commerce reports are calculated on the server.");
  if (d.additionalMetrics?.length) {
    const metrics = reportMetrics(d), results = metrics.map(m=>evaluateReport(metricDefinition(d,m),records,properties,dealStages,scopeRules,membership,associations,now,fiscalStartMonth));
    const primary = results[0], indexed=results.map(r=>new Map(r.rows.map(row=>[row.key,row])));
    return {...primary, metrics:metrics.map((m,i)=>({id:m.id,value:results[i].total,measured:results[i].measured})),
      rows:sortReportRows(primary.rows.map(row=>({...row,metrics:metrics.map((m,i)=>({id:m.id,value:indexed[i].get(row.key)?.value ?? null,measured:indexed[i].get(row.key)?.measured ?? 0}))})),d,reportDefinitionFields(d,properties,dealStages).find(f=>f.id===d.groupBy),reportDefinitionFields(d,properties,dealStages).find(f=>f.id===d.breakdown?.field))};
  }
  validateSegmentConditions(d.segmentConditions, d.kind, membership);
  if (d.association) return evaluateAssociatedReport(d, records, properties, dealStages, scopeRules, membership, associations,now,fiscalStartMonth);
  const fields = reportDefinitionFields(d,properties,dealStages,undefined,fiscalStartMonth), formulas=compileReportFormulas(d.formulas,reportSourceFields(d,properties,dealStages));
  const read=(r:CRMRecord,id:string,relative=false):unknown=>{const formula=formulas.get(id);return formula?evaluateFormula(formula.node,field=>readReportValue(r,field,records),formula.nullAsZero):readReportValue(r,id,records,relative);};
  if (scopeRules.length) validateFilterFields([scopeRules], fields);
  const field = fields.find(
    (f) => f.id === d.groupBy,
  );
  const selected = records.filter(
    (r) =>
      r.kind === d.kind &&
      matchesSegmentConditions(r.id, r.kind, d.segmentConditions, membership) &&
      matchesFilterGroups(d.groups, fields, (field,rule)=>read(r,field,rule?.operator==="relativeDate"), "UTC",now) &&
      (!scopeRules.length || matchesFilterGroups([scopeRules], fields, (field,rule)=>read(r,field,rule?.operator==="relativeDate"), "UTC",now)),
  );
  if(d.breakdown)return evaluateBreakdown(d,selected,fields,dealStages,read);
  const buckets = new Map<string, { label: string; records: CRMRecord[] }>();
  for (const r of selected) {
    let value: unknown = d.groupBy
      ? read(r, d.groupBy)
      : "All records";
    if ((field?.type === "date" || field?.type === "datetime") && value) {
      const day = String(value).slice(0, 10);
      value =
        d.interval === "year"
          ? day.slice(0, 4)
          : d.interval === "quarter"
            ? `${day.slice(0, 4)} Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`
            : d.interval === "month"
              ? day.slice(0, 7)
              : day;
    }
    const missing = value === undefined || value === null || value === "";
    const ownerGroup=d.ownerGrouping==="member"?ownerReportGroup(value,read(r,d.groupBy+"Member") as RecordOwner|undefined):undefined;
    const key = ownerGroup?.key ?? (missing ? "missing" : JSON.stringify(value));
    const label = ownerGroup?.label ?? (missing
      ? "No value"
      : d.groupBy === "leadPipelineId" ? leadPipelineFor(dealStages,String(value))?.name || String(value) : d.groupBy === "leadStage" ? leadStageLabels(dealStages)[String(value)] || String(value)
      : d.groupBy === "ticketPipelineId" ? ticketPipelineFor(dealStages,String(value))?.name || String(value)
      : isTicketSlaStatusField(d.groupBy) ? closeSlaLabels[String(value) as CloseSlaStatus] || String(value) : d.groupBy === "ticketStatus" ? ticketStageLabels(dealStages)[String(value)] || String(value)
      : d.groupBy === "pipelineId"
        ? pipelineLabel(dealStages, String(value))
        : d.groupBy === "stage" && d.kind === "deals"
          ? stageLabel(dealStages, String(value))
          : typeof value === "boolean"
            ? value
              ? "Yes"
              : "No"
            : String(value));
    const bucket = buckets.get(key) || { label, records: [] };
    if(d.ownerGrouping==="member"&&label<bucket.label)bucket.label=label;
    bucket.records.push(r);
    buckets.set(key, bucket);
  }
  const numbers = (rs: CRMRecord[]) =>
    rs
      .map((r) => read(r, d.measure))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const rows = [...buckets].map(([key, b]) => {
    const values = numbers(b.records);
    return {
      key,
      label:
        d.kind === "deals" && d.groupBy === "stage"
          ? [
              ...new Set(
                b.records.map((r) =>
                  stageLabel(
                    dealStages,
                    String(r.data.stage ?? ""),
                    r.data.pipelineId || "default",
                  ),
                ),
              ),
            ].join(" / ") || b.label
          : b.label,
      value: aggregate(d.metric, values, b.records.length),
      count: b.records.length,
      measured: values.length,
      recordIds: b.records.map((r) => r.id),
    };
  });
  if(d.ownerGrouping==="member")labelOwnerReportGroups(rows);
  sortReportRows(rows, d, field);
  const allValues = numbers(selected);
  return {
    rows,
    ...(d.ownerGrouping==="member"?{groupIdentityLabel:"Workspace member ID"}:{}),
    total: aggregate(d.metric, allValues, selected.length),
    count: selected.length,
    measured: allValues.length,
    recordIds: selected.map((r) => r.id),
  };
}

// Axis buckets retain stage/member/date labels independently. Intersect by record
// ID, then aggregate original values; never average the displayed cell averages.
function breakdownDimensions<T>(d:ReportDefinition,selected:T[],fields:FilterField[],pipeline:DealStageSource,read:(r:T,id:string)=>unknown,record:(r:T,id:string)=>CRMRecord|undefined){
  const axes=[{field:d.groupBy,interval:d.interval,ownerGrouping:d.ownerGrouping},d.breakdown!] as const;
  const axisMaps=axes.map(axis=>{
    const field=fields.find(f=>f.id===axis.field),byRow=new Map<T,ReportDimension>();
    const buckets=new Map<string,{dimension:ReportDimension;labels:Set<string>;items:T[]}>();
    for(const r of selected){
      let value=read(r,axis.field);
      if(value && (field?.type==="date" || field?.type==="datetime")){
        const day=String(value).slice(0,10);
        value=axis.interval==="year"?day.slice(0,4):axis.interval==="quarter"?`${day.slice(0,4)} Q${Math.ceil(Number(day.slice(5,7))/3)}`:axis.interval==="month"?day.slice(0,7):day;
      }
      const missing=value===undefined||value===null||value==="",owner=axis.ownerGrouping==="member"?ownerReportGroup(value,read(r,axis.field+"Member") as RecordOwner|undefined):undefined;
      const key=owner?.key??(missing?"missing":JSON.stringify(value));
      const label=owner?.label??(missing?"No value":axis.field.replace(/^associated:/,"")==="stage"&&record(r,axis.field)?.kind==="deals"?stageLabel(pipeline,String(value),record(r,axis.field)?.data.pipelineId||"default"):
        axis.field.replace(/^associated:/,"")==="pipelineId"?pipelineLabel(pipeline,String(value)):
        axis.field.replace(/^associated:/,"")==="leadPipelineId"?leadPipelineFor(pipeline,String(value))?.name||String(value):axis.field.replace(/^associated:/,"")==="leadStage"?leadStageLabels(pipeline)[String(value)]||String(value):
        axis.field.replace(/^associated:/,"")==="ticketPipelineId"?ticketPipelineFor(pipeline,String(value))?.name||String(value):axis.field.replace(/^associated:/,"")==="ticketStatus"?ticketStageLabels(pipeline,record(r,axis.field)?.data.ticketPipelineId||"default")[String(value)]||String(value):
        isTicketSlaStatusField(axis.field.replace(/^associated:/,""))?closeSlaLabels[String(value) as CloseSlaStatus]||String(value):typeof value==="boolean"?value?"Yes":"No":String(value));
      const bucket=buckets.get(key)||{dimension:{key,label},labels:new Set<string>(),items:[]};
      bucket.labels.add(label);bucket.items.push(r);buckets.set(key,bucket);
    }
    for(const b of buckets.values())b.dimension.label=axis.ownerGrouping==="member"?[...b.labels].sort()[0]:[...b.labels].sort().join(" / ");
    if(axis.ownerGrouping==="member")labelOwnerReportGroups([...buckets.values()].map(b=>b.dimension));
    for(const b of buckets.values())for(const item of b.items)byRow.set(item,b.dimension);
    return byRow;
  });
  return (row:T)=>axisMaps.map(axis=>axis.get(row)!) as [ReportDimension,ReportDimension];
}

function evaluateBreakdown(d:ReportDefinition,selected:CRMRecord[],fields:FilterField[],pipeline:DealStageSource,read:(r:CRMRecord,id:string)=>unknown):ReportResult {
  const dimensionsFor=breakdownDimensions(d,selected,fields,pipeline,read,r=>r);
  const buckets=new Map<string,{dimensions:[ReportDimension,ReportDimension];records:CRMRecord[]}>();
  for(const r of selected){const dimensions=dimensionsFor(r),key=JSON.stringify(dimensions.map(v=>v.key));
    const b=buckets.get(key)||{dimensions,records:[]};b.records.push(r);buckets.set(key,b);
  }
  const numbers=(rs:CRMRecord[])=>rs.map(r=>read(r,d.measure)).filter((v):v is number=>typeof v==="number"&&Number.isFinite(v));
  const rows:ReportRow[]=[...buckets].map(([key,b])=>{const values=numbers(b.records);return{key,dimensions:b.dimensions,label:b.dimensions.map(v=>v.label).join(" · "),value:aggregate(d.metric,values,b.records.length),count:b.records.length,measured:values.length,recordIds:b.records.map(r=>r.id)};});
  sortReportRows(rows,d,fields.find(f=>f.id===d.groupBy),fields.find(f=>f.id===d.breakdown?.field));
  const values=numbers(selected);
  return{rows,total:aggregate(d.metric,values,selected.length),count:selected.length,measured:values.length,recordIds:selected.map(r=>r.id)};
}

// Joined filters apply to the same pair. Counts of primary records remain distinct
// from joined rows; numeric aggregation explicitly chooses row or record weighting.
function evaluateAssociatedReport(d: ReportDefinition, records: CRMRecord[], properties: Property[], pipeline: DealStageSource, scopeRules: FilterRule[], membership: SegmentMembership | undefined, associations: Association[],now:Date,fiscalStartMonth?:number): ReportResult {
  const config = d.association!, fields = reportDefinitionFields(d, properties, pipeline,undefined,fiscalStartMonth);
  if (scopeRules.length) validateFilterFields([scopeRules], fields);
  const formulas=compileReportFormulas(d.formulas,reportSourceFields(d,properties,pipeline));
  const neighbors = relatedRecordsByRecord(records, associations);
  const labels = new Map(associations.map(a => [JSON.stringify(associationPair(a.recordA, a.recordB)), a.labels]));
  const groupField = fields.find(f => f.id === d.groupBy);
  type Pair = { primary: CRMRecord; associated?: CRMRecord; key: string; label: string; dimensions?:[ReportDimension,ReportDimension] };
  const pairs: Pair[] = [];
  const read = (pair: Pick<Pair, "primary" | "associated">, field: string,relative=false):unknown => {
    const formula=formulas.get(field);
    if(formula)return evaluateFormula(formula.node,id=>read(pair,id),formula.nullAsZero);
    const related = field.startsWith("associated:"), record = related ? pair.associated : pair.primary;
    return record ? readReportValue(record, related ? field.slice(11) : field, records,relative) : undefined;
  };
  for (const primary of records) {
    if (primary.kind !== d.kind || !matchesSegmentConditions(primary.id, primary.kind, d.segmentConditions, membership)) continue;
    const related = (neighbors.get(primary.id) || []).filter(r => r.kind === config.kind &&
      (config.selection === "all" || config.selection === "primary" && directlyLinked(primary, r) || config.selection === "label" &&
        (labels.get(JSON.stringify(associationPair(primary.id, r.id))) || []).some(label => label.toLowerCase() === config.label.toLowerCase())));
    const targets: (CRMRecord | undefined)[] = related.length ? related : config.join === "all" ? [undefined] : [];
    for (const associated of targets) {
      const pair = { primary, associated };
      if (!matchesFilterGroups(d.groups, fields, (field,rule) => read(pair, field,rule?.operator==="relativeDate"), "UTC",now) ||
        scopeRules.length && !matchesFilterGroups([scopeRules], fields, (field,rule) => read(pair, field,rule?.operator==="relativeDate"), "UTC",now)) continue;
      let value = d.groupBy ? read(pair, d.groupBy) : "All records";
      if ((groupField?.type === "date" || groupField?.type === "datetime") && value) {
        const day = String(value).slice(0,10);
        value = d.interval === "year" ? day.slice(0,4) : d.interval === "quarter" ? `${day.slice(0,4)} Q${Math.ceil(Number(day.slice(5,7))/3)}` : d.interval === "month" ? day.slice(0,7) : day;
      }
      const missing = value === undefined || value === null || value === "";
      const groupingRecord = d.groupBy.startsWith("associated:") ? associated : primary;
      const groupingField = d.groupBy.replace(/^associated:/, "");
      const label = missing ? "No value" : groupingField === "leadPipelineId" ? leadPipelineFor(pipeline,String(value))?.name || String(value) : groupingField === "leadStage" ? leadStageLabels(pipeline)[String(value)] || String(value) : groupingField === "ticketPipelineId" ? ticketPipelineFor(pipeline,String(value))?.name || String(value) : isTicketSlaStatusField(groupingField) ? closeSlaLabels[String(value) as CloseSlaStatus] || String(value) : groupingField === "ticketStatus" ? ticketStageLabels(pipeline,groupingRecord?.data.ticketPipelineId || "default")[String(value)] || String(value) : groupingField === "pipelineId" ? pipelineLabel(pipeline, String(value)) : groupingField === "stage" && groupingRecord?.kind === "deals" ? stageLabel(pipeline, String(value), groupingRecord.data.pipelineId || "default") : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
      const ownerGroup=d.ownerGrouping==="member"?ownerReportGroup(value,read(pair,d.groupBy+"Member") as RecordOwner|undefined):undefined;
      pairs.push({...pair, key: ownerGroup?.key ?? (missing ? "missing" : JSON.stringify(value)), label:ownerGroup?.label ?? label});
    }
  }
  if(d.breakdown){
    const dimensionsFor=breakdownDimensions(d,pairs,fields,pipeline,read,(pair,field)=>field.startsWith("associated:")?pair.associated:pair.primary);
    for(const pair of pairs){pair.dimensions=dimensionsFor(pair);pair.key=JSON.stringify(pair.dimensions.map(v=>v.key));pair.label=pair.dimensions.map(v=>v.label).join(" · ");}
  }
  function summarize(rows: Pair[]) {
    const formula=d.metric==="count"?undefined:formulas.get(d.measure);
    const usesRelated=formula?.fields.some(id=>id.startsWith("associated:")), usesPrimary=formula?.fields.some(id=>!id.startsWith("associated:"));
    const measureRelated = d.metric === "count" ? config.countSource === "associated" : formula ? !!usesRelated&&!usesPrimary : d.measure.startsWith("associated:");
    const seen = new Set<string>(), values: number[] = [];
    let count = 0;
    for (const row of rows) {
      const record = measureRelated ? row.associated : row.primary;
      // A formula using both sources belongs to the pair, not an arbitrary side.
      const identity=formula&&usesRelated&&(usesPrimary||!row.associated)?JSON.stringify([row.primary.id,row.associated?.id]):record?.id;
      if (!identity || config.aggregation === "distinctRecords" && seen.has(identity)) continue;
      seen.add(identity); count++;
      const value = read(row, d.measure);
      if (typeof value === "number" && Number.isFinite(value)) values.push(value);
    }
    return { value: aggregate(d.metric, values, count), measured: d.metric === "count" ? 0 : values.length };
  }
  const buckets = new Map<string, Pair[]>();
  for (const pair of pairs) { const bucket = buckets.get(pair.key) || []; bucket.push(pair); buckets.set(pair.key,bucket); }
  const rows = [...buckets].map(([key, bucket]) => ({ key, ...(d.breakdown?{dimensions:bucket[0].dimensions}:{}), label:d.ownerGrouping==="member"?bucket.map(r=>r.label).sort()[0]:[...new Set(bucket.map(r=>r.label))].join(" / "), ...summarize(bucket), count:new Set(bucket.map(r=>r.primary.id)).size, recordIds:[...new Set(bucket.map(r=>r.primary.id))] }));
  if(!d.breakdown&&d.ownerGrouping==="member")labelOwnerReportGroups(rows);
  sortReportRows(rows, d, groupField,fields.find(f=>f.id===d.breakdown?.field));
  const summary = summarize(pairs), recordIds = [...new Set(pairs.map(r=>r.primary.id))];
  return { rows, ...(!d.breakdown&&d.ownerGrouping==="member"?{groupIdentityLabel:"Workspace member ID"}:{}), total:summary.value, measured:summary.measured, count:recordIds.length, recordIds,
    pairs:pairs.map(r=>({primaryId:r.primary.id,associatedId:r.associated?.id,groupKey:r.key})),
    joined:{rows:pairs.length,associatedRecords:new Set(pairs.flatMap(r=>r.associated?[r.associated.id]:[])).size,aggregation:config.aggregation} };
}
// Instantiate new history templates against the current catalog; saved reports retain their IDs.
export function instantiateReportTemplate(template:ReportDefinition,source:DealStageSource):ReportDefinition {
  if(template.kind!=="deals"||!template.funnel)return structuredClone(template);
  return {...structuredClone(template),funnel:template.chart==="stageTime"?defaultStageTime(source):defaultFunnel(source)};
}
export const reportTemplates: ReportDefinition[] = [
  reportSchema.parse({name:"Deal time in stage",kind:"deals",chart:"stageTime",funnel:defaultStageTime(stages)}),
  reportSchema.parse({name:"Contact time in lifecycle stage",kind:"contacts",chart:"stageTime",funnel:defaultStageTime(stages,"contacts")}),
  reportSchema.parse({name:"Company time in lifecycle stage",kind:"companies",chart:"stageTime",funnel:defaultStageTime(stages,"companies")}),
  reportSchema.parse({name:"Contact lifecycle conversion",kind:"contacts",chart:"funnel",funnel:defaultFunnel(stages,"contacts")}),
  reportSchema.parse({name:"Company lifecycle conversion",kind:"companies",chart:"funnel",funnel:defaultFunnel(stages,"companies")}),
  reportSchema.parse({name:"Deal stage conversion",kind:"deals",chart:"funnel",funnel:defaultFunnel(stages)}),
  reportSchema.parse({name:"Quoted value by linked deal owner",kind:"quotes",metric:"sum",measure:"tcvUsd",groupBy:"currentDealOwner",commercePopulation:"active"}),
  reportSchema.parse({name:"Invoiced amount by company industry",kind:"invoices",metric:"sum",measure:"invoicedUsd",groupBy:"currentCompanyIndustry",commercePopulation:"active"}),
  reportSchema.parse({name:"Applied payments by linked deal owner",kind:"payments",metric:"sum",measure:"amountUsd",groupBy:"currentDealOwner",commercePopulation:"active"}),
  reportSchema.parse({name:"Quoted value by line item",kind:"quote_lines",metric:"sum",measure:"tcvUsd",groupBy:"name",commercePopulation:"active",additionalMetrics:[{id:"quantity",metric:"sum",measure:"quantity"}]}),
  reportSchema.parse({name:"Accepted quote items by month",kind:"quote_lines",metric:"sum",measure:"acceptedTcvUsd",groupBy:"acceptedOn",chart:"line",sort:"label",commercePopulation:"active",groups:[[{field:"status",operator:"eq",value:"accepted"}]]}),
  reportSchema.parse({name:"Invoiced value by line item",kind:"invoice_lines",metric:"sum",measure:"invoicedUsd",groupBy:"name",commercePopulation:"active",additionalMetrics:[{id:"quantity",metric:"sum",measure:"quantity"}]}),
  reportSchema.parse({name:"Invoiced line value by month",kind:"invoice_lines",metric:"sum",measure:"invoicedUsd",groupBy:"issuedOn",chart:"line",sort:"label",commercePopulation:"active"}),
  reportSchema.parse({name:"Won value by product",kind:"line_items",metric:"sum",measure:"tcvUsd",groupBy:"productId",commercePopulation:"all",groups:[[{field:"dealOutcome",operator:"eq",value:"won"}]],additionalMetrics:[{id:"quantity",metric:"sum",measure:"quantity"}]}),
  reportSchema.parse({name:"Open deal MRR by product",kind:"line_items",metric:"sum",measure:"mrrUsd",groupBy:"productId",commercePopulation:"active"}),
  reportSchema.parse({name:"Won value by saved item name",kind:"line_items",metric:"sum",measure:"tcvUsd",groupBy:"name",commercePopulation:"all",groups:[[{field:"dealOutcome",operator:"eq",value:"won"}]],additionalMetrics:[{id:"quantity",metric:"sum",measure:"quantity"}]}),
  reportSchema.parse({name:"Open deal MRR by saved item name",kind:"line_items",metric:"sum",measure:"mrrUsd",groupBy:"name",commercePopulation:"active"}),
  reportSchema.parse({name:"Won product value by close month",kind:"line_items",metric:"sum",measure:"tcvUsd",groupBy:"closeDate",chart:"line",sort:"label",commercePopulation:"all",groups:[[{field:"dealOutcome",operator:"eq",value:"won"}]]}),
  reportSchema.parse({name:"Products by billing frequency",kind:"products",metric:"count",groupBy:"billingFrequency",commercePopulation:"active"}),
  reportSchema.parse({name:"Quoted value by status",kind:"quotes",metric:"sum",measure:"tcvUsd",groupBy:"status",commercePopulation:"active",additionalMetrics:[{id:"quotes",metric:"count"}]}),
  reportSchema.parse({name:"Accepted quote value by month",kind:"quotes",metric:"sum",measure:"acceptedTcvUsd",groupBy:"acceptedOn",chart:"line",sort:"label",commercePopulation:"active",groups:[[{field:"status",operator:"eq",value:"accepted"}]]}),
  reportSchema.parse({name:"Quotes by first publication month",kind:"quotes",metric:"count",groupBy:"firstPublishedOn",chart:"line",sort:"label",commercePopulation:"active"}),
  reportSchema.parse({name:"Published quotes by expiration month",kind:"quotes",metric:"count",groupBy:"expiresOn",chart:"line",sort:"label",commercePopulation:"active",groups:[[{field:"status",operator:"eq",value:"published"}]]}),
  reportSchema.parse({name:"Outstanding balance by aging",kind:"invoices",metric:"sum",measure:"balanceUsd",groupBy:"agingBucket",commercePopulation:"active",groups:[[{field:"balanceUsd",operator:"gt",value:"0"}]]}),
  reportSchema.parse({name:"Applied payments by month",kind:"payments",metric:"sum",measure:"amountUsd",groupBy:"receivedOn",chart:"line",sort:"label",commercePopulation:"active"}),
  reportSchema.parse({name:"Invoiced amount by month",kind:"invoices",metric:"sum",measure:"invoicedUsd",groupBy:"issuedOn",chart:"line",sort:"label",commercePopulation:"active"}),
  reportSchema.parse({name:"Overdue balance by buyer",kind:"invoices",metric:"sum",measure:"balanceUsd",groupBy:"buyerName",commercePopulation:"active",groups:[[{field:"status",operator:"eq",value:"overdue"}]],additionalMetrics:[{id:"invoices",metric:"count"}]}),
  reportSchema.parse({name:"Call duration in minutes by assigned person",kind:"activities",metric:"sum",measure:"formula:minutes",groupBy:"assignedTo",formulas:[{id:"minutes",label:"Duration (minutes)",expression:"[durationSeconds] / 60"}],additionalMetrics:[{id:"average",metric:"average",measure:"formula:minutes"},{id:"calls",metric:"count"}],groups:[[{field:"type",operator:"eq",value:"Call"}]]}),
  reportSchema.parse({name:"Deal count, revenue and average by company industry",kind:"deals",metric:"count",metricLabel:"Deals",groupBy:"associated:industry",association:{kind:"companies",selection:"primary",aggregation:"distinctRecords"},additionalMetrics:[{id:"revenue",label:"Total deal amount",metric:"sum",measure:"amount"},{id:"average",label:"Average deal amount",metric:"average",measure:"amount"}],sortMetric:"revenue",metricScale:"separate"}),
  reportSchema.parse({name:"Deal revenue by company industry", kind:"deals", metric:"sum", measure:"amount", groupBy:"associated:industry", association:{kind:"companies",selection:"primary",aggregation:"distinctRecords"}}),
  reportSchema.parse({name:"Contacts per company", kind:"companies", metric:"count", groupBy:"name", association:{kind:"contacts",countSource:"associated",aggregation:"distinctRecords"}}),
  reportSchema.parse({ name: "Calls and meetings by type", kind: "activities", groupBy: "activityType", groups: [[{ field: "type", operator: "eq", value: "Call" }], [{ field: "type", operator: "eq", value: "Meeting" }]] }),
  reportSchema.parse({ name: "Calls by outcome", kind: "activities", groupBy: "outcome", groups: [[{ field: "type", operator: "eq", value: "Call", valueTo: "" }]] }),
  reportSchema.parse({ name: "Activities by assigned person", kind: "activities", groupBy: "assignedTo" }),
  reportSchema.parse({ name: "Call duration by assigned person", kind: "activities", metric: "sum", measure: "durationSeconds", groupBy: "assignedTo", groups: [[{ field: "type", operator: "eq", value: "Call", valueTo: "" }]] }),
  reportSchema.parse({ name: "Calls by company industry", kind: "activities", activityRecordKind: "companies", groupBy: "record:industry", groups: [[{field:"type",operator:"eq",value:"Call"}]] }),
  reportSchema.parse({ name: "Meetings by deal stage", kind: "activities", activityRecordKind: "deals", groupBy: "record:stage", groups: [[{field:"type",operator:"eq",value:"Meeting"}]] }),
  reportSchema.parse({ name: "Calls by associated company", kind: "activities", activityRecordKind: "companies", groupBy: "recordId", groups: [[{field:"type",operator:"eq",value:"Call"}]] }),
  reportSchema.parse({ name: "Activities by type", kind: "activities", groupBy: "type" }),
  reportSchema.parse({ name: "Activities by month", kind: "activities", groupBy: "occurredAt", chart: "line", sort: "label" }),
  reportSchema.parse({ name: "Calls by home record owner", kind: "activities", groupBy: "recordOwner", groups: [[{ field: "type", operator: "eq", value: "Call" }]] }),
  reportSchema.parse({
    name: "Deal amount by stage",
    kind: "deals",
    metric: "sum",
    measure: "amount",
    groupBy: "stage",
  }),
  reportSchema.parse({
    name: "Contacts by lifecycle stage",
    kind: "contacts",
    groupBy: "lifecycle",
  }),
  reportSchema.parse({
    name: "Tasks by status",
    kind: "tasks",
    groupBy: "status",
  }),
  reportSchema.parse({
    name: "Contacts created by month",
    kind: "contacts",
    groupBy: "createdAt",
    chart: "line",
    sort: "label",
  }),
];

export function reportCSV(d: ReportDefinition, result: ReportResult, properties: Property[] = [], pipeline: DealStageSource = stages,sourceFields?:FilterField[]) {
  const dimensionFields=sourceFields?[...sourceFields,...(d.formulas||[]).map(f=>({id:`formula:${f.id}`,label:`Formula · ${f.label}`,type:"number" as const}))]:reportDefinitionFields(d,properties,pipeline);
  const axisHeaders=d.breakdown?[dimensionFields.find(f=>f.id===d.groupBy)?.label||d.groupBy,dimensionFields.find(f=>f.id===d.breakdown?.field)?.label||d.breakdown.field]:["Group"];
  const axisValues=(row:ReportRow)=>d.breakdown?row.dimensions?.map(v=>v.label)||["",""]:[row.label];
  const identityLabels=result.dimensionIdentityLabels||(d.breakdown?[d.ownerGrouping,d.breakdown.ownerGrouping].map(mode=>mode==="member"?"Workspace member ID":null):[]);
  const ownerAxes=identityLabels.flatMap((label,i)=>label?[i]:[]);
  const ownerHeaders=ownerAxes.map(i=>axisHeaders[i]+": "+(identityLabels[i]==="Workspace member ID"?"workspace member ID":identityLabels[i]));
  const ownerValues=(row:ReportRow)=>ownerAxes.map(i=>row.dimensions?.[i].groupIdentity??"");
  const groupHeaders=[...axisHeaders,...ownerHeaders];
  const groupValues=(row:ReportRow)=>[...axisValues(row),...ownerValues(row)];
  const totalGroup=["Overall total",...groupHeaders.slice(1).map(()=>"")];
  const identityHeader=result.groupIdentityLabel?[result.groupIdentityLabel]:[];
  const identity=(row:ReportRow)=>result.groupIdentityLabel?[row.groupIdentity ?? ""]:[];
  const semanticsRows=result.semantics?[["Report scope",result.semantics],["As of (UTC)",result.asOf || ""]]:[];
  const formulaRows=(d.formulas || []).map(f=>["Formula",f.label,f.expression,f.nullAsZero?"Blank inputs become zero":"Blank inputs stay unknown"]);
  if (d.additionalMetrics?.length) {
    const metrics=reportMetrics(d), fields=dimensionFields, labels=metrics.map(m=>reportMetricLabel(d,m,fields));
    return [
      [...groupHeaders,...identityHeader,...labels,d.kind === "activities" ? "Activities" : isCommerceReport(d.kind) ? commerceSourceLabel(d.kind) : d.association ? "Distinct primary records" : "Records",...labels.map(label=>`${label}: numeric values`)],
      ...result.rows.map(row=>[...groupValues(row),...identity(row),...metrics.map(m=>row.metrics?.find(v=>v.id===m.id)?.value ?? ""),row.count,...metrics.map(m=>row.metrics?.find(v=>v.id===m.id)?.measured ?? 0)]),
      [...totalGroup,...identityHeader.map(()=>""),...metrics.map(m=>result.metrics?.find(v=>v.id===m.id)?.value ?? ""),result.count,...metrics.map(m=>result.metrics?.find(v=>v.id===m.id)?.measured ?? 0)],
      ...formulaRows,
      ...semanticsRows,
      ["Metric definitions",...metrics.map(m=>`${m.metric}: ${m.metric === "count" ? m.countSource === "associated" ? d.association?.kind : d.kind : m.measure}`)],
      ...(d.association ? [["Aggregation",d.association.aggregation === "rows" ? "Each joined row" : "Each measured record once per group and total"],["Sources",d.kind,d.association.kind]] : []),
    ].map(row=>row.map(csvCell).join(",")).join("\r\n");
  }
  return [
    [...groupHeaders,...identityHeader, (isCommerceReport(d.kind) ? reportMetricLabel(d,reportMetrics(d)[0],reportDefinitionFields(d,properties,pipeline)) : d.metricLabel) || (d.metric!=="count" && d.measure.startsWith("formula:") ? `${metricNames[d.metric]} of ${reportDefinitionFields(d,properties,pipeline).find(f=>f.id===d.measure)?.label || d.measure}` : d.kind === "activities" ? (d.metric === "count" ? "Activity count" : `${metricNames[d.metric]} of Duration (seconds)`) : metricNames[d.metric]), d.kind === "activities" ? "Activities" : isCommerceReport(d.kind) ? commerceSourceLabel(d.kind) : d.association ? "Distinct primary records" : "Records", "Numeric values"],
    ...result.rows.map((r) => [...groupValues(r),...identity(r), r.value ?? "", r.count, r.measured]),
    ...(d.activityRecordKind || d.breakdown ? [[...totalGroup,...identityHeader.map(()=>""),result.total ?? "",result.count,result.measured]] : []),
    ...formulaRows,
    ...semanticsRows,
    ...(d.association ? [["Aggregation", d.association.aggregation === "rows" ? "Each joined row" : "Each measured record once per group and total"], ["Primary source", d.kind], ["Associated source", d.association.kind], ["Metric source", d.metric === "count" ? d.association.countSource : d.measure], ...(!d.breakdown?[["Overall total", result.total ?? ""]]:[])] : []),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
