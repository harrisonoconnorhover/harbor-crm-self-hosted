import { z } from "zod";
import { associationTableSchema } from "./association-settings";

export const boardAssociationSectionSchema = z.object({
  kind: z.enum(["companies", "contacts"]),
  label: associationTableSchema.shape.label.refine(value => value !== "label:", "Enter an association label."),
});
export const boardAssociationSectionsSchema = z.array(boardAssociationSectionSchema).max(2)
  .refine(sections => new Set(sections.map(s => s.kind)).size === sections.length, "Choose each association section only once.").default([]);
export type BoardAssociationSection = z.infer<typeof boardAssociationSectionSchema>;
export type BoardAssociationItem = { id: string; name: string; kind: BoardAssociationSection["kind"]; labels: string[]; primary: boolean };
export type BoardAssociationPage = { items: BoardAssociationItem[]; total: number; page: number; size: number; hasMore: boolean };
export type BoardAssociationSummary = Partial<Record<BoardAssociationSection["kind"], BoardAssociationPage>>;
export const boardAssociationInput = boardAssociationSectionSchema.extend({
  id: z.string().min(1).max(150),
  page: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export function boardAssociationFilterLabel(label: string) {
  return label === "primary" ? "Primary only" : label.startsWith("label:") ? label.slice(6) : "All associations";
}
