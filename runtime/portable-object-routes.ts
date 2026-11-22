import {objectImportRequest} from '../lib/portable-object-import';
import {importObjectRecords} from '../db/postgres/custom-object-import-store';
import {z} from 'zod';
import {customObjectCsv} from './portable-custom-object-csv';
import {readObjects,writeObject} from '../db/postgres/custom-object-store';
import {ApiError} from '../lib/api-error';
import {objectAction,objectExport,objectRead} from '../lib/portable-custom-objects';
import {sharedRecordWriteScope} from '../lib/portable-workspace-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
async function objects(request:Request){
  try{
    const actor=await portableApiIdentity(request);
    if(actor instanceof Response)return actor;
    const params=new URL(request.url).searchParams;
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid object query.'},400);
    const query=Object.fromEntries(params),db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(query.export==='csv'){
        const filters={...query};
        delete filters.export;
        const q=objectExport.parse(filters);
        const sessionHash=await requestSessionHash(request.headers);
        if(!sessionHash)return json({error:'Sign in again.'},403);
        return await customObjectCsv(db,{...actor,sessionHash},q,request);
      }
      const auditEmail=request.method==='GET'?actor.email:undefined;
      return json(await readObjects(db,actor.userId,objectRead.parse(query),auditEmail));
    }
    if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Open this workspace before editing.'},403);
    const hash=await requestSessionHash(request.headers);
    if(!hash)return json({error:'Sign in again.'},403);
    const shared=params.size?sharedRecordWriteScope.parse(query):undefined;
    const body=await readBoundedRequestText(request,512*1024);
    if(body===null)return json({error:'Object settings or record values are too large.'},413);
    const input=JSON.parse(body);
    if(input?.action==='preview_csv'||input?.action==='apply_csv'){
      if(shared)return json({error:'Only the workspace owner can import custom records.'},403);
      return json(await importObjectRecords(db,{...actor,sessionHash:hash},objectImportRequest.parse(input)));
    }
    return json(await writeObject(db,{...actor,sessionHash:hash},objectAction.parse(input),shared));
  }catch(e){
    if(e instanceof ApiError)return json({error:e.message},e.status);
    if(e instanceof z.ZodError||e instanceof SyntaxError)return json({error:e instanceof z.ZodError?e.issues[0].message:'Check the record fields.'},400);
    return json({error:'Could not confirm the custom object request.'},503);
  }
}
export {objects as GET,objects as HEAD,objects as POST};
