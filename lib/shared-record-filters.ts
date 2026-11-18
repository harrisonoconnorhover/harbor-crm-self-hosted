import {z} from 'zod';
import {groupsSchema,type FilterGroups} from './filters';
export const sharedRecordGroups=groupsSchema.refine(v=>v.flat().length<=20,'Use at most 20 advanced conditions.');
export function parseRecordGroups(raw:string):FilterGroups {let value;try{value=JSON.parse(raw)}catch{throw Error('Advanced filters are invalid. Edit or clear them to continue.')}return sharedRecordGroups.parse(value)}
export const filterCatalogQuery=z.object({workspaceId:z.string().guid("Invalid uuid"),kind:z.enum(['contacts','companies','deals','tickets','leads']),query:z.string().trim().max(160).default(''),after:z.string().max(200).default(''),selected:z.string().max(10000).default('[]')}).strict();
