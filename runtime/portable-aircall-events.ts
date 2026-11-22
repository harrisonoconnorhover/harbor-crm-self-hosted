import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {portableAircallAssets} from '../db/postgres/portable-contact-activity-schema';
import {aircallActivityId,type AircallAsset} from '../lib/aircall-activity';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableDb} from './portable-db';

const reply=(status:number)=>new Response(null,{status,headers:{'cache-control':'no-store'}});
const digest=(value:string)=>createHash('sha256').update(value).digest();
const callId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const envelope=z.object({token:z.string(),event:z.string(),resource:z.string(),data:z.unknown()});
const transcription=z.object({call_id:z.union([callId,z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(callId)]),type:z.literal('call')});
const recording=z.object({id:callId,recording:z.string().url().nullable().optional()});

export async function POST(request:Request){
  const secret=process.env.HARBOR_AIRCALL_WEBHOOK_TOKEN;
  const workspace=z.string().guid().safeParse(process.env.HARBOR_AIRCALL_WORKSPACE_ID);
  if(!secret||!workspace.success)return reply(404);
  const text=await readBoundedRequestText(request,256*1024);
  if(text===null)return reply(413);
  let body:unknown;
  try{body=JSON.parse(text);}catch{return reply(400);}
  const parsed=envelope.safeParse(body);
  if(!parsed.success)return reply(400);
  const {token,event,resource,data}=parsed.data;
  if(!timingSafeEqual(digest(secret),digest(token)))return reply(403);
  let id:number,asset:AircallAsset;
  if(resource==='conversation_intelligence'&&event==='transcription.created'){
    if(z.object({type:z.literal('voicemail')}).safeParse(data).success)return reply(200);
    const result=transcription.safeParse(data);
    if(!result.success)return reply(400);
    id=result.data.call_id;asset='transcript';
  }else if(resource==='call'&&(event==='call.comm_assets_generated'||event==='call.ended')){
    const result=recording.safeParse(data);
    if(!result.success)return reply(400);
    if(!result.data.recording)return reply(200);
    id=result.data.id;asset='recording';
  }else return reply(200);

  // The provider can finish processing before the rep logs the call.
  await portableDb().insert(portableAircallAssets).values({workspaceId:workspace.data,activityId:aircallActivityId(id),asset}).onConflictDoNothing();
  return reply(200);
}
