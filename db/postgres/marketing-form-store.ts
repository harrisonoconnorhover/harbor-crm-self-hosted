import {and,asc,desc,eq,inArray,lte,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {sendMarketingEmail} from '../../lib/marketing-mail-transport.mjs';
import {leadFormActivations,leadForms,leadInquiries} from './lead-form-schema';
import {marketingFormDeliveries as jobs,marketingFormRoutes as routes} from './marketing-form-schema';
import {deferResend,resendCoolingDown,resendRetryDelay} from './marketing-mail-cooldown';
import {privateWorkspaces} from './workspace-schema';
import {assertFormMarketingWorkspace,deliverSalesforceInquiry,FormDeliveryError,formNotificationMessage,
  internalFormRecipients,parseMarketingFormRoute,salesforceFormTarget,type MarketingFormRouteInput} from '../../lib/marketing-form-delivery';
import type {PortableLeadFormPayload} from '../../lib/portable-lead-forms';

type Db=PostgresJsDatabase;
const clock=sql<number>`floor(extract(epoch from clock_timestamp())*1000)::bigint`.mapWith(Number);
const routingScope=(workspaceId:string,formId:string)=>and(eq(routes.workspaceId,workspaceId),eq(routes.formId,formId));
const jobScope=(workspaceId:string,id:string)=>and(eq(jobs.workspaceId,workspaceId),eq(jobs.id,id));
const maxAttempts=6;
const leaseMs=120_000;
const receiptId=(id:unknown):id is string=>typeof id==='string'&&/^[\w.@:/-]{1,240}$/.test(id);
type Mail=ReturnType<typeof formNotificationMessage>;
export type FormDeliveryProviders={
  notify:(message:Mail,env:NodeJS.ProcessEnv)=>Promise<{id:string}>;
  upsert:(input:{workspaceId:string;inquiryId:string;payload:PortableLeadFormPayload;reconcile:boolean},env:NodeJS.ProcessEnv)=>Promise<{id:string}>;
};

const providers:FormDeliveryProviders={
  notify:sendMarketingEmail,
  async upsert(input,env){
    const {salesforceApiFromEnv}=await import('../../lib/marketing-salesforce');
    return deliverSalesforceInquiry(input,env,salesforceApiFromEnv);
  },
};

export async function configureMarketingForm(db:Db,workspaceId:string,formId:string,config:MarketingFormRouteInput,env=process.env,actorId?:string){
  assertFormMarketingWorkspace(workspaceId,env);
  const target=parseMarketingFormRoute(config,env);
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id,owner:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,workspaceId)).for('no key update');
    if(!workspace||actorId!==undefined&&workspace.owner!==actorId)throw Error('Workspace unavailable.');
    const [form]=await tx.select({id:leadForms.id}).from(leadForms).where(and(eq(leadForms.workspaceId,workspaceId),eq(leadForms.id,formId)));
    if(!form)throw Error('Choose a form in this workspace.');
    const [current]=await tx.select().from(routes).where(routingScope(workspaceId,formId));
    if(current&&current.salesforceTarget===target.salesforceTarget&&JSON.stringify(current.recipients)===JSON.stringify(target.recipients))
      return {configured:true,recipients:current.recipients,salesforce:!!current.salesforceTarget};
    if(current)await tx.update(jobs).set({state:'skipped',nextAt:null,updatedAt:clock,issue:'Routing changed before dispatch.'})
      .where(and(eq(jobs.workspaceId,workspaceId),eq(jobs.formId,formId),eq(jobs.routeId,current.routeId),eq(jobs.state,'pending')));
    if(!target.recipients.length&&!target.salesforceTarget){
      if(current)await tx.delete(routes).where(routingScope(workspaceId,formId));
      return {configured:false,recipients:[],salesforce:false};
    }
    const routeId=crypto.randomUUID();
    await tx.insert(routes).values({workspaceId,formId,routeId,...target}).onConflictDoUpdate({
      target:[routes.workspaceId,routes.formId],set:{routeId,...target},
    });
    return {configured:true,recipients:target.recipients,salesforce:!!target.salesforceTarget};
  });
}

