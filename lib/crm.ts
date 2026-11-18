import { taskRepeatSchema, type TaskRepeat } from "./task-repeat";
import { taskTimeFields } from "./task-deadline";
import type {RecordSourceData} from './record-source';
import type { DealRevenue } from "./deal-revenue";
import { z } from "zod";
import {offsetDateTime} from './iso-date-time';
import { extensionSchemas, type StandardData } from "./standard-properties";

export const leadStages = ['New','Attempting','Connected','Qualified','Disqualified'] as const;
export const ticketStatuses = ["New", "Waiting on contact", "Waiting on us", "Closed"] as const;
export const ticketPriorities = ["Low", "Medium", "High", "Urgent"] as const;
export const taskTypes = ["To-do", "Call", "Email"] as const;
export const kinds = ["contacts", "companies", "deals", "tasks", "tickets", "leads"] as const;
export type Kind = (typeof kinds)[number];
export const stages = [
  "Appointment scheduled",
  "Qualified to buy",
  "Presentation scheduled",
  "Decision maker bought-in",
  "Contract sent",
  "Closed won",
  "Closed lost",
] as const;
export const lifecycles = [
  "Subscriber",
  "Lead",
  "Marketing qualified lead",
  "Sales qualified lead",
  "Opportunity",
  "Customer",
  "Evangelist",
  "Other",
] as const;
// Both optional name parts allow 160 characters; an imported display name must
// retain both plus their separator, or a full email address, without truncation.
export const CONTACT_NAME_MAX = 321;
// A domain-only company import retains the entire existing domain field.
export const COMPANY_DOMAIN_MAX = 255;
export const COMPANY_NAME_MAX = COMPANY_DOMAIN_MAX;
const base = {
  name: z.string().trim().min(1, "Name is required").max(160),
  owner: z.string().trim().max(100).default(""),
  sample: z.boolean().optional(),
};
const link = z.string().max(100).default("");
const date = z
  .union([z.literal(""), z.string().date("Use a valid date")])
  .default("");
