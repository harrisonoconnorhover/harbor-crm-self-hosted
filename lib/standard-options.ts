import { z } from "zod";
import type { Kind } from "./crm";
import type { Property } from "./workspace";
import { standardField } from "./standard-properties";
export const standardOptionsInput = z.object({
  kind: z.enum(["contacts", "companies", "deals", "tasks", "tickets", "leads"]), field: z.string().min(1).max(100),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(50)
    .refine(options => new Set(options.map(o => o.toLowerCase())).size === options.length, "Use unique option names."),
});
export function standardOptions(kind: Kind, id: string, properties: Property[]) {
  const field = standardField(kind, id, properties);
  if (!field || field.type !== "select") throw Error("Choose a configurable standard dropdown. Pipeline, lifecycle and task system choices are managed separately.");
  const setting = properties.find(p => p.kind === kind && p.standardField === id);
  return { kind, field: id, label: field.label, options: [...field.options!], revision: setting?.revision ?? 0 };
}
export function validateStandardOptions(input: z.infer<typeof standardOptionsInput>, properties: Property[]) {
  const current = standardOptions(input.kind, input.field, properties);
  if (current.options.some(option => !input.options.includes(option))) throw Error("Keep existing options unchanged. They may be used by records, saved views, reports or workflows. You can add and reorder choices.");
  return current;
}
