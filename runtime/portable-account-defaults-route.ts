import {z} from 'zod';
import {readAccountDefaults,writeAccountDefaults} from '../db/postgres/account-defaults-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {saveAccountDefaults} from '../lib/portable-account-defaults';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function owner(request:Request){
  const user=await portableApiIdentity(request);
  if(user instanceof Response)return user;
  if(user.guest||new URL(request.url).searchParams.size)return json({error:'Open account defaults from your own workspace.'},403);
  return user;
}
export async function GET(request:Request){
  const user=await owner(request);
  return user instanceof Response?user:json(await readAccountDefaults(portableDb(),user.userId));
}
export async function POST(request:Request){
  const user=await owner(request);
  if(user instanceof Response)return user;
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Open your workspace to change its defaults.'},403);
  const sessionHash=await requestSessionHash(request.headers);
  if(!sessionHash)return json({error:'Sign in again.'},403);
  const body=await readBoundedRequestText(request,8192);
  if(body===null)return json({error:'Request is too large.'},413);
  try{return json(await writeAccountDefaults(portableDb(),{...user,sessionHash},saveAccountDefaults.parse(JSON.parse(body))));}
  catch(e){
    if(e instanceof ApiError)return json({error:e.message},e.status);
    if(e instanceof z.ZodError||e instanceof SyntaxError)return json({error:'Check the workspace name, time zone and display formats.'},400);
    throw e;
  }
}
