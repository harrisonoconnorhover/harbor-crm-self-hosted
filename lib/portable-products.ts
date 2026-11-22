import {z} from 'zod';
import {billingFrequencies,type Product} from './commerce';

const portableProductFilters=z.object({
  q:z.string().trim().max(200).optional(),
  archived:z.enum(['true','false']).optional(),
  billingFrequency:z.enum(billingFrequencies).or(z.literal('')).optional(),
}).strict();
// A cursor carries the database-sorted name as well as the ID, so the boundary
// survives a rename or removal. Base64url keeps names out of URL syntax.
const cursor=z.string().min(38).max(1024).refine(value=>{
  const id=value.slice(0,36),encoded=value.slice(37);
  if(value[36]!=='.'||!z.string().guid().safeParse(id).success||!encoded)return false;
  const name=Buffer.from(encoded,'base64url').toString('utf8');
  return !name.includes('\0')&&Buffer.from(name).toString('base64url')===encoded;
},'Invalid catalog position.');
export const portableProductQuery=portableProductFilters.extend({
  id:z.string().guid("Invalid uuid").optional(),
  after:cursor.optional(),before:cursor.optional(),
  page:z.coerce.number().int().min(0).max(1_000_000).optional(),
}).refine(q=>[q.page,q.after,q.before].filter(value=>value!==undefined).length<=1)
  .refine(query=>!query.id||(query.q===undefined&&query.page===undefined&&!query.after&&!query.before&&query.archived===undefined&&query.billingFrequency===undefined));
export const portableProductExportQuery=portableProductFilters.extend({export:z.literal('csv')});
export const subscriptionPlansQuery=portableProductFilters.pick({q:true,archived:true}).extend({
  view:z.literal('subscriptions'),productId:z.string().guid().optional(),after:cursor.optional(),before:cursor.optional(),
}).strict().refine(query=>!(query.after&&query.before));
export const checkoutSessionsCursor=z.string().max(255).regex(/^cs_[A-Za-z0-9_]+$/);
export const productSubscriptionQuery=z.object({view:z.enum(['subscription','subscribers']),id:z.string().guid(),
  revision:z.coerce.number().int().positive().safe(),after:checkoutSessionsCursor.optional()}).strict()
  .refine(q=>!q.after||q.view==='subscribers');
export const subscriberStatusLabels={
  incomplete:'Incomplete',incomplete_expired:'Incomplete (expired)',trialing:'Trialing',active:'Active',
  past_due:'Past due',canceled:'Canceled',unpaid:'Unpaid',paused:'Paused',
} as const;
export type SubscriberPage={mode:'test'|'live';next:string|null;items:{subscriptionId:string;email:string|null;
  status:keyof typeof subscriberStatusLabels;cancelAtPeriodEnd:boolean;cancelAt:number|null}[]};
export const portableProductExportLimit=500;
export type PortableProductQuery=z.output<typeof portableProductQuery>;
export type PortableProductFilters=z.output<typeof portableProductFilters>;
export type PortableProductPage={items:Product[];total:number|null;page:number|null;size:number;previous:string|null;next:string|null};
