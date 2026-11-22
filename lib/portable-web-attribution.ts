import {z} from 'zod';
export const journeyId=z.string().guid();
const printable=z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u);
export const siteWrite=z.object({
  id:journeyId,revision:z.number().int().min(0).max(2147483646),
  name:printable,origin:z.string().min(1).max(254),enabled:z.boolean(),
}).strict();
export const reportPeriod=z.enum(['30d','7d','previous7d','24h']);
export type ReportPeriod=z.infer<typeof reportPeriod>;
const timestamp=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const attributionQuery=z.object({
  period:reportPeriod.optional(),siteId:journeyId.optional(),contactId:journeyId.optional(),inquiryId:journeyId.optional(),
  beforeAt:timestamp.optional(),beforeId:journeyId.optional(),through:timestamp.optional(),
}).strict().refine(q=>(q.beforeAt===undefined)===(q.beforeId===undefined)&&(q.beforeAt===undefined)===(q.through===undefined));
export type AttributionQuery=z.infer<typeof attributionQuery>;
export const trafficDimension=z.enum(['source','medium','campaign','page']);
export const trafficQuery=z.object({
  tab:z.literal('traffic'),period:reportPeriod.optional(),siteId:journeyId.optional(),group:trafficDimension.default('source'),
  afterViews:z.coerce.number().int().positive().max(2147483647).optional(),
  afterLabel:z.string().min(1).max(3072).refine(label=>!label.includes('\0')).optional(),
  through:timestamp.optional(),
}).strict().refine(q=>(q.afterViews===undefined)===(q.afterLabel===undefined)&&(q.afterViews===undefined)===(q.through===undefined));
export type TrafficQuery=z.infer<typeof trafficQuery>;
export const journeyPointer=z.object({siteId:journeyId,visitor:journeyId}).strict();
const label=z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
export const journeyEvent=z.object({
  siteId:journeyId,visitor:journeyId,eventId:journeyId,
  path:z.string().max(256).regex(/^\/[A-Za-z0-9._~/-]*$/).refine(v=>!v.includes('//')&&!v.split('/').some(p=>p==='.'||p==='..')),
  source:label.optional(),medium:label.optional(),campaign:label.optional(),
}).strict();
