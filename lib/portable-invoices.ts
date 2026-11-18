import {z} from 'zod';
import {invoiceData,paymentData,type Invoice,type InvoiceData,type InvoicePayment,type invoiceStatus} from './invoices';
import {dateOnly} from './quotes';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const revision=z.number().int().min(1).max(2147483647);
const timestamp=z.string().min(1).max(64);
const recurring=z.enum(['exclude','one_payment']);
const source=z.discriminatedUnion('type',[
  z.object({type:z.literal('deal'),id,createdAt:timestamp,updatedAt:timestamp,
    lineRevision:z.number().int().min(0).max(2147483647),buyerRevision:revision.nullable(),companyRevision:revision.nullable()}).strict(),
  z.object({type:z.literal('quote'),id,revision,version:revision}).strict(),
]);
export const portableInvoiceWrite=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),id,source,recurring}).strict(),
  z.object({action:z.literal('save'),id,revision,data:invoiceData}).strict(),
  z.object({action:z.literal('finalize'),id,revision}).strict(),
  z.object({action:z.literal('void'),id,revision,reason:z.string().trim().min(1).max(2000)}).strict(),
  z.object({action:z.literal('payment'),id,revision,paymentId:id,data:paymentData}).strict(),
  z.object({action:z.literal('unapply'),id,revision,paymentId:id,reason:z.string().trim().min(1).max(2000)}).strict(),
]);
export const portableInvoiceStatuses=['draft','open','partially_paid','paid','overdue','void'] as const;
const dueDate=dateOnly.refine(value=>value>='0001-01-01','Choose a date in year 0001 or later.');
const portableInvoiceFilters=z.object({dealId:id.optional(),quoteId:id.optional(),q:z.string().trim().max(200).optional(),
  status:z.enum(['all',...portableInvoiceStatuses]).optional(),dueFrom:dueDate.optional(),dueThrough:dueDate.optional()}).strict()
  .refine(({dueFrom,dueThrough})=>!dueFrom||!dueThrough||dueFrom<=dueThrough,'Choose a due date range with the earlier date first.');
export const portableInvoiceList=portableInvoiceFilters.safeExtend({after:id.optional()});
export const portableInvoiceExport=portableInvoiceFilters.safeExtend({export:z.literal('csv')});
export const portableInvoiceExportLimit=500;
export const portableInvoiceDetail=z.object({id,before:z.coerce.number().int().min(1).max(2147483647).optional(),
  paymentsBefore:z.coerce.number().int().min(1).max(2147483647).optional(),
  download:z.literal('true').optional()}).strict();
export const portableInvoiceSourceQuery=z.object({source:z.enum(['deal','quote']),sourceId:id,recurring:recurring.default('exclude')}).strict();
export const portableInvoiceRead=z.union([portableInvoiceDetail,portableInvoiceSourceQuery,portableInvoiceList]);

export type PortableInvoiceWrite=z.output<typeof portableInvoiceWrite>;
export type PortableInvoiceSource=z.output<typeof source>;
export type PortableInvoiceSourceQuery=z.output<typeof portableInvoiceSourceQuery>;
export type PortableInvoiceList=z.output<typeof portableInvoiceList>;
export type PortableInvoiceAction=PortableInvoiceWrite['action'];
export type PortableInvoicePaymentWrite=Extract<PortableInvoiceWrite,{action:'payment'|'unapply'}>;
export type PortableInvoicePreview={data:InvoiceData;source:PortableInvoiceSource;sourceNote:string;recurringCount:number;totalCents:number};
export type PortableInvoicePage={items:{id:string;title:string;buyer:string;dueOn:string;totalCents:number;number:number|null;status:ReturnType<typeof invoiceStatus>;paidCents:number}[];next:string|null};
export type PortableInvoiceDetail={invoice:Invoice;history:{revision:number;action:PortableInvoiceAction;actorName:string|null;at:string;note:string|null}[];
  next:number|null;payments:InvoicePayment[];nextPayment:number|null};

export function portableInvoiceState(finalizedAt:string|null,voidReason:string|null):Invoice['status']{
  if(voidReason!==null)return 'void';
  return finalizedAt===null?'draft':'open';
}
