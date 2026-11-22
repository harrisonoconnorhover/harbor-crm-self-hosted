import {createHmac,timingSafeEqual} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {confirmEmailUnsubscribe} from '../db/postgres/email-suppression-store';
import {emailSuppressions} from '../db/postgres/email-suppression-schema';
import {marketingRecipients} from '../db/postgres/marketing-campaign-schema';
import {configuredMarketingWorkspace} from '../db/postgres/marketing-workspace-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {unsubscribeInput} from '../lib/email/unsubscribe';
import {portableDb} from './portable-db';

const reply=(status:number)=>new Response(null,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
export async function oneClick(request:Request){
  const url=new URL(request.url);
  const valid=unsubscribeInput.safeParse({token:url.searchParams.get('token')});
  if(!valid.success||url.searchParams.size!==1)return reply(400);
  if(request.method==='GET'||request.method==='HEAD'){
    return new Response(null,{status:303,headers:{location:'/email/unsubscribe#'+valid.data.token,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  }
  const type=request.headers.get('content-type')??'';
  if(!/^(application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(type))return reply(415);
  const raw=await readBoundedRequestText(request,2048);
  if(raw===null)return reply(413);
  let form:FormData;
  try{form=await new Response(raw,{headers:{'content-type':type}}).formData();}catch{return reply(400);}
  if(form.get('List-Unsubscribe')!=='One-Click')return reply(400);
  return reply(await confirmEmailUnsubscribe(portableDb(),valid.data.token)?204:404);
}

export function validMarketingSignature(raw:string,headers:Headers,secret:string,now=Date.now()){
  const id=headers.get('svix-id'),stamp=headers.get('svix-timestamp'),signatures=headers.get('svix-signature');
  if(!id||!stamp||!/^\d+$/.test(stamp)||Math.abs(Math.floor(now/1000)-Number(stamp))>300||!signatures||!secret.startsWith('whsec_'))return false;
  const key=Buffer.from(secret.slice(6),'base64');
  if(!key.length)return false;
  const expected=createHmac('sha256',key).update(id+'.'+stamp+'.'+raw).digest();
  return signatures.split(' ').some(signature=>{
    if(!/^v1,[A-Za-z0-9+/]+=*$/.test(signature))return false;
    const bytes=Buffer.from(signature.slice(3),'base64');
    return bytes.length===expected.length&&timingSafeEqual(bytes,expected);
  });
}

const feedbackType=z.enum(['email.delivered','email.suppressed','email.bounced','email.complained']);
const receiptStates={
  'email.delivered':'delivered','email.suppressed':'suppressed','email.bounced':'bounced','email.complained':'complained',
} as const;
const feedback=z.object({type:feedbackType,data:z.object({email_id:z.string().max(200),to:z.array(z.string()).length(1),
  tags:z.record(z.string(),z.string()).optional(),bounce:z.object({type:z.string()}).optional()})});
export async function recordMarketingFeedback(db:PostgresJsDatabase,ws:string,event:z.infer<typeof feedback>){
  const tag=z.uuid().safeParse(event.data.tags?.harbor_delivery);
  const state=receiptStates[event.type];
  if(!tag.success)return;
  await db.transaction(async tx=>{
    const [r]=await tx.select().from(marketingRecipients).where(and(eq(marketingRecipients.workspaceId,ws),
      eq(marketingRecipients.id,tag.data))).for('update');
    if(!r||r.attempts===0||r.email!==event.data.to[0].trim().toLowerCase()||r.providerId&&r.providerId!==event.data.email_id)return;
    // Delivery events can arrive out of order or be retried by the provider.
    if(r.state==='complained')return;
    if(r.state==='bounced'&&(state==='delivered'||state==='suppressed'))return;
    if(r.state==='suppressed'&&state==='delivered')return;
    await tx.update(marketingRecipients).set({state,providerId:event.data.email_id,lastIssue:null}).where(eq(marketingRecipients.id,r.id));
    if(state==='complained'||state==='bounced'&&event.data.bounce?.type==='Permanent'){
      const at=new Date().toISOString();
      await tx.insert(emailSuppressions).values({workspaceId:ws,id:crypto.randomUUID(),email:r.email,createdAt:at,
        recipientOptedOutAt:state==='complained'?at:null}).onConflictDoUpdate({target:[emailSuppressions.workspaceId,emailSuppressions.email],
        set:{recipientOptedOutAt:sql`coalesce(${emailSuppressions.recipientOptedOutAt}, excluded.recipient_opted_out_at)`}});
    }
  });
}

export async function providerFeedback(request:Request){
  const ws=configuredMarketingWorkspace(),secret=process.env.HARBOR_RESEND_WEBHOOK_SECRET;
  if(!ws||!secret)return reply(404);
  const raw=await readBoundedRequestText(request,64*1024);
  if(raw===null)return reply(413);
  if(!validMarketingSignature(raw,request.headers,secret))return reply(401);
  let body;
  try{body=JSON.parse(raw);}catch{return reply(400);}
  if(!feedbackType.safeParse(body?.type).success)return reply(204);
  const parsed=feedback.safeParse(body);
  if(!parsed.success)return reply(400);
  await recordMarketingFeedback(portableDb(),ws,parsed.data);
  return reply(204);
}
