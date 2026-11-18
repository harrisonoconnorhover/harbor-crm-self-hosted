import {and,eq,gt} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {lockPortableLoginSession as lockSession,type PostgresSessionActor} from './identity-store';
import {portableGoogleAttempts as attempts,portableGoogleGrants as grants,type PersonalConnectionProvider} from './portable-google-schema';

type Db=PostgresJsDatabase;
export type ConnectionActor=PostgresSessionActor;
type Attempt=typeof attempts.$inferSelect;
type Grant=typeof grants.$inferSelect;
const attemptFor=(actor:ConnectionActor,provider:PersonalConnectionProvider)=>and(eq(attempts.userId,actor.userId),eq(attempts.provider,provider));
const grantFor=(actor:Pick<ConnectionActor,'userId'>,provider:PersonalConnectionProvider)=>and(eq(grants.userId,actor.userId),eq(grants.provider,provider));
const currentAttempt=(actor:ConnectionActor,provider:PersonalConnectionProvider,stateHash:string)=>and(attemptFor(actor,provider),
  eq(attempts.sessionHash,actor.sessionHash),eq(attempts.stateHash,stateHash),gt(attempts.expiresAt,Date.now()));

export async function saveConnectionAttempt(db:Db,actor:ConnectionActor,value:Pick<Attempt,'provider'|'stateHash'|'verifier'|'expiresAt'>){
  return db.transaction(async tx=>{
    if(!await lockSession(tx,actor))return false;
    const values={...value,userId:actor.userId,sessionHash:actor.sessionHash,claimed:false};
    await tx.insert(attempts).values(values).onConflictDoUpdate({target:[attempts.userId,attempts.provider],set:values});
    return true;
  });
}

export async function claimConnectionAttempt(db:Db,actor:ConnectionActor,provider:PersonalConnectionProvider,stateHash:string){
  return db.transaction(async tx=>{
    if(!await lockSession(tx,actor))return null;
    const [attempt]=await tx.update(attempts).set({claimed:true})
      .where(and(currentAttempt(actor,provider,stateHash),eq(attempts.claimed,false))).returning({verifier:attempts.verifier});
    return attempt?.verifier??null;
  });
}

export async function saveConnectionGrant(db:Db,actor:ConnectionActor,stateHash:string,value:Pick<Grant,'provider'|'id'|'refreshToken'>){
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

export async function readConnectionGrant(db:Db,actor:Pick<ConnectionActor,'userId'|'email'>,provider:PersonalConnectionProvider){
  const [grant]=await db.select().from(grants).where(grantFor(actor,provider));
  return grant?.email===actor.email?grant:undefined;
}

export async function readConnectionGrantStatus(db:Db,actor:Pick<ConnectionActor,'userId'|'email'>,provider:PersonalConnectionProvider){
  const [status]=await db.select({id:grants.id,email:grants.email,needsReconnect:grants.needsReconnect}).from(grants)
    .where(and(grantFor(actor,provider),eq(grants.email,actor.email)));
  return status??null;
}

export async function updateConnectionGrant(db:Db,actor:ConnectionActor,expected:Grant,value:{refreshToken:string}|{needsReconnect:true}){
  const [updated]=await db.update(grants).set(value).where(and(grantFor(actor,expected.provider),
    eq(grants.id,expected.id),eq(grants.refreshToken,expected.refreshToken),eq(grants.needsReconnect,false)))
    .returning({id:grants.id});
  return Boolean(updated);
}

class StaleConnectionDisconnect extends Error{}
export async function disconnectConnectionGrant(db:Db,actor:ConnectionActor,provider:PersonalConnectionProvider,id:string){
  try{
    return await db.transaction(async tx=>{
      if(!await lockSession(tx,actor))return false;
      // Keep the same attempt -> grant lock order as callback completion.
      await tx.delete(attempts).where(attemptFor(actor,provider));
      const [removed]=await tx.delete(grants)
        .where(and(grantFor(actor,provider),eq(grants.id,id),eq(grants.email,actor.email))).returning({id:grants.id});
      if(!removed)throw new StaleConnectionDisconnect();
      return true;
    });
  }catch(error){if(error instanceof StaleConnectionDisconnect)return false;throw error;}
}
