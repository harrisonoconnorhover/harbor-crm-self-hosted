import {logPortableOutreach,logPortableRecordActivity,mutatePortableActivity,readPortableActivityHistory,readPortableActivityRemovals,readPortableOutreach,readPortableRecordActivity} from '../db/postgres/portable-contact-activity-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableActivityFilterKeys,portableActivityHistoryQuery,portableActivityListQuery,portableLoggedActivityQuery,portableLoggedActivityWrite} from '../lib/portable-contact-activities';
import {sharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const accessChanged=(contact:boolean)=>json({error:contact?'Refresh this contact to check your outreach access.':
  'Refresh this record to check your activity access.'},403);
const missing=(contact:boolean)=>json({error:contact?'Contact not found in your workspace.':'Record not found in your workspace.'},404);
const future=()=>json({error:'Choose a time when the activity already happened.'},400);
async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const inputParams=Object.fromEntries(params);
    const writing=request.method==='POST';
    const duplicate=params.size!==new Set(params.keys()).size;
    if(params.has('history')){
      const history=portableActivityHistoryQuery.safeParse(inputParams);
      if(writing||duplicate||!history.success)return json({error:'Invalid activity history query.'},400);
      const page=await readPortableActivityHistory(portableDb(),user.userId,history.data);
      return page?json(page):json({error:'Activity not found on this record.'},404);
    }
    const removed=params.has('removed');
    if(removed&&(writing||params.get('removed')!=='1'))return json({error:'Invalid activity removal query.'},400);
    delete inputParams.removed;
    // Only the primary list read accepts channel/date filters; the strict write and removal scopes reject them.
    const listing=!writing&&!removed;
    const query=listing?portableActivityListQuery.safeParse(inputParams):portableLoggedActivityQuery.safeParse(inputParams);
    if(!query.success||duplicate){
      if(listing&&portableActivityFilterKeys.some(key=>params.has(key)))return json({error:'Check the activity filters.'},400);
      return json({error:params.has('recordId')?'Open a company or deal to view or log activities.':'Open a contact to view or log outreach.'},400);
    }
    const scope=query.data,isContact='contactId' in scope;
    if((!writing&&scope.grantId)||(writing&&scope.afterAt!==undefined))return json({error:'Invalid outreach query.'},400);
    const db=portableDb();
    if(listing){
      const page='contactId' in scope?await readPortableOutreach(db,user.userId,scope):await readPortableRecordActivity(db,user.userId,scope);
      return page?json(page):missing(isContact);
    }
    if(!writing){
      const page=await readPortableActivityRemovals(db,user.userId,scope);
      return page?json(page):missing(isContact);
    }
    let shared;
    if(scope.workspaceId||scope.grantId){
      const parsed=sharedRecordWriteScope.safeParse({workspaceId:scope.workspaceId,grantId:scope.grantId});
      if(!parsed.success)return accessChanged(isContact);
      shared=parsed.data;
    }
    let raw:unknown;
    try{const text=await readBoundedRequestText(request,61_440);if(text!==null)raw=JSON.parse(text);}catch{}
    const input=portableLoggedActivityWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the outreach details.'},400);
    if('action' in input.data){
      const result=await mutatePortableActivity(db,user,scope,input.data,shared);
      if(result==='access')return accessChanged(isContact);
      if(result==='missing')return json({error:'Activity not found on this record.'},404);
      if(result==='stale')return json({error:'This activity changed. Refresh the timeline and try again.'},409);
      if(result==='future')return future();
      if(result==='too_long')return json({error:'Manual activity summaries can have at most 2,000 characters.'},400);
      return result==='removed'?json({ok:true}):json({id:input.data.id,revision:input.data.expectedRevision+(result==='unchanged'?0:1)});
    }
    const result=isContact?await logPortableOutreach(db,user.userId,scope.contactId,input.data,shared):
      await logPortableRecordActivity(db,user.userId,scope,input.data,shared);
    if(result==='access')return accessChanged(isContact);
    if(result==='missing')return missing(isContact);
    if(result==='future')return future();
    if(result==='gone')return json({error:'This activity was removed. Its original request cannot recreate it.'},410);
    if(result==='conflict')return json({error:'This request ID was already used for different outreach details.'},409);
    return json({id:input.data.id},result==='created'?201:200);
  }catch{return json({error:'Could not finish the outreach request. Try again.'},503);}
}

export {route as GET,route as POST};
