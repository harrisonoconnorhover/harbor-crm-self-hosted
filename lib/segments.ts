import { importGroupsSchema, validateImportGroups } from "./import-conditions";
import { segmentGroupsSchema, validateSegmentConditions } from "./segment-conditions";
import { z } from "zod";
import { groupsSchema, validateFilters } from "./filters";
import {
  activityCriteriaSchema,
  validateActivityCriteria,
} from "./activity-conditions";
import {
  associatedCriteriaSchema,
  validateAssociatedCriteria,
  relatedRecordsByRecord,
} from "./associated-conditions";
import {
  matchesWorkflowConditions,
  type RecordConditionContext,
} from "./record-conditions";
import type { CRMRecord, Kind } from "./crm";
import type { Property } from "./workspace";
import type { PipelineSettings } from "./forecast";

export const segmentCriteriaSchema = z.object({
  groups: groupsSchema,
  segmentGroups: segmentGroupsSchema.optional(),
  importGroups: importGroupsSchema.optional(),
  activityCriteria: activityCriteriaSchema.optional(),
  associatedCriteria: associatedCriteriaSchema.optional(),
});
export const segmentInput = z.object({
  id: z.string().guid("Invalid uuid"),
  revision: z.number().int().min(0),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  kind: z.enum(["contacts", "companies", "deals", "tasks", "tickets", "leads"]),
  mode: z.enum(["active", "static"]),
  criteria: segmentCriteriaSchema,
  startEmpty: z.boolean().default(false),
});
export type SegmentCriteria = z.infer<typeof segmentCriteriaSchema>;
export type Segment = Omit<z.infer<typeof segmentInput>, "startEmpty"> & {
  createdAt: string;
  updatedAt: string;
};
export type SegmentSummary = Omit<Segment, "criteria">;
export function matchingSegmentRecords(
  kind: Kind,
  criteria: SegmentCriteria,
  rows: CRMRecord[],
  properties: Property[],
  pipeline: PipelineSettings,
  context: RecordConditionContext,
) {
  validateImportGroups(criteria.importGroups, kind, context.segmentMembership);
  for (const group of criteria.segmentGroups || []) validateSegmentConditions(group, kind, context.segmentMembership);
  validateFilters(criteria.groups, kind, properties, pipeline, context.fiscalStartMonth);
  validateActivityCriteria(criteria.activityCriteria, context.options,context.fiscalStartMonth);
  validateAssociatedCriteria(criteria.associatedCriteria, properties, pipeline,context.fiscalStartMonth);
  const relatedByRecord = criteria.associatedCriteria?.length
    ? relatedRecordsByRecord(rows, context.associations || [])
    : undefined;
  const logs = new Map<string, typeof context.activities>();
  for (const log of context.activities) {
    const list = logs.get(log.recordId) || [];
    list.push(log);
    logs.set(log.recordId, list);
  }
  return rows.filter(
    (r) =>
      r.kind === kind &&
      matchesWorkflowConditions(r, rows, criteria, properties, {
        ...context,
        relatedByRecord,
        activities: logs.get(r.id) || [],
      }),
  );
}
