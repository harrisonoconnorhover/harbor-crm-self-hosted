import {z} from 'zod';

const kind=z.enum(['contacts','companies']);
const cursor=z.string().max(400).transform((value,context)=>{
  try{
    const parsed=z.tuple([z.number().int().min(0).max(100),z.string().guid("Invalid uuid"),z.string().guid("Invalid uuid")]).parse(JSON.parse(value));
    return parsed as [number,string,string];
  }catch{context.addIssue({code:'custom',message:'Invalid cursor'});return z.NEVER;}
});
export const portableDuplicateQuery=z.object({
  kind:kind.default('contacts'),status:z.enum(['suggested','dismissed']).default('suggested'),
  query:z.string().max(200).default(''),strength:z.enum(['all','strong','possible']).default('all'),cursor:cursor.optional(),
  workspaceId:z.string().guid("Invalid uuid").optional(),grantId:z.string().guid("Invalid uuid").optional(),
}).strict().refine(input=>!input.workspaceId===!input.grantId);
export type PortableDuplicateQuery=z.output<typeof portableDuplicateQuery>;
export const portableDuplicateAction=z.object({action:z.enum(['dismiss','restore']),kind,recordA:z.string().guid("Invalid uuid"),recordB:z.string().guid("Invalid uuid")})
  .strict().refine(input=>input.recordA!==input.recordB);
export type PortableDuplicateAction=z.infer<typeof portableDuplicateAction>;

export type PortableDuplicateRecord={id:string;revision:number;name:string;email?:string;phone?:string;domain?:string;city?:string;company?:string};
export type PortableDuplicatePair={left:PortableDuplicateRecord;right:PortableDuplicateRecord;score:number;reasons:string[];dismissedAt?:string};
export type PortableDuplicatePage={pairs:PortableDuplicatePair[];nextCursor:string|null;total:number;limited:boolean;recordsChecked:number};
export const portableDuplicatesLink=(kind:'contacts'|'companies',workspaceId?:string)=>
  '/?'+new URLSearchParams({view:'duplicates',kind,...(workspaceId?{workspaceId}:{})});
