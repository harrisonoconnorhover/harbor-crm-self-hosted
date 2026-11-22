import {listPortableCustomProperties,savePortableCustomProperty} from '../db/postgres/custom-property-store';
import {listPortableStandardAccess,savePortableStandardAccess} from '../db/postgres/standard-property-access';
import {portableStandardAccessWrite} from '../lib/portable-standard-property-access';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableCustomPropertyRead,portableCustomPropertyWrite} from '../lib/portable-custom-properties';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function propertiesRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      const query=portableCustomPropertyRead.safeParse(Object.fromEntries(params));
      if(!query.success||params.size!==new Set(params.keys()).size)return json({error:'Invalid custom property query.'},400);
      const {kind,workspaceId}=query.data;
      if(workspaceId&&!await sharedWorkspaceGrant(db,user.userId,workspaceId,true))return json({error:'Shared workspace unavailable.'},404);
      const [properties,standardAccess]=await Promise.all([
        listPortableCustomProperties(db,user.userId,kind,workspaceId),
        listPortableStandardAccess(db,user.userId,kind,workspaceId),
      ]);
      return json({properties,standardAccess});
    }
    if(user.guest||params.size)return json({error:'Manage properties in your own workspace.'},403);
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,32_000);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const access=portableStandardAccessWrite.safeParse(body);
    if(access.success)return json({property:await savePortableStandardAccess(db,user.userId,access.data)});
    const input=portableCustomPropertyWrite.safeParse(body);
    if(!input.success)return json({error:'Check the custom property definition.'},400);
    const property=await savePortableCustomProperty(db,user.userId,input.data);
    return json({property},input.data.action==='create'?201:200);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    console.error('Portable custom property request failed.');
    return json({error:'Could not finish this custom property request.'},503);
  }
}

export {propertiesRoute as GET,propertiesRoute as POST};
