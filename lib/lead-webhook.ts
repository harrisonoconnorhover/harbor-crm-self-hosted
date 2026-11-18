import {z} from 'zod';
import {ApiError} from './api-error';
import {digest} from './api-access';
import {readBoundedRequestText} from './bounded-request-text';
import {leadFormPayload} from './lead-forms';

const webhookInput=z.object({id:z.string().guid("Invalid uuid").transform(id=>id.toLowerCase()),payload:leadFormPayload}).strict();
export type LeadWebhookInput=z.output<typeof webhookInput>;
export const leadWebhookFingerprint=(formId:string,input:LeadWebhookInput)=>
  digest(JSON.stringify(['inbound',formId,input.payload]));
const respond=(body:unknown,status:number)=>Response.json(body,{status,headers:{
  'cache-control':'no-store','referrer-policy':'no-referrer',
  ...(status===401?{'www-authenticate':'Bearer'}:{}),
}});

export async function receiveLeadWebhook<T>(
  request:Request,params:Promise<{id:string}>,authorize:(request:Request)=>Promise<T>,
  accept:(token:T,id:string,input:LeadWebhookInput)=>Promise<Response|void>,
){
  try{
    const token=await authorize(request);
    const id=z.string().guid("Invalid uuid").safeParse((await params).id);
    if(!id.success)throw new ApiError(404,'Form unavailable.');
    if(new URL(request.url).search)throw new ApiError(400,'Send inquiry details in the JSON body.');
    const body=await readBoundedRequestText(request,32*1024);
    if(body===null)throw new ApiError(413,'This inquiry is too long. Shorten your message.');
    const result=await accept(token,id.data.toLowerCase(),webhookInput.parse(JSON.parse(body)));
    return result??respond({accepted:true},200);
  }catch(error){
    if(error instanceof ApiError)return respond({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return respond({error:'Send an inquiry UUID and valid contact details.'},400);
    console.error('Lead webhook could not confirm an inquiry.');
    return respond({error:'Could not confirm this inquiry. Retry with the same inquiry UUID.'},503);
  }
}
