import {personalConnectionActor} from './portable-connection-session';
import {z} from 'zod';
import {disconnectConnectionGrant,readConnectionGrantStatus} from '../db/postgres/portable-connection-store';
import type {PortableGoogleProvider} from '../db/postgres/portable-google-schema';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {CalendarError,calendarBusy} from '../lib/calendar/google';
import {GmailError} from '../lib/email/gmail';
import {GoogleConnectionError} from '../lib/google-oauth-result';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {boundedGoogleRead,completePersonalGoogle,personalGoogleAccess,startPersonalGoogle} from './portable-google-connections';

const query=z.object({provider:z.enum(['gmail','calendar']),action:z.literal('check').optional()}).strict();
const stateShape=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const codeShape=z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/);
const idShape=z.object({id:z.string().guid("Invalid uuid")}).strict();
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const redirect=(location:string)=>new Response(null,{status:303,headers:{...headers,location}});
const view=(provider:PortableGoogleProvider)=>provider==='gmail'?'email-settings':'calendar';
const reportCheck=(provider:PortableGoogleProvider,status:number)=>
  console.info(JSON.stringify({event:'harbor_portable_google_connection_check',provider,status}));

async function route(request:Request){
  let checking:PortableGoogleProvider|undefined;
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const parsed=query.safeParse(Object.fromEntries(params));
    if(!parsed.success||params.size!==new Set(params.keys()).size)return json({error:'Choose a Google connection.'},400);
    const {provider,action}=parsed.data;
    const config=portablePersonalGoogleConfig(provider);
    if(!config)return json({error:'Personal Google connections are not configured.'},404);
    const actor=await personalConnectionActor(request,user);
    if(request.method==='GET'){
      if(action)return json({error:'Use the Google connection controls.'},400);
      return json({connection:await readConnectionGrantStatus(portableDb(),actor,provider)});
    }
    if(request.method==='DELETE'){
      if(action)return json({error:'Use the Google connection controls.'},400);
      let input:unknown;
      try{input=JSON.parse(await readBoundedRequestText(request,2048)??'');}catch{}
      const values=idShape.safeParse(input);
      if(!values.success)return json({error:'Choose a connection to disconnect.'},400);
      if(!await disconnectConnectionGrant(portableDb(),actor,provider,values.data.id))
        return json({error:'This connection changed. Refresh and try again.'},409);
      return json({disconnected:true});
    }
    if(action==='check'){
      checking=provider;
      const calendarFetch=provider==='calendar'?boundedGoogleRead().fetcher:undefined;
      const grant=await personalGoogleAccess(request,actor,provider,config,{calendarFetch});
      if(provider==='calendar'){
        const now=Date.now();
        await grant.assertCurrent();
        await grant.read(()=>calendarBusy(grant.accessToken,new Date(now).toISOString(),new Date(now+60_000).toISOString(),calendarFetch));
      }
      await grant.assertCurrent();
      reportCheck(provider,200);
      return json({connection:'ok'});
    }
    if(request.headers.get('origin')!==new URL(config.redirectUri).origin)
      return json({error:'Start the connection from Harbor.'},403);
    return redirect(await startPersonalGoogle(actor,provider,config));
  }catch(error){
    const failure=error instanceof ApiError?error:new ApiError(503,'Google could not complete this request. Try again shortly.');
    if(checking)reportCheck(checking,failure.status);
    return json({error:failure.message},failure.status);
  }
}

async function callback(request:Request,provider:PortableGoogleProvider){
  const back=(outcome:string)=>redirect('/?view='+view(provider)+'&google='+outcome);
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const config=portablePersonalGoogleConfig(provider);
    if(!config)return back('setup');
    const params=new URL(request.url).searchParams;
    const state=stateShape.safeParse(params.get('state')),code=codeShape.safeParse(params.get('code'));
    const denied=params.getAll('error').length===1&&!params.has('code');
    if(!state.success||params.getAll('state').length!==1||
      !(denied||code.success&&params.getAll('code').length===1&&!params.has('error')))return back('expired');
    const actor=await personalConnectionActor(request,user);
    await completePersonalGoogle(request,actor,provider,config,state.data,code.success?code.data:null);
    return back('connected');
  }catch(error){
    if(error instanceof GoogleConnectionError)return back(error.reason);
    if(error instanceof ApiError)return back(error.status===409?'wrong_account':'expired');
    if(error instanceof CalendarError||error instanceof GmailError)return back('failed');
    return back('failed');
  }
}
export {route as GET,route as POST,route as DELETE};
export const gmailCallback=(request:Request)=>callback(request,'gmail');
export const calendarCallback=(request:Request)=>callback(request,'calendar');
