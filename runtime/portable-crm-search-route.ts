import {z} from 'zod';
import {searchPortableCrm} from '../db/postgres/portable-crm-search';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {searchInput} from '../lib/crm-search';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const query=searchInput.strict();
const scope=z.object({workspaceId:z.string().guid().optional()}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

export async function POST(request:Request){
  const user=await portableApiIdentity(request,'api_read');
  if(user instanceof Response)return user;
  let body:unknown;
  try{
    const text=await readBoundedRequestText(request,4096);
    if(text!==null)body=JSON.parse(text);
  }catch{}
  const input=query.safeParse(body);
  const params=new URL(request.url).searchParams;
  const selected=scope.safeParse(Object.fromEntries(params));
  if(!input.success||!selected.success||params.size!==new Set(params.keys()).size)
    return json({error:'Check the workspace, search text, object, and page.'},400);
  try{
    const results=await searchPortableCrm(portableDb(),user.userId,input.data,selected.data.workspaceId);
    return results?json(results):json({error:'Workspace unavailable.'},404);
  }
  catch{return json({error:'Could not search your CRM.'},503);}
}
