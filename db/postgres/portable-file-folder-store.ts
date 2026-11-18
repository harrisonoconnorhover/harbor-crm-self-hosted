import {and,asc,eq,gt,isNull,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableFolderWrite} from '../../lib/portable-file-folders';
import {contactFile} from './contact-file-store';
import {contacts,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableFileFolders as folders,portableFileLocations as locations} from './portable-file-folder-schema';
import {lockRecordWorkspace} from './private-workspace-store';

const pageSize=25;
const maxFolderDepth=32;
const fields={id:folders.id,name:folders.name,revision:folders.revision};
type FolderPathEntry={id:string;name:string;revision:number;parentId:string|null};

async function folderPath(db:PostgresJsDatabase,workspaceId:string,id:string){
  const path=await db.execute<FolderPathEntry>(sql`
    WITH RECURSIVE path AS (
      SELECT id,name,revision,parent_id,1 AS depth FROM portable_file_folders
      WHERE workspace_id=${workspaceId} AND id=${id} AND deleted_at IS NULL
      UNION ALL
      SELECT f.id,f.name,f.revision,f.parent_id,p.depth+1 FROM portable_file_folders f JOIN path p ON f.id=p.parent_id
      WHERE f.workspace_id=${workspaceId} AND f.deleted_at IS NULL AND p.depth<${maxFolderDepth}
    ) SELECT id,name,revision,parent_id AS "parentId" FROM path ORDER BY depth DESC
  `);
  // Refuse an incomplete path even if a malformed hierarchy was restored.
  return path[0]?.parentId===null?[...path]:null;
}

export async function readPortableFileFolderPath(db:PostgresJsDatabase,ownerId:string,id:string){
  const [workspace]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,ownerId)).limit(1);
  return workspace?folderPath(db,workspace.id,id):null;
}

async function readFolderPage(db:PostgresJsDatabase,ownerId:string,after?:string,parentId?:string){
  const parent=parentId==='root'?isNull(folders.parentId):parentId?eq(folders.parentId,parentId):undefined;
  const rows=await db.select(fields).from(folders)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,folders.workspaceId))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),isNull(folders.deletedAt),parent,after?gt(folders.id,after):undefined))
    .orderBy(asc(folders.id)).limit(pageSize+1);
  const items=rows.slice(0,pageSize);
  return {folders:items,next:rows.length>pageSize?items.at(-1)!.id:null};
}

export function readPortableFileFolders(db:PostgresJsDatabase,ownerId:string,after?:string,parentId?:string){
  if(!parentId||parentId==='root')return readFolderPage(db,ownerId,after,parentId);
  return db.transaction(async tx=>{
    if(!await readPortableFileFolderPath(tx,ownerId,parentId))return null;
    return readFolderPage(tx,ownerId,after,parentId);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

async function folderHeight(db:PostgresJsDatabase,workspaceId:string,id:string){
  const [row]=await db.execute<{height:number}>(sql`
    WITH RECURSIVE descendants(id,depth) AS (
      SELECT ${id}::uuid,1
      UNION ALL
      SELECT f.id,d.depth+1 FROM portable_file_folders f JOIN descendants d ON f.parent_id=d.id
      WHERE f.workspace_id=${workspaceId} AND f.deleted_at IS NULL AND d.depth<${maxFolderDepth}
    ) SELECT max(depth) AS height FROM descendants
  `);
  return row.height;
}

async function moveFile(db:PostgresJsDatabase,workspaceId:string,input:Extract<PortableFolderWrite,{action:'move'}>){
  const {contactId,fileId,folderId}=input;
  const [contact]=await db.select({id:contacts.id}).from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contactId),activeContact)).for('update');
  if(!contact)return 'missing';
  const current=await contactFile(db,{workspaceId,contactId},fileId);
  if(!current)return 'missing';
  if(current.versionId!==input.versionId)return 'stale';
  if(folderId){
    const [destination]=await db.select({id:folders.id}).from(folders)
      .where(and(eq(folders.workspaceId,workspaceId),eq(folders.id,folderId),isNull(folders.deletedAt))).limit(1);
    if(!destination)return 'missing';
  }
  const [location]=await db.select({folderId:locations.folderId,revision:locations.revision}).from(locations)
    .where(and(eq(locations.workspaceId,workspaceId),eq(locations.contactId,contactId),eq(locations.fileId,fileId))).limit(1);
  if((location?.revision??0)!==input.expectedRevision)return 'stale';
  if((location?.folderId??null)===folderId)return 'saved';
  // A Root move keeps the revision so a stale request cannot follow an A→Root round trip.
  const revision=input.expectedRevision+1;
  await db.insert(locations).values({workspaceId,contactId,fileId,folderId,revision}).onConflictDoUpdate({
    target:[locations.workspaceId,locations.contactId,locations.fileId],set:{folderId,revision},
  });
  return 'saved';
}

