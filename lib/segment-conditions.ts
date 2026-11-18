import { z } from "zod";
import type { Kind } from "./crm";

export const segmentConditionsSchema = z
  .array(
    z.object({
      segmentId: z
        .string()
        .guid("Choose a segment for each membership requirement."),
      mode: z.enum(["in", "not_in"]),
    }),
  )
  .max(10);
export const segmentGroupsSchema = z.array(segmentConditionsSchema.refine(g => g.length > 0, "Add a membership requirement or remove the empty group.")).max(10);
export type SegmentGroups = z.infer<typeof segmentGroupsSchema>;
export type SegmentConditions = z.infer<typeof segmentConditionsSchema>;
export type SegmentMembership = Map<
  string,
  { kind: Kind; members: ReadonlySet<string>; excluded?: ReadonlySet<string> }
>;
export function segmentReferences(value: unknown): string[] {
  const ids = new Set<string>();
  if (value && typeof value === "object" && "trigger" in value && value.trigger === "segment" && "segmentTrigger" in value) {
    const trigger = z.object({segmentId:z.string().guid("Invalid uuid")}).parse(value.segmentTrigger);
    ids.add(trigger.segmentId);
  }
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "segmentConditions" && Array.isArray(child))
        for (const requirement of segmentConditionsSchema.parse(child))
          ids.add(requirement.segmentId);
      else if (key === "segmentGroups" && Array.isArray(child))
        for (const group of segmentGroupsSchema.parse(child))
          for (const requirement of group) ids.add(requirement.segmentId);
      else if (key === "steps" || key === "paths" || key === "otherwise")
        visit(child);
    }
  }
  visit(value);
  return [...ids];
}
export function validateSegmentConditions(
  criteria: SegmentConditions | undefined,
  kind: Kind,
  membership: SegmentMembership = new Map(),
) {
  if (!criteria?.length) return;
  segmentConditionsSchema.parse(criteria);
  for (const requirement of criteria)
    if (membership.get(requirement.segmentId)?.kind !== kind)
      throw new Error(
        "A segment is unavailable or belongs to another object. Choose an existing segment for this object.",
      );
}
export function matchesSegmentConditions(
  recordId: string,
  kind: Kind,
  criteria: SegmentConditions | undefined,
  membership?: SegmentMembership,
) {
  if (!criteria?.length) return true;
  // Missing context must never turn a negative condition into a match.
  if (!membership) return false;
  validateSegmentConditions(criteria, kind, membership);
  return criteria.every(
    (c) =>
      membership.get(c.segmentId)!.members.has(recordId) === (c.mode === "in"),
  );
}

export function matchesSegmentGroups(recordId: string, kind: Kind, groups: SegmentGroups | undefined, membership?: SegmentMembership) {
  if (!groups?.length) return true;
  if (!membership) return false;
  // Validate all alternatives before short-circuiting: unavailable exclusions must fail closed.
  for (const group of groups) validateSegmentConditions(group, kind, membership);
  return groups.some(group => matchesSegmentConditions(recordId, kind, group, membership));
}

/** Dependencies first, static snapshots are leaves. Also used by workflow projections. */
export function orderedSegmentDefinitions<T extends {id: string; mode?: string; criteria: unknown}>(definitions: T[]): T[] {
  const byId = new Map(definitions.map(s => [s.id, s])), visiting = new Set<string>(), visited = new Set<string>(), ordered: T[] = [];
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Segments cannot depend on themselves or form a circular reference.");
    if (visited.has(id)) return;
    const segment = byId.get(id);
    if (!segment) throw new Error("A referenced segment is unavailable.");
    visiting.add(id);
    if (segment.mode !== "static") for (const dependency of segmentReferences(segment.criteria)) visit(dependency);
    visiting.delete(id); visited.add(id); ordered.push(segment);
  }
  for (const segment of definitions) visit(segment.id);
  return ordered;
}
