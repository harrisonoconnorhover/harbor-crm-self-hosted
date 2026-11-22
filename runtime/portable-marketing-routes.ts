import {z} from 'zod';
import {eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {listLeadForms} from '../db/postgres/lead-form-store';
import {marketingFormRoutes} from '../db/postgres/marketing-form-schema';
import {configureMarketingForm,listMarketingFormDeliveries} from '../db/postgres/marketing-form-store';
import {internalFormRecipients,salesforceFormTarget} from '../lib/marketing-form-delivery';
import {marketingAudiencePage} from '../db/postgres/marketing-audience-store';
import {resendCooldownUntil} from '../db/postgres/marketing-mail-cooldown';
import {listMarketingCampaigns,marketingDeliveryIssues,recipientCampaignHistory,queueMarketingCampaign,resolveMarketingIssue,setMarketingCampaignPaused} from '../db/postgres/marketing-campaign-store';
import {marketingWorkspaceForOwner} from '../db/postgres/marketing-workspace-store';
import {marketingAudienceFilter} from '../lib/marketing-audience';
import {marketingActivityQuery,marketingCampaignInput,recipientHistoryQuery} from '../lib/marketing-campaign';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
const bodySchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('formSettings')}).strict(),
  z.object({action:z.literal('configureForm'),formId:z.uuid(),recipients:z.array(z.email()).max(8),salesforce:z.boolean()}).strict(),
  marketingCampaignInput,recipientHistoryQuery,z.object({action:z.literal('preview'),filter:marketingAudienceFilter,after:z.email().optional()}).strict(),
  z.object({action:z.literal('pause'),id:z.uuid(),paused:z.boolean()}).strict(),
  z.object({action:z.literal('resolve'),id:z.uuid(),resolution:z.enum(['skip','accepted']),expectedAttempt:z.number().int().nonnegative().max(2147483647).optional(),providerId:z.string().trim().min(1).max(200).optional()}).strict(),
]);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store'}});
async function formSettings(db:PostgresJsDatabase,ws:string,actor:string){
  const [forms,routes,recent]=await Promise.all([listLeadForms(db,actor),db.select().from(marketingFormRoutes)
    .where(eq(marketingFormRoutes.workspaceId,ws)),listMarketingFormDeliveries(db,ws,20)]);
  let hasSalesforce=false;
  try{hasSalesforce=!!salesforceFormTarget(process.env);}catch{/* Setup is optional. */}
  return {forms:forms.map(form=>{
    const route=routes.find(r=>r.formId===form.id);
    return {id:form.id,title:form.definition.title,enabled:form.enabled,recipients:route?.recipients??[],salesforce:!!route?.salesforceTarget};
  }),allowlist:[...internalFormRecipients(process.env)].sort(),hasSalesforce,recent:recent.map(({id,formId,kind,state,issue})=>({id,formId,kind,state,issue}))};
}

export async function marketingCampaignRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const db=portableDb(),ws=await marketingWorkspaceForOwner(db,user.userId);
    if(request.method!=='POST'){
      const params=new URL(request.url).searchParams;
      const query=marketingActivityQuery.parse(Object.fromEntries(params));
      if(params.size!==Object.keys(query).length)return json({error:'Invalid campaign page.'},400);
      const [campaigns,issues,providerRetryAtMs]=await Promise.all([
        listMarketingCampaigns(db,ws,query.campaignAfter),marketingDeliveryIssues(db,ws,query.issueAfter),resendCooldownUntil(db)]);
      return json({campaigns:campaigns.items,campaignNext:campaigns.next,issues:issues.items,issueNext:issues.next,providerRetryAtMs});
    }
    const raw=await readBoundedRequestText(request,8192);
    if(raw===null)return json({error:'The campaign request is too large.'},413);
    const input=bodySchema.parse(JSON.parse(raw));
    if(input.action==='formSettings')return json(await formSettings(db,ws,user.userId));
    if(input.action==='configureForm'){
      const allowed=internalFormRecipients(process.env);
      if(input.recipients.some(email=>!allowed.has(email.toLowerCase())))throw new ApiError(400,'Choose an internal recipient configured by your operator.');
      if(input.salesforce){try{salesforceFormTarget(process.env);}catch{throw new ApiError(400,'The Salesforce submission mapping is unavailable.');}}
      await configureMarketingForm(db,ws,input.formId,{recipients:input.recipients,salesforce:input.salesforce},process.env,user.userId);
      return json(await formSettings(db,ws,user.userId));
    }
    if(input.action==='recipientHistory')return json(await recipientCampaignHistory(db,ws,input));
    if(input.action==='preview')return json(await marketingAudiencePage(db,ws,input.filter,input.after));
    if(input.action==='queue')return json(await queueMarketingCampaign(db,ws,user.userId,input));
    if(input.action==='pause')await setMarketingCampaignPaused(db,ws,user.userId,input.id,input.paused);
    else await resolveMarketingIssue(db,ws,user.userId,input.id,input.resolution,input.providerId,input.expectedAttempt);
    return json({ok:true});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:'Check the campaign fields and try again.'},400);
    return json({error:'Could not confirm the campaign request. Refresh before trying again.'},503);
  }
}
