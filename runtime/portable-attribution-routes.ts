import {z} from 'zod';
import {readAttribution,readTraffic,recordPageview,saveAttributionSite,trackingSite} from '../db/postgres/web-attribution-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {leadFormEmbedOrigin} from '../lib/lead-form-embedding';
import {attributionQuery,trafficQuery,journeyEvent,journeyId,siteWrite} from '../lib/portable-web-attribution';
import {portableApiIdentity} from './portable-api-identity';
import {portableMode} from './portable-config.mjs';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
function failure(error:unknown){
  if(error instanceof ApiError)return json({error:error.message},error.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the website or page fields.'},400);
  return json({error:'Web attribution is temporarily unavailable.'},503);
}
async function body(request:Request){
  const raw=await readBoundedRequestText(request,4096);
  if(raw===null)throw new ApiError(413,'The attribution request is too large.');
  return JSON.parse(raw);
}
async function attribution(request:Request){
  try{
    const actor=await portableApiIdentity(request);
    if(actor instanceof Response)return actor;
    if(actor.guest)throw new ApiError(403,'The workspace owner manages web attribution.');
    const params=new URL(request.url).searchParams;
    if(new Set(params.keys()).size!==params.size)throw new ApiError(400,'Choose one site or inquiry.');
    if(request.method==='GET'||request.method==='HEAD'){
      const query=Object.fromEntries(params);
      if(query.tab==='traffic')return json(await readTraffic(portableDb(),actor.userId,trafficQuery.parse(query)));
      return json(await readAttribution(portableDb(),actor,attributionQuery.parse(query),request.method!=='HEAD'));
    }
    if(params.size)throw new ApiError(400,'Unexpected website settings query.');
    if(request.headers.get('origin')!==new URL(request.url).origin)throw new ApiError(403,'Open this workspace before editing.');
    const sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)throw new ApiError(403,'Sign in again.');
    const input=siteWrite.parse(await body(request));
    const origin=leadFormEmbedOrigin(input.origin,portableMode(process.env));
    if(!origin)throw new ApiError(400,'Enter the exact website origin, including HTTPS.');
    return json(await saveAttributionSite(portableDb(),{...actor,sessionHash},{...input,origin}));
  }catch(error){return failure(error);}
}

export async function collect(request:Request){
  try{
    const origin=request.headers.get('origin'),params=new URL(request.url).searchParams;
    const siteId=journeyId.safeParse(params.get('siteId'));
    if(!origin||origin!==leadFormEmbedOrigin(origin,portableMode(process.env))||params.size!==1||!siteId.success)
      throw new ApiError(403,'Website unavailable.');
    const headers={'access-control-allow-origin':origin,'cache-control':'no-store','vary':'Origin','referrer-policy':'no-referrer'};
    if(request.method==='OPTIONS'){
      if(request.headers.get('access-control-request-method')!=='POST'||!await trackingSite(portableDb(),siteId.data,origin))
        throw new ApiError(403,'Website unavailable.');
      return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'POST',
        'access-control-allow-headers':'Content-Type','access-control-max-age':'300'}});
    }
    if(request.headers.get('sec-gpc')==='1')return new Response(null,{status:204,headers});
    const {visitor,...input}=journeyEvent.parse(await body(request));
    if(input.siteId!==siteId.data)throw new ApiError(400,'Site mismatch.');
    await recordPageview(portableDb(),origin,{...input,visitorToken:visitor});
    return new Response(null,{status:202,headers});
  }catch(error){return failure(error);}
}
export {attribution as GET,attribution as HEAD,attribution as POST};
