import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs} from './job-schema';
import {closeAttempt,jobClock,lockClaim,segmentEntrySuperseded,type Claim} from './job-store';
import {dealWorkflowActivations,dealWorkflows} from './workflow-schema';
import {privateWorkspaces} from './workspace-schema';

export async function beginWorkflowWebhookDispatch(db:PostgresJsDatabase,claim:Claim,configured:boolean){
  const source=claim.workflowWebhook;
  if(!source)return false;
  return db.transaction(async tx=>{
    // Serialize the dispatch decision with workflow edits, deactivation and Contact archive.
    const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,claim.workspaceId)).for('no key update');
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='external')return false;
    const [contact]=await tx.select({revision:contacts.revision}).from(contacts).where(and(eq(contacts.workspaceId,job.workspaceId),
      eq(contacts.id,job.contactId),activeContact)).for('share');
    if(!contact||workspace?.ownerId!==(job.authorizedOwnerId??job.actorId)){
      await closeAttempt(tx,job,await jobClock(tx),'failed','authority_changed');
      return false;
    }
    const [active]=await tx.select({id:dealWorkflows.id}).from(dealWorkflows)
      .innerJoin(dealWorkflowActivations,and(eq(dealWorkflowActivations.workspaceId,dealWorkflows.workspaceId),
        eq(dealWorkflowActivations.workflowId,dealWorkflows.id)))
      .where(and(eq(dealWorkflows.workspaceId,job.workspaceId),eq(dealWorkflows.id,source.workflowId),
        eq(dealWorkflows.revision,source.workflowRevision)));
    const at=await jobClock(tx);
    if(job.leaseUntil===null||job.leaseUntil<=at)return false;
    if(!active){
      await closeAttempt(tx,job,at,'skipped','webhook_workflow_changed');
      return false;
    }
    if(await segmentEntrySuperseded(tx,job,contact.revision)){
      await closeAttempt(tx,job,at,'skipped','segment_left');
      return false;
    }
    if(!configured){
      await closeAttempt(tx,job,at,'failed','webhook_destination_unavailable');
      return false;
    }
    const dispatchAt=await jobClock(tx);
    if(job.leaseUntil<=dispatchAt)return false;
    await tx.update(jobs).set({status:'dispatching',leaseUntil:dispatchAt+30_000})
      .where(and(eq(jobs.workspaceId,job.workspaceId),eq(jobs.id,job.id)));
    return true;
  });
}

type DeliveryReceipt={status:'delivered'|'pending'|'uncertain'|'failed';httpStatus:number|null;delay:number};

export async function finishWorkflowWebhookDispatch(db:PostgresJsDatabase,claim:Claim,receipt:DeliveryReceipt){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'dispatching');
    if(!job||job.kind!=='external')return;
    const at=await jobClock(tx);
    switch(receipt.status){
      case 'delivered':return closeAttempt(tx,job,at,'succeeded',null);
      case 'uncertain':return closeAttempt(tx,job,at,'attention','external_outcome_unknown');
      case 'pending':return closeAttempt(tx,job,at,'queued','webhook_rate_limited',at+receipt.delay*1000);
      case 'failed':return closeAttempt(tx,job,at,'failed',receipt.httpStatus===429?'webhook_rate_limited':'webhook_rejected');
    }
  });
}
