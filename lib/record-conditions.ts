import {isFiscalReportPeriod} from "./report-date-range";
import { matchesImportGroups, type ImportGroups } from "./import-conditions";
import { matchesSegmentGroups, type SegmentGroups, matchesSegmentConditions, type SegmentConditions, type SegmentMembership } from "./segment-conditions";
import type { CRMRecord } from "./crm";
import type { Property } from "./workspace";
import type { Association } from "./associations";
import { assertFiscalFilterContext, filterFields, matchesFilters, type FilterGroups } from "./filters";
import { matchesActivityCriteria, emptyActivityContext, activityConditionFields, type ActivityCriteria, type ActivityContext } from "./activity-conditions";
import { matchesAssociatedCriteria, type AssociatedCriteria, type RelatedByRecord } from "./associated-conditions";

export type RecordConditionContext = ActivityContext & { fiscalStartMonth?:number; actor?: {userId: string;workspaceId: string}; now?: Date; segmentMembership?: SegmentMembership; segmentMatchIds?: ReadonlySet<string>; associations?: Association[]; relatedByRecord?: RelatedByRecord };
export function matchesWorkflowConditions(record: CRMRecord, all: CRMRecord[], condition: { groups: FilterGroups; activityCriteria?: ActivityCriteria; associatedCriteria?: AssociatedCriteria; segmentConditions?: SegmentConditions; segmentGroups?: SegmentGroups; importGroups?: ImportGroups }, properties: Property[], context: RecordConditionContext = emptyActivityContext) {
  assertFiscalFilterContext(condition.groups, filterFields(record.kind, properties, undefined, context.fiscalStartMonth));
  assertFiscalFilterContext(condition.activityCriteria?.groups || [],activityConditionFields(context.options,context.fiscalStartMonth));
  for (const requirement of condition.associatedCriteria || []) assertFiscalFilterContext(requirement.groups,filterFields(requirement.kind,properties,undefined,context.fiscalStartMonth));
  return matchesSegmentConditions(record.id, record.kind, condition.segmentConditions, context.segmentMembership)
    && matchesSegmentGroups(record.id, record.kind, condition.segmentGroups, context.segmentMembership)
    && matchesImportGroups(record.id, record.kind, condition.importGroups, context.segmentMembership)
    && matchesFilters(record, all, condition.groups, properties,undefined,context.now,context.fiscalStartMonth)
    && matchesActivityCriteria(record.id, condition.activityCriteria, context)
    && matchesAssociatedCriteria(record, all, condition.associatedCriteria, properties, context.associations, context.relatedByRecord,undefined,context.now,context.fiscalStartMonth);
}


// Evaluate calendar dependence from the complete condition, including negative
// existence requirements, before a missing related record can short-circuit it.
export function conditionUsesFiscal(condition:{groups?:FilterGroups;activityCriteria?:ActivityCriteria;associatedCriteria?:AssociatedCriteria}){
 const groups=[condition.groups||[],condition.activityCriteria?.groups||[],...(condition.associatedCriteria||[]).map(r=>r.groups)];
 return groups.some(value=>value.some(group=>group.some(rule=>rule.operator==='relativeDate'&&isFiscalReportPeriod(rule.relativeDate?.period))));
}
