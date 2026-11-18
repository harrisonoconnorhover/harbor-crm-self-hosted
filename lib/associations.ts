import type { CRMRecord } from "./crm";

export type Association = {
  id: string;
  recordA: string;
  recordB: string;
  labels: string[];
  createdAt: string;
};
export type PrimaryField = "companyId" | "contactId" | "relatedId";
export function primaryField(
  source: CRMRecord,
  target: CRMRecord,
): PrimaryField | undefined {
  if (
    (source.kind === "contacts" || source.kind === "deals" || source.kind === "tickets" || source.kind === "leads") &&
    target.kind === "companies"
  )
    return "companyId";
  if ((source.kind === "deals" || source.kind === "tickets" || source.kind === "leads") && target.kind === "contacts") return "contactId";
  if (source.kind === "tasks") return "relatedId";
}
export function primaryLabel(field: PrimaryField) {
  return field === "companyId"
    ? "Primary company"
    : field === "contactId"
      ? "Primary contact"
      : "Primary related record";
}
export function associationPair(a: string, b: string) {
  return a < b ? ([a, b] as const) : ([b, a] as const);
}
export function directlyLinked(a: CRMRecord, b: CRMRecord) {
  const field = primaryField(a, b);
  return !!field && a.data[field] === b.id;
}

// Legacy primary links and explicit associations form one undirected relationship.
// Resolving through the supplied records also excludes deleted/missing endpoints.
export function associatedRecords(
  record: CRMRecord,
  records: CRMRecord[],
  associations: Association[],
) {
  const explicit = new Map<string, Association>();
  for (const link of associations) {
    if (link.recordA === record.id) explicit.set(link.recordB, link);
    else if (link.recordB === record.id) explicit.set(link.recordA, link);
  }
  return records
    .filter(
      (r) =>
        r.id !== record.id &&
        (explicit.has(r.id) ||
          directlyLinked(record, r) ||
          directlyLinked(r, record)),
    )
    .map((r) => ({
      record: r,
      labels: explicit.get(r.id)?.labels ?? [],
      primary: directlyLinked(record, r),
    }))
    .sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        a.record.data.name.localeCompare(b.record.data.name) ||
        a.record.id.localeCompare(b.record.id),
    );
}
