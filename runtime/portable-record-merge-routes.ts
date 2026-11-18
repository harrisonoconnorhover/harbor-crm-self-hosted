import {mergePortableCompanies,previewPortableCompanyMerge} from '../db/postgres/portable-company-merge-store';
import {mergePortableContacts,previewPortableContactMerge} from '../db/postgres/portable-contact-merge-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableRecordMergeAction} from '../lib/portable-record-merge';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

// Preview and merge both POST, so the review can't be cached or prefetched.
export async function POST(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before merging.'},403);
      shared=scope.data;
    }
    let body:unknown;
    try{const text=await readBoundedRequestText(request,16384);if(text!==null)body=JSON.parse(text);}catch{}
    const input=portableRecordMergeAction.safeParse(body);
    if(!input.success)return json({error:'Choose two different Contacts or Companies to merge.'},400);
    const db=portableDb(),contacts=input.data.kind==='contacts';
    if(input.data.action==='preview'){
      return json({preview:await (contacts?previewPortableContactMerge:previewPortableCompanyMerge)(db,user.userId,input.data,shared)});
    }
    return json({receipt:await (contacts?mergePortableContacts:mergePortableCompanies)(db,user.userId,input.data,shared)});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not complete this merge.'},503);
  }
}
