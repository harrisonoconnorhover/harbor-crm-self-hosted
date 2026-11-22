import {createHmac} from 'node:crypto';
import type {Sql} from 'postgres';
import {webhookDestinations,type WebhookDestination} from './portable-webhook-config';

type Claim={
  id:string;workspace_id:string;subscription_id:string;object_kind:string;record_id:string;revision:number;
  action:string;occurred_at:Date|string;attempts:number;attempt_key:string;
};

// The receiver must respond within eight seconds. A missing response or receipt stays uncertain.
const sendTimeout=8_000;
const maxAutomaticAttempts=5;

async function claimDelivery(db:Sql,destinations:WebhookDestination[]){
  // The database only sees configured names. Receiver URLs and signing keys stay in the worker.
  const allowed=destinations.map(d=>({workspace_id:d.workspaceId,name:d.name}));
  const [claim]=await db<(Claim&{destination:string})[]>`
    WITH subscription AS MATERIALIZED (
      SELECT s.id,s.workspace_id,s.destination FROM portable_webhook_subscriptions s
      JOIN jsonb_to_recordset(${JSON.stringify(allowed)}::text::jsonb) AS a(workspace_id uuid,name text)
        ON a.workspace_id=s.workspace_id AND a.name=s.destination
      JOIN LATERAL (
        SELECT d.available_at,d.id FROM portable_webhook_deliveries d
        WHERE d.workspace_id=s.workspace_id AND d.subscription_id=s.id AND d.status='pending'
          AND d.available_at<=statement_timestamp()
        ORDER BY d.available_at,d.id LIMIT 1
      ) next ON true
      LEFT JOIN LATERAL (
        SELECT d.attempted_at FROM portable_webhook_deliveries d
        WHERE d.workspace_id=s.workspace_id AND d.attempted_at IS NOT NULL
        ORDER BY d.attempted_at DESC NULLS LAST LIMIT 1
      ) last ON true
      ORDER BY last.attempted_at NULLS FIRST,next.available_at,next.id
      LIMIT 1 FOR SHARE OF s SKIP LOCKED
    ), candidate AS MATERIALIZED (
      SELECT next.id,s.destination FROM subscription s
      JOIN LATERAL (
        SELECT d.id FROM portable_webhook_deliveries d
        WHERE d.workspace_id=s.workspace_id AND d.subscription_id=s.id AND d.status='pending'
          AND d.available_at<=statement_timestamp()
        ORDER BY d.available_at,d.id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) next ON true
    )
    UPDATE portable_webhook_deliveries d SET status='sending',attempts=attempts+1,
      attempted_at=clock_timestamp(),http_status=NULL,finished_at=NULL
    FROM candidate c WHERE d.id=c.id
    RETURNING d.id,workspace_id,subscription_id,object_kind,record_id,revision,action,occurred_at,attempts,
      attempted_at::text AS attempt_key,c.destination`;
  if(!claim)return null;
  const destination=destinations.find(d=>d.workspaceId===claim.workspace_id&&d.name===claim.destination)!;
  return {claim,destination};
}

function retryDelay(value:string|null,attempt:number){
  const fallback=5*2**Math.min(attempt-1,5);
  if(!value)return fallback;
  const seconds=/^\d+$/.test(value)?Number(value):Math.ceil((Date.parse(value)-Date.now())/1000);
  return Number.isNaN(seconds)?fallback:Math.max(fallback,seconds);
}

export async function deliverSignedWebhook(event:{id:string}&Record<string,unknown>,attempt:number,destination:WebhookDestination,signal?:AbortSignal){
  const body=JSON.stringify(event);
  const timestamp=Math.floor(Date.now()/1000).toString();
  const signature=createHmac('sha256',destination.secret).update(timestamp+'.'+body).digest('hex');
  const timeout=AbortSignal.timeout(sendTimeout);
  let response:Response;
  try{
    response=await fetch(destination.url,{method:'POST',redirect:'manual',signal:signal?AbortSignal.any([timeout,signal]):timeout,
      headers:{'Content-Type':'application/json','Idempotency-Key':event.id,'X-Harbor-Event-Id':event.id,
        'X-Harbor-Timestamp':timestamp,'X-Harbor-Signature':'sha256='+signature},body});
  }catch{return {status:'uncertain',httpStatus:null,delay:0} as const;}
  // The HTTP status is the acknowledgement. Never buffer or log a receiver's response body.
  void response.body?.cancel().catch(()=>{});
  const httpStatus=response.status;
  if(response.ok)return {status:'delivered',httpStatus,delay:0} as const;
  if(httpStatus===429&&attempt<maxAutomaticAttempts){
    const wait=retryDelay(response.headers.get('retry-after'),attempt);
    // A longer requested wait goes to an operator; never retry sooner than the receiver requested.
    if(wait<=86400)return {status:'pending',httpStatus,delay:wait} as const;
  }
  return {status:httpStatus===408||httpStatus>=500?'uncertain':'failed',httpStatus,delay:0} as const;
}

export async function runPortableWebhookPass(db:Sql,signal?:AbortSignal){
  if(process.env.HARBOR_WEBHOOK_DELIVERY_ENABLED!=='true'||signal?.aborted)return 'disabled';
  const destinations=webhookDestinations();
  // Abandoned claims may already have reached the receiver, even when the destination has since been removed.
  await db`UPDATE portable_webhook_deliveries d SET status='uncertain',finished_at=clock_timestamp()
    FROM (SELECT workspace_id,id FROM portable_webhook_deliveries
      WHERE status='sending' AND attempted_at<statement_timestamp()-interval '1 minute'
      ORDER BY attempted_at,id LIMIT 20 FOR UPDATE SKIP LOCKED) abandoned
    WHERE d.workspace_id=abandoned.workspace_id AND d.id=abandoned.id`;
  await db`DELETE FROM portable_webhook_deliveries d USING (
      SELECT id FROM portable_webhook_deliveries WHERE status='delivered' AND finished_at<statement_timestamp()-interval '30 days'
      ORDER BY finished_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) expired
    WHERE d.id=expired.id`;
  if(!destinations.length||signal?.aborted)return 'idle';
  const started=performance.now();
  const work=await claimDelivery(db,destinations);
  if(!work)return 'idle';
  const {claim,destination}=work;
  const result=performance.now()-started>sendTimeout||signal?.aborted?
    {status:'uncertain',httpStatus:null,delay:0}:await deliverSignedWebhook({
      id:claim.id,workspaceId:claim.workspace_id,subscriptionId:claim.subscription_id,
      object:claim.object_kind,recordId:claim.record_id,revision:claim.revision,action:claim.action,
      occurredAt:new Date(claim.occurred_at).toISOString(),
    },claim.attempts,destination,signal);
  const ack=await db`UPDATE portable_webhook_deliveries SET status=${result.status},http_status=${result.httpStatus},
    finished_at=CASE WHEN ${result.status}='pending' THEN NULL ELSE clock_timestamp() END,
    available_at=CASE WHEN ${result.status}='pending' THEN clock_timestamp()+${result.delay}::int*interval '1 second' ELSE available_at END
    WHERE workspace_id=${claim.workspace_id} AND id=${claim.id} AND status='sending'
      AND attempts=${claim.attempts} AND attempted_at=${claim.attempt_key}::text::timestamptz`;
  return ack.count?result.status:'uncertain';
}
