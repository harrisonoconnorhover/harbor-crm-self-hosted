import {z} from 'zod';
import {leadStages,schemas} from './crm';
import {portableRecordSearch,writeSchema} from './portable-records';
import {extensionSchemas} from './standard-properties';

const id=z.string().guid("Invalid uuid");
const stage=z.enum(leadStages);
type LeadProperty='leadType'|'leadLabel'|'description'|'disqualificationCategory'|'disqualificationReason';
const standardFields=extensionSchemas.leads as Record<LeadProperty,z.ZodType<string|undefined>>;
export const portableLeadFields=z.object({...standardFields,name:schemas.leads.shape.name,leadStage:stage}).strict();
// Omitting assigneeId keeps the current assignee; null clears it.
const save=writeSchema(z.object({action:z.literal('save'),data:portableLeadFields.partial({leadStage:true}),
  contactId:id.nullable().optional(),companyId:id.nullable().optional(),assigneeId:z.string().min(1).max(200).nullable().optional()}));
const convert=z.object({action:z.literal('convert'),id,expectedRevision:z.number().int().min(1).max(2147483646),
  dealName:schemas.deals.shape.name}).strict();

export const portableLeadWrite=z.union([save,convert]);
// My leads and Unassigned reuse the record owner filter's query values.
export const portableLeadOwnerView=z.enum(['mine','unassigned']);
export const portableLeadRead=z.object({id:id.optional(),after:id.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  search:portableRecordSearch.optional(),stage:stage.optional(),owner:portableLeadOwnerView.optional(),workspaceId:id.optional()}).strict()
  .refine(input=>!(input.id&&(input.after||input.search||input.stage||input.owner)));
export const portableLeadHistoryQuery=z.object({id,workspaceId:id.optional(),
  before:z.coerce.number().int().min(2).max(2147483647).optional()}).strict();
export type LeadFields=z.output<typeof portableLeadFields>;
export type LeadWrite=z.output<typeof portableLeadWrite>;
export type LeadQuery=z.output<typeof portableLeadRead>;
// dealId stays set after conversion, including while that Deal is archived (dealArchived).
// The assignee is the workspace member responsible for the Lead, separate from whoever saved it.
export type LeadRecord={id:string;revision:number;data:LeadFields;contactId:string|null;companyId:string|null;dealId:string|null;dealArchived:boolean;
  assigneeId:string|null;assigneeLabel:string|null;contactName:string|null;companyName:string|null;createdAt:string;updatedAt:string};
export type LeadPage={records:LeadRecord[];next:string|null};
// Events saved before Lead assignment have no assignee fields; read them as unassigned.
export type LeadSnapshot=Pick<LeadRecord,'data'|'contactId'|'companyId'|'dealId'>&Partial<Pick<LeadRecord,'assigneeId'|'assigneeLabel'>>;
export type LeadHistory={entries:{revision:number;actorName:string|null;occurredAt:string;
  previous:LeadSnapshot|null;data:LeadSnapshot}[];next:number|null};
