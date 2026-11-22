import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PortableLeadFormPayload} from './portable-lead-forms';

const address=z.string().trim().toLowerCase().email().max(254);
const routeSchema=z.object({recipients:z.array(address).max(8),salesforce:z.boolean()}).strict();
const apiName=z.string().max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const mappingSchema=z.object({
  object:apiName,
  externalIdField:apiName.refine(field=>field.endsWith('__c'),'Use a custom unique External ID field.'),
  fields:z.object({name:apiName,email:apiName,phone:apiName.optional(),country:apiName.optional(),message:apiName.optional()}).strict(),
  constants:z.record(apiName,z.string().min(1).max(255)).optional(),
}).strict();
type Mapping=z.infer<typeof mappingSchema>;
export type MarketingFormRouteInput=z.input<typeof routeSchema>;
export type FormDeliveryClass='retry'|'rejected'|'uncertain';
export class FormDeliveryError extends Error {
  constructor(public disposition:FormDeliveryClass,message:string){super(message);}
}

export function assertFormMarketingWorkspace(workspaceId:string,env:NodeJS.ProcessEnv){
  if(!z.uuid().safeParse(workspaceId).success||env.HARBOR_MARKETING_WORKSPACE_ID?.toLowerCase()!==workspaceId)
    throw new Error('Choose the workspace named in HARBOR_MARKETING_WORKSPACE_ID.');
}

export function internalFormRecipients(env:NodeJS.ProcessEnv){
  const raw=env.HARBOR_MARKETING_FORM_RECIPIENTS?.trim();
  if(!raw)return new Set<string>();
  const allowed=z.array(address).max(100).parse(raw.split(','));
  return new Set(allowed);
}

export function salesforceFormTarget(env:NodeJS.ProcessEnv){
  const origin=new URL(env.HARBOR_SALESFORCE_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash||
     !origin.hostname.endsWith('.my.salesforce.com'))throw new Error('Configure the Salesforce My Domain HTTPS origin.');
  let input:unknown;
  try{input=JSON.parse(env.HARBOR_SALESFORCE_FORM_MAPPING??'');}catch{throw new Error('Set HARBOR_SALESFORCE_FORM_MAPPING to a JSON object.');}
  const parsed=mappingSchema.safeParse(input);
  if(!parsed.success)throw new Error('Check the Salesforce form object, unique external ID and field map.');
  const mapping=parsed.data;
  const names=[...Object.values(mapping.fields),...Object.keys(mapping.constants??{}),mapping.externalIdField].map(s=>s.toLowerCase());
  if(Object.keys(mapping.constants??{}).length>12||new Set(names).size!==names.length||names.includes('id')||
     names.some(s=>['attributes','constructor','__proto__','prototype'].includes(s)))throw new Error('Use distinct Salesforce field names.');
  const ordered=(o:Record<string,string>)=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a<b?-1:a>b?1:0));
  const destination=createHash('sha256').update(JSON.stringify([origin.origin,mapping.object,mapping.externalIdField,
    ordered(mapping.fields),ordered(mapping.constants??{})])).digest('hex');
  return {origin:origin.origin,mapping,destination};
}

export function parseMarketingFormRoute(input:unknown,env:NodeJS.ProcessEnv){
  const route=routeSchema.parse(input);
  const recipients=[...new Set(route.recipients)].sort();
  if(recipients.length){
    const allow=internalFormRecipients(env);
    if(recipients.some(recipient=>!allow.has(recipient)))throw new Error('Choose an address listed in HARBOR_MARKETING_FORM_RECIPIENTS.');
  }
  return {recipients,salesforceTarget:route.salesforce?salesforceFormTarget(env).destination:null};
}

type SalesforceApi={origin:string;apiPath:string;accessToken:string};
type SalesforceFormInput={inquiryId:string;workspaceId:string;payload:PortableLeadFormPayload;reconcile:boolean};
const recordId=z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/);

