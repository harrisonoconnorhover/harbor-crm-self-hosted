import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {ActivityCursor,MarketingCampaignInput,MarketingCampaignSummary,RecipientHistoryPage,RecipientHistoryQuery} from '../../lib/marketing-campaign';
import type {MarketingAudienceFilter} from '../../lib/marketing-audience';
import {eligibleMarketingRecipients,marketingAudienceStatus,marketingRecipientEligible} from './marketing-audience-store';
import {marketingCampaignActivations as activations,marketingCampaigns as campaigns,marketingRecipients as recipients} from './marketing-campaign-schema';
import {marketingAudienceSync} from './marketing-audience-schema';
import {marketingDesigns} from './marketing-design-schema';
import {insertEmailUnsubscribeToken} from './email-suppression-store';
import {privateWorkspaces} from './workspace-schema';
import {escapeEmailText} from '../../lib/email/rich-text';
import {deferResend,resendCoolingDown,resendRetryDelay} from './marketing-mail-cooldown';
import {marketingMailSender,sendMarketingEmail} from '../../lib/marketing-mail-transport.mjs';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];

export async function listMarketingCampaigns(db:Db,workspaceId:string,after?:ActivityCursor):Promise<{items:MarketingCampaignSummary[];next:string|null}>{
  const rows=await db.select({id:campaigns.id,name:campaigns.name,paused:campaigns.paused,createdAt:campaigns.createdAt,sendAfter:campaigns.sendAfter,
    active:sql<boolean>`${activations.campaignId} IS NOT NULL`,sourceChanged:sql<boolean>`${marketingAudienceSync.sourceKey} IS DISTINCT FROM ${campaigns.sourceKey}`,audienceSize:campaigns.audienceSize}).from(campaigns)
    .leftJoin(marketingAudienceSync,eq(marketingAudienceSync.workspaceId,campaigns.workspaceId))
    .leftJoin(activations,and(eq(activations.workspaceId,campaigns.workspaceId),eq(activations.campaignId,campaigns.id)))
    .where(and(eq(campaigns.workspaceId,workspaceId),after?sql`(${campaigns.createdAt},${campaigns.id}) < (${after.at},${after.id}::uuid)`:undefined))
    .orderBy(desc(campaigns.createdAt),desc(campaigns.id)).limit(26);
  const page=rows.slice(0,25),last=page.at(-1);
  if(!last)return {items:[],next:null};
  const counts=await db.select({campaignId:recipients.campaignId,state:recipients.state,total:sql<number>`count(*)::int`})
    .from(recipients).where(and(eq(recipients.workspaceId,workspaceId),inArray(recipients.campaignId,page.map(r=>r.id))))
    .groupBy(recipients.campaignId,recipients.state);
  return {items:page.map(row=>({...row,states:Object.fromEntries(counts.filter(c=>c.campaignId===row.id).map(c=>[c.state,c.total]))})),
    next:rows.length>25?last.createdAt+':'+last.id:null};
}

export async function recipientCampaignHistory(db:Db,workspaceId:string,{email,after}:RecipientHistoryQuery):Promise<RecipientHistoryPage>{
  const rows=await db.select({id:campaigns.id,name:campaigns.name,createdAt:campaigns.createdAt,
    state:recipients.state,attempts:recipients.attempts,providerId:recipients.providerId,lastIssue:recipients.lastIssue})
    .from(campaigns).innerJoin(recipients,and(eq(recipients.workspaceId,campaigns.workspaceId),eq(recipients.campaignId,campaigns.id),
      eq(recipients.email,email))).where(and(eq(campaigns.workspaceId,workspaceId),
      after?sql`(${campaigns.createdAt},${campaigns.id})<(${after.createdAt},${after.id}::uuid)`:undefined))
    .orderBy(desc(campaigns.createdAt),desc(campaigns.id)).limit(26);
  const items=rows.slice(0,25),last=items.at(-1);
  return {items,next:rows.length>25&&last?{createdAt:last.createdAt,id:last.id}:null};
}

