import {applyForecastMapping} from './forecast-category';
import {leadPipelineFor} from './lead-pipelines';
import {recordOwner,matchesMemberOwner} from './record-owner';
import {taskAssignee} from './task-assignee';
import { linkTextSchema, linkTextValueSchema, propertyEmailSchema, propertyURLSchema } from "./property-links";
import { propertyDateTimeSchema } from "./property-datetime";
import {defaultPipelineId} from './pipeline-default';
import { normalizeTaskRepeat } from "./task-repeat";
import { normalizeTaskDeadline } from "./task-deadline";
import {retainRecordSource} from './record-source';
import {uniqueNumber,numberRoundTrips} from './unique-number';
import { ticketPipelineFor, moveTicketPipeline } from "./ticket-pipelines";
import { segmentConditionsSchema, matchesSegmentConditions } from "./segment-conditions";
import { activityCriteriaSchema, matchesActivityCriteria, emptyActivityContext } from "./activity-conditions";
import { associatedCriteriaSchema, matchesAssociatedCriteria } from "./associated-conditions";
import type { RecordConditionContext } from "./record-conditions";
import { standardOptionSchemas } from "./standard-properties";
import { boardSummarySchema } from "./board-summary";
import { boardGroupingSchema } from "./board-grouping";
import { associationSettingsSchema } from "./association-settings";
import { boardCardSettingsSchema } from "./board-card-settings";
import { columnWidthsSchema } from "./column-widths";
import { type DealStageSource, recordStages } from "./forecast";
import { z } from "zod";
import { matchesTaskQueue } from "./task-queues";
import { groupsSchema, matchesFilters, matchesTaskScope, localDay } from "./filters";
import { schemas, stages, type Data, type Kind, type CRMRecord } from "./crm";

import { customTextLimit, isTextProperty, recordDataByteLimit } from "./property-text";
import {validationRulesSchema,definitionValidationError,propertyValidationError,formatPropertyText,type ValidationRules} from "./property-validation";
import {samePropertyValue} from "./property-values";
import { InputError } from "./input-error";
export { InputError } from "./input-error";
export const propertyTypes = [
  "text",
  "textarea",
  "url",
  "email",
  "number",
  "date",
  "datetime",
  "checkbox",
  "select",
  "multiselect",
] as const;
export type Property = {
  showRelativeTime?:boolean;
  linkText?:string;
  allowCustomLinkText?:boolean;
  uniqueValues?: boolean;
  validationTimeZone?:string;
  filterTimeZone?:string;
  validation?: ValidationRules | null;
  archivedAt?: string | null;
  description?: string;
  standardField?: string | null;
  revision?: number;
  id: string;
  kind: Kind;
  label: string;
  type: (typeof propertyTypes)[number];
  options: string[];
};
export const propertyInputFields = z
  .object({
    kind: z.enum(["contacts", "companies", "deals", "tasks", "tickets", "leads"]),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).optional(),
    type: z.enum(propertyTypes),
    showRelativeTime: z.boolean().optional(),
    linkText: linkTextSchema.optional(),
    allowCustomLinkText: z.boolean().optional(),
    uniqueValues: z.boolean().optional(),
    validation: validationRulesSchema.nullable().optional(),
    options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  });
