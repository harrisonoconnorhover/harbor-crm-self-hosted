import {ticketSlaFields,isTicketSlaField} from './ticket-sla-properties';
import {isFiscalReportPeriod} from './report-date-range';
import {leadPipelines,leadStageOptions,leadStageLabels} from './lead-pipelines';
import {leadStages} from './crm';
import {textSetOperators,isTextSetOperator,isTextFilterType,negativeTextOperator,matchesTextSet} from './text-filter';
import {recordMemberOwner,memberOwnerFilterSchema,type RecordOwner} from './record-owner';
import {isPropertyComparison,comparisonFields,matchesPropertyComparison} from './property-comparison';
import {relativeDateSchema,matchesRelativeDate,relativeDateSummary} from './relative-date-filter';
import { propertyDateTimeSchema } from "./property-datetime";
import {recordSourceFields} from './record-source';
import {currentStageFields,isCurrentStageField} from './current-stage';
import { dealRevenueFields } from "./deal-revenue";
import { ticketCatalog, ticketStageOptions, ticketStageLabels } from "./ticket-pipelines";
import { standardFields } from "./standard-properties";
import {
  type DealStageSource,
  allStageOptions,
  stageOptionLabels,
  pipelineList,
  isPipelineSettings,
} from "./forecast";
import { z } from "zod";
import {
  ticketStatuses, ticketPriorities,
  lifecycles,
  stages,
  taskTypes,
  type CRMRecord,
  type Kind,
} from "./crm";
import type {ValidationRules} from "./property-validation";
import { customTextLimit, isTextProperty } from "./property-text";
import type { Property } from "./workspace";

export const operators = {
  ...textSetOperators,
  anyOf: "is any of",
  noneOf: "is none of",
  allOf: "contains all of",
  notAllOf: "doesn’t contain all of",
  eq: "is equal to",
  neq: "is not equal to",
  contains: "contains",
  notContains: "does not contain",
  starts: "starts with",
  known: "is known",
  unknown: "is unknown",
  gt: "is greater than",
  lt: "is less than",
  gte: "is at least",
  lte: "is at most",
  beforeProperty: "is before another property",
  afterProperty: "is after another property",
  gtProperty: "is greater than property",
  ltProperty: "is less than property",
  relativeDate: "is in a relative date period",
  on: "is on",
  before: "is before",
  after: "is after",
  between: "is between",
} as const;
export type Operator = keyof typeof operators;
export const ruleSchema = z.object({
  member: memberOwnerFilterSchema.optional(),
  field: z.string().min(1).max(150),
  operator: z.enum(Object.keys(operators) as [Operator, ...Operator[]]),
  value: z.string().max(2048).default(""),
  valueTo: z.string().max(2048).default(""),
  relativeDate: relativeDateSchema.optional(),
  compareField: z.string().min(1).max(150).optional(),
  includeUnknown: z.boolean().optional(),
  values: z.array(z.string().trim().min(1).max(2048)).max(50).optional(),
});
export const groupsSchema = z
  .array(z.array(ruleSchema).min(1).max(20))
  .max(10)
  .default([]);
