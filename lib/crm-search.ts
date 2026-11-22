import { z } from "zod";
import { kinds, type Kind } from "./crm";

export const searchInput = z.object({
  query: z.string().max(500).transform(value => value.trim()),
  kind: z.enum(kinds).optional(),
  page: z.number().int().min(0).max(1_000_000).default(0),
});
export type SearchRow = { id: string; kind: Kind; data: Record<string, unknown> };
export type SearchResult = { id: string; kind: Kind; name: string; detail: string };
export type SearchPage = { results: SearchResult[]; total: number; page: number; size: number; counts: Record<Kind, number> };

export const portableSearchKinds = [...kinds, "custom-objects"] as const;
export type PortableSearchKind = typeof portableSearchKinds[number];
const searchCursor=z.object({
  direction:z.enum(["after","before"]), name:z.string().min(1).max(500).refine(name=>!name.includes("\0")),
  id:z.string().guid(),kind:z.enum(portableSearchKinds),objectId:z.string().guid().optional(),
}).strict().refine(cursor=>(cursor.kind==="custom-objects")===(cursor.objectId!==undefined));
export type PortableSearchCursor=z.infer<typeof searchCursor>;
export const portableSearchInput = searchInput.extend({kind: z.enum(portableSearchKinds).optional(),cursor:searchCursor.optional(),match:z.enum(["phrase","words"]).optional()});
export type PortableSearchResult = SearchResult | {id: string; kind: "custom-objects"; objectId: string; name: string; detail: string};
export type PortableSearchPage = Omit<SearchPage, "results" | "counts"> & {
  start:number; next:PortableSearchCursor|null; previous:PortableSearchCursor|null;
  results: PortableSearchResult[]; counts: Record<PortableSearchKind, number>;
};

function foldedSearchText(row: { data: Record<string, unknown> }) {
  const values: unknown[] = [];
  for (const value of Object.values(row.data)) {
    if (value == null) continue;
    if (typeof value === "object") {
      for (const item of Object.values(value)) if (item != null) values.push(item);
    } else values.push(value);
  }
  return values.join(" ").toLowerCase();
}

export function matchesSearchQuery(row: { data: Record<string, unknown> }, query: string) {
  return foldedSearchText(row).includes(query.toLowerCase());
}

// Preserve literal, case-insensitive property-value search, including custom values.
// Return only the fields needed to choose a record; opening it uses the detail flow.
export function searchRecords(rows: SearchRow[], input: z.infer<typeof searchInput>): SearchPage {
  const needle = input.query.toLowerCase();
  const counts = Object.fromEntries(kinds.map(kind => [kind, 0])) as Record<Kind, number>;
  const size = 8;
  if (!needle) return { results: [], total: 0, page: 0, size, counts };

  const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
  const compare = (a: SearchRow, b: SearchRow) =>
    collator.compare(String(a.data.name || ""), String(b.data.name || "")) || a.id.localeCompare(b.id);
  const firstPage = input.page === 0;
  const retained: SearchRow[] = [];
  let total = 0;
  for (const row of rows) {
    if (!foldedSearchText(row).includes(needle)) continue;
    if (Object.hasOwn(counts, row.kind)) counts[row.kind]++;
    if (input.kind && row.kind !== input.kind) continue;
    total++;
    if (!firstPage) {
      retained.push(row);
      continue;
    }
    // The first page needs exact counts but only its eight best matches.
    // Insert after equal entries to preserve stable sort behavior.
    if (retained.length === size && compare(row, retained[size - 1]) >= 0) continue;
    let start = 0;
    let end = retained.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (compare(row, retained[middle]) < 0) end = middle;
      else start = middle + 1;
    }
    retained.splice(start, 0, row);
    if (retained.length > size) retained.pop();
  }
  if (!firstPage) retained.sort(compare);
  const page = Math.min(input.page, Math.max(0, Math.ceil(total / size) - 1));
  return { total, page, size, counts, results: retained.slice(page * size, (page + 1) * size).map(row => ({
    id: row.id, kind: row.kind, name: String(row.data.name || "Untitled"),
    detail: String(row.data.email || row.data.domain || ""),
  })) };
}
