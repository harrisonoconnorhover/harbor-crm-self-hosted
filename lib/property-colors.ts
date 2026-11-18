import { z } from "zod";
import type { Kind } from "./crm";
import { filterFields, type FilterField } from "./filters";
import type { Property } from "./workspace";
import { stageColorsSchema, stageColorOptions, type StageColors } from "./stage-colors";

export type PropertyColorSetting = { kind: Kind; field: string; colors: StageColors; revision: number };
export const propertyColorInput = z.object({
  kind: z.enum(["contacts", "companies", "deals", "tasks", "tickets", "leads"]),
  field: z.string().min(1).max(150),
  colors: stageColorsSchema.refine(colors => Object.keys(colors).length <= 50, "Use up to 50 option colors."),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export function colorableFields(kind: Kind, properties: Property[]): FilterField[] {
  return filterFields(kind, properties).filter(f =>
    (f.type === "select" || f.type === "checkbox") && !["stage", "pipelineId"].includes(f.id));
}
export function propertyColorOptions(field: FilterField) {
  return (field.type === "checkbox" ? [true, false] : field.options ?? []).map(value => ({
    id: JSON.stringify(value), value,
    label: typeof value === "boolean" ? value ? "Yes" : "No" : field.optionLabels?.[value] ?? value,
  }));
}
export function validatePropertyColors(input: z.infer<typeof propertyColorInput>, properties: Property[]) {
  const field = colorableFields(input.kind, properties).find(f => f.id === input.field);
  if (!field) throw new Error("Choose an available dropdown or checkbox property. Stage colors are managed in Pipeline settings.");
  const ids = new Set(propertyColorOptions(field).map(o => o.id));
  if (Object.keys(input.colors).some(id => !ids.has(id))) throw new Error("A property option is unavailable. Reload properties before editing its colors.");
}
export function propertyColorHex(settings: PropertyColorSetting[], kind: Kind, field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const color = settings.find(s => s.kind === kind && s.field === field)?.colors[JSON.stringify(value)];
  return stageColorOptions.find(o => o.value === color)?.hex;
}
