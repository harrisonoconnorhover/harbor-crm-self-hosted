import {and,asc,eq,gt,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {MarketingDesignSave} from '../../lib/marketing-design';
import {marketingDesigns as designs} from './marketing-design-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';

const summary={id:designs.id,name:designs.name,subject:designs.subject,revision:designs.revision};
const fields={...summary,plainText:designs.plainText,project:designs.project,html:designs.html};
const owned=(workspaceId:string,ownerId:string)=>and(eq(designs.workspaceId,workspaceId),eq(privateWorkspaces.ownerId,ownerId));
const missing=()=>new ApiError(404,'Design not found in this workspace.');
const conflict=()=>new ApiError(409,'The saved design changed. Open it again before saving another version.');

export async function listMarketingDesigns(db:PostgresJsDatabase,workspaceId:string,ownerId:string,after?:string){
  const rows=await db.select(summary).from(designs).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,designs.workspaceId))
    .where(and(owned(workspaceId,ownerId),after?gt(designs.id,after):undefined)).orderBy(asc(designs.id)).limit(26);
  const items=rows.slice(0,25);
  return {items,next:rows.length>25?items.at(-1)!.id:null};
}

export async function readMarketingDesign(db:PostgresJsDatabase,workspaceId:string,ownerId:string,id:string){
  const [row]=await db.select(fields).from(designs).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,designs.workspaceId))
    .where(and(owned(workspaceId,ownerId),eq(designs.id,id))).limit(1);
  if(!row)throw missing();
  return row;
}

export async function saveMarketingDesign(db:PostgresJsDatabase,workspaceId:string,ownerId:string,input:MarketingDesignSave){
  return db.transaction(async tx=>{
    if(await lockRecordWorkspace(tx,ownerId,false)!==workspaceId)throw missing();
    const {id,name,subject,plainText,project,html,expectedRevision}=input;
    const content={name,subject,plainText,project,html};
    const scope=and(eq(designs.workspaceId,workspaceId),eq(designs.id,id));
    if(expectedRevision===undefined){
      const [newRow]=await tx.insert(designs).values({workspaceId,id,...content}).onConflictDoNothing().returning(summary);
      if(newRow)return newRow;
    }else{
      const [updated]=await tx.update(designs).set({...content,revision:sql`${designs.revision} + 1`})
        .where(and(scope,eq(designs.revision,expectedRevision))).returning(summary);
      if(updated)return updated;
    }
    // A lost success response can be retried with the same ID, content and original revision.
    const [existing]=await tx.select(fields).from(designs).where(scope).limit(1);
    if(!existing)throw missing();
    if(existing.revision===(expectedRevision??0)+1&&existing.name===name&&existing.subject===subject&&
       existing.project===project&&existing.plainText===plainText&&existing.html===html){
      return {id:existing.id,name,subject,revision:existing.revision};
    }
    throw conflict();
  });
}
