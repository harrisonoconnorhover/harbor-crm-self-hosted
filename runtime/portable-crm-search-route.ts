import {z} from 'zod';
import {recordCustomAccess,recordPreviewAccess} from '../db/postgres/record-access-store';
import {searchPortableCrm} from '../db/postgres/portable-crm-search';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableSearchInput} from '../lib/crm-search';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const query=portableSearchInput.strict();
const scope=z.object({workspaceId:z.string().guid().optional()}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

export async function POST(request:Request){
  const user=await portableApiIdentity(request,'api_read');
  if(user instanceof Response)return user;
  let body:unknown;
  try{
    const text=await readBoundedRequestText(request,8192);
    if(text!==null)body=JSON.parse(text);
  }catch{}
  const input=query.safeParse(body);
  const params=new URL(request.url).searchParams;
  const selected=scope.safeParse(Object.fromEntries(params));
  if(!input.success||!selected.success||params.size!==new Set(params.keys()).size)
    return json({error:'Check the workspace, search text, object, and page.'},400);
  try{
    const {workspaceId}=selected.data;
    const results=await portableDb().transaction(async tx=>{
      const page=await searchPortableCrm(tx,user.userId,input.data,workspaceId);
      if(page){
        await recordPreviewAccess(tx,user,'search',page.results,workspaceId);
        await recordCustomAccess(tx,user,'search',page.results.filter(row=>row.kind==='custom-objects'),workspaceId);
      }
      return page;
    },{isolationLevel:'repeatable read'});
    return results?json(results):json({error:'Workspace unavailable.'},404);
  }
  catch{return json({error:'Could not search your CRM.'},503);}
}
