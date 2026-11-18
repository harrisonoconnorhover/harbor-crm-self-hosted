import {and,eq,isNull} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {emailContent} from '../../lib/email/message';
import {suppressedAddress} from '../../lib/email/suppression';
import {insertEmailUnsubscribeToken,workspaceEmailBlocked} from './email-suppression-store';
import {emailSuppressions as blocks} from './email-suppression-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {loginIdentities} from './identity-schema';
import {availableJobSlots,closeAttempt,gmailReauthorizationIssue,gmailSuppressedIssue,jobClock,lockClaim,segmentEntrySuperseded,type Claim} from './job-store';
import {portableJobs as jobs} from './job-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {scheduledGmail as mail} from './scheduled-gmail-schema';
import {privateWorkspaces} from './workspace-schema';
import {dealWorkflowActivations,dealWorkflowRuns,dealWorkflows} from './workflow-schema';

type Db=PostgresJsDatabase;
type Scope={workspaceId:string;contactId:string};
type Addressed={workspaceId:string;id:string};
type Schedule={id:string;recipient:string;subject:string;body:string;scheduledFor:number};
export const gmailSendGraceMs=15*60_000;
// Plain Gmail sends have a 15 s network deadline. Allow time to save the receipt.
const dispatchLeaseMs=30_000;
const jobScope=(job:Addressed)=>and(eq(jobs.workspaceId,job.workspaceId),eq(jobs.id,job.id));
const mailScope=(job:Addressed)=>and(eq(mail.workspaceId,job.workspaceId),eq(mail.jobId,job.id));
const addressed=and(eq(mail.workspaceId,jobs.workspaceId),eq(mail.jobId,jobs.id));
const workspaceOwner=and(eq(privateWorkspaces.id,jobs.workspaceId),eq(privateWorkspaces.ownerId,jobs.actorId));
export const portableGmailMessageId=(job:Addressed)=>'<harbor.'+job.id+'@'+job.workspaceId+'.harbor.invalid>';

const normalize=(email:unknown)=>{
  const parsed=suppressedAddress.safeParse(email);
  return parsed.success?parsed.data:null;
};

export function enqueueGmail(db:Db,scope:Scope,actorId:string,sender:string,input:Schedule){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId||workspaceId!==scope.workspaceId)return 'missing';
    const [existing]=await tx.select({job:jobs,mail}).from(jobs).leftJoin(mail,addressed).where(jobScope({...scope,id:input.id}));
    if(existing){
      const {job,mail:message}=existing;
      return job.kind==='gmail'&&job.contactId===scope.contactId&&job.actorId===actorId&&job.body===input.body&&
        job.scheduledFor===input.scheduledFor&&message?.subject===input.subject&&message.sender===sender&&message.recipient===input.recipient?'ok':'conflict';
    }
    const [contact]=await tx.select({data:contacts.data}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,scope.contactId),activeContact));
    if(!contact)return 'missing';
    const recipient=normalize(contact.data.email);
    if(!recipient)return 'recipient';
    if(recipient!==input.recipient)return 'recipient_changed';
    if(!emailContent.safeParse({to:[recipient],subject:input.subject,body:input.body}).success)return 'content';
    if(await workspaceEmailBlocked(tx,workspaceId,recipient))return 'suppressed';
    const at=await jobClock(tx);
    if(input.scheduledFor<at-gmailSendGraceMs||input.scheduledFor>at+90*86_400_000)return 'date';
    if(!await availableJobSlots(tx,workspaceId))return 'full';
    await tx.insert(jobs).values({...scope,id:input.id,actorId,kind:'gmail',body:input.body,
      scheduledFor:input.scheduledFor,availableAt:input.scheduledFor,createdAt:at});
    await tx.insert(mail).values({workspaceId,jobId:input.id,sender,recipient,subject:input.subject});
    return 'ok';
  });
}

