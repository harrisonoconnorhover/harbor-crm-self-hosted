import {z} from 'zod';
import {lifecycles} from './crm';
import {ruleSchema} from './filters';
import {portableRecordSearch} from './portable-records';
import {segmentInput} from './segments';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const revision=z.number().int().min(0).max(2147483646);
const rule=ruleSchema.pick({field:true,operator:true,value:true,valueTo:true}).extend({valueTo:z.literal('').default('')});
const lifecycleRule=rule.extend({field:z.literal('lifecycle'),operator:z.literal('eq'),value:z.enum(lifecycles)}).strict();
const textRule=rule.extend({field:z.enum(['name','email']),operator:z.literal('contains'),value:portableRecordSearch}).strict();
const criteria=z.object({
  groups:z.array(z.array(z.union([lifecycleRule,textRule])).min(1).max(3)
    .refine(group=>new Set(group.map(rule=>rule.field)).size===group.length)).max(1).default([]),
}).strict();
const definition=segmentInput.pick({name:true,description:true}).extend({
  id,revision,kind:z.literal('contacts'),mode:z.enum(['active','static']),criteria,
}).strict();
const segment=definition.extend({initialMembers:z.enum(['empty','snapshot']).optional()})
  .refine(value=>value.initialMembers===undefined||(value.mode==='static'&&value.revision===0));

export const portableSegmentWrite=z.discriminatedUnion('action',[
  z.object({action:z.literal('save'),segment}).strict(),
  z.object({action:z.literal('delete'),id,revision:z.number().int().positive().max(2147483647)}).strict(),
  z.object({action:z.literal('members'),id,revision:revision.min(1),requestId:id,operation:z.enum(['add','remove']),
    contactIds:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length)}).strict(),
]);
const cursor={after:id.optional(),limit:z.coerce.number().int().min(1).max(50).default(25)};
const readSearch=portableRecordSearch.refine(value=>!value.includes('\0')).optional();
export const portableSegmentRead=z.union([
  z.object({id,candidates:z.literal('true').optional(),q:readSearch,...cursor}).strict(),
  z.object({kind:z.literal('contacts').optional(),activeOnly:z.literal('true').optional(),q:readSearch,...cursor}).strict(),
]);
export type PortableSegmentDefinition=z.output<typeof definition>;
export type PortableSegment=PortableSegmentDefinition&{createdAt:string;updatedAt:string};
export type PortableSegmentWrite=z.output<typeof portableSegmentWrite>;
export type PortableSegmentRead=z.output<typeof portableSegmentRead>;
export type PortableSegmentList={segments:PortableSegment[];next:string|null};
export type PortableSegmentMembers={segment:PortableSegment;items:{id:string;name:string;email:string;lifecycle:string|null}[];
  total:string;next:string|null};
export type PortableSegmentMembershipReceipt={id:string;requestId:string;revision:number};
