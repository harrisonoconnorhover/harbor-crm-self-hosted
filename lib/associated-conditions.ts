import { z } from "zod";
import { kinds, type CRMRecord } from "./crm";
import { directlyLinked, type Association } from "./associations";
import { assertFiscalFilterContext, filterFields, groupsSchema, matchesFilters, validateFilters } from "./filters";
import { stages } from "./crm";
import type { DealStageSource } from "./forecast";
import type { Property } from "./workspace";

export const associatedCriteriaSchema = z.array(z.object({
  kind: z.enum(kinds),
  mode: z.enum(["any", "none"]),
  groups: groupsSchema,
})).max(10);
export type AssociatedCriteria = z.infer<typeof associatedCriteriaSchema>;
export type RelatedByRecord = Map<string, CRMRecord[]>;

export function validateAssociatedCriteria(criteria: AssociatedCriteria | undefined, properties: Property[], pipeline: DealStageSource = stages, fiscalStartMonth?:number) {
  if (!criteria) return;
  associatedCriteriaSchema.parse(criteria);
  for (const requirement of criteria) validateFilters(requirement.groups, requirement.kind, properties, pipeline,fiscalStartMonth);
}

// Owner-scoped callers provide the authorized records and links. Resolve both
// endpoints, union legacy/explicit links, and exclude self/deleted endpoints.
export function relatedRecordsByRecord(records: CRMRecord[], associations: Association[]): RelatedByRecord {
  const byId = new Map(records.map(r => [r.id, r]));
  const neighbors = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      const ids = neighbors.get(from) || new Set<string>();
      ids.add(to); neighbors.set(from, ids);
    }
  };
  for (const link of associations) connect(link.recordA, link.recordB);
  for (const source of records) for (const field of ["companyId", "contactId", "relatedId"] as const) {
    const target = byId.get(String(source.data[field] || ""));
    if (target && directlyLinked(source, target)) connect(source.id, target.id);
  }
  return new Map([...neighbors].map(([id, ids]) => [id, [...ids].map(other => byId.get(other)!)]));
}

export function matchesAssociatedCriteria(record: CRMRecord, all: CRMRecord[], criteria: AssociatedCriteria | undefined, properties: Property[], associations: Association[] = [], related?: RelatedByRecord, timeZone?: string,now=new Date(),fiscalStartMonth?:number) {
  if (!criteria?.length) return true;
  for (const requirement of criteria) assertFiscalFilterContext(requirement.groups,filterFields(requirement.kind,properties,undefined,fiscalStartMonth));
  // A caller may supply the current record over an earlier context snapshot.
  const currentRecords = related ? all : all.map(r => r.id === record.id ? record : r);
  const neighbors = (related || relatedRecordsByRecord(currentRecords, associations)).get(record.id) || [];
  return criteria.every(requirement => {
    const found = neighbors.some(candidate => candidate.kind === requirement.kind && matchesFilters(candidate, currentRecords, requirement.groups, properties, timeZone,now,fiscalStartMonth));
    return requirement.mode === "any" ? found : !found;
  });
}
