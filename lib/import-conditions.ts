import { z } from "zod";
import type { Kind } from "./crm";
import type { SegmentMembership } from "./segment-conditions";

export const importGroupsSchema = z.array(z.array(z.object({
  importId: z.string().regex(/^[a-f0-9]{64}$/, "Choose an import for each requirement."),
  mode: z.enum(["in", "not_in"]),
})).min(1, "Add an import requirement or remove the empty group.").max(10)).max(10);
export type ImportGroups = z.infer<typeof importGroupsSchema>;
// Import IDs are namespaced so they cannot collide with saved audiences.
export const importMembershipKey = (id: string) => `import:${id}`;
export function importReferences(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("importGroups" in value)) return [];
  return [...new Set(importGroupsSchema.parse(value.importGroups || []).flat().map(r => r.importId))];
}
export function validateImportGroups(groups: ImportGroups | undefined, kind: Kind, membership?: SegmentMembership) {
  if (!groups?.length) return;
  importGroupsSchema.parse(groups);
  for (const rule of groups.flat()) if (membership?.get(importMembershipKey(rule.importId))?.kind !== kind)
    throw Error("An import is unavailable, has no recorded membership, or belongs to another object. Choose an import for this object.");
}
export function matchesImportGroups(recordId: string, kind: Kind, groups: ImportGroups | undefined, membership?: SegmentMembership) {
  if (!groups?.length) return true;
  if (!membership) return false;
  validateImportGroups(groups, kind, membership);
  return groups.some(group => group.every(rule => membership.get(importMembershipKey(rule.importId))!.members.has(recordId) === (rule.mode === "in")));
}
