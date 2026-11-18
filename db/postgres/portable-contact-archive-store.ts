import {and,asc,eq,gt,inArray,isNotNull,isNull,ne,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableArchivedRecord,PortableArchiveInput,PortableArchiveReceipt} from '../../lib/portable-contact-archive';
import {contactArchiveReceipts as receipts,contactEvents,contacts,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs} from './job-schema';
import {uncertainGmailIssues} from './job-store';
import {leadFormNoteSources} from './lead-form-schema';
import {portableMeetings as meetings,portableReschedules as reschedules} from './portable-meeting-schema';
import {recordSegmentMembershipWithoutEnrollment} from './portable-segment-workflow-store';
import {lockRecordWorkspace} from './private-workspace-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {archiveAccessError,archivedByLabel,archiveWorkspaceScope} from './portable-archive-scope';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const pageSize=25;
const at=(value:string|null)=>value===null?null:new Date(value).toISOString();

export async function readPortableContactArchive(db:Db,actorId:string,after?:string,shared?:SharedRecordWriteScope){
  const rows=await db.select({id:contacts.id,name:sql<string>`${contacts.data}->>'name'`,
    email:sql<string>`coalesce(${contacts.data}->>'email','')`,revision:contacts.revision,archivedAt:contacts.archivedAt,
    archivedBy:archivedByLabel(contactEvents,contactEvents.contactId,contacts.id,contacts.workspaceId,contacts.revision)})
    .from(contacts).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,contacts.workspaceId))
    // A merged Contact lives on in the one it was merged into, so it isn't listed.
    .where(and(archiveWorkspaceScope(db,actorId,shared),isNotNull(contacts.archivedAt),isNull(contacts.mergedIntoId),after?gt(contacts.id,after):undefined))
    .orderBy(asc(contacts.id)).limit(pageSize+1);
  const records:PortableArchivedRecord[]=rows.slice(0,pageSize).map(row=>({...row,archivedAt:at(row.archivedAt)!}));
  return {records,next:rows.length>pageSize?records.at(-1)!.id:null};
}

export async function pendingContactWork(tx:Tx,workspaceId:string,contactId:string){
  const [row]=await tx.execute<{pending:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.workspaceId}=${workspaceId} AND ${jobs.contactId}=${contactId}
      AND ${inArray(jobs.status,['queued','running','dispatching','attention'])}
      AND (${jobs.status}='attention' AND ${jobs.kind}='gmail' AND ${inArray(jobs.issue,uncertainGmailIssues)}
        AND ${jobs.operatorReviewedAt} IS NOT NULL) IS NOT TRUE)
    OR EXISTS (SELECT 1 FROM ${meetings} LEFT JOIN ${reschedules}
      ON ${reschedules.workspaceId}=${meetings.workspaceId} AND ${reschedules.meetingId}=${meetings.id}
      WHERE ${meetings.workspaceId}=${workspaceId} AND ${meetings.contactId}=${contactId}
      AND ${or(inArray(meetings.status,['submitting','attention','cancelling','cancel_attention']),
        inArray(reschedules.status,['submitting','attention']))}) AS pending
  `);
  return row.pending;
}

export function changePortableContactArchive(db:Db,actorId:string,input:PortableArchiveInput,shared?:SharedRecordWriteScope):Promise<PortableArchiveReceipt>{
  return db.transaction(async tx=>{
    // Admissions and related writes take this lock before deciding which Contact is active.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)throw shared?new ApiError(403,archiveAccessError):new ApiError(404,'Contact not found in your workspace.');
    const {id,requestId,expectedRevision,action}=input;
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.contactId!==id||previous.action!==action||previous.revision!==expectedRevision+1){
        throw new ApiError(409,'That request ID was used for a different Contact change.');
      }
      return {id,action,revision:previous.revision,archivedAt:at(previous.archivedAt)};
    }
    const scope=and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,id));
    const [contact]=await tx.select({archivedAt:contacts.archivedAt,revision:contacts.revision,data:contacts.data,
      primaryCompanyId:contacts.primaryCompanyId,mergedIntoId:contacts.mergedIntoId})
      .from(contacts).where(scope).for('update');
    if(!contact||contact.mergedIntoId)throw new ApiError(404,'Contact not found in your workspace.');
    if(contact.revision!==expectedRevision||Boolean(contact.archivedAt)!==(action==='restore')){
      throw new ApiError(409,'This Contact changed. Refresh before trying again.');
    }
    if(action==='archive'&&await pendingContactWork(tx,workspaceId,id)){
      throw new ApiError(409,'Resolve pending jobs and uncertain Calendar actions, or review uncertain Gmail delivery, before archiving this Contact.');
    }
    const email=contact.data.email?.trim().toLowerCase();
    if(action==='restore'&&email){
      const [duplicate]=await tx.select({id:contacts.id}).from(contacts)
        .where(and(eq(contacts.workspaceId,workspaceId),ne(contacts.id,id),activeContact,
          sql`lower(${contacts.data}->>'email')=${email}`)).limit(1);
      if(duplicate)throw new ApiError(409,'An active Contact already has this email address.');
    }
    const now=new Date().toISOString(),archivedAt=action==='archive'?now:null,revision=expectedRevision+1;
    await tx.update(contacts).set({archivedAt,revision,updatedAt:now}).where(scope);
    // Keep each record revision addressable by workflow and history readers.
    await tx.insert(contactEvents).values({workspaceId,contactId:id,revision,actorId,
      previous:contact.data,data:contact.data,previousPrimaryCompanyId:contact.primaryCompanyId,
      primaryCompanyId:contact.primaryCompanyId,occurredAt:now});
    if(action==='restore')await recordSegmentMembershipWithoutEnrollment(tx,workspaceId,id);
    else await tx.update(leadFormNoteSources).set({state:'skipped',nextAt:null,retryAt:null,issue:'form_automation_changed'})
      .where(and(eq(leadFormNoteSources.workspaceId,workspaceId),eq(leadFormNoteSources.contactId,id),
        eq(leadFormNoteSources.state,'waiting')));
    await tx.insert(receipts).values({workspaceId,requestId,contactId:id,action,revision,archivedAt});
    return {id,action,revision,archivedAt};
  });
}
