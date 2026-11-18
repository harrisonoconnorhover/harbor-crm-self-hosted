import {createHash,createHmac} from 'node:crypto';
import {and,eq,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {OutlookItem,OutlookLookup,OutlookRecordResults} from '../../lib/outlook-records';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {loginIdentities,loginSessions} from './identity-schema';
import {jobClock} from './job-store';
import {portableActivityCreationReceipts as receipts} from './portable-activity-receipt-schema';
import {portableContactActivities as activities} from './portable-contact-activity-schema';
import {portableGoogleGrants as grants} from './portable-google-schema';
import {portableNeverLogRules as rules} from './portable-never-log-schema';
import {lockRecordWorkspace} from './private-workspace-store';

type Context={userId:string;email:string;sessionHash:string;accountId:string;grantId:string};
type Stamp={id:string;createdAt:string;revision:number;email:string};
const hash=(...parts:unknown[])=>createHash('sha256').update(JSON.stringify(parts)).digest();
const ruleKeys=(address:string)=>[address,'*@'+address.slice(address.lastIndexOf('@')+1)];
function activityId(accountId:string,provider:string,id:string){
  const bytes=hash('harbor-outlook-activity-v1',accountId,provider,id).subarray(0,16);
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function proof(context:Context,contact:Stamp,query:OutlookLookup,item:OutlookItem){
  return createHmac('sha256',context.sessionHash).update(JSON.stringify(['harbor-outlook-selection-v1',context.userId,
    context.accountId,context.grantId,contact.id,contact.createdAt,contact.revision,contact.email,query.provider,query.through,query.days,
    item.id,item.occurredAt,item.subject,item.excerpt??'',item.participants])).digest('base64url');
}
export async function finishOutlookLookup(db:PostgresJsDatabase,context:Context,contact:Stamp,query:OutlookLookup,
  results:{items:OutlookItem[];limited:boolean},selection?:string):Promise<OutlookRecordResults|{logged:true;alreadyLogged:boolean}>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,context.userId,false,undefined,undefined,true);
    const changed=()=>new ApiError(409,'The contact or Outlook item changed. Search again before logging.');
    if(!workspaceId)throw changed();
    const now=await jobClock(tx);
    const [session]=await tx.select({id:loginSessions.userId}).from(loginSessions)
      .innerJoin(loginIdentities,eq(loginIdentities.id,loginSessions.userId))
      .where(and(eq(loginSessions.userId,context.userId),eq(loginSessions.tokenHash,context.sessionHash),
        eq(loginIdentities.email,context.email),gt(loginSessions.expiresAt,now))).for('share');
    if(!session)throw new ApiError(401,'Sign in again to read Outlook.');
    const [grant]=await tx.select({id:grants.id}).from(grants).where(and(eq(grants.userId,context.userId),
      sql`${grants.provider}=${query.provider}`,eq(grants.id,context.grantId),eq(grants.email,context.email),eq(grants.needsReconnect,false))).for('share');
    if(!grant)throw new ApiError(409,'Your Outlook connection changed. Reconnect or start a new search.');
    const [current]=await tx.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,workspaceId),
      eq(contacts.id,contact.id),eq(contacts.revision,contact.revision),eq(contacts.createdAt,contact.createdAt),
      sql`${contacts.data}->>'email'=${contact.email}`,activeContact)).limit(1);
    if(!current)throw changed();
    const participants=[...new Set([contact.email.toLowerCase(),...results.items.flatMap(item=>item.participants.filter(person=>person!==context.email))])];
    const excluded=new Set((await tx.select({value:rules.value}).from(rules).where(and(eq(rules.workspaceId,workspaceId),
      inArray(rules.value,[...new Set(participants.flatMap(ruleKeys))])))).map(row=>row.value));
    const blocked=(person:string)=>person!==context.email&&ruleKeys(person).some(key=>excluded.has(key));
    const matches=results.items.filter(item=>item.occurredAt<=now&&!blocked(contact.email.toLowerCase())&&!item.participants.some(blocked))
      .map(item=>({item,id:activityId(context.accountId,query.provider,item.id),selection:proof(context,contact,query,item)}))
      .sort((first,second)=>second.item.occurredAt-first.item.occurredAt||first.id.localeCompare(second.id));
    const ids=matches.map(match=>match.id);
    const prior=new Map((ids.length?await tx.select({id:receipts.id,fingerprint:receipts.fingerprint}).from(receipts)
      .where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.namespace,'contact'),inArray(receipts.id,ids))):[]).map(row=>[row.id,row.fingerprint]));
    if(!selection)return {items:matches.map(({item,id,selection})=>({selection,subject:item.subject,
      occurredAt:item.occurredAt,excerpt:item.excerpt,logged:prior.has(id)})),limited:results.limited};
    const match=matches.find(item=>item.selection===selection);
    if(!match)throw changed();
    const fingerprint='outlook:'+hash(context.accountId,query.provider,contact.id,contact.createdAt).toString('base64url');
    if(prior.has(match.id)){
      if(prior.get(match.id)!==fingerprint)throw new ApiError(409,'This Outlook item has already been recorded. Check the timeline.');
      return {logged:true,alreadyLogged:true};
    }
    const isMail=query.provider==='outlook-mail';
    await tx.insert(activities).values({workspaceId,id:match.id,contactId:contact.id,actorId:context.userId,kind:isMail?'Email':'Meeting',
      occurredAt:match.item.occurredAt,recordedAt:now,summary:(isMail?'Received in Outlook: ':'Attended meeting in Outlook: ')+match.item.subject});
    await tx.insert(receipts).values({workspaceId,namespace:'contact',id:match.id,fingerprint});
    return {logged:true,alreadyLogged:false};
  });
}
