import {z} from 'zod';
import {ApiError} from '../api-error';
import {readBoundedRequestText} from '../bounded-request-text';

export const guestInvitationInput=z.object({pageId:z.string().guid("Invalid uuid"),requestId:z.string().guid("Invalid uuid").transform(id=>id.toLowerCase())}).strict();
export type GuestInvitationInput=z.output<typeof guestInvitationInput>;

export async function guestInvitationId(workspaceId:string,requestId:string){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('harbor:guest-invitation:'+workspaceId+':'+requestId)));
  bytes[6]=(bytes[6]&0x0f)|0x80;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export type GuestInvitationStatus={id:string;status:string;eventUrl:string|null};

export async function attachGuestInvitationStatuses<T extends {id:string}>(workspaceId:string,requests:T[],
  load:(ids:string[])=>Promise<GuestInvitationStatus[]>){
  if(!requests.length)return [];
  const ids=await Promise.all(requests.map(request=>guestInvitationId(workspaceId,request.id)));
  const meetings=new Map((await load(ids)).map(meeting=>[meeting.id,meeting]));
  return requests.map((request,index)=>({...request,invitation:meetings.get(ids[index])??null}));
}

export const guestInvitationChanged=()=>new ApiError(409,'The request, availability link, or contact changed. Refresh and review it before sending.');
export function onlyGuestContact<T>(matches:T[]){
  if(matches.length!==1)throw new ApiError(409,matches.length?
    'More than one Contact has this email. Resolve the duplicate before sending.':
    'Create a Contact with the verified email address, then refresh and retry.');
  return matches[0];
}

export async function guestInvitationRoute<T>(request:Request,enabled:boolean,
  authorize:()=>Promise<T|Response>,submit:(owner:T,input:GuestInvitationInput)=>Promise<unknown>){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
  try{
    const owner=await authorize();
    if(owner instanceof Response)return owner;
    if(!enabled)return json({error:'Guest invitations are off on this host.'},403);
    if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Submit invitations from Harbor.'},403);
    const text=await readBoundedRequestText(request,1024);
    if(text===null)return json({error:'The invitation request is too large.'},413);
    const result=await submit(owner,guestInvitationInput.parse(JSON.parse(text)));
    return result instanceof Response?result:json(result);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the invitation request.'},400);
    return json({error:'Could not confirm the invitation. Refresh the request and check Calendar before trying again.'},503);
  }
}
