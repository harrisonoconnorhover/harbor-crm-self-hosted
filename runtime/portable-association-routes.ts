import {changePortableAssociation,readPortableAssociations} from '../db/postgres/portable-association-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableAssociationAction,portableAssociationQuery} from '../lib/portable-associations';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function associationRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const {grantId,...source}=Object.fromEntries(params);
    const query=portableAssociationQuery.safeParse(source);
    const writing=request.method==='POST';
    if(!query.success||params.size!==new Set(params.keys()).size||writing&&query.data.after!==undefined||
      grantId!==undefined&&(!writing||!query.data.workspaceId))
      return json({error:'Open a record to view or edit its associations.'},400);
    let shared:SharedRecordWriteScope|undefined;
    if(writing&&query.data.workspaceId){
      const scope=sharedRecordWriteScope.safeParse({workspaceId:query.data.workspaceId,grantId});
      if(!scope.success)return json({error:'Open the shared workspace again before saving.'},403);
      shared=scope.data;
    }
    const db=portableDb();
    if(!writing){
      const page=await readPortableAssociations(db,user.userId,query.data);
      return page?json(page):json({error:'Record not found.'},404);
    }
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,4096);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const action=portableAssociationAction.safeParse(body);
    if(!action.success)return json({error:'Check the record and association labels.'},400);
    const result=await changePortableAssociation(db,user.userId,query.data,action.data,shared);
    if(result==='access')return json({error:'You no longer have edit access for this workspace. Refresh before trying again.'},403);
    if(result==='self')return json({error:'Choose a different record.'},400);
    if(result==='missing')return json({error:'Record not found.'},404);
    if(result==='conflict')return json({error:'These records are already linked with different labels.'},409);
    return json({ok:true});
  }catch{return json({error:'Could not finish the association request. Try again.'},503);}
}

export {associationRoute as GET,associationRoute as POST};