export function rejectGmailMailbox(db:Db,claim:Claim,issue:'gmail_mailbox_unavailable'|typeof gmailReauthorizationIssue='gmail_mailbox_unavailable'){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(job?.kind==='gmail')await closeAttempt(tx,job,await jobClock(tx),'failed',issue);
  });
}

function suppressedPendingGmail(db:Db,job:Addressed,sender:string){
  return db.select({id:mail.jobId}).from(mail)
    .innerJoin(blocks,and(eq(blocks.workspaceId,mail.workspaceId),eq(blocks.email,mail.recipient)))
    .where(and(mailScope(job),eq(mail.sender,sender),isNull(mail.dispatchStartedAt)));
}

export async function skipSuppressedGmailBeforeRefresh(db:Db,claim:Claim,sender:string){
  if(!(await suppressedPendingGmail(db,claim,sender)).length)return false;
  return db.transaction(async tx=>{
    // Recheck under the same lock as opt-out and manual suppression changes.
    const workspaceId=await lockRecordWorkspace(tx,claim.actorId,false,undefined,undefined,true);
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='gmail')return true;
    if(workspaceId!==job.workspaceId||!(await suppressedPendingGmail(tx,job,sender)).length)return false;
    await closeAttempt(tx,job,await jobClock(tx),'skipped',gmailSuppressedIssue);
    return true;
  });
}

export function checkGmailDeadlineBeforeRefresh(db:Db,claim:Claim){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='gmail')return false;
    const at=await jobClock(tx);
    if(job.leaseUntil===null||job.leaseUntil<=at)return false;
    if(at-job.scheduledFor<=gmailSendGraceMs)return true;
    const [message]=await tx.select({dispatchStartedAt:mail.dispatchStartedAt}).from(mail).where(mailScope(job));
    const finishedAt=await jobClock(tx);
    if(job.leaseUntil<=finishedAt)return false;
    if(message?.dispatchStartedAt!=null)await closeAttempt(tx,job,finishedAt,'attention','external_outcome_unknown');
    else await closeAttempt(tx,job,finishedAt,'failed','email_schedule_expired');
    return false;
  });
}

