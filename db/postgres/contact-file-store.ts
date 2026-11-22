import {ownedRecordScope} from './record-ownership-scope';
import {and,asc,desc,eq,gt,isNotNull,lt} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {contactFileVersions as versions} from './contact-file-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {lockRecordWorkspace} from './private-workspace-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';

type Scope={workspaceId:string;contactId:string};
type UploadScope=Scope&{actorId:string;shared?:SharedRecordWriteScope};
export type UploadVersion={fileId:string;versionId:string;expectedVersion:string|null;name:string;size:number;sha256:string};
type FileVersion=typeof versions.$inferSelect;
type Result={status:'missing'|'conflict'|'access'}|{status:'ok';version:FileVersion};

const contactScope=(scope:Scope)=>and(eq(contacts.workspaceId,scope.workspaceId),eq(contacts.id,scope.contactId));
const fileScope=(scope:Scope)=>and(eq(versions.workspaceId,scope.workspaceId),eq(versions.contactId,scope.contactId));
const fileScopeFor=(scope:Scope,id:string)=>and(fileScope(scope),eq(versions.fileId,id));
export const fileVersionKey=(row:Pick<FileVersion,'workspaceId'|'contactId'|'fileId'|'versionId'>&Partial<Pick<FileVersion,'storageContactId'>>)=>
  ['contact-files',row.workspaceId,row.storageContactId??row.contactId,row.fileId,row.versionId].join('/');

export async function listContactFiles(db:PostgresJsDatabase,scope:Scope,after:string|undefined,limit:number){
  const rows=await db.selectDistinctOn([versions.fileId],{
    id:versions.fileId,versionId:versions.versionId,name:versions.name,size:versions.size,
  }).from(versions).where(and(fileScope(scope),isNotNull(versions.revision),after?gt(versions.fileId,after):undefined))
    .orderBy(asc(versions.fileId),desc(versions.revision)).limit(limit+1);
  const files=rows.slice(0,limit);
  return {files,next:rows.length>limit?files.at(-1)!.id:null};
}

export async function listContactFileVersions(db:PostgresJsDatabase,scope:Scope,id:string,beforeRevision:number|undefined,limit:number){
  const rows=await db.select({id:versions.fileId,versionId:versions.versionId,name:versions.name,size:versions.size,
    revision:versions.revision,createdAt:versions.createdAt,
  }).from(versions).where(and(fileScopeFor(scope,id),isNotNull(versions.revision),
    beforeRevision===undefined?undefined:lt(versions.revision,beforeRevision)))
    .orderBy(desc(versions.revision)).limit(limit+1);
  const page=rows.slice(0,limit);
  return {versions:page,next:rows.length>limit?page.at(-1)!.revision:null};
}

export async function contactFile(db:PostgresJsDatabase,scope:Scope,id:string,versionId?:string){
  const [version]=await db.select().from(versions).where(and(fileScopeFor(scope,id),isNotNull(versions.revision),
    versionId?eq(versions.versionId,versionId):undefined)).orderBy(desc(versions.revision)).limit(1);
  return version;
}

export async function registerVersion(db:PostgresJsDatabase,scope:UploadScope,input:UploadVersion):Promise<Result>{
  return db.transaction(async tx=>{
    if(await lockRecordWorkspace(tx,scope.actorId,false,scope.shared,'contactFiles',true,true,['files',input.expectedVersion?'edit':'create'])!==scope.workspaceId)return {status:'access'};
    const [contact]=await tx.select({id:contacts.id}).from(contacts).where(and(contactScope(scope),activeContact,
      scope.shared?ownedRecordScope(tx,scope.actorId,scope.workspaceId,contacts,'edit','contactFiles'):undefined)).for('update');
    if(!contact)return {status:'missing'};
    const file=fileScopeFor(scope,input.fileId);
    const target=and(file,eq(versions.versionId,input.versionId));
    const [registered]=await tx.select().from(versions).where(target).limit(1);
    if(registered){
      // Pre-sharing versions belong to the owner for retries. New versions are bound to the uploader.
      if(registered.actorId!==scope.actorId&&(scope.shared||registered.actorId!==null))return {status:'conflict'};
      if(registered.expectedVersion!==input.expectedVersion||registered.name!==input.name||
         registered.size!==input.size||registered.sha256!==input.sha256)return {status:'conflict'};
      if(registered.revision!==null)return {status:'ok',version:registered};
    }
    const current=await contactFile(tx,scope,input.fileId);
    if((current?.versionId??null)!==input.expectedVersion)return {status:current?'conflict':'missing'};
    if(registered)return {status:'ok',version:registered};
    const [version]=await tx.insert(versions).values({workspaceId:scope.workspaceId,contactId:scope.contactId,actorId:scope.actorId,...input,createdAt:new Date().toISOString()}).returning();
    return {status:'ok',version};
  });
}

export async function publishVersion(db:PostgresJsDatabase,scope:UploadScope,input:FileVersion):Promise<Result>{
  return db.transaction(async tx=>{
    // Storage runs between transactions, so the original grant may have been revoked.
    if(await lockRecordWorkspace(tx,scope.actorId,false,scope.shared,'contactFiles',true,true,['files',input.expectedVersion?'edit':'create'])!==scope.workspaceId)return {status:'access'};
    const [contact]=await tx.select({id:contacts.id}).from(contacts).where(and(contactScope(scope),activeContact,
      scope.shared?ownedRecordScope(tx,scope.actorId,scope.workspaceId,contacts,'edit','contactFiles'):undefined)).for('update');
    if(!contact)return {status:'missing'};
    const target=and(fileScopeFor(scope,input.fileId),eq(versions.versionId,input.versionId));
    const [registered]=await tx.select().from(versions).where(target).limit(1);
    if(!registered)return {status:'missing'};
    if(registered.revision!==null)return {status:'ok',version:registered};
    const current=await contactFile(tx,scope,input.fileId);
    if((current?.versionId??null)!==registered.expectedVersion)return {status:'conflict'};
    const [version]=await tx.update(versions).set({revision:(current?.revision??0)+1}).where(target).returning();
    return {status:'ok',version};
  });
}