export async function deliverSalesforceInquiry(input:SalesforceFormInput,env:NodeJS.ProcessEnv,
  connect:(env:NodeJS.ProcessEnv)=>Promise<SalesforceApi>,fetchImpl:typeof fetch=fetch){
  const target=salesforceFormTarget(env);
  let api:SalesforceApi;
  try{api=await connect(env);}catch{throw new FormDeliveryError('retry','Salesforce authorization failed before writing.');}
  if(api.origin!==target.origin||!/^\/services\/data\/v\d{1,3}\.\d$/.test(api.apiPath))throw new FormDeliveryError('rejected','Salesforce connection and form destination differ.');
  const map=target.mapping;
  const key=input.workspaceId+'-'+input.inquiryId;
  const url=new URL(api.apiPath+'/sobjects/'+map.object+'/'+map.externalIdField+'/'+key,api.origin);
  const headers={'authorization':'Bearer '+api.accessToken, 'content-type':'application/json'};
  const options={headers,redirect:'error' as const,cache:'no-store' as const};
  async function failure(response:Response,writing:boolean){
    const status=response.status;
    let limited=status===429;
    if(status===403){
      const errors:unknown=await response.json().catch(()=>null);
      limited=Array.isArray(errors)&&errors.some(entry=>entry?.errorCode==='REQUEST_LIMIT_EXCEEDED');
    }
    const ambiguous=status===408||status===409||status>=500;
    const disposition=limited?'retry':ambiguous?(writing?'uncertain':'retry'):'rejected';
    const operation=writing?'upsert':'external ID lookup';
    return new FormDeliveryError(disposition,'Salesforce '+operation+' returned HTTP '+status+'.');
  }
  if(input.reconcile){
    const lookup=new URL(url);
    lookup.searchParams.set('fields','Id');
    let response:Response;
    try{response=await fetchImpl(lookup,{...options,signal:AbortSignal.timeout(10000)});}
    catch{throw new FormDeliveryError('retry','Salesforce lookup unavailable.');}
    if(response.status===200){
      const found=z.object({Id:recordId}).safeParse(await response.json().catch(()=>null));
      if(!found.success)throw new FormDeliveryError('uncertain','Salesforce lookup returned no record ID.');
      return {id:found.data.Id};
    }
    if(response.status!==404)throw await failure(response,false);
  }
  const body:Record<string,string>=Object.assign(Object.create(null),map.constants);
  for(const [source,destination] of Object.entries(map.fields)){
    const value=input.payload[source as keyof Mapping['fields']];
    if(value)body[destination]=value;
  }
  let response:Response;
  try{response=await fetchImpl(url,{...options,method:'PATCH',body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch{throw new FormDeliveryError('uncertain','Salesforce write acknowledgment unavailable.');}
  if(![200,201,204].includes(response.status))throw await failure(response,true);
  // Older API versions return an empty success. The stable external key identifies that record.
  if(response.status===204)return {id:key};
  const parsed=z.object({success:z.literal(true),id:recordId}).safeParse(await response.json().catch(()=>null));
  if(!parsed.success)
    throw new FormDeliveryError('uncertain','Salesforce returned an incomplete write acknowledgment.');
  return {id:parsed.data.id};
}

export function formNotificationMessage(destination:string,deliveryId:string,formId:string,payload:PortableLeadFormPayload){
  const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const parts=[['Form ID',formId],['Name',payload.name],['Email',payload.email],['Phone',payload.phone],['Message',payload.message]].filter(([,value])=>value);
  return {to:destination,subject:'New Harbor form submission',idempotencyKey:'harbor-form-'+deliveryId,
    text:parts.map(([k,v])=>k+': '+v).join('\n\n'),html:'<dl>'+parts.map(([k,v])=>'<dt>'+k+'</dt><dd>'+escape(v)+'</dd>').join('')+'</dl>'};
}
