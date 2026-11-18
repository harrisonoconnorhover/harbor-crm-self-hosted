import {and,asc,eq,gt,inArray,lte} from 'drizzle-orm';
import {drizzle,type PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type {GoogleIdentityStore} from '../../lib/identity-service';
import {loginIdentities,loginSessions} from './identity-schema';

export type PostgresSessionActor={userId:string;email:string;sessionHash:string};
type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export async function lockPortableLoginSession(tx:Transaction,actor:PostgresSessionActor){
  const [session]=await tx.select({hash:loginSessions.tokenHash}).from(loginSessions)
    .innerJoin(loginIdentities,eq(loginIdentities.id,loginSessions.userId))
    .where(and(eq(loginSessions.userId,actor.userId),eq(loginSessions.tokenHash,actor.sessionHash),
      eq(loginIdentities.email,actor.email),gt(loginSessions.expiresAt,Date.now())))
    .for('share',{of:loginSessions});
  return Boolean(session);
}

export function postgresIdentityStore(db:PostgresJsDatabase):GoogleIdentityStore{
  return {
    async recordIdentity(identity,now){
      const [account]=await db.insert(loginIdentities).values({
        id:crypto.randomUUID(),googleSubject:identity.subject,email:identity.email,fullName:identity.fullName,createdAt:now,updatedAt:now,
      }).onConflictDoUpdate({
        target:loginIdentities.googleSubject,set:{email:identity.email,fullName:identity.fullName,updatedAt:now},
      }).returning({id:loginIdentities.id});
      return account.id;
    },
    async saveSession(session){
      await db.transaction(async tx=>{
        await tx.insert(loginSessions).values(session);
        const expired=tx.select({tokenHash:loginSessions.tokenHash}).from(loginSessions)
          .where(lte(loginSessions.expiresAt,session.createdAt)).orderBy(asc(loginSessions.expiresAt)).limit(100);
        await tx.delete(loginSessions).where(inArray(loginSessions.tokenHash,expired));
      });
    },
    async findSession(tokenHash,now){
      const [identity]=await db.select({userId:loginIdentities.id,email:loginIdentities.email,fullName:loginIdentities.fullName})
        .from(loginSessions).innerJoin(loginIdentities,eq(loginIdentities.id,loginSessions.userId))
        .where(and(eq(loginSessions.tokenHash,tokenHash),gt(loginSessions.expiresAt,now)));
      return identity;
    },
    async revokeSession(tokenHash,allDevices,now){
      if(allDevices){
        const current=db.select({userId:loginSessions.userId}).from(loginSessions)
          .where(and(eq(loginSessions.tokenHash,tokenHash),gt(loginSessions.expiresAt,now)));
        await db.delete(loginSessions).where(inArray(loginSessions.userId,current));
      }else await db.delete(loginSessions).where(eq(loginSessions.tokenHash,tokenHash));
    },
  };
}

export function openPostgresIdentity(databaseUrl:string){
  const client=postgres(databaseUrl);
  return {store:postgresIdentityStore(drizzle(client)),close:()=>client.end()};
}
