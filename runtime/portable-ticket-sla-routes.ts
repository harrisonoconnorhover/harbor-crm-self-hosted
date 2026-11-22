import {getResponsePolicy,saveResponsePolicy} from '../db/postgres/ticket-first-response-store';
import {responsePolicyInput} from '../lib/first-response';
import {ApiError} from '../lib/api-error';
import {requestSessionHash} from './portable-identity';
import {z} from 'zod';
import {readPortableCloseSlaPolicy,savePortableCloseSlaPolicy} from '../db/postgres/portable-ticket-sla-store';
import {readPortableTickets} from '../db/postgres/ticket-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableCloseSlaInput} from '../lib/portable-tickets';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const query=z.object({recordId:z.string().guid("Invalid uuid").optional()}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function ticketSlaRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    if(user.guest||params.has('workspaceId'))return json({error:'Open SLA settings in your own workspace.'},403);
    const db=portableDb();
    if(params.get('kind')==='first-response'&&params.size===1){
      if(request.method!=='POST')return json(await getResponsePolicy(db,user.userId));
      const raw=await readBoundedRequestText(request,65536);
      if(!raw)return json({error:'Check support hours and holidays.'},400);
      const input=responsePolicyInput.parse(JSON.parse(raw));
      const sessionHash=await requestSessionHash(request.headers);
      if(!sessionHash)return json({error:'Sign in again.'},403);
      return json(await saveResponsePolicy(db,{...user,sessionHash},input));
    }
    if(request.method==='GET'||request.method==='HEAD'){
      const input=query.safeParse(Object.fromEntries(params));
      if(!input.success||params.size!==new Set(params.keys()).size)return json({error:'Invalid ticket SLA query.'},400);
      if(!input.data.recordId)return json(await readPortableCloseSlaPolicy(db,user.userId));
      const record=await readPortableTickets(db,user.userId,{id:input.data.recordId,limit:1});
      if(!record||'records' in record)return json({error:'Ticket not found.'},404);
      return json(record.sla??{asOf:new Date().toISOString(),receipt:null,status:null});
    }
    if(params.size)return json({error:'Invalid ticket SLA write.'},400);
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,8192);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const input=portableCloseSlaInput.safeParse(body);
    if(!input.success)return json({error:input.error.issues[0]?.message??'Check the close-time SLA targets.'},400);
    const policy=await savePortableCloseSlaPolicy(db,user.userId,input.data);
    return policy?json(policy):json({error:'The SLA settings changed. Reload them before saving.'},409);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:error instanceof z.ZodError?error.issues[0].message:'Invalid settings.'},400);
    return json({error:'Could not load or save SLA targets.'},503);
  }
}

export {ticketSlaRoute as GET,ticketSlaRoute as POST};
