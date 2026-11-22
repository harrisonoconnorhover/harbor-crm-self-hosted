import type {FirstResponse,firstResponseStatus} from './first-response';
import {z} from 'zod';
import {supportTag,ticketTags} from './team-inbox';
import {schemas,ticketPriorities,ticketStatuses} from './crm';
import {portableRecordSearch,writeSchema} from './portable-records';
import {extensionSchemas} from './standard-properties';
import {closeSlaInput,type CloseSlaPolicy,type CloseSlaRecord} from './ticket-sla';

export const portableCloseSlaInput=closeSlaInput.refine(value=>value.pipelineRevision===undefined&&
  value.pauseConditions===undefined&&value.revision<=2147483646,'Choose a valid close-time SLA policy.');
export type PortableCloseSlaPolicy=Pick<CloseSlaPolicy,'revision'|'enabled'|'targets'|'warningMinutes'|'updatedAt'>;

const id=z.string().guid("Invalid uuid");
export const portableTicketStatus=z.enum(ticketStatuses);
const portableTicketInput=schemas.tickets.pick({name:true}).extend({
  owner:schemas.tickets.shape.owner.unwrap().optional(),
  ticketPriority:schemas.tickets.shape.ticketPriority.unwrap().optional(),
  ticketStatus:portableTicketStatus.optional(),
  tags:ticketTags.optional(),
  description:extensionSchemas.tickets.description as z.ZodType<string|undefined>,
  ticketSource:extensionSchemas.tickets.ticketSource as z.ZodType<string|undefined>,
  ticketCategory:extensionSchemas.tickets.ticketCategory as z.ZodType<string|undefined>,
}).strict();

export const portableTicketFields=portableTicketInput.extend({
  owner:schemas.tickets.shape.owner,
  ticketPriority:schemas.tickets.shape.ticketPriority,
  ticketStatus:portableTicketStatus.default('New'),
});

const portableTicketFilters=z.object({
  status:portableTicketStatus.optional(),priority:z.enum(ticketPriorities).optional(),
  source:portableTicketFields.shape.ticketSource.refine(value=>value!=='').optional(),
  tag:supportTag.toLowerCase().pipe(supportTag).optional(),
  category:portableTicketFields.shape.ticketCategory.refine(value=>value!=='').optional(),
  assignee:z.union([z.enum(['me','unassigned','unavailable']),id]).optional(),
  response:z.enum(['unanswered','due_next_hour','waiting','overdue','met','late']).optional(),
  sla:z.enum(['overdue','due_soon']).optional(),search:portableRecordSearch.optional(),
  contactId:id.optional(),companyId:id.optional(),
  // Lists default to ticket ID order; "updated" lists most recently changed first.
  sort:z.enum(['updated','response_due']).optional(),
}).strict();
export const portableTicketRead=portableTicketFilters.extend({
  id:id.optional(),editableOnly:z.literal('1').optional(),after:id.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  afterUpdatedAt:z.string().datetime({precision:3}).refine(value=>!value.startsWith('0000-')).optional(),
  afterDueAt:z.union([z.literal('none'),z.iso.datetime({precision:6}).refine(value=>!value.startsWith('0000-'))]).optional(),
  workspaceId:id.optional(),
}).refine(value=>!(value.id&&(value.editableOnly||value.after||value.afterUpdatedAt||value.afterDueAt||value.sort||value.status||value.priority||value.source||
  value.category||value.tag||value.assignee||value.response||value.sla||value.search||value.contactId||value.companyId))&&
  !(value.contactId&&value.companyId)&&
  // An updated-order cursor carries both its timestamp and ID; ID order carries only the ID.
  (value.sort==='updated'?(value.after===undefined)===(value.afterUpdatedAt===undefined):value.afterUpdatedAt===undefined)&&
  (value.sort==='response_due'?(value.after===undefined)===(value.afterDueAt===undefined):value.afterDueAt===undefined));
export const portableTicketExportFilters=portableTicketFilters.refine(value=>!(value.contactId&&value.companyId));

export const portableTicketWrite=z.union([
  writeSchema(z.object({action:z.literal('save'),data:portableTicketInput,assigneeId:z.string().min(1).max(200).nullable().optional(),contactId:id.nullable().optional(),companyId:id.nullable().optional()})),
  z.object({action:z.literal('take_unavailable'),id,expectedRevision:z.number().int().min(1).max(2147483646),
    previousAssigneeId:z.string().min(1).max(200)}).strict(),
  z.object({action:z.literal('take_first_response'),id,expectedRevision:z.number().int().min(1).max(2147483646)}).strict(),
  z.object({action:z.literal('status'),id,expectedRevision:z.number().int().min(1).max(2147483646),
    status:portableTicketStatus}).strict(),
]);

export type PortableTicketFields=z.output<typeof portableTicketFields>;
export type PortableTicketQuery=z.output<typeof portableTicketRead>;
export type PortableTicketWrite=z.output<typeof portableTicketWrite>;
export type PortableTicketRecord={
  id:string;revision:number;data:PortableTicketFields;contactId:string|null;companyId:string|null;
  assigneeId?:string|null;assigneeLabel?:string|null;editable?:boolean;
  inboxConversationId?:string|null;contactName:string|null;companyName:string|null;closedAt:string|null;createdAt:string;updatedAt:string;sla?:CloseSlaRecord;firstResponse?:FirstResponse&{status:ReturnType<typeof firstResponseStatus>};
};
export type PortableTicketPage={records:PortableTicketRecord[];next:string|null;nextUpdatedAt?:string|null;nextDueAt?:string|null};
