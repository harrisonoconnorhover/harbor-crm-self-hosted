import {z} from 'zod';
import {readBoundedRequestText} from '../bounded-request-text';
import {seal,sha256,unseal} from '../email/crypto';
import type {loginConfig} from '../identity';

const locator=z.object({
  workspaceId:z.string().guid("Invalid uuid"),pageId:z.string().guid("Invalid uuid"),requestId:z.string().guid("Invalid uuid"),expiresAt:z.number().int(),
}).strict();
export type GuestStatusLocator=z.output<typeof locator>;
type StatusConfig=Pick<ReturnType<typeof loginConfig>,'origin'|'clientSecret'>;
const key=(config:StatusConfig)=>sha256('harbor:guest-status:key:v1:'+config.clientSecret);
const scope=(config:StatusConfig)=>'harbor:guest-status:v1:'+config.origin;
const receiptShape=z.string().max(768).regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const guestStatusRetention=14*86_400_000;

export async function issueGuestStatusReceipt(config:StatusConfig,location:Omit<GuestStatusLocator,'expiresAt'>,now:number){
  return seal(JSON.stringify({...location,expiresAt:now+guestStatusRetention}),await key(config),scope(config));
}

export async function openGuestStatusReceipt(config:StatusConfig,receipt:string,now=Date.now()){
  try{
    const value=locator.parse(JSON.parse(await unseal(receipt,await key(config),scope(config))));
    return value.expiresAt>now?value:null;
  }catch{return null;}
}

export type GuestBookingStatus={state:'pending'|'confirmed'|'checking'|'cancelled'|'closed';start?:string;end?:string};

export function guestBookingStatus(guestStart:string,guestEnd:string,open:boolean,
  meeting:{state:string;start:string;end:string}|null,now=Date.now()):GuestBookingStatus{
  if(meeting?.state==='scheduled')return {state:'confirmed',start:meeting.start,end:meeting.end};
  if(meeting?.state==='cancelled')return {state:'cancelled'};
  if(meeting?.state==='rejected'||meeting?.state==='failed')return {state:'closed'};
  if(meeting)return {state:'checking'};
  return open&&Date.parse(guestStart)>now?{state:'pending',start:guestStart,end:guestEnd}:{state:'closed'};
}

export async function guestBookingStatusRoute(request:Request,enabled:boolean,
  config:()=>StatusConfig,read:(location:GuestStatusLocator)=>Promise<GuestBookingStatus|Response|null>){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{
    'cache-control':'no-store','referrer-policy':'no-referrer',
  }});
  const unavailable=()=>json({error:'This booking status link is no longer available.'},404);
  if(!enabled)return unavailable();
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Check booking status from Harbor.'},403);
  try{
    const text=await readBoundedRequestText(request,1024);
    if(text===null)return unavailable();
    const input=z.object({receipt:receiptShape}).strict().safeParse(JSON.parse(text));
    if(!input.success)return unavailable();
    const location=await openGuestStatusReceipt(config(),input.data.receipt);
    if(!location)return unavailable();
    const result=await read(location);
    return result instanceof Response?result:result?json(result):unavailable();
  }catch(error){
    if(error instanceof SyntaxError)return unavailable();
    return json({error:'Harbor could not check this booking. Try again shortly.'},503);
  }
}