export type FilterRule = z.infer<typeof ruleSchema>;
export type FilterGroups = z.infer<typeof groupsSchema>;
export type FilterField = {
  memberOwner?: boolean;
  showRelativeTime?:boolean;
  linkText?:string;
  allowCustomLinkText?:boolean;
  id: string;
  label: string;
  type: "text" | "url" | "email" | "number" | "date" | "datetime" | "select" | "checkbox" | "multiselect";
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  group?: string;
  description?: string;
  optional?: boolean;
  multiline?: boolean;
  maxLength?: number;
  uniqueValues?: boolean;
  validation?:ValidationRules|null;
  validationTimeZone?:string;
  filterTimeZone?:string;
  fiscalStartMonth?:number;
  inputType?: "url" | "tel";
};
const field = (
  id: string,
  label: string,
  type: FilterField["type"] = "text",
  options?: readonly string[],
): FilterField => ({ id, label, type, options });
export function filterFields(
  kind: Kind,
  properties: Property[],
  dealStages: DealStageSource = stages,
  fiscalStartMonth?:number,
): FilterField[] {
  const common = [
    field("name", kind === "tasks" ? "Task title" : "Name"),
    {...field("owner", "Record owner"),memberOwner:true},
    field("createdAt", "Create date", "date"),
    field("updatedAt", "Last modified", "date"),
    ...recordSourceFields,
  ];
  const byKind: Record<Kind, FilterField[]> = {
    leads: [{...field("leadStage","Lead stage","select",leadStageOptions(dealStages)),optionLabels:leadStageLabels(dealStages)},{...field("leadPipelineId","Lead pipeline","select",leadPipelines(dealStages).map(p=>p.id)),optionLabels:Object.fromEntries(leadPipelines(dealStages).map(p=>[p.id,p.name]))},field("company","Company name"),field("contact","Contact name"),field("lastContacted","Last contacted","date"),field("lastActivity","Last activity date","date")],
    contacts: [
      field("email", "Email"),
      field("phone", "Phone"),
      field("title", "Job title"),
      field("company", "Company name"),
      field("lifecycle", "Lifecycle stage", "select", lifecycles),
      field("lastContacted", "Last contacted", "date"),
      field("lastActivity", "Last activity date", "date"),
    ],
    companies: [
      field("domain", "Domain"),
      field("website", "Website URL"),
      field("industry", "Industry"),
      field("city", "City"),
      field("lifecycle", "Lifecycle stage", "select", lifecycles),
      field("lastContacted", "Last contacted", "date"),
      field("lastActivity", "Last activity date", "date"),
    ],
    deals: [
      ...dealRevenueFields.map(f => field(f.id, f.label, "number")),
      field("amount", "Amount", "number"),
      {
        ...field("stage", "Deal stage", "select", allStageOptions(dealStages)),
        optionLabels: stageOptionLabels(dealStages),
      },
      {
        ...field(
          "pipelineId",
          "Pipeline",
          "select",
          isPipelineSettings(dealStages)
            ? pipelineList(dealStages).map((p) => p.id)
            : ["default"],
        ),
        optionLabels: isPipelineSettings(dealStages)
          ? Object.fromEntries(
              pipelineList(dealStages).map((p) => [p.id, p.name]),
            )
          : { default: "Sales pipeline" },
      },
      field("closeDate", "Close date", "date"),
      field("company", "Company name"),
      field("contact", "Contact name"),
      field("lastContacted", "Last contacted", "date"),
      field("lastActivity", "Last activity date", "date"),
    ],
    tickets: [
      {...field("ticketStatus", "Ticket status", "select", ticketStageOptions(dealStages)),optionLabels:ticketStageLabels(dealStages)},
      {...field("ticketPipelineId", "Ticket pipeline", "select", ticketCatalog(dealStages).pipelines.map(p=>p.id)),optionLabels:Object.fromEntries(ticketCatalog(dealStages).pipelines.map(p=>[p.id,p.name]))}, field("closedAt", "Close date", "date"), field("timeToCloseHours", "Time to close (hours)", "number"),
      field("ticketPriority", "Priority", "select", ticketPriorities),
      field("company", "Company name"), field("contact", "Contact name"),
      field("lastContacted", "Last contacted", "date"), field("lastActivity", "Last activity date", "date"),
    ],
    tasks: [
      field("taskType", "Task type", "select", [...taskTypes]),
      field("dueDate", "Due date", "date"),
      field("dueTime", "Due time"), field("dueTimeZone", "Due time zone"),
      field("dueTimeOccurrence", "Clock-change occurrence", "select", ["earlier", "later"]),
      field("status", "Status", "select", ["Not started", "Completed"]),
      field("priority", "Priority", "select", ["Low", "Medium", "High"]),
      field("related", "Related record name"),
    ],
  };
  return [
    ...common,
    ...byKind[kind],
    ...currentStageFields(kind),
    ...ticketSlaFields(kind),
    ...standardFields(kind, properties),
    ...properties
      .filter((p) => !p.standardField && p.kind === kind)
      .map((p) => ({...field("custom:" + p.id, p.label, p.type === "textarea" ? "text" : p.type, p.options), description:p.description || undefined, showRelativeTime:p.showRelativeTime, ...(p.type === "url" ? {linkText:p.linkText,allowCustomLinkText:p.allowCustomLinkText} : {}), uniqueValues:p.uniqueValues, validation:p.validation, validationTimeZone:p.validationTimeZone, ...(p.type === "datetime" ? {filterTimeZone:p.filterTimeZone || "UTC"} : {}), ...(isTextProperty(p.type) ? {multiline:p.type === "textarea", maxLength:customTextLimit} : {})})),
  ].map(f => (f.type==='date'||f.type==='datetime')&&!f.id.startsWith('custom:') ? {...f,showRelativeTime:!!properties.find(p=>p.kind===kind&&p.standardField===f.id)?.showRelativeTime} : f).map(f => fiscalStartMonth !== undefined && (f.type==='date'||f.type==='datetime') ? {...f,fiscalStartMonth} : f);
}
export function allowedOperators(type: FilterField["type"]): Operator[] {
  const presence: Operator[] = ["known", "unknown"];
  if (type === "multiselect") return ["anyOf", "noneOf", "allOf", "notAllOf", ...presence];
  if (type === "number")
    return ["eq", "neq", "gt", "gte", "lt", "lte", "between", "gtProperty", "ltProperty", ...presence];
  if (type === "datetime") return ["eq", "neq", "before", "after", "between", "relativeDate", "beforeProperty", "afterProperty", ...presence];
  if (type === "date") return ["on", "before", "after", "between", "relativeDate", "beforeProperty", "afterProperty", ...presence];
  if (type === "select") return ["eq", "neq", "anyOf", "noneOf", ...presence];
  if (type === "checkbox") return ["eq", "neq", ...presence];
  return ["contains", "notContains", "eq", "neq", "starts", ...Object.keys(textSetOperators) as (keyof typeof textSetOperators)[], ...presence];
}
export function validateFilters(
  groups: FilterGroups,
  kind: Kind,
  properties: Property[],
  dealStages: DealStageSource = stages,
  fiscalStartMonth?:number,
) {
  validateFilterFields(groups, filterFields(kind, properties, dealStages,fiscalStartMonth));
}
// Check before evaluating any rows or short-circuiting OR/negative criteria.
// Only contexts with a server-resolved calendar may evaluate fiscal rules.
export function assertFiscalFilterContext(groups: FilterGroups, fields: FilterField[] = []) {
  for (const group of groups) for (const rule of group) {
    if (rule.operator !== 'relativeDate' || !isFiscalReportPeriod(rule.relativeDate?.period)) continue;
    const month = fields.find(field => field.id === rule.field)?.fiscalStartMonth;
    if (!Number.isInteger(month) || month! < 1 || month! > 12)
      throw Error('Fiscal date filters are not available in this context. Use a calendar period or explicit dates.');
  }
}
export function validateFilterFields(groups: FilterGroups, fields: FilterField[]) {
  groupsSchema.parse(groups);
  assertFiscalFilterContext(groups, fields);
  for (const group of groups)
    for (const rule of group) {
      const f = fields.find((f) => f.id === rule.field);
      if (!f)
        throw new Error(
          "A filtered property is unavailable. Choose another property.",
        );
      if(rule.member){
        if(!f.memberOwner||!['eq','neq'].includes(rule.operator))throw Error('Member owner filters require an owner property and an equal or not-equal comparison.');
        if(rule.includeUnknown!==undefined)throw Error('Use a separate is unknown condition to include unassigned records.');
        continue;
      }
      if (!allowedOperators(f.type).includes(rule.operator))
        throw new Error(`Choose a valid comparison for ${f.label}.`);
      if(rule.includeUnknown!==undefined && !((["multiselect","select"].includes(f.type)&&negativeSetOperator(rule.operator))||(isTextFilterType(f.type)&&negativeTextOperator(rule.operator))))throw Error("Empty-value inclusion is only available for negative option or text-set filters.");
      if (["known", "unknown"].includes(rule.operator)) continue;
      if(isPropertyComparison(rule.operator)){if(!comparisonFields(f,fields).some(other=>other.id===rule.compareField))throw Error(`Choose another available ${f.type} property to compare with ${f.label}.`);continue;}
      if(rule.operator==="relativeDate"){relativeDateSchema.parse(rule.relativeDate);continue;}
      if (isTextSetOperator(rule.operator)) {
        if(!rule.values?.length)throw Error(`Enter at least one value for ${f.label}.`);
        continue;
      }
      if (f.type === "select" && ["anyOf","noneOf"].includes(rule.operator)) {
        if(!rule.values?.length || rule.values.some(v=>!f.options?.includes(v)))throw Error(`Choose available options for ${f.label}.`);
        continue;
      }
      if (f.type === "multiselect") {
        if (!rule.values?.length || rule.values.some(v => !f.options?.some(o => o.toLowerCase() === v.trim().toLowerCase())))
          throw new Error(`Choose available options for ${f.label}.`);
        continue;
      }
      const values =
        rule.operator === "between" ? [rule.value, rule.valueTo] : [rule.value];
      for (const value of values) {
        if (!value.trim()) throw new Error(`Enter a value for ${f.label}.`);
        if (f.type === "number" && !Number.isFinite(Number(value)))
          throw new Error(`Enter a number for ${f.label}.`);
        if (f.type === "date" && !z.string().date().safeParse(value).success)
          throw new Error(`Enter a valid date for ${f.label}.`);
        if (f.type === "datetime" && !propertyDateTimeSchema.safeParse(value).success)
          throw new Error(`Enter a date and time with an explicit time zone for ${f.label}.`);
        if (f.type === "checkbox" && !["true", "false"].includes(value))
          throw new Error(`Choose Yes or No for ${f.label}.`);
        if (f.type === "select" && !f.options?.includes(value))
          throw new Error(`Choose an option for ${f.label}.`);
      }
      if (
        rule.operator === "between" &&
        (f.type === "number"
          ? Number(rule.value) > Number(rule.valueTo)
          : f.type === "datetime" ? Date.parse(rule.value) > Date.parse(rule.valueTo) : rule.value > rule.valueTo)
      )
        throw new Error(`The range for ${f.label} must start before it ends.`);
    }
}
export function localDay(date = new Date(), timeZone?: string) {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)!.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function readFilterValue(
  r: CRMRecord,
  field: string,
  records: CRMRecord[],
): unknown {
  if(isTicketSlaField(field))return r.kind==='tickets'?r.closeSlaProperties?.[field]:undefined;
  if(field === "ownerMember") return recordMemberOwner(r) || undefined;
  if (isCurrentStageField(field)) return r[field as "currentStageEnteredAt"];
  if(field==='leadPipelineId'&&r.kind==='leads')return r.data.leadPipelineId||'default';
  if (field === "ticketPipelineId" && r.kind === "tickets") return r.data.ticketPipelineId || "default";
  if (field === "timeToCloseHours" && r.kind === "tickets") {
    const hours = (Date.parse(r.data.closedAt || "") - Date.parse(r.createdAt)) / 3_600_000;
    return Number.isFinite(hours) && hours >= 0 ? hours : undefined;
  }
  if (field === "pipelineId" && r.kind === "deals")
    return r.data.pipelineId || "default";
  if (field === "taskType" && r.kind === "tasks")
    return r.data.taskType || "To-do";
  if (["createdAt", "updatedAt", "lastContacted", "lastActivity"].includes(field))
    return r[field as "createdAt"];
  if (field.startsWith("custom:")) return r.data.custom?.[field.slice(7)];
  const link = (
    {
      company: "companyId",
      contact: "contactId",
      related: "relatedId",
    } as const
  )[field as "company"];
  return link
    ? records.find((x) => x.id === r.data[link])?.data.name
    : r.data[field as keyof typeof r.data];
}
export function matchesFilters(
  r: CRMRecord,
  records: CRMRecord[],
  groups: FilterGroups,
  properties: Property[],
  timeZone?: string,
  now = new Date(),
  fiscalStartMonth?:number,
) {
  return matchesFilterGroups(groups, filterFields(r.kind, properties,undefined,fiscalStartMonth), field => readFilterValue(r, field, records), timeZone,now);
}
export function matchesFilterGroups(groups: FilterGroups, fields: FilterField[], read: (field: string,rule?:FilterRule) => unknown, timeZone?: string, now=new Date()) {
  assertFiscalFilterContext(groups, fields);
  return (
    !groups.length ||
    groups.some(
      (group) =>
        group.length > 0 &&
        group.every((rule) => {
          const f = fields.find((f) => f.id === rule.field);
          if (!f || !allowedOperators(f.type).includes(rule.operator))
            return false;
          if(rule.member){
            if(!f.memberOwner||!['eq','neq'].includes(rule.operator))return false;
            const actual=read(rule.field+'Member',rule) as RecordOwner|undefined;
            if(!actual)return false;
            const same=actual.workspaceId===rule.member.workspaceId&&actual.userId===rule.member.userId;
            return rule.operator==='eq'?same:!same;
          }
          const raw = read(rule.field,rule);
          const known = raw !== undefined && raw !== null && raw !== "" && (!Array.isArray(raw) || raw.length > 0);
          if (rule.operator === "known") return known;
          if (rule.operator === "unknown") return !known;
          if((["multiselect","select"].includes(f.type)||isTextSetOperator(rule.operator)) && !known)return !!rule.values?.length && filterIncludesUnknown(rule);
          // Other unknown values need an explicit OR is unknown.
          if (!known) return false;
          if(isPropertyComparison(rule.operator)){const other=comparisonFields(f,fields).find(other=>other.id===rule.compareField);return !!other&&matchesPropertyComparison(raw,read(other.id,rule),f.type,rule.operator,timeZone);}
          if(rule.operator==="relativeDate")return !!rule.relativeDate&&matchesRelativeDate(raw,rule.relativeDate,now,f.fiscalStartMonth);
          if(isTextSetOperator(rule.operator))return matchesTextSet(raw,rule.operator,rule.values||[]);
          if(f.type==="select" && ["anyOf","noneOf"].includes(rule.operator)){
            if(typeof raw!=="string" || !rule.values?.length)return false;
            const matches=rule.values.includes(raw);
            return rule.operator==="anyOf"?matches:!matches;
          }
          if (f.type === "multiselect") {
            if (!Array.isArray(raw) || !rule.values?.length) return false;
            const actual = new Set(raw.map(v => String(v).toLowerCase()));
            const overlaps = rule.values.some(v => actual.has(v.trim().toLowerCase()));
            const containsAll=rule.values.every(v=>actual.has(v.trim().toLowerCase()));
            return rule.operator === "anyOf" ? overlaps : rule.operator === "noneOf" ? !overlaps : rule.operator === "allOf" ? containsAll : rule.operator === "notAllOf" && !containsAll;
          }
          const normalize = (v: unknown, actual = false): string | number =>
            f.type === "number"
              ? Number(v)
              : f.type === "datetime" ? Date.parse(String(v))
              : f.type === "date" && actual && String(v).length > 10
                ? localDay(new Date(String(v)), timeZone)
                : String(v).toLocaleLowerCase();
          const value = normalize(raw, true),
            expected = normalize(rule.value),
            upper = normalize(rule.valueTo);
          switch (rule.operator) {
            case "eq":
            case "on":
              return value === expected;
            case "neq":
              return value !== expected;
            case "contains":
              return String(value).includes(String(expected));
            case "notContains":
              return !String(value).includes(String(expected));
            case "starts":
              return String(value).startsWith(String(expected));
            case "gt":
            case "after":
              return value > expected;
            case "gte":
              return value >= expected;
            case "lt":
            case "before":
              return value < expected;
            case "lte":
              return value <= expected;
            case "between":
              return value >= expected && value <= upper;
            default:
              return false;
          }
        }),
    )
  );
}
export type TaskScope = "all" | "today" | "overdue" | "upcoming";
export function matchesTaskScope(
  r: CRMRecord,
  scope: TaskScope,
  today = localDay(),
  now = new Date(),
  timeZone?: string,
) {
  if (scope === "all" || r.kind !== "tasks") return true;
  if (!r.data.dueDate || r.data.status === "Completed") return false;
  const day = r.data.dueAt ? localDay(new Date(r.data.dueAt), timeZone) : r.data.dueDate;
  return scope === "today"
    ? day === today
    : scope === "overdue"
      ? (r.data.dueAt ? Date.parse(r.data.dueAt) < +now : r.data.dueDate < today)
      : day > today;
}

export const negativeSetOperator=(operator:string)=>operator==="noneOf"||operator==="notAllOf";
export const filterIncludesUnknown=(rule:FilterRule)=>(negativeSetOperator(rule.operator)||negativeTextOperator(rule.operator))&&(rule.includeUnknown??rule.operator==="notAllOf");
export function filterRuleValueText(rule:FilterRule,fields:FilterField[]=[]){
  if(rule.member)return `${rule.member.label || 'Workspace member'} (member)`;
  if(isPropertyComparison(rule.operator))return fields.find(f=>f.id===rule.compareField)?.label||rule.compareField||"Choose a property";
  if(rule.operator==="relativeDate"&&rule.relativeDate)return relativeDateSummary(rule.relativeDate);
  const labels=fields.find(f=>f.id===rule.field)?.optionLabels;
  if(rule.values?.length&&(["anyOf","noneOf","allOf","notAllOf"].includes(rule.operator)||isTextSetOperator(rule.operator)))return rule.values.map(v=>labels?.[v]||v).join("; ")+(filterIncludesUnknown(rule)?" (including empty values)":"");
  return (labels?.[rule.value]||rule.value)+(rule.operator==="between"?` and ${rule.valueTo}`:"");
}
