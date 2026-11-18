import {z} from 'zod';
import {contactFile,fileVersionKey,listContactFiles,listContactFileVersions,publishVersion,registerVersion} from '../db/postgres/contact-file-store';
import {visibleContactScope} from '../db/postgres/contact-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {sharedRecordWriteScope} from '../lib/portable-workspace-access';
import {attachmentBytes,attachmentDisposition,attachmentName} from '../lib/activity-attachments';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {fileDigest,objectStorageConfigured,readPrivateObject,writePrivateObject} from './portable-object-storage';

const id=z.string().guid("Invalid uuid");
const limit=z.coerce.number().int().min(1).max(25).default(25);
const list=z.object({recordId:id,workspaceId:id.optional(),after:id.optional(),limit}).strict();
const history=z.object({recordId:id,workspaceId:id.optional(),versionsFor:id,
  beforeRevision:z.coerce.number().int().min(1).max(2_147_483_647).optional(),limit}).strict();
const download=z.object({recordId:id,workspaceId:id.optional(),fileId:id,versionId:id.optional()}).strict();
const upload=z.object({recordId:id,workspaceId:id.optional(),grantId:id.optional(),fileId:id,versionId:id,expectedVersion:id.optional()}).strict();
const headers={'cache-control':'private, no-store'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const failure=(error:string,status:number)=>json({error},status);
const accessChanged=()=>failure('You no longer have contact file edit access. Refresh before trying again.',403);

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const values=Object.fromEntries(params);
    if(params.size!==new Set(params.keys()).size)return failure('Invalid file request.',400);
    const db=portableDb();
    if(request.method==='POST'){
      const input=upload.safeParse(values);
      if(!input.success)return failure('Invalid upload identifiers.',400);
      const {recordId,workspaceId,grantId,fileId,versionId,expectedVersion=null}=input.data;
      let shared;
      if(workspaceId||grantId){
        const parsed=sharedRecordWriteScope.safeParse({workspaceId,grantId});
        if(!parsed.success)return accessChanged();
        shared=parsed.data;
        const grant=await sharedWorkspaceGrant(db,user.userId,shared.workspaceId);
        if(!grant?.contactFiles||grant.role!=='editor'||grant.id!==shared.grantId)return accessChanged();
      }
      const contact=await visibleContactScope(db,user.userId,recordId,workspaceId,'contactFiles');
      if(!contact)return failure('Contact not found.',404);
      const scope={...contact,actorId:user.userId,shared};
      if(!objectStorageConfigured())return failure('File storage is unavailable.',503);
      let name,bytes;
      try{
        name=attachmentName(decodeURIComponent(request.headers.get('x-harbor-file-name')??''));
        bytes=await attachmentBytes(request);
      }catch{return failure('Choose a named, non-empty file of up to 10 MB.',400);}
      const staged=await registerVersion(db,scope,{fileId,versionId,expectedVersion,name,size:bytes.length,sha256:fileDigest(bytes)});
      if(staged.status==='access')return accessChanged();
      if(staged.status!=='ok')return staged.status==='missing'?failure('File or contact not found.',404):failure('The file changed. Reload and try again.',409);
      if(staged.version.revision===null){
        try{await writePrivateObject(fileVersionKey(staged.version),bytes,staged.version.sha256);}
        catch{return failure('File storage did not confirm the upload. Retry the same file.',502);}
        const published=await publishVersion(db,scope,staged.version);
        if(published.status==='access')return accessChanged();
        if(published.status==='missing')return failure('File or contact not found.',404);
        if(published.status!=='ok')return failure('The file changed. Reload and try again.',409);
      }
      return json({file:{id:fileId,versionId,name,size:bytes.length}});
    }
    if(params.has('fileId')){
      const input=download.safeParse(values);
      if(!input.success)return failure('Invalid download identifiers.',400);
      const scope=await visibleContactScope(db,user.userId,input.data.recordId,input.data.workspaceId,'contactFiles');
      if(!scope)return failure('Contact not found.',404);
      const version=await contactFile(db,scope,input.data.fileId,input.data.versionId);
      if(!version)return failure('File not found.',404);
      try{
        const bytes=await readPrivateObject(fileVersionKey(version),version);
        if(!await visibleContactScope(db,user.userId,scope.contactId,input.data.workspaceId,'contactFiles')){
          return failure('Contact not found.',404);
        }
        return new Response(bytes,{headers:{...headers,'content-type':'application/octet-stream',
          'content-disposition':attachmentDisposition(version.name),'content-length':String(bytes.length),'x-content-type-options':'nosniff'}});
      }catch{return failure('File contents could not be verified.',502);}
    }
    if(params.has('versionsFor')){
      const input=history.safeParse(values);
      if(!input.success)return failure('Invalid file history query.',400);
      const {recordId,workspaceId,versionsFor,beforeRevision,limit}=input.data;
      const scope=await visibleContactScope(db,user.userId,recordId,workspaceId,'contactFiles');
      if(!scope)return failure('Contact not found.',404);
      const page=await listContactFileVersions(db,scope,versionsFor,beforeRevision,limit);
      if(!await visibleContactScope(db,user.userId,recordId,workspaceId,'contactFiles'))return failure('Contact not found.',404);
      if(beforeRevision===undefined&&!page.versions.length)return failure('File not found.',404);
      return json(page);
    }
    const input=list.safeParse(values);
    if(!input.success)return failure('Invalid file query.',400);
    const scope=await visibleContactScope(db,user.userId,input.data.recordId,input.data.workspaceId,'contactFiles');
    if(!scope)return failure('Contact not found.',404);
    const page=await listContactFiles(db,scope,input.data.after,input.data.limit);
    if(!await visibleContactScope(db,user.userId,scope.contactId,input.data.workspaceId,'contactFiles')){
      return failure('Contact not found.',404);
    }
    return json(page);
  }catch{
    console.error('Portable contact file request failed.');
    return failure('Could not finish this file request.',500);
  }
}

export {route as GET,route as POST};
