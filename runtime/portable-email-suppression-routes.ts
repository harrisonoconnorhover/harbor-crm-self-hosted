import {z} from 'zod';
import {addEmailSuppression,confirmEmailUnsubscribe,createEmailUnsubscribeToken,listEmailSuppressions,removeEmailSuppression}
  from '../db/postgres/email-suppression-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {suppressedAddress,suppressionInput,suppressionQuery} from '../lib/email/suppression';
import {unsubscribeInput} from '../lib/email/unsubscribe';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestIdentity} from './portable-identity';

const removeInput=z.object({id:z.string().guid("Invalid uuid")}).strict();
const linkInput=z.object({action:z.literal('unsubscribeLink'),email:suppressedAddress}).strict();
const createInput=z.union([suppressionInput,linkInput]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{
  'cache-control':'private, no-store','referrer-policy':'no-referrer',
}});

function failure(error:unknown,message:string){
  if(error instanceof ApiError)return json({error:error.message},error.status);
  if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:message},400);
  console.error('Portable email preference request failed.');
  return json({error:'Could not confirm the change. Try again shortly.'},503);
}

export async function manageSuppression(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const url=new URL(request.url),params=url.searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid do-not-email query.'},400);
      const input=suppressionQuery.parse(Object.fromEntries(params));
      return json(await listEmailSuppressions(db,user.userId,input.query,input.after));
    }
    if(params.size)return json({error:'Invalid do-not-email request.'},400);
    const text=await readBoundedRequestText(request,2048);
    if(text===null)return json({error:'Email request is too large.'},413);
    const body:unknown=JSON.parse(text);
    const current=await requestIdentity(request.headers);
    if(current?.userId!==user.userId||current.email!==user.email){
      return json({error:'Sign in again to manage email preferences.'},403);
    }
    if(request.method==='DELETE'){
      await removeEmailSuppression(db,user.userId,removeInput.parse(body).id);
      return json({removed:true});
    }
    const input=createInput.parse(body);
    if('action' in input){
      const token=await createEmailUnsubscribeToken(db,user.userId,input.email);
      return json({url:url.origin+'/email/unsubscribe#'+token});
    }
    return json(await addEmailSuppression(db,user.userId,input));
  }catch(error){return failure(error,'Check the do-not-email request.');}
}

export async function unsubscribe(request:Request){
  try{
    if(request.headers.get('origin')!==new URL(request.url).origin)
      return json({error:'Use the confirmation page from your unsubscribe link.'},403);
    const text=await readBoundedRequestText(request,512);
    if(text===null)return json({error:'Invalid unsubscribe request.'},413);
    const {token}=unsubscribeInput.parse(JSON.parse(text));
    if(!await confirmEmailUnsubscribe(portableDb(),token))return json({error:'This unsubscribe link is unavailable.'},404);
    return json({unsubscribed:true});
  }catch(error){return failure(error,'This unsubscribe link is incomplete.');}
}
