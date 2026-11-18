import {isTicketSlaField,plannedCloseSlaProperties} from '../ticket-sla-properties';
import {leadPipelineFor,leadStageOptions,moveLeadPipeline} from '../lead-pipelines';
import {formatWorkflowDate} from './format-date';
import {recordMemberOwner} from '../record-owner';
import {primaryField} from '../associations';
import type {TaskAssignee} from '../task-assignee';
import { taskTimeFields } from "../task-deadline";
import {isRecordSourceField} from '../record-source';
import {uniqueNumber} from '../unique-number';
import {isCurrentStageField,plannedStageValues} from '../current-stage';
import { isCommerceStep, prepareWorkflowDocument, type CommerceContext, type PlannedDocument } from "./commerce";
import { isDealRevenueField, retainDealRevenue } from "../deal-revenue";
import { ticketStageOptions, ticketPipelineFor, moveTicketPipeline } from "../ticket-pipelines";
import { ticketLifecycle } from "../ticket-lifecycle";
import { commerceTriggerSchema, type CommerceEvent, type CommercePayload } from "./commerce-events";
import type { Segment } from "../segments";
import type { Activity } from "../crm";
import { segmentConditionsSchema, type SegmentConditions } from "../segment-conditions";
import { activityCriteriaSchema, validateActivityCriteria, emptyActivityContext, type ActivityCriteria } from "../activity-conditions";
import { associatedCriteriaSchema, validateAssociatedCriteria, type AssociatedCriteria } from "../associated-conditions";
import { matchesWorkflowConditions, type RecordConditionContext } from "../record-conditions";
import { defaultActivityOptions, type ActivityOptions } from "../activity-options";
import {
  type DealStageSource,
  movePipeline,
  recordStages,
  allStageOptions,
} from "../forecast";
import {
  httpURLSchema,
  httpMethods,
  httpURL,
  prepareRequest,
  HttpError,
  type HttpCredential,
  type HttpRequest,
  type HttpResponse,
} from "./http";
import { z } from "zod";
import type { TaskQueue } from "../task-queues";
import {
  stages,
  kinds,
  taskTypes,
  type CRMRecord,
  type Data,
  type Kind,
} from "../crm";
import {
  groupsSchema,
  assertFiscalFilterContext,
  matchesFilters,
  readFilterValue,
  validateFilters,
  filterFields,
} from "../filters";
import {customTextLimit} from "../property-text";
import { customValue, parseRecord, type Property } from "../workspace";

const key = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,39}$/,
    "Use a letter, followed by letters, numbers, or underscores.",
  );
const binding = z.object({
  source: z.enum(["literal", "property", "output"]),
  value: z.string().max(2000),
  stepId: z.string().max(40).default(""),
});
const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid time zone, such as America/New_York.");
const taskDueSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("relative"),
    days: z.number().int().min(0).max(3650),
    timeZone: timeZoneSchema,
  }),
  z.object({ mode: z.literal("value"), binding }),
]);
export function taskDueDate(now: Date, days: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day") + days))
    .toISOString()
    .slice(0, 10);
}
const base = { id: key, name: z.string().trim().min(1).max(80) };
const commerceFields = {
 title: binding, sellerName: binding, sellerEmail: binding, sellerAddress: binding,
 days: z.number().int().min(1).max(3650), whenNoLines: z.enum(["skip", "fail"]),
};
const rotationTeamRef=z.object({id:z.string().guid("Invalid uuid"),label:z.string().max(100).optional()});
const leafStepSchema = z.discriminatedUnion("type", [
  z.object({...base,type:z.literal("formatDate"),binding,whenEmpty:z.enum(["fail","empty"]).default("fail"),format:z.discriminatedUnion("mode",[
    z.object({mode:z.literal("date"),amount:z.number().int().min(-3650).max(3650),unit:z.enum(["days","months","years"]),timeZone:timeZoneSchema}),
    z.object({mode:z.literal("datetime"),hours:z.number().int().min(-87600).max(87600)}),
  ])}),
  z.object({...base,type:z.literal("rotateOwner"),distribution:z.enum(["round_robin","load_balanced","random"]).default("round_robin"),members:z.array(z.object({id:z.string().min(1).max(200),label:z.string().max(100).optional()})).max(50).refine(v=>new Set(v.map(m=>m.id)).size===v.length,"Choose each member once."),team:rotationTeamRef.optional(),teams:z.array(rotationTeamRef).max(50).refine(v=>new Set(v.map(t=>t.id)).size===v.length,"Choose each team once.").optional(),availableOnly:z.boolean().optional(),capacityWaitMinutes:z.number().int().min(1).max(43200).optional(),overwrite:z.boolean().default(false),poolId:z.string().guid("Invalid uuid").optional()}),
  z.object({...base, ...commerceFields, type:z.literal("createQuoteDraft")}),
  z.object({...base, ...commerceFields, type:z.literal("createInvoiceDraft"), recurring:z.enum(["exclude","one_payment"])}),
  z.object({
    ...base,
    type: z.literal("delay"),
    minutes: z.number().int().min(1).max(525600),
  }),
  z.object({
    ...base,
    type: z.literal("code"),
    code: z.string().min(1).max(12000),
    outputAliases: z.record(key, key).refine(v => Object.keys(v).length <= 50,
      "A code action supports up to 50 copied output references.").optional(),
    inputs: z
      .array(z.object({ name: key, field: z.string().max(150) }))
      .max(20),
  }),
  z.object({
    ...base,
    type: z.literal("set"),
    field: z.string().min(1).max(150),
    binding: binding.extend({value:z.string().max(customTextLimit)}),
    executionValue: z.discriminatedUnion("mode",[
      z.object({mode:z.literal("date"),days:z.number().int().min(-3650).max(3650).default(0),timeZone:timeZoneSchema}),
      z.object({mode:z.literal("datetime"),hours:z.number().int().min(-87600).max(87600).default(0)}),
    ]).optional(),
    listOperation: z.enum(["append","replace","remove","clear"]).optional(),
    target: z.object({kind:z.enum(kinds),selection:z.enum(["all","primary","oldest","newest"]),label:z.string().trim().max(60).default(""),onlyIfEmpty:z.boolean().default(false)}).optional(),
    propertyCopy: z.object({kind:z.enum(kinds),selection:z.enum(["primary","oldest","newest"]),label:z.string().trim().max(60).default(""),field:z.string().min(1,"Choose a source property.").max(150),onlyIfEmpty:z.boolean().default(false),whenEmpty:z.enum(["skip","clear"]).default("skip")}).optional(),
    ownerAssignment: z.discriminatedUnion("mode", [
      z.object({mode:z.literal("associated"),kind:z.enum(kinds),selection:z.enum(["primary","oldest","newest"]),label:z.string().trim().max(60).default(""),onlyIfUnassigned:z.boolean().default(false)}),
      z.object({mode:z.literal("member"),id:z.string().min(1,"Choose a workspace member.").max(200),label:z.string().max(100).optional(),onlyIfUnassigned:z.boolean().default(false)}),
      z.object({mode:z.literal("clear")}),
    ]).optional(),
  }),
  z.object({ ...base, type: z.literal("note"), binding }),
  z.object({
    ...base,
    type: z.literal("http"),
    url: httpURLSchema,
    method: z.enum(httpMethods),
    credentialId: z.union([z.literal(""), z.string().guid("Invalid uuid")]).default(""),
    inputs: z.array(z.object({ name: key, binding })).max(20),
    sampleResponse: z
      .string()
      .max(32000)
      .refine((v) => {
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      }, "Enter valid sample response JSON."),
  }),
  z.object({ ...base, type: z.literal("condition"), groups: groupsSchema, activityCriteria: activityCriteriaSchema.optional(), associatedCriteria: associatedCriteriaSchema.optional(), segmentConditions: segmentConditionsSchema.optional() }),
  z.object({
    ...base,
    type: z.literal("task"),
    ...taskTimeFields,
    queueId: z.union([z.literal(""), z.string().guid("Invalid uuid")]).optional(),
    taskType: z.enum(taskTypes).default("To-do"),
    title: binding,
    owner: binding,
    useRecordOwner: z.boolean().optional(),
    assigneeId: z.string().min(1, "Choose a workspace member.").max(200).optional(),
    assigneeLabel: z.string().max(100).optional(),
    priority: z.enum(["Low", "Medium", "High"]),
    due: taskDueSchema,
  }),
]);
export type AssociatedChange = {before:CRMRecord;after:CRMRecord};
export const MAX_ASSOCIATED_EDITS = 100;
export type Binding = z.infer<typeof binding>;
export type BranchPath = {
  id: string;
  name: string;
  groups: z.infer<typeof groupsSchema>;
  activityCriteria?: ActivityCriteria; associatedCriteria?: AssociatedCriteria; segmentConditions?: SegmentConditions;
  steps: Step[];
};
export type Step =
  | z.infer<typeof leafStepSchema>
  | {
      id: string;
      name: string;
      type: "branch";
      paths: BranchPath[];
      otherwise: Step[];
    };
