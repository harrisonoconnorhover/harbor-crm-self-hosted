import {z} from 'zod';

const target={
  ticketId:z.string().guid(),ticketRevision:z.number().int().positive(),contactId:z.string().guid(),
  expectedRevision:z.number().int().min(0).max(2_147_483_646),
};
const customerText=(max:number)=>z.string().trim().max(max).refine(value=>!value.includes('\0'));
export const casePortalChange=z.discriminatedUnion('action',[
  z.object({...target,action:z.literal('publish'),subject:customerText(200).refine(value=>value.length>0),update:customerText(4000),articleId:z.string().guid().nullable().optional()}).strict(),
  z.object({...target,action:z.enum(['withdraw','invite','revoke'])}).strict(),
]);
export type CasePortalChange=z.infer<typeof casePortalChange>;
export type CasePortalState={
  center:{id:string;name:string;enabled:boolean}|null;
  contact:{id:string;name:string}|null;
  ticketId:string;ticketRevision:number;publicationRevision:number;
  publication:{revision:number;subject:string;update:string;article:{id:string;title:string|null}|null}|null;
  access:{revision:number;state:'invited'|'active'|'revoked'|'expired';expiresAt:number|null}|null;
  inviteToken?:string;
};
