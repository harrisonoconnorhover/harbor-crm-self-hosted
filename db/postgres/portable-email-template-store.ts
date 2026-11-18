import {and,asc,eq,gt,ilike,isNull} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableTemplateDelete,PortableTemplateSave} from '../../lib/portable-email-templates';
import {activeContact} from './contact-visibility';
import {contacts,privateWorkspaces} from './contact-schema';
import {portableEmailTemplates as templates} from './portable-email-template-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';

const pageSize=25;
const summary={id:templates.id,name:templates.name,revision:templates.revision};
const fields={...summary,subject:templates.subject,body:templates.body};
const owned=(ownerId:string)=>and(eq(privateWorkspaces.ownerId,ownerId),isNull(templates.deletedAt));

export async function readPortableEmailTemplate(db:PostgresJsDatabase,ownerId:string,id:string){
  const [template]=await db.select(fields).from(templates)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,templates.workspaceId))
    .where(and(owned(ownerId),eq(templates.id,id))).limit(1);
  return template;
}

export async function readPortableEmailTemplatePreview(db:PostgresJsDatabase,ownerId:string,id:string,contactId:string){
  const [result]=await db.select({template:fields,contact:contacts.data}).from(templates)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,templates.workspaceId))
    .innerJoin(contacts,and(eq(contacts.workspaceId,templates.workspaceId),eq(contacts.id,contactId)))
    .where(and(owned(ownerId),eq(templates.id,id),activeContact)).limit(1);
  return result;
}

export async function listPortableEmailTemplates(db:PostgresJsDatabase,ownerId:string,search?:string,after?:string){
  const pattern=recordSearchPattern(search);
  const rows=await db.select(summary).from(templates)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,templates.workspaceId))
    .where(and(owned(ownerId),pattern?ilike(templates.name,pattern):undefined,after?gt(templates.id,after):undefined))
    .orderBy(asc(templates.id)).limit(pageSize+1);
  const items=rows.slice(0,pageSize);
  return {items,next:rows.length>pageSize?items.at(-1)!.id:null};
}

export function savePortableEmailTemplate(db:PostgresJsDatabase,ownerId:string,input:PortableTemplateSave){
  return db.transaction(async tx=>{
    const {id,expectedRevision,...content}=input;
    const creating=expectedRevision===undefined;
    const workspaceId=await lockRecordWorkspace(tx,ownerId,creating,undefined,undefined,true);
    if(!workspaceId)return {status:'missing' as const};
    const scope=and(eq(templates.workspaceId,workspaceId),eq(templates.id,id));
    const [row]=await tx.select().from(templates).where(scope).limit(1);
    if(!row){
      if(!creating)return {status:'missing' as const};
      const [template]=await tx.insert(templates).values({workspaceId,id,...content}).returning(fields);
      return {status:'created' as const,template};
    }
    if(row.deletedAt!==null)return {status:creating?'stale' as const:'missing' as const};
    const same=row.name===content.name&&row.subject===content.subject&&row.body===content.body;
    if(creating?(row.revision!==0||!same):row.revision!==expectedRevision)return {status:'stale' as const};
    if(same)return {status:'saved' as const,template:{id,name:row.name,subject:row.subject,body:row.body,revision:row.revision}};
    const [template]=await tx.update(templates).set({...content,revision:row.revision+1}).where(scope).returning(fields);
    return {status:'saved' as const,template};
  });
}

export function deletePortableEmailTemplate(db:PostgresJsDatabase,ownerId:string,{id,expectedRevision}:PortableTemplateDelete){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
    if(!workspaceId)return 'missing';
    const scope=and(eq(templates.workspaceId,workspaceId),eq(templates.id,id));
    const [row]=await tx.select({revision:templates.revision,deletedAt:templates.deletedAt}).from(templates).where(scope).limit(1);
    if(!row)return 'missing';
    if(row.deletedAt!==null)return row.revision===expectedRevision+1?'deleted':'missing';
    if(row.revision!==expectedRevision)return 'stale';
    // Retain the request ID without retaining deleted draft content.
    await tx.update(templates).set({name:'',subject:'',body:'',deletedAt:Date.now(),revision:row.revision+1}).where(scope);
    return 'deleted';
  });
}
