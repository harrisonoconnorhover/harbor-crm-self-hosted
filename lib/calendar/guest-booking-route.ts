import {z} from 'zod';
import {ApiError} from '../api-error';
import {readBoundedRequestText} from '../bounded-request-text';
import {guestBookingInput,type GuestBookingInput} from './guest-booking';

export async function guestBookingRoute(request:Request,pageId:string,enabled:boolean,
  execute:(pageId:string,input:GuestBookingInput)=>Promise<unknown>){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{
    'cache-control':'no-store','referrer-policy':'no-referrer',
  }});
  const id=z.string().guid("Invalid uuid").safeParse(pageId);
  if(!enabled||!id.success)return json({error:'This availability link is no longer open.'},404);
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Submit requests from Harbor.'},403);
  try{
    const text=await readBoundedRequestText(request,2048);
    if(text===null)return json({error:'The booking request is too large.'},413);
    const input=guestBookingInput.parse(JSON.parse(text));
    return json(await execute(id.data,input),input.action==='request'?202:200);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check your email, time or verification code.'},400);
    console.error('Guest booking request could not be completed.');
    return json({error:'Could not confirm the request. Try again with the same details.'},503);
  }
}
