import {z} from 'zod';
import {tokenInput} from './api-access';
import {portableCompanyFields,portableContactFields,portableDealFields,portableRecordKind,portableRecordReadFields} from './portable-records';
import {portableLeadFields} from './portable-leads';
import {portableTaskFields} from './portable-tasks';
import {portableTicketFields} from './portable-tickets';

const id=z.string().guid("Invalid uuid");
export const portableExternalRecordKind=z.enum([...portableRecordKind.options,'tasks','leads','tickets']);
export type PortableExternalRecordKind=z.output<typeof portableExternalRecordKind>;
export const portableTokenCreate=tokenInput.refine(input=>input.objects[0]==='inquiries'||
  (input.permission==='read'&&input.objects.every(object=>portableExternalRecordKind.safeParse(object).success)),
'Choose read access for Contacts, Companies, Deals, Tasks, Leads or Tickets, or a separate inquiry token.');
export const portableTokenRevoke=z.object({action:z.literal('revoke'),id}).strict();
export const portableTokenPage=z.object({
  afterAt:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  afterId:id.optional(),
}).strict().refine(input=>(input.afterAt===undefined)===(input.afterId===undefined));
export const portableExternalRecordPage=portableRecordReadFields.pick({limit:true}).extend({after:id.optional()}).strict();
export const portableExternalRecordBatch=z.object({
  inputs:z.array(z.object({id}).strict()).min(1).max(50),
  properties:z.array(z.string().min(1).max(150)).max(100).optional(),
}).strict().refine(({inputs})=>new Set(inputs.map(item=>item.id.toLowerCase())).size===inputs.length);

const publicBatchFields={
  contacts:portableContactFields.shape,
  companies:portableCompanyFields.shape,
  deals:portableDealFields.shape,
  tasks:portableTaskFields.shape,
  leads:portableLeadFields.shape,
  tickets:portableTicketFields.omit({owner:true}).shape,
} satisfies Record<PortableExternalRecordKind,z.ZodRawShape>;

export function validPortableBatchProperties(kind:PortableExternalRecordKind,properties?:string[]){
  return properties===undefined||properties.every(field=>Object.hasOwn(publicBatchFields[kind],field));
}
