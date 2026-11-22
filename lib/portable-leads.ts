import {z} from 'zod';
import {leadStages,schemas} from './crm';
import {portableRecordSearch,writeSchema} from './portable-records';
import {extensionSchemas} from './standard-properties';

const id=z.string().guid("Invalid uuid");
const stage=z.enum(leadStages);
type LeadProperty='leadType'|'leadLabel'|'description'|'disqualificationCategory'|'disqualificationReason';
const standardFields=extensionSchemas.leads as Record<LeadProperty,z.ZodType<string|undefined>>;
export const portableLeadFields=z.object({...standardFields,name:schemas.leads.shape.name,leadStage:stage}).strict();
// An omitted assignee uses routing on creation and preserves the assignee on edit. Null means unassigned.
const save=writeSchema(z.object({action:z.literal('save'),data:portableLeadFields.partial({leadStage:true}),
  contactId:id.nullable().optional(),companyId:id.nullable().optional(),assigneeId:z.string().min(1).max(200).nullable().optional()}));
const convert=z.object({action:z.literal('convert'),id,expectedRevision:z.number().int().min(1).max(2147483646),
  dealName:schemas.deals.shape.name}).strict();

export const leadRoutingPage=z.object({action:z.literal('route_page'),queueIfUnavailable:z.boolean().optional(),leads:z.array(z.object({
  id:id.transform(value=>value.toLowerCase()),expectedRevision:z.number().int().min(1).max(2147483646),
}).strict()).min(1).max(25)}).strict().refine(input=>new Set(input.leads.map(row=>row.id)).size===input.leads.length);
export type LeadRoutingTarget=z.output<typeof leadRoutingPage>['leads'][number];

const route=convert.omit({dealName:true}).extend({action:z.literal('route')});
export const portableLeadWrite=z.union([save,convert,route,route.extend({action:z.literal('queue_routing'),releaseAssigneeId:z.string().min(1).max(200).optional()})]);
// My leads and Unassigned reuse the record owner filter's query values.
export const portableLeadOwnerView=z.enum(['mine','unassigned','needs-routing','waiting-routing']);
const routingPosition=z.tuple([id,z.iso.datetime({precision:6}).refine(time=>!time.startsWith('0000'))]);
const leadPosition=z.string().max(64).refine(value=>id.safeParse(value).success||routingPosition.safeParse(value.split('~')).success);
export const portableLeadRead=z.object({id:id.optional(),after:leadPosition.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  search:portableRecordSearch.optional(),stage:stage.optional(),owner:portableLeadOwnerView.optional(),workspaceId:id.optional()}).strict()
  .refine(input=>!(input.id&&(input.after||input.search||input.stage||input.owner)))
  .refine(input=>!input.after?.includes('~')||input.owner==='needs-routing'||input.owner==='waiting-routing');
export const portableLeadHistoryQuery=z.object({id,workspaceId:id.optional(),
  before:z.coerce.number().int().min(2).max(2147483647).optional()}).strict();
export type LeadFields=z.output<typeof portableLeadFields>;
export type LeadWrite=z.output<typeof portableLeadWrite>;
export type LeadQuery=z.output<typeof portableLeadRead>;
// dealId stays set after conversion, including while that Deal is archived (dealArchived).
// The assignee is the workspace member responsible for the Lead, separate from whoever saved it.
export type LeadRecord={routingPending?:boolean;routingRetryAt?:string|null;editable?:boolean;convertedDealUnavailable?:boolean;id:string;revision:number;data:LeadFields;contactId:string|null;companyId:string|null;dealId:string|null;dealArchived:boolean;
  assigneeId:string|null;assigneeLabel:string|null;contactName:string|null;companyName:string|null;createdAt:string;updatedAt:string};
export type LeadPage={records:LeadRecord[];next:string|null};
// Events saved before Lead assignment have no assignee fields; read them as unassigned.
export type LeadSnapshot=Pick<LeadRecord,'data'|'contactId'|'companyId'|'dealId'>&Partial<Pick<LeadRecord,'assigneeId'|'assigneeLabel'>>;
export type LeadEventData=LeadSnapshot&{routingChange?:'queued'|'cancelled'};
export type LeadHistory={entries:{revision:number;actorName:string|null;occurredAt:string;
  previous:LeadSnapshot|null;data:LeadEventData}[];next:number|null};
