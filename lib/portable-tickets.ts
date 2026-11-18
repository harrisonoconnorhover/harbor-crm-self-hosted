import {z} from 'zod';
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
  category:portableTicketFields.shape.ticketCategory.refine(value=>value!=='').optional(),
  sla:z.enum(['overdue','due_soon']).optional(),search:portableRecordSearch.optional(),
  contactId:id.optional(),companyId:id.optional(),
  // Lists default to ticket ID order; "updated" lists most recently changed first.
  sort:z.literal('updated').optional(),
}).strict();
export const portableTicketRead=portableTicketFilters.extend({
  id:id.optional(),after:id.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  afterUpdatedAt:z.string().datetime({precision:3}).refine(value=>!value.startsWith('0000-')).optional(),
  workspaceId:id.optional(),
}).refine(value=>!(value.id&&(value.after||value.afterUpdatedAt||value.sort||value.status||value.priority||value.source||
  value.category||value.sla||value.search||value.contactId||value.companyId))&&
  !(value.contactId&&value.companyId)&&
  // An updated-order cursor carries both its timestamp and ID; ID order carries only the ID.
  (value.sort==='updated'?(value.after===undefined)===(value.afterUpdatedAt===undefined):value.afterUpdatedAt===undefined));
export const portableTicketExportFilters=portableTicketFilters.refine(value=>!(value.contactId&&value.companyId));

export const portableTicketWrite=z.union([
  writeSchema(z.object({action:z.literal('save'),data:portableTicketInput,contactId:id.nullable().optional(),companyId:id.nullable().optional()})),
  z.object({action:z.literal('status'),id,expectedRevision:z.number().int().min(1).max(2147483646),
    status:portableTicketStatus}).strict(),
]);

export type PortableTicketFields=z.output<typeof portableTicketFields>;
export type PortableTicketQuery=z.output<typeof portableTicketRead>;
export type PortableTicketWrite=z.output<typeof portableTicketWrite>;
export type PortableTicketRecord={
  id:string;revision:number;data:PortableTicketFields;contactId:string|null;companyId:string|null;
  contactName:string|null;companyName:string|null;closedAt:string|null;createdAt:string;updatedAt:string;sla?:CloseSlaRecord;
};
export type PortableTicketPage={records:PortableTicketRecord[];next:string|null;nextUpdatedAt?:string|null};
