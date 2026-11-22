import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {digest,newToken,type ApiTokenInfo} from '../../lib/api-access';
import {portableTokenScopes,type portableTokenCreate,type portableTokenPage} from '../../lib/portable-api-tokens';
import {loginIdentities} from './identity-schema';
import {portableApiTokens as tokens} from './portable-api-token-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const fields={
  id:tokens.id,name:tokens.name,prefix:tokens.prefix,scopes:tokens.scopes,createdAt:tokens.createdAt,
  expiresAt:tokens.expiresAt,revokedAt:tokens.revokedAt,
};
type TokenRow=Pick<typeof tokens.$inferSelect,keyof typeof fields>;
const info=(row:TokenRow):ApiTokenInfo=>({...row,createdAt:new Date(row.createdAt).toISOString(),
  expiresAt:new Date(row.expiresAt).toISOString(),revokedAt:row.revokedAt===null?null:new Date(row.revokedAt).toISOString()});
const owned=(actorId:string)=>and(eq(workspaces.ownerId,actorId),eq(tokens.issuerId,actorId));
const workspaceJoin=and(eq(tokens.workspaceId,workspaces.id),eq(tokens.issuerId,workspaces.ownerId));
const clock=sql`floor(extract(epoch from clock_timestamp())*1000)::bigint`;

export async function readPortableApiTokens(db:PostgresJsDatabase,actorId:string,input:z.infer<typeof portableTokenPage>){
  const limit=25;
  const rows=await db.select(fields).from(tokens).innerJoin(workspaces,workspaceJoin)
    .where(and(owned(actorId),input.afterAt===undefined?undefined:
      sql`(${tokens.createdAt}, ${tokens.id}) < (${input.afterAt}, ${input.afterId})`))
    .orderBy(desc(tokens.createdAt),desc(tokens.id)).limit(limit+1);
  const page=rows.slice(0,limit),last=page.at(-1);
  return {tokens:page.map(info),next:rows.length>limit&&last?{afterAt:last.createdAt,afterId:last.id}:null};
}

export async function createPortableApiToken(tx:Transaction,actorId:string,input:z.infer<typeof portableTokenCreate>,directoryScope?:string){
  const token=newToken(),tokenHash=await digest(token);
  const workspaceId=await lockRecordWorkspace(tx,actorId,true);
  if(!workspaceId)throw Error('API token workspace is unavailable.');
  const createdAt=Date.now();
  const [row]=await tx.insert(tokens).values({
    id:crypto.randomUUID(),workspaceId,issuerId:actorId,name:input.name,prefix:token.slice(0,15),tokenHash,
    scopes:portableTokenScopes(input,directoryScope),createdAt,expiresAt:createdAt+input.days*86_400_000,
  }).returning(fields);
  return {token,info:info(row)};
}

export async function revokePortableApiToken(tx:Transaction,actorId:string,id:string){
  const workspacesOwned=tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.ownerId,actorId));
  const target=and(eq(tokens.issuerId,actorId),eq(tokens.id,id),sql`${tokens.workspaceId} IN (${workspacesOwned})`);
  const [row]=await tx.update(tokens).set({revokedAt:clock})
    .where(and(target,isNull(tokens.revokedAt))).returning({id:tokens.id});
  return !!row||(await tx.select({id:tokens.id}).from(tokens).where(target)).length>0;
}

export async function currentPortableApiToken(db:PostgresJsDatabase,tokenHash:string,lock=false){
  const query=db.select({
    id:tokens.id,workspaceId:tokens.workspaceId,ownerId:workspaces.ownerId,email:loginIdentities.email,scopes:tokens.scopes,
  }).from(tokens).innerJoin(workspaces,workspaceJoin)
    .innerJoin(loginIdentities,eq(loginIdentities.id,workspaces.ownerId))
    .where(and(eq(tokens.tokenHash,tokenHash),isNull(tokens.revokedAt),sql`${tokens.expiresAt} > ${clock}`)).limit(1);
  const [row]=await (lock?query.for('share',{of:tokens}):query);
  return row;
}

export async function lockPortableInquiryToken(db:PostgresJsDatabase,workspaceId:string,ownerId:string,id:string){
  const [token]=await db.select({id:tokens.id}).from(tokens).where(and(
    eq(tokens.id,id),eq(tokens.workspaceId,workspaceId),eq(tokens.issuerId,ownerId),isNull(tokens.revokedAt),
    sql`${tokens.expiresAt} > ${clock} AND ${tokens.scopes} ? 'inquiries:write'`,
  )).for('share');
  return !!token;
}
