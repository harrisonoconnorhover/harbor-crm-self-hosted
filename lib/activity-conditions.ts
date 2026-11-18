import { z } from "zod";
import type { Activity } from "./crm";
import { defaultActivityOptions, type ActivityOptions } from "./activity-options";
import { reportFields } from "./reporting";
import { assertFiscalFilterContext, groupsSchema, matchesFilterGroups, validateFilterFields, type FilterField } from "./filters";
export const activityCriteriaSchema = z.object({ mode: z.enum(["any", "none"]), groups: groupsSchema });
export type ActivityCriteria = z.infer<typeof activityCriteriaSchema>;
export type ActivityContext = { activities: Activity[]; options: ActivityOptions; now?:Date; fiscalStartMonth?:number };
export const emptyActivityContext: ActivityContext = { activities: [], options: defaultActivityOptions };
export function activityConditionFields(options = defaultActivityOptions, fiscalStartMonth?:number): FilterField[] {
  const fields:FilterField[] = [...reportFields("activities", [], undefined, options).filter(f => !f.id.startsWith("record")), { id: "body", label: "Activity summary", type: "text" }];
  return fields.map(f => fiscalStartMonth !== undefined && (f.type==="date"||f.type==="datetime") ? {...f,fiscalStartMonth} : f);
}
export function validateActivityCriteria(criteria: ActivityCriteria | undefined, options = defaultActivityOptions, fiscalStartMonth?:number) {
  if (criteria) { activityCriteriaSchema.parse(criteria); validateFilterFields(criteria.groups, activityConditionFields(options,fiscalStartMonth)); }
}
export function matchesActivityCriteria(recordId: string, criteria: ActivityCriteria | undefined, context: ActivityContext = emptyActivityContext) {
  if (!criteria) return true;
  const fields = activityConditionFields(context.options,context.fiscalStartMonth);
  assertFiscalFilterContext(criteria.groups,fields);
  const found = context.activities.some(a => (a.recordIds||[a.recordId]).includes(recordId) && matchesFilterGroups(criteria.groups, fields,
    field => field === "occurredAt" ? a.occurredAt || a.createdAt : a[field as keyof Activity], "UTC",context.now));
  return criteria.mode === "any" ? found : !found;
}
