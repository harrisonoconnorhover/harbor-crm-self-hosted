import {and,asc,count,eq,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableExternalRecordKind} from '../../lib/portable-api-tokens';
import {lockRecordWorkspace} from './private-workspace-store';
import {webhookDeliveries as deliveries,webhookSubscriptions as subscriptions} from './webhook-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Destinations=(workspaceId:string)=>string[];
type Cursor={afterAt:string;afterId:string};
type ReceiptFilters={attention?:boolean;eventId?:string;recordId?:string;object?:PortableExternalRecordKind};
const receiptPageSize=25;
const subscriptionLimit=16;
const subscriptionFields={id:subscriptions.id,destination:subscriptions.destination,objects:subscriptions.objects,createdAt:subscriptions.createdAt};

export async function readWebhookSettings(db:PostgresJsDatabase,ownerId:string,destinationsFor:Destinations,cursor?:Cursor,{attention,eventId,recordId,object}:ReceiptFilters={}){
  return db.transaction(async tx=>{
    // Transfer and grant changes cannot switch the owner between the permission check and the page read.
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false);
    if(!workspaceId)return {workspaceId:null,destinations:[] as string[],configurationIssue:false,subscriptions:[],deliveries:[],next:null};
    let destinations:string[]=[],configurationIssue=false;
    try{destinations=destinationsFor(workspaceId);}catch{configurationIssue=true;}
    const registered=await tx.select(subscriptionFields).from(subscriptions)
      .where(eq(subscriptions.workspaceId,workspaceId)).orderBy(asc(subscriptions.destination)).limit(subscriptionLimit);
    const rows=await tx.select({
      id:deliveries.id,subscriptionId:deliveries.subscriptionId,destination:subscriptions.destination,objectKind:deliveries.objectKind,
      recordId:deliveries.recordId,revision:deliveries.revision,action:deliveries.action,status:deliveries.status,
      attempts:deliveries.attempts,httpStatus:deliveries.httpStatus,
      ownerConfirmed:sql<boolean>`${deliveries.confirmedBy} IS NOT NULL`,finishedAt:deliveries.finishedAt,
      occurredAt:sql<string>`to_char(${deliveries.occurredAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(deliveries).innerJoin(subscriptions,and(eq(subscriptions.workspaceId,deliveries.workspaceId),eq(subscriptions.id,deliveries.subscriptionId)))
      .where(and(eq(deliveries.workspaceId,workspaceId),eventId?eq(deliveries.id,eventId):undefined,
        recordId?eq(deliveries.recordId,recordId):undefined,object?eq(deliveries.objectKind,object):undefined,
        attention?inArray(deliveries.status,['failed','uncertain']):undefined,
        cursor?sql`(${deliveries.occurredAt},${deliveries.id}) < (${cursor.afterAt}::timestamptz,${cursor.afterId}::uuid)`:undefined))
      .orderBy(sql`${deliveries.occurredAt} DESC NULLS LAST`,sql`${deliveries.id} DESC NULLS LAST`).limit(receiptPageSize+1);
    const visible=rows.slice(0,receiptPageSize),last=visible.at(-1);
    return {workspaceId,destinations,configurationIssue,subscriptions:registered,deliveries:visible,
      next:rows.length>receiptPageSize&&last?{afterAt:last.occurredAt,afterId:last.id}:null};
  });
}
export type WebhookSettingsPage=Awaited<ReturnType<typeof readWebhookSettings>>;

type Change={action:'subscribe';destination:string;objects:PortableExternalRecordKind[]}|{action:'remove';id:string}|
  {action:'edit_objects';id:string;objects:PortableExternalRecordKind[];expectedObjects:PortableExternalRecordKind[]}|
  {action:'retry'|'confirm_received';id:string;expectedAttempts:number;confirmed:true};

export async function changeWebhookSettings(tx:Transaction,ownerId:string,change:Change,destinationsFor:Destinations){
  const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
  if(!workspaceId)throw new ApiError(404,'Create a workspace before managing subscriptions.');
  if(change.action==='subscribe'){
    if(!destinationsFor(workspaceId).includes(change.destination))throw new ApiError(400,'Choose a configured destination.');
    const [{total}]=await tx.select({total:count()}).from(subscriptions).where(eq(subscriptions.workspaceId,workspaceId));
    if(total>=subscriptionLimit)throw new ApiError(409,'This workspace has reached its subscription limit.');
    const [subscription]=await tx.insert(subscriptions).values({workspaceId,id:crypto.randomUUID(),destination:change.destination,
      objects:change.objects,createdAt:new Date().toISOString()}).onConflictDoNothing().returning(subscriptionFields);
    if(!subscription)throw new ApiError(409,'This destination is already subscribed.');
    return {subscription};
  }
  if(change.action==='remove'||change.action==='edit_objects'){
    const own=and(eq(subscriptions.workspaceId,workspaceId),eq(subscriptions.id,change.id));
    const [subscription]=await tx.select(subscriptionFields).from(subscriptions).where(own).for('update');
    if(!subscription)throw new ApiError(404,'Subscription unavailable.');
    if(change.action==='edit_objects'){
      const matches=(objects:string[])=>subscription.objects.length===objects.length&&objects.every(kind=>subscription.objects.includes(kind));
      if(matches(change.objects))return {subscription};
      if(!matches(change.expectedObjects))throw new ApiError(409,'The selected record types changed. Refresh deliveries and review the subscription again.');
      if(!destinationsFor(workspaceId).includes(subscription.destination))throw new ApiError(409,'Ask the operator to configure this destination before editing its subscription.');
      const [updated]=await tx.update(subscriptions).set({objects:change.objects}).where(own).returning(subscriptionFields);
      return {subscription:updated};
    }
    const [inFlight]=await tx.select({id:deliveries.id}).from(deliveries)
      .where(and(eq(deliveries.workspaceId,workspaceId),eq(deliveries.subscriptionId,change.id),eq(deliveries.status,'sending'))).limit(1);
    if(inFlight)throw new ApiError(409,'A delivery is in progress. Refresh before removing this subscription.');
    await tx.delete(subscriptions).where(own);
    return {removed:true};
  }
  const own=and(eq(deliveries.workspaceId,workspaceId),eq(deliveries.id,change.id));
  const [receipt]=await tx.select({destination:subscriptions.destination}).from(deliveries)
    .innerJoin(subscriptions,and(eq(subscriptions.workspaceId,deliveries.workspaceId),eq(subscriptions.id,deliveries.subscriptionId))).where(own);
  if(!receipt)throw new ApiError(404,'Delivery unavailable.');
  if(change.action==='confirm_received'){
    const [confirmed]=await tx.update(deliveries).set({status:'delivered',confirmedBy:ownerId,finishedAt:sql`clock_timestamp()`})
      .where(and(own,eq(deliveries.status,'uncertain'),eq(deliveries.attempts,change.expectedAttempts))).returning({id:deliveries.id});
    if(!confirmed)throw new ApiError(409,'Delivery changed. Refresh its status before confirming receipt.');
    return {confirmed:true};
  }
  if(!destinationsFor(workspaceId).includes(receipt.destination))throw new ApiError(409,'Ask the operator to configure this destination before retrying.');
  const [queued]=await tx.update(deliveries).set({status:'pending',httpStatus:null,attemptedAt:null,
    finishedAt:null,availableAt:sql`clock_timestamp()`}).where(and(own,
    inArray(deliveries.status,['failed','uncertain']),eq(deliveries.attempts,change.expectedAttempts))).returning({id:deliveries.id});
  if(!queued)throw new ApiError(409,'Delivery changed. Refresh its status before retrying.');
  return {queued:true};
}