// Return the original address so paths, query strings and fragments survive edits/imports.
export function websiteHref(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? value : undefined;
  } catch { return undefined; }
}
export const schemas = {
  leads: z.object({...extensionSchemas.leads,...base,leadPipelineId:z.string().min(1).max(100).default('default'),leadStage:z.string().min(1).max(100).default('New'),companyId:link,contactId:link}),
  contacts: z.object({
    ...extensionSchemas.contacts,
    ...base,
    name: z.string().trim().min(1, "Name is required").max(CONTACT_NAME_MAX),
    email: z.union([z.literal(""), z.string().email()]).default(""),
    phone: z.string().max(60).default(""),
    title: z.string().max(160).default(""),
    companyId: link,
    lifecycle: z.enum(lifecycles).default("Lead"),
  }),
  companies: z.object({
    ...extensionSchemas.companies,
    ...base,
    name: z.string().trim().min(1, "Name is required").max(COMPANY_NAME_MAX),
    domain: z.string().trim().max(COMPANY_DOMAIN_MAX).default(""),
    website: z.string().trim().max(2048).refine(
      value => !value || !!websiteHref(value),
      "Use a full http:// or https:// website URL without login details.",
    ).default(""),
    industry: z.string().max(120).default(""),
    city: z.string().max(120).default(""),
    lifecycle: z.enum(lifecycles).default("Lead"),
  }),
  deals: z.object({
    ...extensionSchemas.deals,
    ...base,
    amount: z.number().finite().min(0).max(1e12).default(0),
    companyId: link,
    contactId: link,
    pipelineId: z.string().min(1).max(100).default("default"),
    stage: z.enum(stages).default(stages[0]),
    closeDate: date,
  }),
  tickets: z.object({
    ...extensionSchemas.tickets,
    ...base,
    closedAt: offsetDateTime.nullable().default(null),
    ticketPipelineId: z.string().min(1).max(100).default("default"),
    ticketStatus: z.string().min(1).max(100).default("New"),
    ticketPriority: z.enum(ticketPriorities).default("Medium"),
    companyId: link,
    contactId: link,
  }),
  tasks: z.object({
    ...extensionSchemas.tasks,
    ...base,
    taskType: z.enum(taskTypes).default("To-do"),
    dueDate: date,
    ...taskTimeFields,
    repeat: taskRepeatSchema.nullable().optional(),
    status: z.enum(["Not started", "Completed"]).default("Not started"),
    priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
    relatedId: link,
  }),
};
export type Data = RecordSourceData & StandardData & Partial<DealRevenue> & {
  name: string;
  owner: string;
  recordOwner?: import("./record-owner").RecordOwner;
  taskAssignee?: import("./task-assignee").TaskAssignee;
  sample?: boolean;
  custom?: Record<string, string | number | boolean | string[]>;
  customLinkText?: Record<string, import("./property-links").LinkTextValue>;
  email?: string;
  phone?: string;
  title?: string;
  companyId?: string;
  contactId?: string;
  lifecycle?: string;
  domain?: string;
  website?: string;
  industry?: string;
  city?: string;
  amount?: number;
  pipelineId?: string;
  stage?: string;
  closeDate?: string;
  dueDate?: string;
  dueTime?: string;
  dueTimeZone?: string;
  dueTimeOccurrence?: "" | "earlier" | "later";
  dueAt?: string;
  repeat?: TaskRepeat | null;
  repeatAnchorDate?: string;
  repeatAnchorTime?: string;
  repeatOccurrence?: "earlier" | "later";
  repeatDueAt?: string;
  status?: string;
  priority?: string;
  relatedId?: string;
  taskType?: (typeof taskTypes)[number];
  closedAt?: string | null;
  ticketPipelineId?: string;
  leadPipelineId?: string;
  leadStage?: string;
  ticketStatus?: string;
  ticketPriority?: (typeof ticketPriorities)[number];
};
export type CRMRecord = {
  closeSlaProperties?: import('./ticket-sla-properties').TicketSlaProperties;
  // Execution-only snapshots; ordinary record responses do not hydrate these.
  ticketSlaClocks?: {close:import('./ticket-sla-pause').SlaClock|null;firstResponse:import('./ticket-sla-pause').SlaClock|null};
  clonedFrom?: {id:string;name:string};
  stageHistoryReliable?: boolean;
  currentStageEnteredAt?: string | null;
  daysInCurrentStage?: number | null;
  tags?: import("./deal-tags").DealTagBadge[];
  queueId?: string | null;
  lastContacted?: string;
  lastActivity?: string;
  id: string;
  kind: Kind;
  data: Data;
  createdAt: string;
  updatedAt: string;
};
export type Activity = {
  connectedEmail?: "sent" | "received" | "inbox";
  connectedEmailURL?: string;
  recordIds?: string[];
  assignedTo?: string | null;
  outcome?: string | null;
  activityType?: string | null;
  durationSeconds?: number | null;
  direction?: string | null;
  createdById?: string | null;
  createdByName?: string | null;
  completedTaskId?: string | null;
  revision?: number;
  updatedAt?: string | null;
  occurredAt?: string | null;
  id: string;
  recordId: string;
  type: string;
  body: string;
  createdAt: string;
};
export function parseData(kind: Kind, input: unknown): Data {
  return schemas[kind].parse(input);
}
export function summarize(records: CRMRecord[], outcome: (record: CRMRecord) => "open" | "won" | "lost" = r => r.data.stage === "Closed won" ? "won" : r.data.stage === "Closed lost" ? "lost" : "open") {
  const deals = records.filter((r) => r.kind === "deals");
  const open = deals.filter(
    (r) => outcome(r) === "open",
  );
  return {
    contacts: records.filter((r) => r.kind === "contacts").length,
    openDeals: open.length,
    pipeline: open.reduce((s, r) => s + (r.data.amount || 0), 0),
    won: deals
      .filter((r) => outcome(r) === "won")
      .reduce((s, r) => s + (r.data.amount || 0), 0),
  };
}
export function csvCell(value: unknown) {
  if (typeof value === "string" && /^[=+@\-\t\r]/.test(value))
    value = "\'" + value;
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}
