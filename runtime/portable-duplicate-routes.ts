import {changePortableDuplicateDismissal,readPortableDuplicates} from '../db/postgres/portable-duplicate-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {privateWorkspaces} from '../db/postgres/workspace-schema';
import {eq} from 'drizzle-orm';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableDuplicateAction,portableDuplicateQuery} from '../lib/portable-duplicates';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const editorRequired='Editor access to this workspace is required.';

// Duplicate review belongs to the owner and to editors holding the named grant.
async function duplicates(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method!=='POST'){
      const query=portableDuplicateQuery.safeParse(Object.fromEntries(params));
      if(!query.success||params.size!==new Set(params.keys()).size)return json({error:'Choose valid duplicate-review filters.'},400);
      let workspaceId:string|undefined;
      if(query.data.workspaceId){
        const grant=await sharedWorkspaceGrant(db,user.userId,query.data.workspaceId);
        if(grant?.id!==query.data.grantId||grant.role!=='editor')return json({error:editorRequired},403);
        workspaceId=query.data.workspaceId;
      }else{
        [{id:workspaceId}={id:undefined}]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,user.userId));
      }
      if(!workspaceId)return json({pairs:[],nextCursor:null,total:0,limited:false,recordsChecked:0});
      return json(await readPortableDuplicates(db,workspaceId,query.data));
    }
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before reviewing duplicates.'},403);
      shared=scope.data;
    }
    let body:unknown;
    try{const text=await readBoundedRequestText(request,4096);if(text!==null)body=JSON.parse(text);}catch{}
    const input=portableDuplicateAction.safeParse(body);
    if(!input.success)return json({error:'Choose two different records.'},400);
    return json(await changePortableDuplicateDismissal(db,user.userId,input.data,shared));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not load or update duplicate reviews. Refresh and try again.'},503);
  }
}

export {duplicates as GET,duplicates as POST};
