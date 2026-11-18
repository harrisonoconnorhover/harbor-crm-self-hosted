import { z } from "zod";
import { kinds, type Kind } from "./crm";

export const recordOptionsInput = z.object({
  kind: z.enum(kinds).optional(),
  query: z.string().max(500).default("").transform(value => value.trim()),
  page: z.number().int().min(0).max(1_000_000).default(0),
  selectedId: z.string().max(150).default(""),
  excludeId: z.string().max(150).default(""),
});
export type RecordOption = { id: string; kind: Kind; name: string; detail: string };
export type RecordOptions = { results: RecordOption[]; total: number; page: number; size: number; selected: RecordOption | null };
export function recordOptions(rows: RecordOption[], input: z.infer<typeof recordOptionsInput>): RecordOptions {
  const allowed = rows.filter(r => r.id !== input.excludeId && (!input.kind || r.kind === input.kind));
  const needle = input.query.toLowerCase();
  const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
  const matches = allowed.filter(r => `${r.name} ${r.detail}`.toLowerCase().includes(needle))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const size = 25;
  const page = Math.min(input.page, Math.max(0, Math.ceil(matches.length / size) - 1));
  return { results: matches.slice(page * size, (page + 1) * size), total: matches.length, page, size,
    selected: allowed.find(r => r.id === input.selectedId) ?? null };
}
