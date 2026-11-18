import {and,asc,desc,eq,gt,ilike,isNotNull,isNull,notExists,or,sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {activeContact} from './contact-visibility';
import {contactFileVersions as versions} from './contact-file-schema';
import {contacts,privateWorkspaces} from './contact-schema';
import {portableFileFolders as folders,portableFileLocations as locations} from './portable-file-folder-schema';
import {readPortableFileFolderPath} from './portable-file-folder-store';
import {recordSearchPattern} from './record-search';

export type PortableFileSort='default'|'name'|'newest';
type Cursor={contactId:string;fileId:string;versionId?:string};
type FileLibraryFilters={search?:string;after?:Cursor;folderId?:string;sort?:PortableFileSort;contactId?:string};
const pageSize=25;

export async function readPortableFileLibrary(db:PostgresJsDatabase,ownerId:string,{search,after,folderId,sort='default',contactId}:FileLibraryFilters){
  return db.transaction(async tx=>{
    const path=folderId&&folderId!=='root'?await readPortableFileFolderPath(tx,ownerId,folderId):[];
    if(!path)return null;
    const folder=path.at(-1)??null;
    const contactName=sql<string>`${contacts.data}->>'name'`;
    const [contact]=contactId?await tx.select({id:contacts.id,name:contactName}).from(contacts)
      .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,contacts.workspaceId))
      .where(and(eq(privateWorkspaces.ownerId,ownerId),activeContact,eq(contacts.id,contactId))).limit(1):[];
    if(contactId&&!contact)return null;
    const latest=alias(versions,'newer_file_version');
    const newer=tx.select({id:latest.versionId}).from(latest)
      .where(and(eq(latest.workspaceId,versions.workspaceId),eq(latest.contactId,versions.contactId),
        eq(latest.fileId,versions.fileId),gt(latest.revision,versions.revision)));
    const pattern=recordSearchPattern(search);
    const ids=sql`(${versions.contactId},${versions.fileId})`;
    const nameKey=sql<string>`lower(${versions.name}) COLLATE "C"`;
    let position=after?sql`${ids} > (${after.contactId}::uuid,${after.fileId}::uuid)`:undefined;
    if(after&&sort!=='default'){
      if(!after.versionId)return null;
      // The pinned version retains its key even if a replacement arrived.
      // Fetch the timestamp as text so the cursor does not round microseconds.
      const [anchor]=await tx.select({key:sort==='name'?nameKey:sql<string>`${versions.createdAt}::text`}).from(versions)
        .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,versions.workspaceId))
        .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(versions.contactId,after.contactId),
          eq(versions.fileId,after.fileId),eq(versions.versionId,after.versionId),isNotNull(versions.revision))).limit(1);
      if(!anchor)return null;
      position=sort==='name'
        ?sql`(${nameKey},${versions.contactId},${versions.fileId}) >
          (${anchor.key}::text,${after.contactId}::uuid,${after.fileId}::uuid)`
        :sql`(${versions.createdAt}<${anchor.key}::timestamptz OR (${versions.createdAt}=${anchor.key}::timestamptz AND ${position}))`;
    }
    const order=[asc(versions.contactId),asc(versions.fileId)];
    if(sort==='name')order.unshift(asc(nameKey));
    if(sort==='newest')order.unshift(desc(versions.createdAt));
    // Find the current version before applying the name filter. A superseded
    // filename must not match or introduce a second library entry.
    const rows=await tx.select({contactId:versions.contactId,fileId:versions.fileId,versionId:versions.versionId,
      name:versions.name,size:versions.size,contactName,folderId:locations.folderId,folderName:folders.name,
      locationRevision:sql<number>`coalesce(${locations.revision},0)`}).from(versions)
      .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,versions.workspaceId))
      .innerJoin(contacts,and(eq(contacts.workspaceId,versions.workspaceId),eq(contacts.id,versions.contactId)))
      .leftJoin(locations,and(eq(locations.workspaceId,versions.workspaceId),eq(locations.contactId,versions.contactId),
        eq(locations.fileId,versions.fileId)))
      .leftJoin(folders,and(eq(folders.workspaceId,locations.workspaceId),eq(folders.id,locations.folderId),isNull(folders.deletedAt)))
      .where(and(eq(privateWorkspaces.ownerId,ownerId),activeContact,isNotNull(versions.revision),notExists(newer),
        contactId?eq(versions.contactId,contactId):undefined,
        folder?eq(locations.folderId,folder.id):folderId==='root'?isNull(locations.folderId):undefined,
        pattern?or(ilike(versions.name,pattern),ilike(contactName,pattern)):undefined,
        position))
      .orderBy(...order).limit(pageSize+1);
    const files=rows.slice(0,pageSize),last=files.at(-1);
    const next=last&&rows.length>pageSize
      ?sort==='default'?`${last.contactId}:${last.fileId}`:`${sort}:${last.contactId}:${last.fileId}:${last.versionId}`
      :null;
    return {files,folder,path,next,contact:contact??null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