export function beginGmailDispatch(db:Db,claim:Claim,sender:string,workflowGmailEnabled:boolean){
  return db.transaction(async tx=>{
    // Address edits and opt-outs take this same lock before they commit.
    const workspaceId=await lockRecordWorkspace(tx,claim.actorId,false,undefined,undefined,true);
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='gmail')return null;
    const at=await jobClock(tx);
    const [message]=await tx.select().from(mail).where(mailScope(job));
    const [identity]=await tx.select({email:loginIdentities.email}).from(loginIdentities).where(eq(loginIdentities.id,job.actorId));
    if(workspaceId!==job.workspaceId||message?.sender!==sender||normalize(identity?.email)!==sender){
      await closeAttempt(tx,job,at,'failed','gmail_mailbox_unavailable');
      return null;
    }
    if(message.dispatchStartedAt!==null){
      await closeAttempt(tx,job,at,'attention','external_outcome_unknown');
      return null;
    }
    if(at-job.scheduledFor>gmailSendGraceMs){
      await closeAttempt(tx,job,at,'failed','email_schedule_expired');
      return null;
    }
    const [contact]=await tx.select({data:contacts.data,revision:contacts.revision}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,job.contactId),activeContact));
    if(job.segmentEntryRevision!==null){
      const [rule]=await tx.select({id:dealWorkflows.id}).from(dealWorkflowRuns)
        .innerJoin(dealWorkflows,and(eq(dealWorkflows.workspaceId,dealWorkflowRuns.workspaceId),
          eq(dealWorkflows.id,dealWorkflowRuns.workflowId),eq(dealWorkflows.revision,dealWorkflowRuns.workflowRevision)))
        .innerJoin(dealWorkflowActivations,and(eq(dealWorkflowActivations.workspaceId,dealWorkflows.workspaceId),
          eq(dealWorkflowActivations.workflowId,dealWorkflows.id)))
        .where(and(eq(dealWorkflowRuns.workspaceId,workspaceId),eq(dealWorkflowRuns.id,job.id),eq(dealWorkflowRuns.jobId,job.id)));
      if(!workflowGmailEnabled||!rule){
        await closeAttempt(tx,job,at,'skipped','gmail_workflow_changed');
        return null;
      }
      if(contact&&await segmentEntrySuperseded(tx,job,contact.revision)){
        await closeAttempt(tx,job,at,'skipped','segment_left');
        return null;
      }
    }
    if(normalize(contact?.data.email)!==message.recipient){
      await closeAttempt(tx,job,at,'skipped','email_address_changed');
      return null;
    }
    if(await workspaceEmailBlocked(tx,workspaceId,message.recipient)){
      await closeAttempt(tx,job,at,'skipped',gmailSuppressedIssue);
      return null;
    }
    const dispatchAt=await jobClock(tx);
    if(job.leaseUntil===null||job.leaseUntil<=dispatchAt)return null;
    // The contact and suppression reads can wait after the initial deadline check.
    if(dispatchAt-job.scheduledFor>gmailSendGraceMs){
      await closeAttempt(tx,job,dispatchAt,'failed','email_schedule_expired');
      return null;
    }
    await tx.update(jobs).set({status:'dispatching',leaseUntil:dispatchAt+dispatchLeaseMs}).where(jobScope(job));
    await tx.update(mail).set({dispatchStartedAt:dispatchAt}).where(mailScope(job));
    const token=await insertEmailUnsubscribeToken(tx,workspaceId,job.actorId,message.recipient);
    return {recipient:message.recipient,subject:message.subject,body:job.body,token,at:dispatchAt,
      sendBefore:Math.min(job.scheduledFor+gmailSendGraceMs,dispatchAt+dispatchLeaseMs),messageId:portableGmailMessageId(job)};
  });
}

export function finishGmailDispatch(db:Db,claim:Claim,providerId?:string){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'dispatching');
    if(!job||job.kind!=='gmail')return;
    if(providerId)await tx.update(mail).set({providerId}).where(mailScope(job));
    await closeAttempt(tx,job,await jobClock(tx),providerId?'succeeded':'attention',providerId?null:'external_outcome_unknown');
  });
}

export async function gmailReconciliationTarget(db:Db,key:Addressed,sender:string){
  const [row]=await db.select({status:jobs.status,issue:jobs.issue,scheduledFor:jobs.scheduledFor,
    dispatchStartedAt:mail.dispatchStartedAt}).from(jobs)
    .innerJoin(mail,addressed).innerJoin(privateWorkspaces,workspaceOwner)
    .innerJoin(loginIdentities,eq(loginIdentities.id,jobs.actorId)).where(and(
      jobScope(key),eq(jobs.kind,'gmail'),eq(mail.sender,sender),eq(loginIdentities.email,sender)));
  return row;
}

export function recordGmailReconciliation(db:Db,key:Addressed,sender:string,providerId:string){
  return db.transaction(async tx=>{
    const [job]=await tx.select({job:jobs}).from(jobs).innerJoin(mail,addressed).innerJoin(privateWorkspaces,workspaceOwner)
      .innerJoin(loginIdentities,eq(loginIdentities.id,jobs.actorId)).where(and(
        jobScope(key),eq(jobs.kind,'gmail'),eq(mail.sender,sender),eq(loginIdentities.email,sender))).for('update',{of:jobs});
    if(job?.job.status==='succeeded')return true;
    if(job?.job.status!=='attention')return false;
    await tx.update(mail).set({providerId}).where(mailScope(key));
    // Keep the original attempt's outcome visible. Reconciliation records the provider receipt on the job.
    await tx.update(jobs).set({status:'succeeded',issue:null,finishedAt:await jobClock(tx)}).where(jobScope(key));
    return true;
  });
}
