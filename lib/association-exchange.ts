import {z} from 'zod';
import {kinds} from './crm';
export const ASSOCIATION_JSON_FIELD='association:links';
export const ASSOCIATION_JSON_LABEL='Associated records (JSON)';
export const ASSOCIATION_EXPORT_ROWS=500,ASSOCIATION_EXPORT_LINKS=2000,ASSOCIATION_EXPORT_BYTES=2_000_000;
export const associationExchangeLink=z.object({kind:z.enum(kinds),id:z.string().min(1).max(150),labels:z.array(z.string().min(1).max(60).refine(v=>v===v.trim(),'Keep labels free of outer whitespace.')).max(5).default([]),primary:z.boolean().default(false)}).strict().refine(v=>new Set(v.labels.map(l=>l.toLowerCase())).size===v.labels.length,'Use each association label once.');
export type AssociationExchangeLink=z.infer<typeof associationExchangeLink>;
const links=z.array(associationExchangeLink).max(120).superRefine((values,c)=>{
 const ids=new Set<string>(),counts=new Map<string,number>();
 for(const v of values){if(ids.has(v.id))c.addIssue({code:'custom',message:'Use each associated Record ID once.'});ids.add(v.id);counts.set(v.kind,(counts.get(v.kind)??0)+1);}
 if([...counts.values()].some(n=>n>20))c.addIssue({code:'custom',message:'Use at most 20 associated records of each object per row.'});
});
export function parseAssociationLinks(text:string):AssociationExchangeLink[]{
 if(!text.trim())return [];
 try{return links.parse(JSON.parse(text));}catch(error){if(error instanceof z.ZodError)throw Error(error.issues[0]?.message??'Check the associated records JSON.');throw Error('Use a JSON array of associated records with kind, id, labels and primary.');}
}
export const associationExportInput=z.object({kind:z.enum(kinds),ids:z.array(z.string().min(1).max(150)).min(1).max(ASSOCIATION_EXPORT_ROWS).refine(v=>new Set(v).size===v.length,'Choose distinct records.')}).strict();
