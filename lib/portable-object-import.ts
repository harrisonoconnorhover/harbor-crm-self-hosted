import {z} from 'zod';
import type {CustomValue} from './property-values';

export const objectImportLimit=100;
export const objectImportBytes=250_000;
const source=z.object({objectId:z.string().guid(),csv:z.string().min(1).max(objectImportBytes)});
export const objectImportRequest=z.discriminatedUnion('action',[
  source.extend({action:z.literal('preview_csv')}).strict(),
  source.extend({action:z.literal('apply_csv'),requestId:z.string().guid(),review:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),
]);
export type ObjectImportRequest=z.infer<typeof objectImportRequest>;
export type ObjectCsvRow={row:number;name:string;state:'create'|'update'|'skip'|'error';error?:string;
  changes:{label:string;before:CustomValue|null;after:CustomValue}[]};
export type ObjectCsvPreview={review:string;rows:ObjectCsvRow[]};