export const MAX_ACTIONS = 50;
export const MAX_BRANCH_DEPTH = 5;
// Bound the schema itself so invalid, deeply nested input never reaches the executor.
function buildStepSchema(
  depth: number,
): z.ZodType<Step> {
  if (depth === MAX_BRANCH_DEPTH) return leafStepSchema;
  const children = z.array(buildStepSchema(depth + 1)).max(MAX_ACTIONS);
  return z.discriminatedUnion("type", [
    ...leafStepSchema.options,
    z.object({
      ...base,
      type: z.literal("branch"),
      paths: z
        .array(
          z.object({
            ...base,
            groups: groupsSchema,
            activityCriteria: activityCriteriaSchema.optional(), associatedCriteria: associatedCriteriaSchema.optional(), segmentConditions: segmentConditionsSchema.optional(),
            steps: children,
          }).refine(p => p.groups.length > 0 || !!p.activityCriteria || !!p.associatedCriteria?.length || !!p.segmentConditions?.length, "Each branch path needs record, activity, association or segment conditions."),
        )
        .min(1)
        .max(20),
      otherwise: children,
    }),
  ]);
}
export const stepSchema = buildStepSchema(0);
export function flattenSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) =>
    s.type === "branch"
      ? [
          s,
          ...s.paths.flatMap((p) => flattenSteps(p.steps)),
          ...flattenSteps(s.otherwise),
        ]
      : [s],
  );
}
export function findCondition(
  steps: Step[],
  id: string,
): { groups: z.infer<typeof groupsSchema>; activityCriteria?: ActivityCriteria; associatedCriteria?: AssociatedCriteria; segmentConditions?: SegmentConditions } | undefined {
  for (const step of steps) {
    if (step.type === "condition" && step.id === id) return step;
    if (step.type === "branch") {
      for (const path of step.paths) {
        if (path.id === id) return path;
        const found = findCondition(path.steps, id);
        if (found) return found;
      }
      const found = findCondition(step.otherwise, id);
      if (found) return found;
    }
  }
}
export function updateCondition(
  steps: Step[],
  id: string,
  groups: z.infer<typeof groupsSchema>,
  activity: { activityCriteria?: ActivityCriteria; associatedCriteria?: AssociatedCriteria; segmentConditions?: SegmentConditions } = {},
): Step[] {
  return steps.map((s) =>
    s.type === "condition" && s.id === id
      ? { ...s, groups, ...activity }
      : s.type === "branch"
        ? {
            ...s,
            paths: s.paths.map((p) => ({
              ...p,
              groups: p.id === id ? groups : p.groups,
              ...(p.id === id ? activity : {}),
              steps: updateCondition(p.steps, id, groups, activity),
            })),
            otherwise: updateCondition(s.otherwise, id, groups, activity),
          }
        : s,
  );
}
export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(kinds),
  enabled: z.boolean().default(false),
  trigger: z.enum(["manual", "created", "updated", "activity", "segment", "commerce"]).default("manual"),
  commerceTrigger: commerceTriggerSchema.optional(),
  segmentTrigger: z.object({segmentId:z.string().guid("Choose a segment for this trigger."),event:z.enum(["joined","left"])}).optional(),
  enrollment: z.enum(["once", "when_matching", "every_event"]).optional(),
  reEnrollmentGroups: groupsSchema.unwrap().optional(),
  activityCriteria: activityCriteriaSchema.optional(), associatedCriteria: associatedCriteriaSchema.optional(), segmentConditions: segmentConditionsSchema.optional(),
  groups: groupsSchema,
  steps: z.array(stepSchema).min(1).max(MAX_ACTIONS),
}).superRefine((definition,context)=>{
  for(const step of flattenSteps(definition.steps))if(step.type==='rotateOwner'){
    if(step.capacityWaitMinutes!==undefined&&definition.kind!=='tickets')context.addIssue({code:'custom',path:['steps'],message:'Waiting for ticket capacity is available in ticket workflows only.'});
    if(step.distribution==='random'&&!['tickets','leads'].includes(definition.kind))context.addIssue({code:'custom',path:['steps'],message:'Random assignment is available in ticket and lead workflows.'});
    if(step.availableOnly&&!['tickets','leads'].includes(definition.kind))context.addIssue({code:'custom',path:['steps'],message:'Available-only assignment is available in ticket and lead workflows.'});
    if(step.teams!==undefined){
      if(step.team||!step.teams.length&&!step.members.length)context.addIssue({code:'custom',path:['steps'],message:'Choose at least one user or team, without a separate single-team source.'});
      if(!['tickets','leads'].includes(definition.kind))context.addIssue({code:'custom',path:['steps'],message:'Combined users and teams are available in ticket and lead workflows.'});
    }else if(step.team?step.members.length!==0:step.members.length===0)context.addIssue({code:'custom',path:['steps'],message:'Choose either one team or at least one specific member for owner rotation.'});
  }
});
export type Definition = z.infer<typeof workflowSchema>;
/** Evaluates repeat triggers only; initial enrollment conditions remain a separate gate. */
export function matchesReEnrollment(
  def: Definition,
  before: CRMRecord,
  current: CRMRecord,
  records: CRMRecord[],
  properties: Property[],
  activityContext: RecordConditionContext = emptyActivityContext,
  previousActivityContext: RecordConditionContext = activityContext,
  previousRecordsSnapshot?: CRMRecord[],
) {
  assertFiscalFilterContext(def.reEnrollmentGroups || [], filterFields(current.kind, properties, undefined, activityContext.fiscalStartMonth));
  const previousRecords = (previousRecordsSnapshot || records).map((r) => (r.id === before.id ? before : r));
  // Preserve the original combined-condition transition for existing definitions.
  if (def.reEnrollmentGroups === undefined)
    return (
      !matchesWorkflowConditions(before, previousRecords, def, properties, previousActivityContext) &&
      matchesWorkflowConditions(current, records, def, properties, activityContext)
    );
  return def.reEnrollmentGroups.some((group) => {
    if (!matchesFilters(current, records, [group], properties, undefined, activityContext.now, activityContext.fiscalStartMonth)) return false;
    if (!matchesFilters(before, previousRecords, [group], properties, undefined, previousActivityContext.now, previousActivityContext.fiscalStartMonth))
      return true;
    // A configured "is known" rule also fires when its populated value changes.
    return group.some(
      (rule) =>
        rule.operator === "known" &&
        JSON.stringify(readFilterValue(before, rule.field, previousRecords)) !==
          JSON.stringify(readFilterValue(current, rule.field, records)),
    );
  });
}
export type Workflow = Definition & {
  id: string;
  revision: number;
  updatedAt: string;
};
export type Trace = {
  id: string;
  name: string;
  type: string;
  status: "succeeded" | "failed" | "skipped" | "running" | "waiting";
  external?: {
    state: "simulated" | "attempted" | "responded";
    method: string;
    url: string;
    status?: number;
    requestKey?: string;
  };
  inputs?: unknown;
  outputs?: unknown;
  logs?: string[];
  path?: string[];
  reason?: string;
  error?: string;
};
export type Continuation = {
  capacityWait?: {enteredAt:string;expiresAt:string};
  steps: Step[];
  path: string[];
  outputs: Record<string, Record<string, unknown>>;
  trace: Trace[];
};
export type Run = {
  capacityWait?: {enteredAt:string;expiresAt:string};
  recordEvent?: {id:string;trigger:"created"|"updated"|"activity";detectedAt:string};
  commerceEvent?: CommerceEvent;
  segmentEvent?: {id:string;epoch:string;segmentId:string;event:"joined"|"left";detectedAt:string};
  manualEnrollment?: boolean;
  id: string;
  workflowId: string;
  workflowName: string;
  revision: number;
  recordId: string;
  recordName: string;
  mode: "test" | "live";
  status: string;
  createdAt: string;
  trace: Trace[];
  before: Data;
  after: Data;
  error?: string | null;
  resumeAt?: string | null;
};
export type CodeResult = {
  outputFields: Record<string, unknown>;
  logs: string[];
};
export type CodeRunner = (
  code: string,
  event: {
    inputFields: Record<string, unknown>;
    outputs: Record<string, unknown>;
  },
) => Promise<CodeResult>;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
export function workflowFields(kind: Kind, properties: Property[], source: DealStageSource = stages, fiscalStartMonth?:number) {
  return filterFields(kind, properties, source, fiscalStartMonth).filter(
    (f) => !["company", "contact", "related"].includes(f.id),
  );
}
export function dateFormatSourceFields(kind:Kind,properties:Property[],source:DealStageSource,mode:'date'|'datetime'){
 return workflowFields(kind,properties,source).filter(f=>mode==='date'?['date','datetime'].includes(f.type):f.type==='datetime'||['createdAt','updatedAt','lastContacted','lastActivity','closedAt'].includes(f.id));
}
export function writableFields(kind: Kind, properties: Property[], source: DealStageSource = stages, includeLists = false) {
  return workflowFields(kind, properties, source).filter(
    (f) => !isRecordSourceField(f.id) && !isCurrentStageField(f.id) && !isTicketSlaField(f.id) && !isDealRevenueField(f.id) && (includeLists || f.type !== "multiselect") && !["timeToCloseHours", "closedAt", "createdAt", "updatedAt", "lastContacted", "lastActivity"].includes(f.id),
  );
}
// Copy stored properties only. Activity/history-derived fields require their own
// source snapshots; do not expose them as silently empty copy sources.
export function copySourceFields(kind:Kind,properties:Property[],catalog:DealStageSource,target:ReturnType<typeof workflowFields>[number]|undefined){
  return workflowFields(kind,properties,catalog).filter(f=>f.id!=="owner"&&!isCurrentStageField(f.id) && !isTicketSlaField(f.id)&&!["lastContacted","lastActivity"].includes(f.id)&&!!target&&(f.type===target.type || target.type==="text"&&["text","email","url","select","number"].includes(f.type)));
}
export const emptyPropertyValue=(value:unknown)=>value===undefined||value===null||value===""||Array.isArray(value)&&value.length===0;
export function readField(record: CRMRecord, field: string): unknown {
  if (isTicketSlaField(field) || isCurrentStageField(field) || field === "timeToCloseHours" || isDealRevenueField(field)) return readFilterValue(record,field,[]);
  if(field==='leadPipelineId')return record.data.leadPipelineId||'default';
  if (field === "ticketPipelineId") return record.data.ticketPipelineId || "default";
  if (field === "pipelineId") return record.data.pipelineId || "default";
  if (field.startsWith("custom:")) return record.data.custom?.[field.slice(7)];
  if (["createdAt", "updatedAt", "lastContacted", "lastActivity"].includes(field))
    return record[field as "createdAt"];
  return record.data[field as keyof Data];
}
export function validateWorkflow(
  def: Definition,
  properties: Property[],
  queues: TaskQueue[] = [],
  credentials: HttpCredential[] = [],
  dealStages: DealStageSource = stages,
  activityOptions: ActivityOptions = defaultActivityOptions,
  fiscalStartMonth?:number,
) {
  if (def.trigger === "segment" && !def.segmentTrigger) throw new Error("Choose a segment and membership event.");
  if (def.trigger === "segment" && def.enrollment === "when_matching") throw new Error("For segment events, choose once or every matching event for re-enrollment.");

  if (def.trigger === "commerce" && (def.kind !== "deals" || !def.commerceTrigger)) throw new Error("Commerce events require a deal workflow and a document event.");
  if (def.trigger === "commerce" && def.enrollment === "when_matching") throw new Error("Commerce events support once or every matching event.");
  workflowSchema.parse(def);
  validateActivityCriteria(def.activityCriteria, activityOptions,fiscalStartMonth);
  validateAssociatedCriteria(def.associatedCriteria, properties, dealStages,fiscalStartMonth);
  validateFilters(def.groups, def.kind, properties, dealStages, fiscalStartMonth);
  if (def.reEnrollmentGroups !== undefined)
    validateFilters(def.reEnrollmentGroups, def.kind, properties, dealStages, fiscalStartMonth);
  if (flattenSteps(def.steps).length > MAX_ACTIONS)
    throw new Error(
      `A workflow can contain up to ${MAX_ACTIONS} actions across all paths.`,
    );
  const seen = new Set<string>();
  const fields = workflowFields(def.kind, properties, dealStages);
  function unique(id: string) {
    if (seen.has(id) || forbiddenKeys.has(id) || (def.trigger === "commerce" && id === "trigger"))
      throw new Error("Each action and branch path needs a unique ID.");
    seen.add(id);
  }
  function visit(steps: Step[], inherited: Set<string>) {
    const codeIds = new Set(inherited);
    for (const [index, step] of steps.entries()) {
      unique(step.id);
      if (step.type === "branch") {
        if (index !== steps.length - 1)
          throw new Error(
            "Add following actions inside a branch path. A branch must end its current path.",
          );
        for (const path of step.paths) {
          unique(path.id);
          validateFilters(path.groups, def.kind, properties, dealStages, fiscalStartMonth);
          validateActivityCriteria(path.activityCriteria, activityOptions,fiscalStartMonth);
          validateAssociatedCriteria(path.associatedCriteria, properties, dealStages,fiscalStartMonth);
          visit(path.steps, codeIds);
        }
        visit(step.otherwise, codeIds);
      } else if (step.type === "code") {
        for (const [alias, producer] of Object.entries(step.outputAliases || {})) {
          if (forbiddenKeys.has(alias) || !codeIds.has(producer))
            throw new Error(`Copied output reference in "${step.name}" needs an earlier action with outputs on this path.`);
        }
        const names = new Set<string>();
        for (const input of step.inputs) {
          if (
            !fields.some((f) => f.id === input.field) ||
            names.has(input.name) ||
            forbiddenKeys.has(input.name)
          )
            throw new Error(
              "Code inputs need unique names and available properties.",
            );
          names.add(input.name);
        }
        codeIds.add(step.id);
      } else if (step.type === "delay" || step.type === "rotateOwner") {
        if(step.type === "rotateOwner" && step.distribution === "load_balanced" && !["tickets","leads"].includes(def.kind)) throw new Error("Load-balanced assignment is only available in ticket and lead workflows.");
        // Duration and distribution are validated by the action schema.
      } else if (step.type === "condition") {
        validateFilters(step.groups, def.kind, properties, dealStages, fiscalStartMonth);
        validateActivityCriteria(step.activityCriteria, activityOptions,fiscalStartMonth);
        validateAssociatedCriteria(step.associatedCriteria, properties, dealStages,fiscalStartMonth);
      }
      else {
        if(step.type === "formatDate"){
          if(step.binding.source==="property"){
            const source=dateFormatSourceFields(def.kind,properties,dealStages,step.format.mode).find(f=>f.id===step.binding.value);
            if(!source)throw Error("Choose a compatible date or date/time source property.");
          }
          if(step.binding.source==="literal")formatWorkflowDate(step.binding.value,step.format,step.whenEmpty);
        }
        if(step.type === "set" && step.target?.selection === "primary" && !primaryField({kind:def.kind} as CRMRecord,{kind:step.target.kind} as CRMRecord))throw Error("This object has no primary association to the target object. Choose all, oldest or newest instead.");
        if(step.type === "set" && step.executionValue){
          const field=writableFields(step.target?.kind||def.kind,properties,dealStages).find(f=>f.id===step.field);
          if(field?.type!==step.executionValue.mode)throw Error("Choose a writable date or date/time property matching this execution value.");
          if(step.propertyCopy||step.ownerAssignment||step.listOperation)throw Error("Choose one value source for this date action.");
        }
        if(step.type === "set" && step.listOperation){
          const property=properties.find(p=>p.kind===(step.target?.kind||def.kind)&&step.field==="custom:"+p.id&&p.type==="multiselect");
          if(!property)throw Error("List operations require a multi-select destination property.");
          if(step.binding.source==="literal"&&!step.propertyCopy&&step.listOperation!=="clear")customValue(property,step.binding.value,{skipRules:true});
        }
        if (step.type === "set" && step.ownerAssignment && step.field !== "owner") throw new Error("Member assignment is only available for the record owner property.");
        if (step.type === "set" && step.ownerAssignment?.mode === "associated" && step.ownerAssignment.selection === "primary" && !primaryField({kind:def.kind} as CRMRecord,{kind:step.ownerAssignment.kind} as CRMRecord)) throw new Error("This object has no primary association to the selected source object. Choose oldest or newest instead.");
        if(step.type === "set" && step.propertyCopy){
          const copy=step.propertyCopy,target=writableFields(step.target?.kind||def.kind,properties,dealStages,true).find(f=>f.id===step.field);
          if(step.ownerAssignment||step.field==="owner")throw Error("Use associated owner assignment to copy record owners.");
          if(copy.selection==="primary"&&!primaryField({kind:def.kind} as CRMRecord,{kind:copy.kind} as CRMRecord))throw Error("This object has no primary association to the source object. Choose oldest or newest instead.");
          if(!copySourceFields(copy.kind,properties,dealStages,target).some(f=>f.id===copy.field))throw Error("Choose an available source property with a compatible type.");
        }
        if (step.type === "task" && step.useRecordOwner && step.assigneeId !== undefined) throw new Error("Choose either the enrolled record owner or a specific workspace member.");
        if (isCommerceStep(step)) {
          if(def.kind!=="deals") throw new Error("Quote and invoice actions require a deal workflow.");
          if(step.sellerName.source==="literal"&&!step.sellerName.value.trim()) throw new Error("Enter a seller name for the draft.");
        }
        if (
          step.type === "set" &&
          !writableFields(step.target?.kind||def.kind, properties, dealStages,!!step.propertyCopy||!!step.target||!!step.listOperation).some((f) => f.id === step.field)
        )
          throw new Error("Choose a writable property for the action.");
        if (
          step.type === "set" &&
          step.field === "stage" && !step.propertyCopy &&
          step.binding.source === "literal" &&
          !allStageOptions(dealStages).includes(step.binding.value)
        )
          throw new Error("Choose an available deal stage for the action.");
        if(step.type==='set'&&!step.propertyCopy&&step.binding.source==='literal'&&
          (step.field==='leadStage'&&!leadStageOptions(dealStages).includes(step.binding.value)||step.field==='leadPipelineId'&&!leadPipelineFor(dealStages,step.binding.value)))throw Error('Choose an available lead pipeline or stage for the action.');
        if (step.type === "set" && !step.propertyCopy && step.binding.source === "literal" &&
          (step.field === "ticketStatus" && !ticketStageOptions(dealStages).includes(step.binding.value) || step.field === "ticketPipelineId" && !ticketPipelineFor(dealStages,step.binding.value)))
          throw new Error("Choose an available ticket pipeline or status for the action.");
        if (step.type === "set" && step.field === "pipelineId" && !step.propertyCopy && step.binding.source === "literal")
          recordStages(dealStages, step.binding.value);
        if (
          step.type === "task" &&
          step.queueId &&
          !queues.some((q) => q.id === step.queueId)
        )
          throw new Error(
            `Task queue for "${step.name}" is unavailable. Choose another queue or No queue.`,
          );
        if (step.type === "http") {
          if (
            step.credentialId &&
            !credentials.some(
              (c) =>
                c.id === step.credentialId &&
                c.origin === httpURL(step.url).origin,
            )
          )
            throw new Error(
              `HTTP credential for "${step.name}" is unavailable or restricted to another origin.`,
            );
          const names = new Set<string>();
          for (const input of step.inputs) {
            if (names.has(input.name) || forbiddenKeys.has(input.name))
              throw new Error("HTTP input names must be unique and valid.");
            names.add(input.name);
          }
        }
        const bindings =
          isCommerceStep(step) ? [step.title,step.sellerName,step.sellerEmail,step.sellerAddress] : step.type === "http"
            ? step.inputs.map((i) => i.binding)
            : step.type === "task"
              ? [
                  step.title,
                  ...(step.assigneeId === undefined && !step.useRecordOwner ? [step.owner] : []),
                  ...(step.due.mode === "value" ? [step.due.binding] : []),
                ]
              : step.type === "set" && (step.ownerAssignment || step.propertyCopy || step.executionValue || step.listOperation === "clear") ? [] : [step.binding];
        for (const value of bindings) {
          if (
            value.source === "output" &&
            (!codeIds.has(value.stepId) ||
              !key.safeParse(value.value).success ||
              forbiddenKeys.has(value.value))
          )
            throw new Error(
              "Choose a named output from an earlier action with outputs on this path.",
            );
          if (
            value.source === "property" &&
            !fields.some((f) => f.id === value.value)
          )
            throw new Error("Choose an available source property.");
        }
        if (step.type === "http" || step.type === "formatDate" || isCommerceStep(step)) codeIds.add(step.id);
      }
    }
  }
  visit(def.steps, new Set(def.trigger === "commerce" ? ["trigger"] : []));
}

