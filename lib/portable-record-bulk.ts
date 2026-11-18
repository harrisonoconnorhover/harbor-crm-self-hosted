import {z} from 'zod';
import {portableRecordKind} from './portable-records';

// Matches the Task queue batch: rows the user selected on the current page, each with the revision they saw.
export const portableRecordBulkLimit=50;
const selection=z.array(z.object({
  id:z.string().guid("Invalid uuid").toLowerCase(),expectedRevision:z.number().int().min(1).max(2147483646),
}).strict()).min(1).max(portableRecordBulkLimit).refine(rows=>new Set(rows.map(row=>row.id)).size===rows.length,'Select each record once.');

export const portableRecordOwnerBatch=z.object({
  action:z.literal('assignOwners'),kind:portableRecordKind,assigneeId:z.string().min(1).max(200).nullable(),records:selection,
}).strict();
export type PortableRecordOwnerBatch=z.output<typeof portableRecordOwnerBatch>;
export type PortableRecordOwnerResult={changed:number}|{error:'access'|'records_missing'|'records_stale'|'assignee_missing'};

// Fields that identify a record aren't bulk-editable: setting one name, email or
// domain on many records is never intended. A deal stage is editable only when
// every selected deal is in the same pipeline.
export const portableBulkExcludedFields={contacts:['name','email'],companies:['name','domain'],deals:['name']} as const;
export const portableBulkPropertyModes=['replace','clear','append','remove'] as const;
const customPropertyId=z.string().guid("Invalid uuid");
export const portableRecordPropertyBatch=z.object({
  action:z.literal('editProperty'),kind:portableRecordKind,field:z.string().min(1).max(200)
    .refine(field=>!field.startsWith('custom:')||customPropertyId.safeParse(field.slice(7)).success),
  mode:z.enum(portableBulkPropertyModes),value:z.unknown().optional(),records:selection,
}).strict().refine(input=>input.mode==='clear'||input.value!==undefined);
export type PortableRecordPropertyBatch=z.output<typeof portableRecordPropertyBatch>;
