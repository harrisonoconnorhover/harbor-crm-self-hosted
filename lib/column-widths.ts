import { z } from "zod";
import {isTicketSlaField} from './ticket-sla-properties';

export type ColumnWidths = Record<string, number>;
export const MAX_COLUMN_WIDTH = 800;
export const minColumnWidth = (field: string) => field === "name" ? 180 : 100;
export function defaultColumnWidth(field: string) {
  if (isTicketSlaField(field)) return 340;
  if (field === "name") return 240;
  if (field === "email") return 260;
  if (["company", "contact"].includes(field)) return 220;
  if (["createdAt", "updatedAt", "lastContacted", "lastActivity"].includes(field)) return 210;
  return 180;
}
export function clampColumnWidth(field: string, width: number) {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(minColumnWidth(field), Math.round(Number.isFinite(width) ? width : defaultColumnWidth(field))));
}
export function columnWidth(field: string, widths: ColumnWidths) {
  return clampColumnWidth(field, Object.hasOwn(widths, field) ? widths[field] : defaultColumnWidth(field));
}
export function withColumnWidth(widths: ColumnWidths, field: string, width: number | null): ColumnWidths {
  const next = { ...widths };
  if (width === null || clampColumnWidth(field, width) === defaultColumnWidth(field)) delete next[field];
  else next[field] = clampColumnWidth(field, width);
  return next;
}
export const columnWidthsSchema = z.record(z.string().min(1).max(150), z.number().int().min(100).max(MAX_COLUMN_WIDTH))
  .refine(widths => Object.keys(widths).length <= 100 && (!Object.hasOwn(widths, "name") || widths.name >= 180), "Use valid column widths.")
  .prefault({});
