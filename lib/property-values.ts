import { z } from "zod";

export const propertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string().max(80)).max(50), z.null()]);
export type CustomValue = string | number | boolean | string[];

// Multi-selects are sets. Copies and reordered selections must not create false
// stale-edit conflicts, import changes or property-history entries.
export function samePropertyValue(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) => Array.isArray(value)
    ? value.length ? JSON.stringify([...new Set(value)].sort()) : null
    : value ?? null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (Array.isArray(a) && a.length && !Array.isArray(b) || Array.isArray(b) && b.length && !Array.isArray(a)) return false;
    return normalize(a) === normalize(b);
  }
  return a === b;
}
