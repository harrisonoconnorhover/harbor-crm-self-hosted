import {and,asc,eq,gt,inArray,isNull,lte,sql} from 'drizzle-orm';
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

type PortableProviderPolicy={
  provider?:'google'|'microsoft'|'saml'|'oidc';
  reservedForOtherProvider:(email:string)=>boolean;
  activeSession:(identity:{oidcSubject:string|null;microsoftSubject:string|null;samlSubject:string|null;oidcDirectoryIssuer:string|null;samlDirectoryIssuer:string|null;email:string;directoryAuthority:string|null})=>boolean;
};
export function postgresIdentityStore(db:PostgresJsDatabase,policy?:PortableProviderPolicy):GoogleIdentityStore{
  return {
    async recordIdentity(identity,now){
      const provider=policy?.provider??'google';
      const subjectKey=({oidc:'oidcSubject',google:'googleSubject',microsoft:'microsoftSubject',saml:'samlSubject'} as const)[provider];
      const subject=loginIdentities[subjectKey];
      return db.transaction(async tx=>{
        // Two web processes may receive callbacks for the same address concurrently.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.email},0))`);
        const conflict=provider==='google'?isNull(loginIdentities.googleSubject):sql`${subject} IS DISTINCT FROM ${identity.subject}`;
        const [occupant]=await tx.select({id:loginIdentities.id}).from(loginIdentities)
          .where(and(eq(loginIdentities.email,identity.email),conflict)).limit(1);
        if(occupant)throw Error('This Harbor address already belongs to another identity.',{cause:'account-conflict'});
        if(policy?.reservedForOtherProvider(identity.email)){
          const [incumbent]=await tx.select({id:loginIdentities.id}).from(loginIdentities)
            .where(and(eq(loginIdentities.email,identity.email),eq(subject,identity.subject))).limit(1);
          if(!incumbent)throw Error('This address is reserved for another sign-in provider.',{cause:'account-conflict'});
        }
        const [account]=await tx.insert(loginIdentities).values({
          id:crypto.randomUUID(),[subjectKey]:identity.subject,
          email:identity.email,fullName:identity.fullName,createdAt:now,updatedAt:now,
        }).onConflictDoUpdate({
          target:subject,set:{email:identity.email,fullName:identity.fullName,updatedAt:now},
          setWhere:provider==='google'?undefined:eq(loginIdentities.email,identity.email),
        }).returning({id:loginIdentities.id});
        if(!account)throw Error('The stored sign-in account uses a different Harbor address.',{cause:'account-conflict'});
        return account.id;
      });
    },
    async saveSession(session,priorSessionHash){
      await db.transaction(async tx=>{
        await tx.insert(loginSessions).values(session);
        if(priorSessionHash)await tx.delete(loginSessions).where(eq(loginSessions.tokenHash,priorSessionHash));
        const expired=tx.select({tokenHash:loginSessions.tokenHash}).from(loginSessions)
          .where(lte(loginSessions.expiresAt,session.createdAt)).orderBy(asc(loginSessions.expiresAt)).limit(100);
        await tx.delete(loginSessions).where(inArray(loginSessions.tokenHash,expired));
      });
    },
    async findSession(tokenHash,now){
      const [identity]=await db.select({userId:loginIdentities.id,email:loginIdentities.email,fullName:loginIdentities.fullName,microsoftSubject:loginIdentities.microsoftSubject,oidcSubject:loginIdentities.oidcSubject,samlSubject:loginIdentities.samlSubject,oidcDirectoryIssuer:loginIdentities.oidcDirectoryIssuer,samlDirectoryIssuer:loginIdentities.samlDirectoryIssuer,directoryAuthority:loginIdentities.directoryAuthority})
        .from(loginSessions).innerJoin(loginIdentities,eq(loginIdentities.id,loginSessions.userId))
        .where(and(eq(loginSessions.tokenHash,tokenHash),gt(loginSessions.expiresAt,now)));
      if(!identity||!(policy?policy.activeSession(identity):!identity.microsoftSubject&&!identity.samlSubject&&!identity.oidcSubject))return;
      return {userId:identity.userId,email:identity.email,fullName:identity.fullName};
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
