import {and,asc,count,eq,gt,isNull} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {randomSecret,sha256} from '../../lib/email/crypto';
import type {EmailSuppressionPage} from '../../lib/email/suppression';
import {emailSuppressions as blocks,emailUnsubscribeTokens as tokens} from './email-suppression-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {matchesTextFields} from './search-index';

type Db=PostgresJsDatabase;
const fields={id:blocks.id,email:blocks.email,createdAt:blocks.createdAt,recipientOptedOutAt:blocks.recipientOptedOutAt};
const addressScope=(workspaceId:string,email:string)=>and(eq(blocks.workspaceId,workspaceId),eq(blocks.email,email));

export async function workspaceEmailBlocked(db:Db,workspaceId:string,email:string){
  const [row]=await db.select({id:blocks.id}).from(blocks).where(addressScope(workspaceId,email));
  return !!row;
}

export async function listEmailSuppressions(db:Db,actorId:string,query:string,after:string):Promise<EmailSuppressionPage>{
  const [workspace]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actorId));
  if(!workspace)return {results:[],total:0,next:null};
  const scope=and(eq(blocks.workspaceId,workspace.id),matchesTextFields([blocks.email],query));
  const [rows,[total]]=await Promise.all([
    db.select(fields).from(blocks).where(and(scope,after?gt(blocks.email,after):undefined)).orderBy(asc(blocks.email)).limit(26),
    db.select({count:count()}).from(blocks).where(scope),
  ]);
  return {results:rows.slice(0,25),total:total.count,next:rows.length>25?rows[24].email:null};
}

export function addEmailSuppression(db:Db,actorId:string,input:{id:string;email:string}){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workspace unavailable.');
    const [existing]=await tx.select(fields).from(blocks).where(addressScope(workspaceId,input.email));
    if(existing)return existing;
    const [saved]=await tx.insert(blocks).values({workspaceId,...input,createdAt:new Date().toISOString()})
      .onConflictDoNothing().returning(fields);
    if(!saved)throw new ApiError(409,'This block ID is already in use.');
    return saved;
  });
}

export function removeEmailSuppression(db:Db,actorId:string,id:string){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId)return;
    const target=and(eq(blocks.workspaceId,workspaceId),eq(blocks.id,id));
    const [block]=await tx.select({recipientOptedOutAt:blocks.recipientOptedOutAt}).from(blocks).where(target);
    if(block?.recipientOptedOutAt)throw new ApiError(409,'This address was unsubscribed by the recipient. The block remains in place.');
    if(block)await tx.delete(blocks).where(target);
  });
}

type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];

export async function insertEmailUnsubscribeToken(tx:Tx,workspaceId:string,ownerId:string,email:string){
  const token=randomSecret();
  await tx.insert(tokens).values({tokenHash:await sha256(token),workspaceId,ownerId,email});
  return token;
}

export function createEmailUnsubscribeToken(db:Db,actorId:string,email:string){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,true,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workspace unavailable.');
    return insertEmailUnsubscribeToken(tx,workspaceId,actorId,email);
  });
}

async function unsubscribeReceipt(db:Db,hash:string){
  const [row]=await db.select({optedOutAt:blocks.recipientOptedOutAt}).from(tokens)
    .innerJoin(privateWorkspaces,and(eq(privateWorkspaces.id,tokens.workspaceId),eq(privateWorkspaces.ownerId,tokens.ownerId)))
    .leftJoin(blocks,and(eq(blocks.workspaceId,tokens.workspaceId),eq(blocks.email,tokens.email)))
    .where(eq(tokens.tokenHash,hash)).limit(1);
  return row;
}

export async function confirmEmailUnsubscribe(db:Db,token:string){
  const hash=await sha256(token);
  // Unknown links and durable confirmations don't need a write transaction or a workspace lock.
  const receipt=await unsubscribeReceipt(db,hash);
  if(!receipt)return false;
  if(receipt.optedOutAt)return true;
  try{
    return await db.transaction(async tx=>{
      const [stored]=await tx.select().from(tokens).where(eq(tokens.tokenHash,hash));
      if(!stored)return false;
      // Use the same workspace lock as owner changes and future dispatch admission.
      const workspaceId=await lockRecordWorkspace(tx,stored.ownerId,false,undefined,undefined,true);
      if(workspaceId!==stored.workspaceId)return false;
      const at=new Date().toISOString();
      await tx.insert(blocks).values({workspaceId,id:crypto.randomUUID(),email:stored.email,createdAt:at,recipientOptedOutAt:at})
        .onConflictDoUpdate({target:[blocks.workspaceId,blocks.email],set:{recipientOptedOutAt:at},
          setWhere:isNull(blocks.recipientOptedOutAt)});
      return true;
    });
  }catch(error){
    // The commit may have reached Postgres even if its reply did not reach Harbor.
    if((await unsubscribeReceipt(db,hash))?.optedOutAt)return true;
    throw error;
  }
}
