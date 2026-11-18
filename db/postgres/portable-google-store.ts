import {and,eq,gt} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {lockPortableLoginSession as lockSession,type PostgresSessionActor} from './identity-store';
import {portableGoogleAttempts as attempts,portableGoogleGrants as grants,type PortableGoogleProvider} from './portable-google-schema';

type Db=PostgresJsDatabase;
export type GoogleActor=PostgresSessionActor;
type Attempt=typeof attempts.$inferSelect;
type Grant=typeof grants.$inferSelect;
const attemptFor=(actor:GoogleActor,provider:PortableGoogleProvider)=>and(eq(attempts.userId,actor.userId),eq(attempts.provider,provider));
const grantFor=(actor:Pick<GoogleActor,'userId'>,provider:PortableGoogleProvider)=>and(eq(grants.userId,actor.userId),eq(grants.provider,provider));
const currentAttempt=(actor:GoogleActor,provider:PortableGoogleProvider,stateHash:string)=>and(attemptFor(actor,provider),
  eq(attempts.sessionHash,actor.sessionHash),eq(attempts.stateHash,stateHash),gt(attempts.expiresAt,Date.now()));

export async function saveGoogleAttempt(db:Db,actor:GoogleActor,value:Pick<Attempt,'provider'|'stateHash'|'verifier'|'expiresAt'>){
  return db.transaction(async tx=>{
    if(!await lockSession(tx,actor))return false;
    const values={...value,userId:actor.userId,sessionHash:actor.sessionHash,claimed:false};
    await tx.insert(attempts).values(values).onConflictDoUpdate({target:[attempts.userId,attempts.provider],set:values});
    return true;
  });
}

export async function claimGoogleAttempt(db:Db,actor:GoogleActor,provider:PortableGoogleProvider,stateHash:string){
  return db.transaction(async tx=>{
    if(!await lockSession(tx,actor))return null;
    const [attempt]=await tx.update(attempts).set({claimed:true})
      .where(and(currentAttempt(actor,provider,stateHash),eq(attempts.claimed,false))).returning({verifier:attempts.verifier});
    return attempt?.verifier??null;
  });
}

export async function saveGoogleGrant(db:Db,actor:GoogleActor,stateHash:string,value:Pick<Grant,'provider'|'id'|'refreshToken'>){
  return db.transaction(async tx=>{
    if(!await lockSession(tx,actor))return false;
    const [attempt]=await tx.delete(attempts)
      .where(and(currentAttempt(actor,value.provider,stateHash),eq(attempts.claimed,true))).returning({hash:attempts.stateHash});
    if(!attempt)return false;
    const values={...value,userId:actor.userId,email:actor.email,needsReconnect:false};
    await tx.insert(grants).values(values).onConflictDoUpdate({target:[grants.userId,grants.provider],set:values});
    return true;
  });
}

export async function readGoogleGrant(db:Db,actor:Pick<GoogleActor,'userId'|'email'>,provider:PortableGoogleProvider){
  const [grant]=await db.select().from(grants).where(grantFor(actor,provider));
  return grant?.email===actor.email?grant:undefined;
}

export async function readGoogleGrantStatus(db:Db,actor:Pick<GoogleActor,'userId'|'email'>,provider:PortableGoogleProvider){
  const [status]=await db.select({id:grants.id,email:grants.email,needsReconnect:grants.needsReconnect}).from(grants)
    .where(and(grantFor(actor,provider),eq(grants.email,actor.email)));
  return status??null;
}

export async function updateGoogleGrant(db:Db,actor:GoogleActor,expected:Grant,value:{refreshToken:string}|{needsReconnect:true}){
  const [updated]=await db.update(grants).set(value).where(and(grantFor(actor,expected.provider),
    eq(grants.id,expected.id),eq(grants.refreshToken,expected.refreshToken),eq(grants.needsReconnect,false)))
    .returning({id:grants.id});
  return Boolean(updated);
}

class StaleGoogleDisconnect extends Error{}
export async function disconnectGoogleGrant(db:Db,actor:GoogleActor,provider:PortableGoogleProvider,id:string){
  try{
    return await db.transaction(async tx=>{
      if(!await lockSession(tx,actor))return false;
      // Keep the same attempt -> grant lock order as callback completion.
      await tx.delete(attempts).where(attemptFor(actor,provider));
      const [removed]=await tx.delete(grants)
        .where(and(grantFor(actor,provider),eq(grants.id,id),eq(grants.email,actor.email))).returning({id:grants.id});
      if(!removed)throw new StaleGoogleDisconnect();
      return true;
    });
  }catch(error){if(error instanceof StaleGoogleDisconnect)return false;throw error;}
}
