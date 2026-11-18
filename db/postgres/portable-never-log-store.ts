import {and,asc,count,eq,ilike,inArray,or} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {privateWorkspaces} from './contact-schema';
import {portableNeverLogRules as rules} from './portable-never-log-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';

const fields={id:rules.id,value:rules.value,createdAt:rules.createdAt};
const maxRules=500;

export function portableNeverLogPage(db:PostgresJsDatabase,ownerId:string,query:string,offset:number){
  return db.transaction(async tx=>{
    const pattern=recordSearchPattern(query);
    const where=and(eq(privateWorkspaces.ownerId,ownerId),pattern?ilike(rules.value,pattern):undefined);
    const [rows,[total]]=await Promise.all([
      tx.select(fields).from(rules).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,rules.workspaceId))
        .where(where).orderBy(asc(rules.value),asc(rules.id)).limit(26).offset(offset),
      tx.select({count:count()}).from(rules).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,rules.workspaceId)).where(where),
    ]);
    return {results:rows.slice(0,25),total:total.count,next:rows.length>25?offset+25:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function addPortableNeverLog(db:PostgresJsDatabase,ownerId:string,input:{id:string;value:string}){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,true,undefined,undefined,true);
    if(!workspaceId)return null;
    const scope=eq(rules.workspaceId,workspaceId);
    const matches=await tx.select(fields).from(rules)
      .where(and(scope,or(eq(rules.id,input.id),eq(rules.value,input.value)))).limit(2);
    const duplicate=matches.find(rule=>rule.value===input.value);
    if(duplicate)return duplicate;
    if(matches.length)return null;
    const [total]=await tx.select({count:count()}).from(rules).where(scope);
    if(total.count>=maxRules)return null;
    const [rule]=await tx.insert(rules).values({workspaceId,...input,createdAt:new Date().toISOString()}).returning(fields);
    return rule;
  });
}

export function removePortableNeverLog(db:PostgresJsDatabase,ownerId:string,id:string){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
    if(workspaceId)await tx.delete(rules).where(and(eq(rules.workspaceId,workspaceId),eq(rules.id,id)));
  });
}

export async function portableNeverLogExclusion(db:PostgresJsDatabase,ownerId:string,sender:string,participants:string[]=[]){
  const ruleValues=(address:string)=>[address,'*@'+address.slice(address.lastIndexOf('@')+1)];
  const senderValues=ruleValues(sender);
  const values=[...new Set([...senderValues,...participants.flatMap(ruleValues)])];
  const matches=await db.select({value:rules.value}).from(rules)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,rules.workspaceId))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),inArray(rules.value,values)));
  return matches.some(match=>senderValues.includes(match.value))?'sender':matches.length?'participant':null;
}
