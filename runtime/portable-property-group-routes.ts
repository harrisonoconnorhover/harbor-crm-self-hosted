import {readPortablePropertyGroups,writePortablePropertyGroups} from '../db/postgres/portable-property-group-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portablePropertyGroupRead,portablePropertyGroupWrite} from '../lib/portable-custom-properties';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function propertyGroupsRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    if(user.guest||params.has('workspaceId'))return json({error:'Manage property groups in your own workspace.'},403);
    if(request.method==='GET'||request.method==='HEAD'){
      const input=portablePropertyGroupRead.safeParse(Object.fromEntries(params));
      if(!input.success||params.size!==1)return json({error:'Choose a supported record type.'},400);
      return json(await readPortablePropertyGroups(portableDb(),user.userId,input.data.kind));
    }
    if(params.size)return json({error:'Choose a supported record type.'},400);
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,16_000);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const input=portablePropertyGroupWrite.safeParse(body);
    if(!input.success)return json({error:'Choose valid properties and a group name of 1–80 characters.'},400);
    return json(await writePortablePropertyGroups(portableDb(),user.userId,input.data));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    console.error('Portable property group request failed.');
    return json({error:'Could not finish this property group request.'},503);
  }
}

export {propertyGroupsRoute as GET,propertyGroupsRoute as POST};
