import {z} from 'zod';
import {billingFrequencies,type Product} from './commerce';

const portableProductFilters=z.object({
  q:z.string().trim().max(200).optional(),
  archived:z.enum(['true','false']).optional(),
  billingFrequency:z.enum(billingFrequencies).or(z.literal('')).optional(),
}).strict();
export const portableProductQuery=portableProductFilters.extend({
  id:z.string().guid("Invalid uuid").optional(),
  page:z.coerce.number().int().min(0).max(1_000_000).optional(),
}).refine(query=>!query.id||(query.q===undefined&&query.page===undefined&&query.archived===undefined&&query.billingFrequency===undefined));
export const portableProductExportQuery=portableProductFilters.extend({export:z.literal('csv')});
export const portableProductExportLimit=500;
export type PortableProductQuery=z.output<typeof portableProductQuery>;
export type PortableProductFilters=z.output<typeof portableProductFilters>;
export type PortableProductPage={items:Product[];total:number;page:number;size:number};
