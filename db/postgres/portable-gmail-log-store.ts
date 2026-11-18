import {and,eq,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {contacts,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {jobClock} from './job-store';
import {portableContactActivities as activities} from './portable-contact-activity-schema';
import {portableGmailLogReceipts as receipts} from './portable-gmail-log-schema';
import {portableNeverLogExclusion} from './portable-never-log-store';
import {loginIdentities,loginSessions} from './identity-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableGoogleGrants} from './portable-google-schema';

type ContactStamp={id:string;createdAt:string;revision:number;email:string};
type ReceivedMessage={messageId:string;threadId:string;occurredAt:number};

export async function loggedPortableGmailIds(db:PostgresJsDatabase,ownerId:string,mailbox:string,ids:string[]){
  if(!ids.length)return new Set<string>();
  const rows=await db.select({id:receipts.messageId}).from(receipts)
    .innerJoin(privateWorkspaces,eq(receipts.workspaceId,privateWorkspaces.id))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(receipts.mailbox,mailbox),inArray(receipts.messageId,ids)));
  return new Set(rows.map(row=>row.id));
}

export function logPortableGmail(db:PostgresJsDatabase,ownerId:string,mailbox:string,contact:ContactStamp,
  message:ReceivedMessage,address:string,participants:string[],sessionHash:string,summary?:string,personalGrantId?:string){
  return db.transaction(async tx=>{
    // Contact edits, archive and Never Log writes serialize on the same workspace row.
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
    if(!workspaceId)return {state:'changed'} as const;
    // A concurrent logout deletes this row. If it commits first, neither
    // the message body nor a replay receipt can be returned from this log.
    const [session]=await tx.select({id:loginSessions.userId}).from(loginSessions)
      .innerJoin(loginIdentities,eq(loginIdentities.id,loginSessions.userId))
      .where(and(eq(loginSessions.tokenHash,sessionHash),eq(loginSessions.userId,ownerId),
        eq(loginIdentities.email,mailbox),gt(loginSessions.expiresAt,await jobClock(tx))))
      .for('share');
    if(!session)return {state:'unauthorized'} as const;
    if(personalGrantId){
      const [grant]=await tx.select({id:portableGoogleGrants.id}).from(portableGoogleGrants)
        .where(and(eq(portableGoogleGrants.userId,ownerId),eq(portableGoogleGrants.provider,'gmail'),
          eq(portableGoogleGrants.email,mailbox),eq(portableGoogleGrants.id,personalGrantId),
          eq(portableGoogleGrants.needsReconnect,false))).for('share');
      if(!grant)return {state:'connection'} as const;
    }
    const [current]=await tx.select({id:contacts.id}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contact.id),eq(contacts.revision,contact.revision),
        eq(contacts.createdAt,contact.createdAt),sql`${contacts.data}->>'email'=${contact.email}`,activeContact)).limit(1);
    if(!current)return {state:'changed'} as const;
    const blocked=await portableNeverLogExclusion(tx,ownerId,address,participants);
    if(blocked)return {state:blocked} as const;
    const [prior]=await tx.select({contactId:receipts.contactId,contactCreatedAt:receipts.contactCreatedAt,
      threadId:receipts.threadId,occurredAt:receipts.occurredAt,activityId:activities.id})
      .from(receipts).leftJoin(activities,and(eq(activities.workspaceId,receipts.workspaceId),
        eq(activities.id,receipts.activityId),eq(activities.contactId,receipts.contactId)))
      .where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.mailbox,mailbox),eq(receipts.messageId,message.messageId))).limit(1);
    if(prior){
      if(prior.contactId!==contact.id||prior.contactCreatedAt!==contact.createdAt||
         prior.threadId!==message.threadId||prior.occurredAt!==message.occurredAt)return {state:'conflict'} as const;
      return {state:'logged',activityId:prior.activityId,alreadyLogged:true} as const;
    }
    if(summary===undefined)return {state:'new'} as const;
    const recordedAt=await jobClock(tx);
    if(message.occurredAt>recordedAt)return {state:'future'} as const;
    const id=crypto.randomUUID();
    await tx.insert(activities).values({workspaceId,id,contactId:contact.id,actorId:ownerId,
      kind:'Email',occurredAt:message.occurredAt,recordedAt,summary});
    await tx.insert(receipts).values({workspaceId,mailbox,...message,contactId:contact.id,
      contactCreatedAt:contact.createdAt,activityId:id});
    return {state:'logged',activityId:id,alreadyLogged:false} as const;
  });
}