function resolveBinding(
  b: Binding,
  record: CRMRecord,
  outputs: Record<string, Record<string, unknown>>,
) {
  if (b.source === "literal") return b.value;
  if (b.source === "property") return readField(record, b.value);
  const value = outputs[b.stepId];
  if (!value || !Object.hasOwn(value, b.value))
    throw new Error(`Output ${b.stepId}.${b.value} was not returned.`);
  return value[b.value];
}
function setField(
  record: CRMRecord,
  field: string,
  value: unknown,
  properties: Property[],
  dealStages: DealStageSource,
  now: Date,
  includeLists = false,
  listOperation?: Extract<Step,{type:"set"}>["listOperation"],
): Data {
  const info = writableFields(record.kind, properties, dealStages,includeLists).find(
    (f) => f.id === field,
  );
  if (!info) throw new Error("This property is not writable.");
  if(info.type === "multiselect" && listOperation && listOperation !== "replace"){
    const property=properties.find(p=>field==="custom:"+p.id&&p.kind===record.kind)!;
    const incoming=(listOperation==="clear"?[]:customValue(property,value,{skipRules:true})||[]) as string[];
    const existing=(customValue(property,readField(record,field),{skipRules:true})||[]) as string[];
    value=listOperation==="clear"?[]:listOperation==="append"?[...new Set([...existing,...incoming])]:existing.filter(option=>!incoming.includes(option));
  }
  if (value === undefined || value === null) value = "";
  if (info.type === "number" && value !== "") {
    if (typeof value !== "number" && typeof value !== "string")
      throw new Error("Expected a numeric output.");
    value = field.startsWith('custom:')&&properties.some(p=>p.id===field.slice(7)&&p.uniqueValues)?uniqueNumber(value):Number(value);
  }
  if (
    info.type === "checkbox" &&
    typeof value === "string" &&
    ["true", "false"].includes(value)
  )
    value = value === "true";
  const data = field.startsWith("custom:")
    ? {
        ...record.data,
        custom: { ...record.data.custom, [field.slice(7)]: value },
      }
    : field === "leadPipelineId" ? moveLeadPipeline(record.data,String(value),dealStages) : field === "ticketPipelineId" ? moveTicketPipeline(record.data,String(value),dealStages) : field === "pipelineId"
      ? movePipeline(record.data, String(value), dealStages)
      : { ...record.data, [field]: value };
  return retainDealRevenue(ticketLifecycle(parseRecord(record.kind, data, properties, dealStages, record.data, {skipValidationRules:true}), record.data, now.toISOString(), dealStages), record.data);
}
export async function planWorkflow(
  def: Definition,
  record: CRMRecord,
  all: CRMRecord[],
  properties: Property[],
  execute: CodeRunner,
  now = new Date(),
  queues: TaskQueue[] = [],
  credentials: HttpCredential[] = [],
  http?: {
    execute: (
      step: Extract<Step, { type: "http" }>,
      data: Record<string, unknown>,
      beforeSend: (requestKey: string) => Promise<void>,
    ) => Promise<HttpResponse>;
    checkpoint: (trace: Trace[]) => Promise<void>;
  },
  timing?: {
    suspend: boolean;
    commercePayload?: CommercePayload;
    skipEnrollmentConditions?: boolean;
    checkEnrollmentGroups?: boolean;
    continuation?: Continuation;
    clock?: () => Date;
  },
  dealStages: DealStageSource = stages,
  activityContext: RecordConditionContext = emptyActivityContext,
  activeSegments: Pick<Segment, "id" | "kind" | "criteria">[] = [],
  commerce?: CommerceContext,
  resolveAssignee?: (id: string, workspaceId?: string) => Promise<TaskAssignee>,
  previewRotation?: (step:Extract<Step,{type:"rotateOwner"}>,record:CRMRecord) => Promise<TaskAssignee|{allAway:true}|{allAtCapacity:true}|undefined>,
  resolveAssociatedOwner?: (record:CRMRecord,selection:Extract<NonNullable<Extract<Step,{type:"set"}>["ownerAssignment"]>,{mode:"associated"}>,staged?:ReadonlyMap<string,CRMRecord>) => Promise<{member?:TaskAssignee;recordId?:string;recordName?:string;reason?:string}>,
  resolveAssociatedRecord?: (record:CRMRecord,selection:NonNullable<Extract<Step,{type:"set"}>["propertyCopy"]>) => Promise<CRMRecord|undefined>,
  resolveAssociatedTargets?: (record:CRMRecord,selection:NonNullable<Extract<Step,{type:"set"}>["target"]>) => Promise<CRMRecord[]>,
) {
  validateWorkflow(def, properties, queues, credentials, dealStages, activityContext.options, activityContext.fiscalStartMonth);
  const documents: PlannedDocument[] = [];
  const associatedChanges=new Map<string,AssociatedChange>();
  const original = structuredClone(record.data);
  let current = { ...record, data: structuredClone(record.data) };
  const trace: Trace[] = structuredClone(timing?.continuation?.trace || []).map(
      (t) =>
        t.status === "waiting"
          ? {
              ...t,
              status: "succeeded" as const,
              reason: `Resumed at ${now.toISOString()}`,
            }
          : t,
    ),
    outputs: Record<string, Record<string, unknown>> = Object.assign(
      Object.create(null),
      ...(timing?.commercePayload ? [{ trigger: structuredClone(timing.commercePayload) }] : []),
      structuredClone(timing?.continuation?.outputs || {}),
    ),
    notes: string[] = [],
    tasks: {
      stepId: string;
      data: Data;
      queueId?: string;
      queueName?: string;
    }[] = [];
  if (
    record.kind !== def.kind ||
    (!timing?.continuation && (timing?.checkEnrollmentGroups
      ? !matchesWorkflowConditions(record, all, {groups:def.groups,activityCriteria:def.activityCriteria,associatedCriteria:def.associatedCriteria}, properties, activityContext)
      : !timing?.skipEnrollmentConditions && !matchesWorkflowConditions(record, all, def, properties, activityContext)))
  )
    return {
      status: "not_matched",
      trace,
      before: original,
      after: original,
      notes: [] as string[],
      tasks,
      documents,
      associatedChanges:[] as AssociatedChange[],
      error: null,
    };
  const stagedLogs: Activity[] = [], stagedTasks: CRMRecord[] = [];
  function conditionSnapshot() {
    const rows = [...all.map(r => r.id === current.id ? current : {...r,...associatedChanges.get(r.id)?.after}), ...stagedTasks];
    const context: RecordConditionContext = {
      ...activityContext,
      activities: [...activityContext.activities, ...stagedLogs],
      // A cached association index predates tasks created in this run.
      relatedByRecord: undefined,
      segmentMembership: new Map(activityContext.segmentMembership),
    };
    for (const segment of activeSegments) {
      if (segment.kind !== current.kind) continue;
      const previousMembership = context.segmentMembership!.get(segment.id);
      const members = new Set(previousMembership?.members);
      const excluded = previousMembership?.excluded;
      if (!excluded?.has(current.id) && matchesWorkflowConditions(current, rows, segment.criteria, properties, context)) members.add(current.id);
      else members.delete(current.id);
      context.segmentMembership!.set(segment.id, { kind: segment.kind, members, excluded });
    }
    return {rows, context};
  }
  let continuation: Continuation | null = null;
  let resumeAt: string | null = null;
  let outcome: { status: string; error: string | null } = {
    status: "succeeded",
    error: null,
  };
  function skip(steps: Step[], path: string[], reason: string) {
    for (const step of steps) {
      trace.push({
        id: step.id,
        name: step.name,
        type: step.type,
        status: "skipped",
        path,
        reason,
      });
      if (step.type === "branch") {
        for (const branch of step.paths)
          skip(branch.steps, [...path, branch.name], reason);
        skip(step.otherwise, [...path, "None met"], reason);
      }
    }
  }
  async function applySet(step:Extract<Step,{type:"set"}>,destination:CRMRecord,entry:Trace,actionAt=now){
    const before=step.target?(associatedChanges.get(destination.id)?.before||destination):record;
    if(step.target?.onlyIfEmpty&&!emptyPropertyValue(readField(destination,step.field))){entry.status="skipped";entry.reason="The destination already has a value; it was preserved.";return destination;}
    if(step.executionValue){
      const date=step.executionValue,value=date.mode==="date"?taskDueDate(actionAt,date.days,date.timeZone):new Date(actionAt.getTime()+date.hours*3600000).toISOString();
      destination={...destination,data:setField(destination,step.field,value,properties,dealStages,now),updatedAt:now.toISOString()};
      entry.inputs={evaluatedAt:actionAt.toISOString(),...date};entry.outputs={[step.field]:readField(destination,step.field)??null};return destination;
    }
    if(step.listOperation==="clear"){
      destination={...destination,data:setField(destination,step.field,[],properties,dealStages,now,true),updatedAt:now.toISOString()};
      entry.inputs={operation:"clear"};entry.outputs={[step.field]:null};return destination;
    }
    if(step.propertyCopy){
          const copy=step.propertyCopy;
          if(copy.onlyIfEmpty&&!emptyPropertyValue(readField(destination,step.field))){entry.status="skipped";entry.reason="The destination already has a value; it was preserved.";return destination;}
          if(!resolveAssociatedRecord)throw Error("Associated property selection is unavailable.");
          const selected=await resolveAssociatedRecord(current,copy);
          const source=selected?(associatedChanges.get(selected.id)?.after||selected):undefined;
          entry.inputs={sourceObject:copy.kind,sourceProperty:copy.field,sourceRecordId:source?.id||null,sourceRecordName:source?.data.name||null};
          if(!source){entry.status="skipped";entry.reason="No associated record matches this selection. The destination was preserved.";return destination;}
          let value=readField(source,copy.field),operation=step.listOperation;
          const target=writableFields(destination.kind,properties,dealStages,true).find(f=>f.id===step.field)!;
          if(emptyPropertyValue(value)){
            if(copy.whenEmpty==="skip"){entry.status="skipped";entry.reason="The source property is empty; the destination was preserved.";return destination;}
            value=target.type==="multiselect"?[]:target.type==="checkbox"?false:"";operation="replace";
          }else if(target.type==="text"&&typeof value==="number")value=String(value);
          else if(target.type==="date"&&typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value))value=value.slice(0,10);
          destination={...destination,data:setField(destination,step.field,value,properties,dealStages,now,true,operation),updatedAt:now.toISOString()};
          destination={...destination,...plannedStageValues(before,destination,now),...plannedCloseSlaProperties(before,destination,now,dealStages)};
          entry.outputs={[step.field]:readField(destination,step.field)??null};
    }else if(step.ownerAssignment){
          const assignment = step.ownerAssignment;
          if (assignment.mode !== "clear" && assignment.onlyIfUnassigned && destination.data.owner) {
            entry.status = "skipped";
            entry.reason = "The record already has an owner; ownership was preserved.";
            entry.outputs = {owner: destination.data.owner};
          } else {
            if (assignment.mode === "member" && !resolveAssignee) throw new Error("Member assignment is unavailable.");
            if (assignment.mode === "associated" && !resolveAssociatedOwner) throw new Error("Associated owner selection is unavailable.");
            const source = assignment.mode === "associated" ? await resolveAssociatedOwner!(current,assignment,new Map([...associatedChanges].map(([id,change])=>[id,change.after]))) : undefined;
            const member = assignment.mode === "member" ? await resolveAssignee!(assignment.id) : source?.member;
            if (source && !member) {entry.status="skipped";entry.reason=source.reason;entry.outputs={owner:destination.data.owner||"",sourceRecordId:source.recordId||null};return destination;}
            const data = setField(destination, "owner", member?.label || "", properties, dealStages, now);
            const identity = destination.kind === "tasks" ? "taskAssignee" : "recordOwner";
            delete data[identity];
            if (member) data[identity] = member;
            destination = {...destination, data, updatedAt:now.toISOString()};
            entry.inputs = {mode:assignment.mode, ...(member ? {memberId:member.userId} : {}),...(source?{sourceRecordId:source.recordId,sourceRecordName:source.recordName}:{})};
            entry.outputs = {owner:data.owner, [identity]:member || null};
          }
    }else{
      const value=resolveBinding(step.binding,current,outputs);
      entry.inputs={value:value??null};
      destination={...destination,data:setField(destination,step.field,value,properties,dealStages,now,!!step.target||!!step.listOperation,step.listOperation),updatedAt:now.toISOString()};
      destination={...destination,...plannedStageValues(before,destination,now),...plannedCloseSlaProperties(before,destination,now,dealStages)};
      entry.outputs={[step.field]:readField(destination,step.field)??null};
    }
    if(step.listOperation)entry.inputs={...(entry.inputs as Record<string,unknown>|undefined),operation:step.listOperation};
    return destination;
  }
  async function visit(steps: Step[], path: string[]) {
    for (const [index, step] of steps.entries()) {
      if (outcome.status !== "succeeded") {
        if (outcome.status === "waiting") return;
        skip(
          steps.slice(index),
          path,
          outcome.status === "failed"
            ? "An earlier action failed."
            : "A continuation condition stopped this run.",
        );
        return;
      }
      const entry: Trace = {
        id: step.id,
        name: step.name,
        type: step.type,
        status: "succeeded",
        path,
      };
      trace.push(entry);
      try {
        if (step.type === "branch") {
          const snapshot = conditionSnapshot();
          const selected = step.paths.findIndex((p) =>
            matchesWorkflowConditions(current, snapshot.rows, p, properties, snapshot.context),
          );
          entry.outputs = {
            path: selected < 0 ? "None met" : step.paths[selected].name,
            pathId: selected < 0 ? "otherwise" : step.paths[selected].id,
          };
          for (const [i, branch] of step.paths.entries()) {
            const nextPath = [...path, branch.name];
            if (i === selected) await visit(branch.steps, nextPath);
            else
              skip(
                branch.steps,
                nextPath,
                "A different branch path was selected.",
              );
          }
          if (selected < 0) await visit(step.otherwise, [...path, "None met"]);
          else
            skip(
              step.otherwise,
              [...path, "None met"],
              "A different branch path was selected.",
            );
        } else if (step.type === "rotateOwner") {
          if (timing?.suspend) {
            // Rotation commits separately so contention never replays earlier
            // HTTP requests or consumes a turn without its record assignment.
            entry.status="waiting";entry.reason="Waiting for owner rotation.";
            outcome={status:"waiting",error:null};resumeAt=now.toISOString();
            continuation={steps:steps.slice(index),path,outputs,trace};
          } else if (!step.overwrite && current.data.owner) {
            entry.status="skipped";entry.reason="The record already has an owner; ownership was preserved.";
          } else {
            if(!previewRotation)throw Error("Owner rotation preview is unavailable.");
            const member=await previewRotation(step,current);
            if(member&&('allAway' in member||'allAtCapacity' in member)){const identity=current.kind==='tasks'?'taskAssignee':'recordOwner';current={...current,data:{...current.data,owner:'',[identity]:undefined},updatedAt:now.toISOString()};entry.outputs={owner:'',memberId:null,...member,simulated:true};entry.reason='allAtCapacity' in member?'Preview only: all eligible users are at ticket capacity; ownership would become unassigned.':'Preview only: all eligible users are Away; ownership would become unassigned.';if('allAtCapacity' in member&&step.capacityWaitMinutes){entry.status='waiting';entry.outputs={owner:'',memberId:null,...member,simulated:true,capacityWaitMinutes:step.capacityWaitMinutes};entry.reason='Preview only: this action would wait for ticket capacity for up to '+step.capacityWaitMinutes+' minutes. Later actions are not simulated.';outcome={status:'stopped',error:null};}}
            else if(member){const identity=current.kind==='tasks'?'taskAssignee':'recordOwner';current={...current,data:{...current.data,owner:member.label,[identity]:member},updatedAt:now.toISOString()};entry.outputs={owner:member.label,memberId:member.userId,simulated:true};entry.reason=step.distribution==='random'?"Preview only: a random owner was sampled. Live assignment draws again; the rotation counter is unchanged.":"Preview only; the rotation counter is unchanged.";}
            else {entry.status="skipped";entry.reason=step.team||step.teams?"No selected user or primary team member is currently an active owner or editor. Ownership was preserved.":"No selected member is currently an active owner or editor. Ownership was preserved.";}
          }
        } else if (step.type === "delay") {
          const reached = timing?.suspend ? (timing.clock?.() ?? now) : now;
          const due = new Date(
            reached.getTime() + step.minutes * 60000,
          ).toISOString();
          entry.inputs = { minutes: step.minutes };
          entry.outputs = { resumeAt: due, simulated: !timing?.suspend };
          if (timing?.suspend) {
            entry.status = "waiting";
            outcome = { status: "waiting", error: null };
            resumeAt = due;
            continuation = {
              steps: steps.slice(index + 1),
              path,
              outputs,
              trace,
            };
          } else {
            entry.reason = "Delay simulated; no waiting or CRM changes.";
            now = new Date(due);
          }
        } else if (isCommerceStep(step)) {
          if(!commerce) throw new Error("Commerce source is unavailable. Reload and try again.");
          const prepared=await prepareWorkflowDocument(step,current,all,commerce,timing?.suspend?(timing.clock?.()??now):now,{
            title:resolveBinding(step.title,current,outputs),sellerName:resolveBinding(step.sellerName,current,outputs),
            sellerEmail:resolveBinding(step.sellerEmail,current,outputs),sellerAddress:resolveBinding(step.sellerAddress,current,outputs),
          });
          entry.inputs={lineRevision:commerce.revision};
          entry.outputs=prepared.outputs;
          outputs[step.id]=prepared.outputs;
          if(prepared.document){
            documents.push(prepared.document);
            entry.reason=commerce.preview?"Preview only; no draft will be saved.":"Draft prepared. It is saved when this action group commits; later HTTP actions cannot read it until then.";
          }else{entry.status="skipped";entry.reason="No eligible saved line items. No draft prepared.";}
        } else if (step.type === "formatDate") {
          const value=resolveBinding(step.binding,current,outputs);
          entry.inputs={value:value??null,...step.format,whenEmpty:step.whenEmpty};
          const formatted={value:formatWorkflowDate(value,step.format,step.whenEmpty)};
          entry.outputs=formatted;outputs[step.id]=formatted;
        } else if (step.type === "code") {
          const inputFields = Object.fromEntries(
            step.inputs.map((i) => [
              i.name,
              readField(current, i.field) ?? null,
            ]),
          );
          entry.inputs = inputFields;
          const codeOutputs = { ...outputs, ...Object.fromEntries(
            Object.entries(step.outputAliases || {}).map(([alias, producer]) => [alias, outputs[producer]]),
          ) };
          const result = await execute(step.code, { inputFields, outputs: codeOutputs });
          entry.outputs = result.outputFields;
          entry.logs = result.logs;
          outputs[step.id] = result.outputFields;
        } else if (step.type === "http") {
          const data = Object.fromEntries(
            step.inputs.map((i) => [
              i.name,
              resolveBinding(i.binding, current, outputs) ?? null,
            ]),
          );
          const prepared = prepareRequest({
            url: step.url,
            method: step.method,
            data,
            requestKey: "preview",
          } as HttpRequest);
          entry.inputs = {
            method: step.method,
            url: prepared.url,
            data,
            credential:
              credentials.find((c) => c.id === step.credentialId)?.name ||
              "None",
          };
          let response: HttpResponse;
          if (http) {
            response = await http.execute(step, data, async (requestKey) => {
              entry.status = "running";
              entry.external = {
                state: "attempted",
                method: step.method,
                url: prepared.url,
                requestKey,
              };
              await http.checkpoint(trace);
            });
            entry.external = {
              ...entry.external!,
              state: "responded",
              status: response.status,
            };
          } else {
            response = { status: 200, body: JSON.parse(step.sampleResponse) };
            entry.external = {
              state: "simulated",
              method: step.method,
              url: prepared.url,
            };
          }
          entry.status = "succeeded";
          entry.outputs = response;
          outputs[step.id] = { ...response };
          if (http) await http.checkpoint(trace);
        } else if (step.type === "task") {
          let assignment: TaskAssignee | undefined;
          if (step.useRecordOwner) {
            const owner = recordMemberOwner(current);
            if (!owner) throw new Error("The enrolled record has no verified member owner. Assign a workspace member on the record before enrolling again.");
            if (!resolveAssignee) throw new Error("Member assignment is unavailable.");
            assignment = await resolveAssignee(owner.userId, owner.workspaceId);
          } else if (step.assigneeId !== undefined) {
            if (!resolveAssignee) throw new Error("Choose an active workspace member before running.");
            assignment = await resolveAssignee(step.assigneeId);
          }
          const name = resolveBinding(step.title, current, outputs),
            owner = assignment?.label ?? resolveBinding(step.owner, current, outputs);
          const dueDate =
            step.due.mode === "none"
              ? ""
              : step.due.mode === "relative"
                ? taskDueDate(now, step.due.days, step.due.timeZone)
                : resolveBinding(step.due.binding, current, outputs);
          entry.inputs = {
            name,
            owner,
            taskType: step.taskType,
            priority: step.priority,
            dueDate,
            ...(step.dueTime ? { dueTime: step.dueTime, dueTimeZone: step.dueTimeZone, dueTimeOccurrence: step.dueTimeOccurrence } : {}),
          };
          const data = parseRecord(
            "tasks",
            {
              name,
              owner,
              taskType: step.taskType,
              priority: step.priority,
              dueDate,
              ...(dueDate && step.dueTime ? { dueTime: step.dueTime, dueTimeZone: step.dueTimeZone, dueTimeOccurrence: step.dueTimeOccurrence } : {}),
              status: "Not started",
              relatedId: current.id,
            },
            properties,
          );
          if (assignment) data.taskAssignee = assignment;
          const queue = queues.find((q) => q.id === step.queueId);
          const membership = queue
            ? { queueId: queue.id, queueName: queue.name }
            : {};
          tasks.push({ stepId: step.id, data, ...membership });
          stagedTasks.push({
            id: `pending-task:${step.id}`, kind: "tasks", data,
            queueId: queue?.id, createdAt: now.toISOString(), updatedAt: now.toISOString(),
          });
          current = { ...current, updatedAt: now.toISOString() };
          entry.outputs = { task: data, ...membership };
        } else if (step.type === "condition") {
          const snapshot = conditionSnapshot();
          const matched = matchesWorkflowConditions(current, snapshot.rows, step, properties, snapshot.context);
          entry.outputs = { matched };
          if (!matched) {
            entry.status = "skipped";
            entry.reason = "Continuation conditions were not met.";
            outcome = { status: "stopped", error: null };
          }
        } else if(step.type === "set"){
          const actionAt=step.executionValue?(timing?.clock?.()??now):now;
          if(!step.target)current=await applySet(step,current,entry,actionAt);
          else{
            if(!resolveAssociatedTargets)throw Error("Associated target selection is unavailable.");
            const targets=await resolveAssociatedTargets(current,step.target);
            if(new Set([...associatedChanges.keys(),...targets.map(r=>r.id)]).size>MAX_ASSOCIATED_EDITS)throw Error("A workflow segment can edit up to 100 associated records. Narrow the association selection.");
            const results=[];
            for(const selected of targets){
              const destination=associatedChanges.get(selected.id)?.after||selected,detail:Trace={id:step.id,name:step.name,type:step.type,status:"succeeded"};
              const after=await applySet(step,destination,detail,actionAt),changed=JSON.stringify(destination.data)!==JSON.stringify(after.data);
              if(changed)associatedChanges.set(selected.id,{before:associatedChanges.get(selected.id)?.before||selected,after});
              results.push({recordId:selected.id,recordName:selected.data.name,status:detail.status,changed,value:readField(after,step.field)??null,...(detail.reason?{reason:detail.reason}:{})});
            }
            entry.inputs={targetObject:step.target.kind,selection:step.target.selection,label:step.target.label,field:step.field,...(step.listOperation?{operation:step.listOperation}:{}),...(step.executionValue?{evaluatedAt:actionAt.toISOString(),...step.executionValue}:{})};
            entry.outputs={matched:targets.length,changed:results.filter(r=>r.changed).length,records:results};
            if(!targets.length){entry.status="skipped";entry.reason="No associated records match this target selection.";}
          }
        } else {
          const value = resolveBinding(step.binding, current, outputs);
          entry.inputs = { value: value ?? null };
          {
            if (
              typeof value !== "string" ||
              !value.trim() ||
              value.length > 10000
            )
              throw new Error("A note must contain 1–10,000 characters.");
            notes.push(value);
            stagedLogs.push({
              id: `pending-note:${step.id}`, recordId: current.id, type: "Note", body: value,
              createdAt: now.toISOString(), occurredAt: now.toISOString(),
            });
            current = {
              ...current, updatedAt: now.toISOString(),
              lastActivity: !current.lastActivity || Date.parse(current.lastActivity) < now.getTime()
                ? now.toISOString() : current.lastActivity,
            };
            entry.outputs = { note: value };
          }
        }
      } catch (e) {
        entry.status = "failed";
        if (e instanceof HttpError && entry.external && e.status)
          entry.external = {
            ...entry.external,
            state: "responded",
            status: e.status,
          };
        entry.error = e instanceof Error ? e.message : String(e);
        outcome = { status: "failed", error: entry.error };
      }
    }
  }
  await visit(
    timing?.continuation?.steps ?? def.steps,
    timing?.continuation?.path ?? [],
  );
  return {
    status: outcome.status,
    trace,
    before: original,
    after: outcome.status === "failed" ? original : current.data,
    notes: outcome.status === "failed" ? [] : notes,
    tasks: outcome.status === "failed" ? [] : tasks,
    documents: outcome.status === "failed" ? [] : documents,
    associatedChanges:outcome.status === "failed" ? [] : [...associatedChanges.values()],
    error: outcome.error,
    continuation: continuation as Continuation | null,
    resumeAt: resumeAt as string | null,
  };
}

export const exampleCode = `// Inputs are mapped below. Return named values for later actions.\nconst email = String(event.inputFields.email || "").trim().toLowerCase();\nconsole.log("Normalized email");\nreturn { normalizedEmail: email, domain: email.split("@")[1] || "" };`;
