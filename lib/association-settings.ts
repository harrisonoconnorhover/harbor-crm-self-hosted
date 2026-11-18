import { z } from "zod";
import { kinds, type Kind } from "./crm";
import { groupsSchema } from "./filters";

export const associationTableSchema = z.object({
  query: z.string().max(200).default(""),
  label: z.string().max(66).refine(value => !value || value === "primary" || value.startsWith("label:"), "Choose an association label.").default(""),
  columns: z.array(z.string().min(1).max(150)).max(100).nullable().default(null),
  sort: z.object({ field: z.string().min(1).max(150), direction: z.enum(["asc", "desc"]) }).prefault({ field: "name", direction: "asc" }),
  groups: groupsSchema,
});
export const associationSettingsSchema = z.object({
  kind: z.enum(kinds).nullable().default(null),
  tables: z.object({
    contacts: associationTableSchema.optional(), companies: associationTableSchema.optional(),
    deals: associationTableSchema.optional(), tasks: associationTableSchema.optional(), tickets: associationTableSchema.optional(), leads: associationTableSchema.optional(),
  }).prefault({}),
}).prefault({});
export type AssociationTableConfig = z.infer<typeof associationTableSchema>;
export type AssociationSettings = z.infer<typeof associationSettingsSchema>;
export const defaultAssociationColumns = (kind: Kind) => kind === "leads" ? ["name","leadStage","leadType","owner"] : kind === "tickets" ? ["name", "ticketStatus", "ticketPriority", "owner"] : ["name", kind === "contacts" ? "email" : kind === "companies" ? "domain" : kind === "deals" ? "amount" : "dueDate", kind === "deals" ? "stage" : kind === "tasks" ? "status" : "lifecycle", "owner"];
export const associationTableConfig = (settings: AssociationSettings, kind: Kind) => settings.tables[kind] ?? associationTableSchema.parse({});
export const associationPageKey = (config: AssociationTableConfig) => JSON.stringify([config.query, config.label, config.sort, config.groups]);
