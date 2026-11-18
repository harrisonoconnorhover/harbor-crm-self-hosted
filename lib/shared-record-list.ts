import {z} from 'zod';
import {utcDateTime} from './iso-date-time';
import {isTicketSlaField,type TicketSlaProperties} from './ticket-sla-properties';
import {sharedListSort,isCustomRecordColumn} from './shared-record-sort';
export {listSorts} from './shared-record-sort';
export type {SharedListSort} from './shared-record-sort';
import type {SharedListSort} from './shared-record-sort';
export const sharedListKinds=['contacts','companies','deals','tickets','leads'] as const;
export type SharedListKind=typeof sharedListKinds[number];
export const sharedListQuery=z.object({workspaceId:z.string().guid("Invalid uuid"),kind:z.enum(sharedListKinds),groups:z.string().max(32000).default('[]'),operation:z.enum(['page','owners']).default('page'),query:z.string().trim().max(160).default(''),owner:z.string().max(1000).default(''),pipelineId:z.string().max(100).default(''),status:z.string().max(100).default(''),sort:sharedListSort.default('updatedAt'),direction:z.enum(['asc','desc']).default('desc'),after:z.string().max(6000).default(''),ownerSearch:z.string().trim().max(160).default('')}).strict().superRefine((q,c)=>{
 if(q.pipelineId&&!['deals','tickets','leads'].includes(q.kind))c.addIssue({code:'custom',message:'This object has no pipelines.'});
 if(!isCustomRecordColumn(q.sort)&&!sharedListColumns[q.kind].some(v=>v.id===q.sort)&&!['createdAt','updatedAt','lastContacted','lastActivity'].includes(q.sort)&&!(q.kind==='tickets'&&isTicketSlaField(q.sort)))c.addIssue({code:'custom',message:'Choose an available sort column.'});
 if(q.owner&&!['me','unassigned','legacy'].includes(q.owner)){try{ownerKeySchema.parse(JSON.parse(q.owner))}catch{c.addIssue({code:'custom',message:'Choose an available record owner.'})}}
});
export const ownerKeySchema=z.union([z.tuple([z.literal('member'),z.string().min(1).max(200)]),z.tuple([z.literal('legacy'),z.string().min(1).max(200)]),z.tuple([z.literal('unassigned')])]);
export const listCursorSchema=z.object({key:z.string().length(64),asOf:utcDateTime.optional(),missing:z.union([z.literal(0),z.literal(1)]),value:z.union([z.string().max(3000),z.number().finite(),z.null()]),id:z.string().min(1).max(1000)}).strict();
export type SharedListQuery=z.infer<typeof sharedListQuery>;
export type SharedListRow=Partial<TicketSlaProperties>&{boardStage?:string;id:string;name:string;email?:string|null;phone?:string|null;domain?:string|null;industry?:string|null;owner:string;ownerKey:string;status:string;pipeline?:string;amount?:number|null;closeDate?:string|null;priority?:string|null;createdAt:string;updatedAt:string;lastContacted:string|null;lastActivity:string|null};
export type SharedListPage={sortProperty?:{id:SharedListSort;label:string};items:SharedListRow[];total:number;next:string|null;pipelines:{id:string;label:string}[];statuses:{id:string;label:string}[]};
export type SharedOwnerPage={items:{id:string;label:string;count:number}[];next:string|null};
export const sharedListColumns:Record<SharedListKind,{id:keyof SharedListRow;label:string;sort?:SharedListSort}[]>={
 contacts:[{id:'name',label:'Name',sort:'name'},{id:'email',label:'Email',sort:'email'},{id:'phone',label:'Phone number'},{id:'owner',label:'Contact owner',sort:'owner'},{id:'status',label:'Lifecycle stage',sort:'status'},{id:'updatedAt',label:'Last modified',sort:'updatedAt'}],
 companies:[{id:'name',label:'Company name',sort:'name'},{id:'domain',label:'Company domain',sort:'domain'},{id:'industry',label:'Industry'},{id:'owner',label:'Company owner',sort:'owner'},{id:'status',label:'Lifecycle stage',sort:'status'},{id:'updatedAt',label:'Last modified',sort:'updatedAt'}],
 deals:[{id:'name',label:'Deal name',sort:'name'},{id:'pipeline',label:'Pipeline'},{id:'status',label:'Deal stage',sort:'status'},{id:'amount',label:'Amount',sort:'amount'},{id:'closeDate',label:'Close date',sort:'closeDate'},{id:'owner',label:'Deal owner',sort:'owner'},{id:'updatedAt',label:'Last modified',sort:'updatedAt'}],
 tickets:[{id:'name',label:'Ticket name',sort:'name'},{id:'pipeline',label:'Pipeline'},{id:'status',label:'Ticket status',sort:'status'},{id:'priority',label:'Priority'},{id:'owner',label:'Ticket owner',sort:'owner'},{id:'updatedAt',label:'Last modified',sort:'updatedAt'}],
 leads:[{id:'name',label:'Lead name',sort:'name'},{id:'pipeline',label:'Pipeline'},{id:'status',label:'Lead stage',sort:'status'},{id:'owner',label:'Lead owner',sort:'owner'},{id:'updatedAt',label:'Last modified',sort:'updatedAt'}],
};
export function sharedListRoute(value:Partial<SharedListQuery>){const p=new URLSearchParams();for(const key of ['workspaceId','kind','query','owner','pipelineId','status','sort','direction','groups','after'] as const){if(value[key])p.set(key=== 'workspaceId'?'workspace':key,value[key]!)}return '/workspaces#'+p;}
export function sharedListFromHash(hash:string,workspaceId:string,kind:SharedListKind):SharedListQuery{
 const p=new URLSearchParams(hash.replace(/^#/,''));if(p.get('workspace')!==workspaceId||p.get('kind')!==kind)return sharedListQuery.parse({workspaceId,kind});
 const parsed=sharedListQuery.safeParse({workspaceId,kind,...Object.fromEntries(['query','owner','pipelineId','status','sort','direction','groups','after'].filter(k=>p.has(k)).map(k=>[k,p.get(k)]))});return parsed.success?parsed.data:{...sharedListQuery.parse({workspaceId,kind}),groups:'[invalid link filters]'};
}
