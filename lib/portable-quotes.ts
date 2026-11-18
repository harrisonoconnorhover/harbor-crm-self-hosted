import {z} from 'zod';
import {dateOnly,quoteData,quoteStatuses,type Quote,type QuoteSnapshot} from './quotes';

const id=z.string().guid("Invalid uuid");
const revision=z.number().int().min(0).max(2147483647);
const note=z.string().trim().max(2000).default('');
export const portableQuoteMutation=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),id,dealId:id,expectedUpdatedAt:z.string().min(1).max(64),lineRevision:revision}).strict(),
  z.object({action:z.literal('save'),id,revision:revision.min(1),data:quoteData}).strict(),
  z.object({action:z.literal('publish'),id,revision:revision.min(1)}).strict(),
  z.object({action:z.literal('recall'),id,revision:revision.min(1)}).strict(),
  z.object({action:z.literal('accept'),id,revision:revision.min(1),name:z.string().trim().min(1).max(160),date:dateOnly,note}).strict(),
  z.object({action:z.literal('decline'),id,revision:revision.min(1),note}).strict(),
  z.object({action:z.literal('void'),id,revision:revision.min(1),note}).strict(),
]);
export const portableQuoteDisplayStatuses=[...quoteStatuses,'expired'] as const;
export type PortableQuoteDisplayStatus=typeof portableQuoteDisplayStatuses[number];
const expirationDate=dateOnly.refine(value=>value>='0001-01-01','Choose a date in year 0001 or later.');
const portableQuoteFilters=z.object({
  dealId:id.optional(),q:z.string().trim().max(200).optional(),
  status:z.enum(['all',...portableQuoteDisplayStatuses]).optional(),
  expiresFrom:expirationDate.optional(),expiresThrough:expirationDate.optional(),
}).strict().refine(({expiresFrom,expiresThrough})=>!expiresFrom||!expiresThrough||expiresFrom<=expiresThrough,
  'Choose an expiration date range with the earlier date first.');
export const portableQuoteExport=portableQuoteFilters.safeExtend({export:z.literal('csv')});
export const portableQuoteExportLimit=500;
export const portableQuoteQuery=portableQuoteFilters.safeExtend({
  id:id.optional(),
  after:id.optional(),before:z.coerce.number().int().min(1).max(2147483647).optional(),
  version:z.coerce.number().int().min(1).max(2147483647).optional(),
  versionBefore:z.coerce.number().int().min(1).max(2147483647).optional(),
  download:z.literal('true').optional(),
}).refine(input=>input.id?!(input.q!==undefined||input.status!==undefined||input.after||input.dealId||input.expiresFrom||input.expiresThrough):
  input.before===undefined&&input.version===undefined&&input.versionBefore===undefined&&input.download===undefined);
export type PortableQuoteMutation=z.output<typeof portableQuoteMutation>;
export type PortableQuoteQuery=z.output<typeof portableQuoteQuery>;
export type PortableQuoteFilters=z.output<typeof portableQuoteFilters>;
export type PortableQuoteSummary={id:string;dealName:string;title:string;buyer:string;expiresOn:string;number:number|null;version:number;status:PortableQuoteDisplayStatus};
export type PortableQuotePage={items:PortableQuoteSummary[];next:string|null};
export type PortableQuoteAction=PortableQuoteMutation['action'];
export type PortableQuoteDisposition=Extract<Quote['status'],'accepted'|'declined'|'voided'>;
export const portableQuoteStatus=(publishedAt:string|null,disposition:PortableQuoteDisposition|null):Quote['status']=>
  disposition??(publishedAt===null?'draft':'published');
export const portableQuoteStatusLabels={draft:'Draft',published:'Published',accepted:'Accepted',declined:'Declined',voided:'Voided',expired:'Expired'} satisfies Record<PortableQuoteDisplayStatus,string>;
export type PortableQuoteVersion={version:number;publishedAt:string};
export type PortableQuoteDetail={quote:Quote;history:{revision:number;action:PortableQuoteAction;actorName:string|null;at:string;note:string|null}[];
  next:number|null;versions:PortableQuoteVersion[];nextVersion:number|null;
  published:(PortableQuoteVersion&{snapshot:QuoteSnapshot})|null};
