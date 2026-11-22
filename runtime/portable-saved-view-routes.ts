import {z} from 'zod';
import {listPortableSavedViews,writePortableSavedView} from '../db/postgres/saved-view-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableRecordKind} from '../lib/portable-records';
import {portableSavedViewLimit,portableSavedViewWrite} from '../lib/portable-saved-views';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const viewQuery=z.object({kind:portableRecordKind,workspaceId:z.string().guid("Invalid uuid").optional()}).strict();
const errors={
  columns:{message:'Choose filters and columns available to you for this record type.',status:400},
  missing:{message:'Saved view not found.',status:404},
  stale:{message:'This view changed. Reload it before saving.',status:409},
  duplicate:{message:'A saved view with that name already exists for these records.',status:409},
  limit:{message:'Keep at most '+portableSavedViewLimit+' saved views per record type.',status:409},
  access:{message:'Editor access to this workspace is required.',status:403},
  author:{message:'Only the workspace owner or the view’s author can change it, and only the owner can change sharing.',status:403},
};

export async function manageSavedViews(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    if(request.method==='GET'||request.method==='HEAD'){
      const input=viewQuery.safeParse(Object.fromEntries(params));
      if(!input.success||params.size!==new Set(params.keys()).size)return json({error:'Choose a record type and workspace.'},400);
      return json({views:await listPortableSavedViews(portableDb(),user.userId,input.data.kind,input.data.workspaceId)});
    }
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Saved views belong to your private workspace or a shared workspace grant.'},400);
      shared=scope.data;
    }
    let payload:unknown;
    try{
      const text=await readBoundedRequestText(request,4_096);
      if(text!==null)payload=JSON.parse(text);
    }
    catch{return json({error:'Check the view name, filters and table columns.'},400);}
    const input=portableSavedViewWrite.safeParse(payload);
    if(!input.success)return json({error:'Check the view name, filters and table columns.'},400);
    const result=await writePortableSavedView(portableDb(),user.userId,input.data,shared);
    if('error' in result){
      const error=errors[result.error];
      return json({error:error.message},error.status);
    }
    return json(result,input.data.action==='create'?201:200);
  }catch{
    console.error('Portable saved view request failed.');
    return json({error:'Could not finish this saved view request.'},500);
  }
}