// Use the database clock so every web and sender replica sees the same confirmation deadline.
const databaseTime=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint`;
const needsDecision=sql`(${recipients.state} IN ('uncertain','failed') OR
  (${recipients.state}='sending' AND ${recipients.dueAt}<=${databaseTime}))`;
const overdueMessage='Confirmation overdue. Check the email provider for a receipt.';

export async function marketingDeliveryIssues(db:Db,workspaceId:string,after?:ActivityCursor){
  const rows=await db.select({dueAt:recipients.dueAt,id:recipients.id,campaignId:recipients.campaignId,campaignName:campaigns.name,email:recipients.email,state:recipients.state,attempts:recipients.attempts,
    lastIssue:sql<string|null>`CASE WHEN ${recipients.state}='sending' THEN ${overdueMessage} ELSE ${recipients.lastIssue} END`})
    .from(recipients).innerJoin(campaigns,and(eq(campaigns.workspaceId,recipients.workspaceId),eq(campaigns.id,recipients.campaignId)))
    .where(and(eq(recipients.workspaceId,workspaceId),needsDecision,
      after?sql`(${recipients.dueAt}<${after.at} OR (${recipients.dueAt}=${after.at} AND ${recipients.id}>${after.id}::uuid))`:undefined))
    .orderBy(desc(recipients.dueAt),recipients.id).limit(26);
  const items=rows.slice(0,25),last=items.at(-1);
  return {items,next:rows.length>25&&last?last.dueAt+':'+last.id:null};
}

async function workspaceLock(tx:Tx,workspaceId:string){
  const [workspace]=await tx.select({id:privateWorkspaces.id,owner:privateWorkspaces.ownerId}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.id,workspaceId)).for('no key update');
  if(!workspace)throw new ApiError(404,'Marketing workspace unavailable.');
  return workspace;
}

export function queueMarketingCampaign(db:Db,workspaceId:string,actorId:string,input:MarketingCampaignInput){
  return db.transaction(async tx=>{
    const workspace=await workspaceLock(tx,workspaceId);
    if(workspace.owner!==actorId)throw new ApiError(403,'Workspace owner access is required.');
    const [previous]=await tx.select({id:campaigns.id,name:campaigns.name,designId:campaigns.designId,
      revision:campaigns.designRevision,filter:campaigns.filter,sendAfter:campaigns.sendAfter,total:campaigns.audienceSize}).from(campaigns)
      .where(and(eq(campaigns.workspaceId,workspaceId),eq(campaigns.id,input.id)));
    if(previous){
      if(previous.name!==input.name||previous.designId!==input.designId||previous.revision!==input.designRevision||
        previous.sendAfter!==(input.sendAfter??null)||previous.total!==input.expectedTotal||['account','related'].some(key=>{
          const prop=key as keyof MarketingAudienceFilter;
          return previous.filter[prop]?.field!==input.filter[prop]?.field||previous.filter[prop]?.value!==input.filter[prop]?.value;
        }))throw new ApiError(409,'This campaign ID already belongs to a different draft.');
      return {id:previous.id,total:previous.total};
    }
    if(input.sendAfter&&input.sendAfter<Date.now()-60000)throw new ApiError(400,'Choose a future send time or clear the schedule.');
    const [source]=await tx.execute<{source_key:string}>(sql`SELECT source_key FROM portable_marketing_audience_sync WHERE workspace_id=${workspaceId} FOR SHARE`);
    const status=await marketingAudienceStatus(tx,workspaceId);
    if(status.state!=='ready'||status.generation!==input.snapshot||!source)throw new ApiError(409,'Salesforce audience changed. Preview again.');
    const [design]=await tx.select().from(marketingDesigns)
      .where(and(eq(marketingDesigns.workspaceId,workspaceId),eq(marketingDesigns.id,input.designId))).for('share');
    if(!design||design.revision!==input.designRevision||!design.html.trim()||!design.subject.trim()||/[\r\n]/.test(design.subject)){
      throw new ApiError(409,'Choose a saved design with an up-to-date subject and email body.');
    }
    await tx.insert(campaigns).values({workspaceId,id:input.id,name:input.name,filter:input.filter,sourceKey:source.source_key,designId:design.id,
      designRevision:design.revision,html:design.html,plainText:design.plainText??'',subject:design.subject,
      createdAt:Date.now(),sendAfter:input.sendAfter,audienceSize:input.expectedTotal});
    const rows=await tx.execute(sql`WITH admitted AS (
      INSERT INTO portable_marketing_recipients (workspace_id,campaign_id,email,due_at)
      SELECT ${workspaceId}::uuid,${input.id}::uuid,eligible.email,${input.sendAfter??0}::bigint FROM (${eligibleMarketingRecipients(workspaceId,input.filter)}) eligible
      RETURNING 1
    ) SELECT count(*)::int AS total FROM admitted`);
    if(Number(rows[0].total)!==input.expectedTotal)throw new ApiError(409,'The eligible audience changed. Preview it again.');
    await tx.insert(activations).values({workspaceId,campaignId:input.id});
    return {id:input.id,total:input.expectedTotal};
  });
}

export function setMarketingCampaignPaused(db:Db,workspaceId:string,actorId:string,id:string,paused:boolean){
  return db.transaction(async tx=>{
    if((await workspaceLock(tx,workspaceId)).owner!==actorId)throw new ApiError(403,'Workspace owner access is required.');
    const [row]=await tx.update(campaigns).set({paused}).where(and(eq(campaigns.workspaceId,workspaceId),eq(campaigns.id,id))).returning({id:campaigns.id});
    if(!row)throw new ApiError(404,'Campaign not found.');
  });
}

export function resolveMarketingIssue(db:Db,workspaceId:string,actorId:string,id:string,resolution:'skip'|'accepted',providerId?:string,expectedAttempt?:number){
  if(resolution==='accepted'&&!providerId)throw new ApiError(400,'Enter the verified provider message ID.');
  return db.transaction(async tx=>{
    if((await workspaceLock(tx,workspaceId)).owner!==actorId)throw new ApiError(403,'Workspace owner access is required.');
    // Older clients could only review settled failures and uncertain attempts.
    const reviewable=expectedAttempt===undefined?inArray(recipients.state,['uncertain','failed']):
      and(needsDecision,eq(recipients.attempts,expectedAttempt));
    const [row]=await tx.update(recipients).set({state:resolution==='skip'?'skipped':'accepted',
      providerId:resolution==='accepted'?providerId:null,lastIssue:resolution==='skip'?'Closed by operator.':null})
      .where(and(eq(recipients.workspaceId,workspaceId),eq(recipients.id,id),reviewable)).returning({id:recipients.id});
    if(!row)throw new ApiError(409,'This delivery no longer needs a decision.');
  });
}

export function marketingCampaignSenderReady(env:NodeJS.ProcessEnv){
  const origin=URL.parse(env.HARBOR_LOGIN_ORIGIN??'');
  return !!(marketingMailSender(env)&&origin?.protocol==='https:'&&origin.origin===env.HARBOR_LOGIN_ORIGIN&&
    env.HARBOR_MARKETING_POSTAL_ADDRESS?.trim()&&env.HARBOR_RESEND_WEBHOOK_SECRET?.startsWith('whsec_')&&env.HARBOR_MARKETING_DELIVERY_ENABLED==='true');
}

export async function runMarketingCampaignPass(db:Db,workspaceId:string,env:NodeJS.ProcessEnv=process.env,send=sendMarketingEmail,stop?:AbortSignal){
  if(!marketingCampaignSenderReady(env))throw new ApiError(503,'Configure the email sender, postal address, public HTTPS origin and provider feedback before dispatch.');
  const now=Date.now();
  const claim=await db.transaction(async tx=>{
    const workspace=await workspaceLock(tx,workspaceId);
    const stale=await tx.execute(sql`UPDATE portable_marketing_recipients SET state='uncertain',last_issue='Worker stopped before confirmation.'
      WHERE id=(SELECT id FROM portable_marketing_recipients WHERE workspace_id=${workspaceId} AND state='sending' AND due_at<=${databaseTime}
        ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`);
    if(stale.length)return {outcome:'uncertain'} as const;
    if(await resendCoolingDown(tx))return {outcome:'throttled'} as const;
    await tx.execute(sql`SELECT 1 FROM portable_marketing_audience_sync WHERE workspace_id=${workspaceId} FOR SHARE`);
    if((await marketingAudienceStatus(tx,workspaceId)).state!=='ready')return {outcome:'waiting_for_sync'} as const;
    const [row]=await tx.execute<{id:string;email:string;attempts:number;state:'queued'|'retry';due_at:string;last_issue:string|null;filter_json:string;subject:string;html:string;plain_text:string}>(sql`
      SELECT r.id,r.email,r.attempts,r.state,r.due_at,r.last_issue,c.filter::text AS filter_json,c.subject,c.html,c.plain_text FROM portable_marketing_recipients r
      JOIN portable_marketing_campaigns c ON (c.workspace_id,c.id)=(r.workspace_id,r.campaign_id)
      JOIN portable_marketing_audience_sync s ON s.workspace_id=c.workspace_id AND s.source_key=c.source_key
      JOIN portable_marketing_campaign_activations a ON (a.workspace_id,a.campaign_id)=(c.workspace_id,c.id)
      WHERE r.workspace_id=${workspaceId} AND r.state IN ('queued','retry') AND r.due_at<=${now} AND NOT c.paused
      ORDER BY r.due_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED FOR SHARE OF c`);
    if(!row)return {outcome:'idle'} as const;
    if(!await marketingRecipientEligible(tx,workspaceId,JSON.parse(row.filter_json),row.email)){
      await tx.update(recipients).set({state:'skipped',lastIssue:'Address is no longer eligible.'}).where(eq(recipients.id,row.id));
      return {outcome:'skipped'} as const;
    }
    if(stop?.aborted)return {outcome:'stopped'} as const;
    const token=await insertEmailUnsubscribeToken(tx,workspaceId,workspace.owner,row.email);
    await tx.update(recipients).set({state:'sending',attempts:row.attempts+1,dueAt:sql`${databaseTime}+120000`,lastIssue:null}).where(eq(recipients.id,row.id));
    return {outcome:'claimed',row,token} as const;
  });
  if(claim.outcome!=='claimed')return claim.outcome;
  const {row,token}=claim;
  const manual=env.HARBOR_LOGIN_ORIGIN+'/email/unsubscribe#'+token;
  const oneClick=env.HARBOR_LOGIN_ORIGIN+'/api/marketing/unsubscribe?token='+token;
  const address=env.HARBOR_MARKETING_POSTAL_ADDRESS!.trim();
  const footer='<p>'+escapeEmailText(address)+'<br><a href="'+manual+'">Unsubscribe</a></p>';
  const html=/<\/body\s*>/i.test(row.html)?row.html.replace(/<\/body\s*>/i,()=>footer+'</body>'):row.html+footer;
  const attempt=and(eq(recipients.workspaceId,workspaceId),eq(recipients.id,row.id),eq(recipients.attempts,row.attempts+1));
  // Another worker, provider feedback or an operator may already have recorded the outcome.
  async function recordedOutcome(reader:Pick<Db,'select'>){
    const [saved]=await reader.select({state:recipients.state}).from(recipients).where(attempt);
    if(!saved)throw Error('Could not reconcile the campaign delivery attempt.');
    return saved.state;
  }
  if(stop?.aborted){
    // The claim committed, but the transport was never called. Leave the provider attempt available.
    const [released]=await db.update(recipients).set({state:row.state,attempts:row.attempts,
      dueAt:Number(row.due_at),lastIssue:row.last_issue}).where(and(attempt,eq(recipients.state,'sending')))
      .returning({id:recipients.id});
    return released?'stopped':recordedOutcome(db);
  }
  let receipt:{id:string};
  try{
    receipt=await send({to:row.email,subject:row.subject,html,text:(row.plain_text||row.subject)+'\n\n'+address+'\nUnsubscribe: '+manual,
      headers:{'List-Unsubscribe':'<'+oneClick+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},
      tag:row.id,idempotencyKey:'harbor-marketing/'+workspaceId+'/'+row.id+'/'+(row.attempts+1)},env);
  }catch(error){
    const providerError=error instanceof Error&&error.name==='MarketingMailError'&&'disposition' in error;
    const disposition=providerError?error.disposition:'uncertain';
    const state=disposition==='retry'&&row.attempts<7?'retry':disposition==='uncertain'?'uncertain':'failed';
    const providerDelay=resendRetryDelay(error);
    const delay=Math.max(providerDelay??0,Math.min(3600000,30000*2**row.attempts));
    return db.transaction(async tx=>{
      if(providerDelay!==null)await deferResend(tx,providerDelay);
      const [saved]=await tx.update(recipients).set({state,dueAt:Date.now()+delay,
        lastIssue:providerError?error.message:'No provider confirmation.'}).where(and(attempt,eq(recipients.state,'sending')))
        .returning({state:recipients.state});
      return saved?.state??recordedOutcome(tx);
    });
  }
  // A webhook can record a terminal outcome before the API response or after our lease expires.
  const [saved]=await db.update(recipients).set({state:'accepted',providerId:receipt.id,lastIssue:null})
    .where(and(attempt,inArray(recipients.state,['sending','uncertain']))).returning({state:recipients.state});
  return saved?.state??recordedOutcome(db);
}