function validatePropertyInput(v: z.output<typeof propertyInputFields>, ctx: z.RefinementCtx) {
  if(v.showRelativeTime && !["date","datetime"].includes(v.type))ctx.addIssue({code:"custom",message:"Relative time is available for date properties only."});
  if(v.type!=="url" && (v.linkText || v.allowCustomLinkText))ctx.addIssue({code:"custom",message:"Link text settings are available for URL properties only."});
  if(v.uniqueValues && !["text","textarea","number"].includes(v.type))ctx.addIssue({code:"custom",message:"Unique values are available for text and number properties."});
  const validationError=definitionValidationError(v.type,v.validation);
  if(validationError)ctx.addIssue({code:"custom",message:validationError});
  if (
    ["select", "multiselect"].includes(v.type) &&
    (!v.options.length ||
      new Set(v.options.map((o) => o.toLowerCase())).size !==
        v.options.length)
  )
    ctx.addIssue({
      code: "custom",
      message: "Choose at least one unique option.",
    });
  if (v.type === "multiselect" && v.options.some(o => o.includes(";")))
    ctx.addIssue({code:"custom", message:"Multiple-checkbox options cannot contain semicolons; imports use them to separate choices."});
}
export const propertyInput = propertyInputFields.superRefine(validatePropertyInput);
export const strictPropertyInput = propertyInputFields.strict().superRefine(validatePropertyInput);
export const viewConfigSchema = z.object({
  associations: associationSettingsSchema,
  pipelineId: z.string().max(100).default("default"),
  queueId: z.string().max(100).default(""),
  groups: groupsSchema,
  activityCriteria: activityCriteriaSchema.optional(),
  associatedCriteria: associatedCriteriaSchema.optional(),
  segmentConditions: segmentConditionsSchema.optional(),
  taskScope: z.enum(["all", "today", "overdue", "upcoming"]).default("all"),
  tagId: z.string().max(100).default(""),
  query: z.string().max(200).default(""),
  filter: z.string().max(100).default(""),
  mine: z.boolean().default(false),
  sort: z.enum(["name", "created", "lastContacted"]).default("name"),
  columnSort: z
    .object({
      field: z.string().min(1).max(150),
      direction: z.enum(["asc", "desc"]),
    })
    .nullable()
    .default(null),
  layout: z.enum(["table", "board"]).default("table"),
  quickFilters: z.array(z.string().min(1).max(150)).max(10).refine(ids => new Set(ids).size === ids.length, "Choose each quick filter once.").nullable().default(null),
  columns: z.array(z.string().max(150)).max(100).nullable().default(null),
  columnWidths: columnWidthsSchema,
  boardCards: boardCardSettingsSchema,
  boardGrouping: boardGroupingSchema,
  boardSummary: boardSummarySchema,
  collapsedStages: z.record(z.string().min(1).max(100),
    z.array(z.string().min(1).max(80)).max(50)
      .refine(ids => new Set(ids).size === ids.length, "Choose unique stages."))
    .refine(value => Object.keys(value).length <= 20, "Too many pipelines.").prefault({}),
  frozenColumns: z.number().int().min(0).max(100).default(1),
  propertyId: z.string().max(100).default(""),
  propertyValue: z.string().max(200).default(""),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type SavedView = {
  id: string;
  kind: Kind;
  name: string;
  config: ViewConfig;
};
export const emptyView = (): ViewConfig => viewConfigSchema.parse({});
export const propertyText = (value: unknown) =>
  Array.isArray(value) ? value.join("; ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "");
function parseCustomValue(
  p: Property,
  value: unknown,
): string | number | boolean | string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (p.type === "multiselect") {
    if (typeof value === "string" && value.trimStart().startsWith(";"))
      throw new InputError("Append syntax is not supported yet. Use choices separated by semicolons to replace the selection.");
    const supplied = z.array(z.string().trim().min(1).max(80)).max(50).parse(
      typeof value === "string" ? value.split(";").map(v => v.trim()).filter(Boolean) : value,
    );
    const selected = new Set(supplied.map(v => v.toLowerCase()));
    if ([...selected].some(v => !p.options.some(o => o.toLowerCase() === v)))
      throw new InputError(`Choose available options for ${p.label}.`);
    const result = p.options.filter(o => selected.has(o.toLowerCase()));
    return result.length ? result : undefined;
  }
  if (p.type === "number") return p.uniqueValues&&typeof value==='string'?uniqueNumber(value):z.number().finite().parse(value);
  if (p.type === "checkbox") return z.boolean().parse(value);
  if (p.type === "url") return propertyURLSchema.parse(value);
  if (p.type === "email") return propertyEmailSchema.parse(value);
  if (p.type === "datetime") return propertyDateTimeSchema.parse(value);
  if (p.type === "date")
    return z.string().date("Use YYYY-MM-DD for dates.").parse(value);
  const text = z.string().max(isTextProperty(p.type) ? customTextLimit : 2000).parse(value);
  if (p.type === "select" && !p.options.includes(text))
    throw new InputError(`Choose an option for ${p.label}.`);
  return text;
}
export function customValue(p:Property,value:unknown,options:{previous?:unknown;skipRules?:boolean;autoFormat?:boolean;now?:Date}={}){
  const unchangedNumber=p.type==='number'&&p.uniqueValues&&typeof value==='string'&&typeof options.previous==='number'&&numberRoundTrips(value.trim(),options.previous);
  let parsed=parseCustomValue(p,unchangedNumber?options.previous:value);
  if(p.type==='number'&&p.uniqueValues&&parsed!==undefined&&!samePropertyValue(parsed,options.previous))uniqueNumber(parsed as number);
  if(!options.skipRules&&!samePropertyValue(parsed,options.previous)){
    if(options.autoFormat!==false&&typeof parsed==='string'){
      const formatted=formatPropertyText(p,parsed);
      if(parsed!==''&&formatted==='')throw new InputError(`Automatic formatting would remove every character from ${p.label}. Enter an allowed value or clear it explicitly.`);
      parsed=formatted;
    }
    const error=propertyValidationError(p,parsed,{now:options.now});if(error)throw new InputError(error);
  }
  return parsed;
}
export function parseRecord(
  kind: Kind,
  input: unknown,
  properties: Property[],
  dealStages: DealStageSource = stages,
  previous?: Data,
  validationOptions: {skipValidationRules?:boolean;autoFormat?:boolean;now?:Date} = {},
): Data {
  const validationNow=validationOptions.now||new Date();
  // Missing pipeline on an existing record means its historical original pipeline.
  // Only a new record without a choice takes the configured creation default.
  if(kind==='deals'||kind==='tickets'||kind==='leads'){
    const field=kind==='leads'?'leadPipelineId':kind==='deals'?'pipelineId':'ticketPipelineId';
    const raw=z.record(z.string(), z.unknown()).parse(input);
    if(raw[field]===undefined)input={...raw,[field]:previous?(previous[field]||'default'):defaultPipelineId(kind,dealStages)};
  }
  const pipelineId = z
    .object({ pipelineId: z.string().default("default") })
    .parse(input).pipelineId;
  const options = kind === "deals" ? recordStages(dealStages, pipelineId) : [];
  const data =
    kind === "deals"
      ? schemas.deals
          .extend({
            ...standardOptionSchemas(kind, properties),
            stage: z
              .string()
              .refine(
                (s) => options.includes(s),
                "Choose an available deal stage.",
              )
              .default(options[0]),
          })
          .parse(input)
      : kind === "leads" ? (() => {
          const id=z.object({leadPipelineId:z.string().default('default')}).parse(input).leadPipelineId,pipeline=leadPipelineFor(dealStages,id);
          if(!pipeline)throw new InputError('Choose an available lead pipeline.');
          return schemas.leads.extend({...standardOptionSchemas(kind,properties),leadStage:z.string().refine(s=>pipeline.stages.some(t=>t.id===s),'Choose an available lead stage.').default(pipeline.stages[0].id)}).parse(input);
        })() : kind === "tickets" ? (() => {
          const id = z.object({ticketPipelineId:z.string().default("default")}).parse(input).ticketPipelineId;
          const pipeline = ticketPipelineFor(dealStages, id);
          if (!pipeline) throw new InputError("Choose an available ticket pipeline.");
          return schemas.tickets.extend({...standardOptionSchemas(kind, properties),ticketStatus:z.string().refine(s=>pipeline.stages.some(t=>t.id===s),"Choose an available ticket status.").default(pipeline.stages[0].id)}).parse(input);
        })() : schemas[kind].extend(standardOptionSchemas(kind, properties)).parse(input);
  if(kind==='leads' && !data.contactId&&!data.companyId)throw new InputError('Choose at least one primary contact or company for this lead.');
  const raw = z
    .object({ custom: z.record(z.string(), z.unknown()).prefault({}) })
    .parse(input).custom;
  // Only trusted server-side prior data may carry unavailable values forward.
  // Clients cannot introduce or change an archived field through a stale form.
  const active = new Set(properties.filter(p => !p.standardField && !p.archivedAt && p.kind === kind).map(p => p.id));
  const custom = Object.fromEntries(Object.entries(previous?.custom || {}).filter(([id]) => !active.has(id)));

  for (const [id, value] of Object.entries(raw)) {
    const p = properties.find((p) => !p.standardField && !p.archivedAt && p.id === id && p.kind === kind);
    if (!p && Object.hasOwn(previous?.custom || {}, id)) continue;
    if (!p)
      throw new InputError(
        "A custom property is no longer available. Refresh and try again.",
      );
    try {
      const v = customValue(p, value, {previous:previous?.custom?.[id],skipRules:validationOptions.skipValidationRules,autoFormat:validationOptions.autoFormat,now:validationNow});
      if (v !== undefined) custom[id] = v;
    } catch (error) {
      if(error instanceof InputError)throw error;
      throw new InputError(`Check the value for ${p.label} (${p.type}).`);
    }
  }
  let normalized = kind==='deals'?applyForecastMapping(data as Data,previous,dealStages,properties):data as Data;
  if (kind !== "tasks") {
    const assignment = previous && recordOwner(previous);
    if (assignment && assignment.label === normalized.owner) normalized.recordOwner = assignment;
  }
  if (kind === "tasks") {
    const assignment=previous&&taskAssignee(previous);
    if(assignment&&assignment.label===normalized.owner)normalized.taskAssignee=assignment;
    // Clearing an existing date also clears its time in partial API/import edits.
    if (previous?.dueDate && !normalized.dueDate) normalized = { ...normalized, dueTime: "", dueTimeZone: "", dueTimeOccurrence: "" };
    if (previous?.repeat && input && typeof input === "object" && !Object.hasOwn(input,"repeat")) normalized.repeat=previous.repeat;
    normalized = normalizeTaskRepeat(normalizeTaskDeadline(normalized), previous);
  }
  const suppliedCaptions = z.object({customLinkText:z.record(z.string(), linkTextValueSchema.nullable()).optional()}).parse(input).customLinkText;
  const captions: NonNullable<Data['customLinkText']> = {...previous?.customLinkText};
  for(const [id,caption] of Object.entries(suppliedCaptions||{})){
    const p=properties.find(p=>p.id===id&&p.kind===kind&&!p.standardField&&!p.archivedAt);
    const old=previous?.customLinkText?.[id];
    if(!p&&old)continue;
    if(!p||p.type!=='url')throw new InputError('Link text requires an available URL property.');
    if(!p.allowCustomLinkText&&JSON.stringify(caption)!==JSON.stringify(old))throw new InputError(`Custom link text is disabled for ${p.label}.`);
    if(caption?.text){
      if(caption.url!==custom[id]&&JSON.stringify(caption)!==JSON.stringify(old))throw new InputError(`Link text must describe the current URL for ${p.label}.`);
      captions[id]=caption;
    }else delete captions[id];
  }
  for(const [id,caption] of Object.entries(captions))if(active.has(id)&&caption.url!==custom[id])delete captions[id];
  const result = retainRecordSource({ ...normalized, custom, ...(Object.keys(captions).length?{customLinkText:captions}:{}) }, previous);
  if (new TextEncoder().encode(JSON.stringify(result)).length > recordDataByteLimit)
    throw new InputError("This record is too large. Shorten long text properties; all record values together must fit within 800 KB.");
  return result;
}
export function matchesView(
  r: CRMRecord,
  all: CRMRecord[],
  config: ViewConfig,
  owner: string,
  properties: Property[] = [],
  timeZone?: string,
  activityContext: RecordConditionContext = emptyActivityContext,
) {
  return (
    (!["deals", "tickets", "leads"].includes(r.kind) ||
      !config.pipelineId ||
      ((r.kind === "leads" ? r.data.leadPipelineId : r.kind === "tickets" ? r.data.ticketPipelineId : r.data.pipelineId) || "default") === config.pipelineId) &&
    matchesTaskQueue(r, config.queueId) &&
    (!config.tagId || (r.kind === "deals" && !!r.tags?.some(tag => tag.id === config.tagId))) &&
    (!config.segmentConditions?.length || (activityContext.segmentMatchIds ? activityContext.segmentMatchIds.has(r.id) : matchesSegmentConditions(r.id,r.kind,config.segmentConditions,activityContext.segmentMembership))) &&
    matchesFilters(r, all, config.groups ?? [], properties, timeZone,activityContext.now,activityContext.fiscalStartMonth) &&
    matchesActivityCriteria(r.id, config.activityCriteria, activityContext) &&
    matchesAssociatedCriteria(r, all, config.associatedCriteria, properties, activityContext.associations, activityContext.relatedByRecord, timeZone,activityContext.now,activityContext.fiscalStartMonth) &&
    (r.kind !== "tasks" || !config.taskScope || config.taskScope === "all" ||
      matchesTaskScope(r, config.taskScope, localDay(activityContext.now || new Date(), timeZone), activityContext.now || new Date(), timeZone)) &&
    (!config.mine || matchesMemberOwner(r, owner, activityContext.actor)) &&
    (!config.filter ||
      [r.data.lifecycle, r.data.stage, r.data.status, r.data.ticketStatus, r.data.leadStage].includes(
        config.filter,
      )) &&
    (!config.propertyId ||
      propertyText(r.data.custom?.[config.propertyId])
        .toLowerCase()
        .includes(config.propertyValue.toLowerCase())) &&
    (config.query === "" ||
      [
        r.data.name,
        r.data.email,
        r.data.title,
        r.data.domain,
        r.data.website,
        r.data.owner,
        all.find((c) => c.id === r.data.companyId)?.data.name,
        ...Object.values(r.data.custom ?? {}).map(propertyText),
      ]
        .join(" ")
        .toLowerCase()
        .includes(config.query.toLowerCase()))
  );
}