async function claim(db:Db,workspaceId:string,env:NodeJS.ProcessEnv){
  return db.transaction(async tx=>{
    const throttled=await resendCoolingDown(tx);
    const [job]=await tx.select().from(jobs).where(and(eq(jobs.workspaceId,workspaceId),
      inArray(jobs.state,['pending','sending']),lte(jobs.nextAt,clock),
      throttled?or(eq(jobs.kind,'salesforce'),eq(jobs.state,'sending')):undefined))
      .orderBy(asc(jobs.nextAt),asc(jobs.id)).limit(1).for('update',{skipLocked:true});
    if(!job)return {status:throttled?'throttled' as const:'idle' as const};
    const scope=jobScope(workspaceId,job.id);
    async function close(state:'skipped'|'uncertain'|'failed',issue:string){
      await tx.update(jobs).set({state,nextAt:null,updatedAt:clock,issue}).where(scope);
      return {status:state,id:job.id};
    }
    if(job.state==='sending'){
      // The lease expired after dispatch was durably marked. Never re-send an unacknowledged notification.
      return close('uncertain','Worker stopped during delivery. Check the provider receipt.');
    }
    const [source]=await tx.select({payload:leadInquiries.payload,routeId:routes.routeId,recipients:routes.recipients,target:routes.salesforceTarget,enabled:leadFormActivations.formId}).from(leadInquiries)
      .innerJoin(leadForms,and(eq(leadForms.id,leadInquiries.formId),eq(leadForms.workspaceId,leadInquiries.workspaceId)))
      .leftJoin(routes,routingScope(workspaceId,job.formId)).leftJoin(leadFormActivations,eq(leadFormActivations.formId,leadForms.id))
      .where(and(eq(leadInquiries.workspaceId,workspaceId),eq(leadInquiries.formId,job.formId),eq(leadInquiries.id,job.inquiryId)));
    if(!source?.payload||!source.enabled||source.routeId!==job.routeId||
       (job.kind==='email'?!source.recipients?.includes(job.destination):source.target!==job.destination))
      return close('skipped','Inquiry, form or routing is no longer active.');
    try{
      if(job.kind==='email'&&!internalFormRecipients(env).has(job.destination))
        return close('failed','This internal recipient is no longer configured.');
      if(job.kind==='salesforce'&&salesforceFormTarget(env).destination!==job.destination)
        return close('failed','Salesforce destination changed. Review before delivery.');
    }catch{return close('failed','Check the operator’s form delivery settings.');}
    const attempts=job.attempts+1;
    await tx.update(jobs).set({state:'sending',attempts,nextAt:sql`${clock}+${leaseMs}::bigint`,updatedAt:clock,issue:null}).where(scope);
    return {status:'claimed' as const,job:{...job,attempts},payload:source.payload};
  });
}

