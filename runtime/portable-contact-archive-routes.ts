import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {changeServiceArchive,readServiceArchive} from '../db/postgres/service-archive-store';
import {changePortableTaskArchive,readPortableTaskArchive} from '../db/postgres/portable-task-archive-store';
import {changePortableCompanyArchive,readPortableCompanyArchive} from '../db/postgres/portable-company-archive-store';
import {ContactArchiveJobConflict,changePortableContactArchive,readPortableContactArchive} from '../db/postgres/portable-contact-archive-store';
import {changePortableDealArchive,readPortableDealArchive} from '../db/postgres/portable-deal-archive-store';
import {recordAccess} from '../db/postgres/record-access-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableArchiveAction,portableArchiveQuery} from '../lib/portable-contact-archive';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {archiveAccessError} from '../db/postgres/portable-archive-scope';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function recycleBin(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    if(request.method!=='POST'){
      const query=portableArchiveQuery.safeParse(Object.fromEntries(params));
      if(!query.success||params.size!==new Set(params.keys()).size)return json({error:'Check the archive page.'},400);
      const {workspaceId,grantId}=query.data,db=portableDb();
      const shared=workspaceId&&grantId?{workspaceId,grantId}:undefined;
      const kind=query.data.kind??'contacts';
      const page=await db.transaction(async tx=>{
        if(shared){
          const grant=await sharedWorkspaceGrant(tx,user.userId,shared.workspaceId,true);
          if(grant?.id!==shared.grantId||grant.role!=='editor'||effectiveMemberToolPolicy(grant,'recycle-bin').view==='none')throw new ApiError(403,archiveAccessError);
        }
        const readers={contacts:readPortableContactArchive,companies:readPortableCompanyArchive,deals:readPortableDealArchive,tasks:readPortableTaskArchive};
        const result=kind==='leads'||kind==='tickets'
          ?await readServiceArchive(tx,user.userId,kind,query.data.after,shared)
          :await readers[kind](tx,user.userId,query.data.after,shared);
        if(request.method!=='HEAD')await recordAccess(tx,user,kind,'list',result.records.map(record=>record.id),workspaceId);
        return result;
      },{isolationLevel:'repeatable read'});
      return json(page);
    }
    let body:unknown;
    try{const text=await readBoundedRequestText(request,4096);if(text!==null)body=JSON.parse(text);}catch{}
    const input=portableArchiveAction.safeParse(body);
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before archiving.'},403);
      shared=scope.data;
    }
    if(!input.success)return json({error:'Check the record and archive action.'},400);
    if(shared&&input.data.action==='restore'){
      const grant=await sharedWorkspaceGrant(portableDb(),user.userId,shared.workspaceId,true);
      // The restore transaction locks this exact grant ID. Every policy change rotates it.
      if(grant?.id!==shared.grantId||effectiveMemberToolPolicy(grant,'recycle-bin').edit==='none')
        return json({error:'You do not have permission to restore archived records.'},403);
    }
    if(input.data.kind==='leads'||input.data.kind==='tickets')return json({receipt:await changeServiceArchive(portableDb(),user.userId,input.data.kind,input.data,shared)});
    const change={contacts:changePortableContactArchive,companies:changePortableCompanyArchive,deals:changePortableDealArchive,tasks:changePortableTaskArchive}[input.data.kind??'contacts'];
    const receipt=await change(portableDb(),user.userId,input.data,shared);
    return json({receipt});
  }catch(error){
    if(error instanceof ContactArchiveJobConflict)return json({error:error.message,blockingJobId:error.jobId},error.status);
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not complete this recycle-bin operation.'},503);
  }
}

export {recycleBin as GET,recycleBin as HEAD,recycleBin as POST};
