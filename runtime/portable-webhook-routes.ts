import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {portableExternalRecordKind} from '../lib/portable-api-tokens';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {lockPortableLoginSession} from '../db/postgres/identity-store';
import {changeWebhookSettings,readWebhookSettings} from '../db/postgres/webhook-management-store';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';
import {configuredWebhookDestinations} from './portable-webhook-config';

const id=z.string().guid();
const page=z.object({afterAt:z.iso.datetime({precision:6}).optional(),afterId:id.optional(),filter:z.literal('attention').optional(),eventId:id.optional(),
  recordId:id.optional(),object:portableExternalRecordKind.optional()})
  .strict().refine(value=>Boolean(value.afterAt)===Boolean(value.afterId))
  .refine(value=>Boolean(value.recordId)===Boolean(value.object)&&!(value.recordId&&value.eventId));
const objectSelection=z.array(portableExternalRecordKind).min(1).max(portableExternalRecordKind.options.length)
  .refine(values=>new Set(values).size===values.length);
const input=z.discriminatedUnion('action',[
  z.object({action:z.literal('subscribe'),destination:z.string().min(1).max(80),objects:objectSelection}).strict(),
  z.object({action:z.literal('edit_objects'),id,objects:objectSelection,expectedObjects:objectSelection}).strict(),
  z.object({action:z.literal('remove'),id}).strict(),
  z.object({action:z.enum(['retry','confirm_received']),id,expectedAttempts:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict(),
]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function manage(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest)return json({error:'Only the workspace owner can manage webhook subscriptions.'},403);
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method!=='POST'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid webhook query.'},400);
      const {afterAt,afterId,filter,...lookup}=page.parse(Object.fromEntries(params));
      return json(await readWebhookSettings(db,user.userId,configuredWebhookDestinations,afterAt&&afterId?{afterAt,afterId}:undefined,{...lookup,attention:filter==='attention'}));
    }
    if(params.size)return json({error:'Invalid webhook query.'},400);
    const raw=await readBoundedRequestText(request,4096);
    if(raw===null)return json({error:'Subscription settings exceed 4 KiB.'},413);
    const change=input.parse(JSON.parse(raw)),sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)return json({error:'Sign in again to manage webhooks.'},403);
    return await db.transaction(async tx=>{
      if(!await lockPortableLoginSession(tx,{...user,sessionHash}))return json({error:'Sign in again to manage webhooks.'},403);
      return json(await changeWebhookSettings(tx,user.userId,change,configuredWebhookDestinations),change.action==='subscribe'?201:200);
    });
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:'Check the webhook settings and try again.'},400);
    return json({error:'Could not manage webhook subscriptions.'},503);
  }
}

export {manage as GET,manage as POST};