export async function runMarketingFormPass(db:Db,workspaceId:string,env=process.env,delivery:FormDeliveryProviders=providers,stop?:AbortSignal){
  assertFormMarketingWorkspace(workspaceId,env);
  if(env.HARBOR_MARKETING_DELIVERY_ENABLED!=='true')return {status:'disabled'};
  const work=await claim(db,workspaceId,env);
  if(work.status!=='claimed')return work;
  const {job,payload}=work;
  const owned=and(jobScope(workspaceId,job.id),eq(jobs.attempts,job.attempts),eq(jobs.state,'sending'));
  if(stop?.aborted){
    const [released]=await db.update(jobs).set({state:'pending',attempts:job.attempts-1,nextAt:job.nextAt,updatedAt:clock,
      issue:job.issue}).where(owned).returning({id:jobs.id});
    return {status:released?'stopped':'superseded',id:job.id};
  }
  let receipt:string;
  try{
    const result=job.kind==='email'
      ?await delivery.notify(formNotificationMessage(job.destination,job.id,job.formId,payload),env)
      :await delivery.upsert({workspaceId,inquiryId:job.inquiryId,payload,reconcile:job.attempts>1},env);
    if(!receiptId(result?.id))throw new FormDeliveryError('uncertain','Provider acknowledgment has no valid receipt.');
    receipt=result.id;
  }catch(error){
    const classification=typeof error==='object'&&error&&'disposition' in error?error.disposition:'uncertain';
    const disposition=classification==='rejected'||classification==='retry'?classification:'uncertain';
    const retry=job.attempts<maxAttempts&&disposition==='retry';
    const state=retry?'pending':disposition==='uncertain'?'uncertain':'failed';
    // Provider reply text may echo form data or a credential. Persist only our own controlled diagnostics.
    const issue=error instanceof FormDeliveryError?error.message:disposition==='rejected'?'Provider declined the request.':
      disposition==='retry'?'Provider asked Harbor to retry.':'Provider acknowledgment unavailable. Verify before retrying.';
    const providerDelay=job.kind==='email'?resendRetryDelay(error):null;
    const delay=Math.max(providerDelay??0,Math.min(3600000,30000*2**Math.min(job.attempts-1,10)));
    const updated=await db.transaction(async tx=>{
      if(providerDelay!==null)await deferResend(tx,providerDelay);
      return tx.update(jobs).set({state,updatedAt:clock,nextAt:retry?sql`${clock}+${delay}::bigint`:null,issue})
        .where(owned).returning({id:jobs.id});
    });
    return {status:updated.length?state:'superseded',id:job.id};
  }
  // A lost database acknowledgment leaves the lease recoverable. It is never classified as a provider rejection.
  const updated=await db.update(jobs).set({state:'succeeded',receipt,updatedAt:clock,nextAt:null,issue:null}).where(owned).returning({id:jobs.id});
  return {status:updated.length?'succeeded':'superseded',id:job.id};
}

export async function listMarketingFormDeliveries(db:Db,workspaceId:string,limit=50,env=process.env){
  assertFormMarketingWorkspace(workspaceId,env);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Choose 1–100 recent receipts.');
  return db.select({id:jobs.id,formId:jobs.formId,inquiryId:jobs.inquiryId,kind:jobs.kind,recipient:sql<string|null>`CASE WHEN ${jobs.kind}='email' THEN ${jobs.destination} END`,
    state:jobs.state,attempts:jobs.attempts,issue:jobs.issue,receipt:jobs.receipt,updatedAt:jobs.updatedAt,nextAt:jobs.nextAt})
    .from(jobs).where(eq(jobs.workspaceId,workspaceId)).orderBy(desc(jobs.createdAt),desc(jobs.id)).limit(limit);
}

export async function resolveMarketingFormDelivery(db:Db,workspaceId:string,deliveryId:string,decision:'confirmed'|'retry'|'skip',
  evidence?:string,env=process.env){
  assertFormMarketingWorkspace(workspaceId,env);
  if(!['confirmed','retry','skip'].includes(decision)||!receiptId(evidence))throw Error('Supply a provider receipt or investigation reference for this decision.');
  const state=decision==='confirmed'?'succeeded':decision==='retry'?'pending':'skipped';
  const [row]=await db.update(jobs).set({state,updatedAt:clock,nextAt:decision==='retry'?clock:null,
    receipt:evidence,issue:decision==='retry'?'Operator confirmed the provider did not accept this action.':
      decision==='skip'?'Operator closed this action.':null}).where(and(jobScope(workspaceId,deliveryId),inArray(jobs.state,['failed','uncertain'])))
    .returning({id:jobs.id,state:jobs.state});
  if(!row)throw Error('Choose a failed or uncertain receipt in this workspace.');
  return row;
}
