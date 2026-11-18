import {z} from 'zod';
import {datedActivityTypes} from './activity-date-policy';
import {dateOnly} from './quotes';

export const portableOutreachKinds=datedActivityTypes;
export const portableOutreachSummaryLimit=2000;
export const portableGmailSummaryLimit=10_000;
const uuid=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const activitySummary=z.string().trim().min(1).refine(value=>!value.includes(String.fromCharCode(0)));
const editable={
  occurredAt:z.number().int().positive().max(253402300799999),
  summary:activitySummary.refine(value=>value.length<=portableOutreachSummaryLimit),
};
export const portableOutreachWrite=z.object({id:uuid,kind:z.enum(portableOutreachKinds),...editable}).strict();
const revision=z.number().int().positive().max(2147483646);
const activityMutation=z.discriminatedUnion('action',[
  z.object({action:z.literal('update'),id:uuid,expectedRevision:revision,...editable,
    summary:activitySummary.refine(value=>value.length<=portableGmailSummaryLimit)}).strict(),
  z.object({action:z.literal('remove'),id:uuid,expectedRevision:revision}).strict(),
]);
export const portableLoggedActivityWrite=z.union([portableOutreachWrite,activityMutation]);
const activityScope={
  workspaceId:uuid.optional(),grantId:uuid.optional(),
  afterAt:z.coerce.number().int().positive().max(253402300799999).optional(),
  afterId:uuid.optional(),
};
const cursorPair=(value:{afterAt?:number;afterId?:string})=>(value.afterAt===undefined)===(value.afterId===undefined);
const contactHome={contactId:uuid,...activityScope};
const recordHome={kind:z.enum(['companies','deals']),recordId:uuid,...activityScope};
export const portableOutreachQuery=z.object(contactHome).strict().refine(cursorPair);
const recordActivityQuery=z.object(recordHome).strict().refine(cursorPair);
export const portableLoggedActivityQuery=z.union([portableOutreachQuery,recordActivityQuery]);

// Read-only list filters. Writes, removals and history keep the unfiltered scope.
export const portableActivityFilterKeys=['channel','from','to'] as const;
const listFilters={
  channel:z.enum(portableOutreachKinds).optional(),from:dateOnly.optional(),to:dateOnly.optional(),
};
const orderedDates=(value:{from?:string;to?:string})=>!value.from||!value.to||value.from<=value.to;
export const portableActivityListQuery=z.union([
  z.object({...contactHome,...listFilters}).strict().refine(cursorPair).refine(orderedDates),
  z.object({...recordHome,...listFilters}).strict().refine(cursorPair).refine(orderedDates),
]);
export type PortableActivityFilters=Pick<z.infer<typeof portableActivityListQuery>,'channel'|'from'|'to'>;
const dayMs=86_400_000;
// Inclusive UTC calendar days in the same millisecond units as occurredAt.
export function activityDateBounds({from,to}:PortableActivityFilters){
  return {start:from?Date.parse(from+'T00:00:00Z'):undefined,end:to?Date.parse(to+'T00:00:00Z')+dayMs-1:undefined};
}
export const hasActivityFilters=(filters:PortableActivityFilters)=>!!(filters.channel||filters.from||filters.to);

const historyScope={history:uuid,workspaceId:uuid.optional(),before:z.coerce.number().int().min(2).max(2147483647).optional()};
export const portableActivityHistoryQuery=z.union([
  z.object({contactId:uuid,...historyScope}).strict(),
  z.object({kind:z.enum(['companies','deals']),recordId:uuid,...historyScope}).strict(),
]);
export type PortableActivityHistoryQuery=z.infer<typeof portableActivityHistoryQuery>;

export type PortableOutreach=z.infer<typeof portableOutreachWrite>;
export type PortableOutreachQuery=z.infer<typeof portableOutreachQuery>;

export type PortableRecordActivityQuery=z.infer<typeof recordActivityQuery>;

export type PortableLoggedActivityQuery=z.infer<typeof portableLoggedActivityQuery>;
export type PortableActivityMutation=z.infer<typeof activityMutation>;
