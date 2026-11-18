import {z} from 'zod';
import type {OutlookProvider} from '../db/postgres/portable-google-schema';
import {disconnectConnectionGrant,readConnectionGrantStatus} from '../db/postgres/portable-connection-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableApiIdentity} from './portable-api-identity';
import {personalConnectionActor} from './portable-connection-session';
import {portableDb} from './portable-db';
import {completeOutlook,outlookAccess,startOutlook} from './portable-outlook-connections';
import {checkOutlookResource,OutlookAuthorizationError,outlookConfig} from './portable-outlook-provider';

const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const redirect=(location:string)=>new Response(null,{status:303,headers:{...headers,location}});
const query=z.object({provider:z.enum(['outlook-mail','outlook-calendar']),action:z.literal('check').optional()}).strict();
const disconnect=z.object({id:z.string().uuid()}).strict();

async function connection(request:Request) {
  try {
    const user=await portableApiIdentity(request);
    if (user instanceof Response) return user;
    const params=new URL(request.url).searchParams;
    const input=query.safeParse(Object.fromEntries(params));
    if (!input.success || new Set(params.keys()).size!==params.size) return json({error:'Choose an Outlook connection.'},400);
    const {provider,action}=input.data;
    const config=outlookConfig(provider,user.email);
    if (!config) return json({error:'Personal Outlook connections are not configured.'},404);
    const actor=await personalConnectionActor(request,user);
    if (action) {
      if (request.method!=='POST') return json({error:'Use the Outlook connection controls.'},400);
      const grant=await outlookAccess(request,user,provider);
      await checkOutlookResource(provider,grant.accessToken,AbortSignal.any([request.signal,AbortSignal.timeout(12_000)]));
      await grant.assertCurrent();
      return json({connection:'ok'});
    }
    if (request.method==='GET') return json({connection:await readConnectionGrantStatus(portableDb(),actor,provider)});
    if (request.method==='DELETE') {
      let body:unknown;
      try { body=JSON.parse(await readBoundedRequestText(request,2048) || 'null'); } catch { /* Invalid body. */ }
      const parsed=disconnect.safeParse(body);
      if (!parsed.success) return json({error:'Choose a connection to disconnect.'},400);
      if (!await disconnectConnectionGrant(portableDb(),actor,provider,parsed.data.id))
        return json({error:'This Outlook connection changed. Refresh and try again.'},409);
      return json({disconnected:true});
    }
    if (request.headers.get('origin')!==new URL(config.redirectUri).origin) return json({error:'Start the connection from Harbor.'},403);
    return redirect(await startOutlook(actor,provider,config));
  } catch (error) {
    return error instanceof ApiError?json({error:error.message},error.status):json({error:'Outlook is temporarily unavailable. Try again shortly.'},503);
  }
}

async function callback(request:Request,provider:OutlookProvider) {
  const view=provider==='outlook-mail'?'email-settings':'calendar';
  const back=(outcome:string)=>redirect('/?view='+view+'&outlook='+outcome);
  try {
    const user=await portableApiIdentity(request);
    if (user instanceof Response) return user;
    const config=outlookConfig(provider,user.email);
    if (!config) return back('setup');
    const params=new URL(request.url).searchParams;
    const state=params.get('state'),code=params.get('code');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || params.getAll('state').length!==1) return back('expired');
    const denied=params.getAll('error').length===1 && !params.has('code');
    if (!denied && (!code || code.length>16384 || /\s/.test(code) || params.getAll('code').length!==1 || params.has('error'))) return back('expired');
    await completeOutlook(request,await personalConnectionActor(request,user),provider,config,state,denied?null:code);
    return back('connected');
  } catch (error) {
    return back(error instanceof OutlookAuthorizationError?error.reason:'failed');
  }
}

export {connection as GET,connection as POST,connection as DELETE};
export const mailCallback=(request:Request)=>callback(request,'outlook-mail');
export const calendarCallback=(request:Request)=>callback(request,'outlook-calendar');
