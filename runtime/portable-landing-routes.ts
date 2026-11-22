import {publicLandingAddress} from './portable-landing-address';
import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {landingChange} from '../lib/portable-landing';
import {changeLanding,landingLinkChoices} from '../db/postgres/landing-page-store';
import {portableApiIdentity} from './portable-api-identity';
import {requestSessionHash} from './portable-identity';
import {portableDb} from './portable-db';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
const linkSearch=z.object({q:z.string().trim().max(120).refine(value=>!value.includes('\0')).optional(),
  current:z.string().guid().optional(),exclude:z.string().guid().optional(),after:z.string().guid().optional()}).strict();

export async function GET(request:Request){
  const actor=await portableApiIdentity(request);
  if(actor instanceof Response)return actor;
  const params=new URL(request.url).searchParams;
  const parsed=linkSearch.safeParse(Object.fromEntries(params));
  if(!parsed.success||params.size!==new Set(params.keys()).size)return json({error:'Invalid page search.'},400);
  return json(await landingLinkChoices(portableDb(),actor.userId,parsed.data));
}
export async function POST(request:Request){
  try{
    const actor=await portableApiIdentity(request);
    if(actor instanceof Response)return actor;
    if(actor.guest||request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Open your workspace to manage pages.'},403);
    const sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)return json({error:'Sign in again.'},403);
    const text=await readBoundedRequestText(request,768*1024);
    if(text===null)return json({error:'Page is too large.'},413);
    const input=landingChange.parse(JSON.parse(text));
    const page=await changeLanding(portableDb(),{...actor,sessionHash},input);
    return json({...page,publicUrl:publicLandingAddress(page)});
  }catch(e){
    if(e instanceof ApiError)return json({error:e.message},e.status);
    if(e instanceof SyntaxError||e instanceof z.ZodError)return json({error:'Check the page title, address and section contents.'},400);
    return json({error:'Could not confirm the page change. Reload to check the saved version.'},503);
  }
}