export function writePortableFileFolder(db:PostgresJsDatabase,ownerId:string,input:PortableFolderWrite){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,input.action==='create',undefined,undefined,true);
    if(!workspaceId)return 'missing';
    if(input.action==='move')return moveFile(tx,workspaceId,input);
    const {id}=input;
    const scope=and(eq(folders.workspaceId,workspaceId),eq(folders.id,id));
    const [current]=await tx.select().from(folders).where(scope).limit(1);
    if(input.action==='create'&&current){
      return current.deletedAt===null&&current.name===input.name&&current.parentId===(input.parentId??null)?'saved':'stale';
    }
    if(input.action!=='create'){
      if(!current||current.deletedAt!==null)return 'missing';
      if(current.revision!==input.expectedRevision)return 'stale';
      if(input.action==='remove'){
        const [entry]=await tx.select({id:locations.fileId}).from(locations)
          .where(and(eq(locations.workspaceId,workspaceId),eq(locations.folderId,id))).limit(1);
        const [child]=await tx.select({id:folders.id}).from(folders)
          .where(and(eq(folders.workspaceId,workspaceId),eq(folders.parentId,id),isNull(folders.deletedAt))).limit(1);
        if(entry||child)return 'notEmpty';
        await tx.update(folders).set({revision:current.revision+1,deletedAt:Date.now()}).where(scope);
        return 'saved';
      }
      if(input.action==='moveFolder'){
        if(input.parentId===current.parentId)return 'saved';
        const destination=input.parentId?await folderPath(tx,workspaceId,input.parentId):[];
        if(!destination)return 'missing';
        if(destination.some(folder=>folder.id===id))return 'invalidParent';
        if(!await folderPath(tx,workspaceId,id))return 'missing';
        if(destination.length+await folderHeight(tx,workspaceId,id)>maxFolderDepth)return 'invalidParent';
        await tx.update(folders).set({parentId:input.parentId,revision:current.revision+1}).where(scope);
        return 'saved';
      }
      if(input.name===current.name)return 'saved';
    }
    if(input.action==='create'&&input.parentId){
      const destination=await folderPath(tx,workspaceId,input.parentId);
      if(!destination)return 'missing';
      if(destination.length>=maxFolderDepth)return 'invalidParent';
    }
    const nameKey=input.name.toLowerCase();
    const [duplicate]=await tx.select({id:folders.id}).from(folders)
      .where(and(eq(folders.workspaceId,workspaceId),eq(folders.nameKey,nameKey),isNull(folders.deletedAt),ne(folders.id,id))).limit(1);
    if(duplicate)return 'duplicate';
    if(input.action==='create'){
      await tx.insert(folders).values({workspaceId,id,parentId:input.parentId??null,name:input.name,nameKey});
      return 'created';
    }
    await tx.update(folders).set({name:input.name,nameKey,revision:input.expectedRevision+1}).where(scope);
    return 'saved';
  });
}
