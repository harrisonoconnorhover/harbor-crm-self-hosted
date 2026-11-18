import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableCodeOutput} from '../../lib/portable-workflow-code';
import {portableCodeJobs as codeJobs} from './code-job-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs} from './job-schema';
import {closeAttempt,jobClock,lockClaim,type Claim} from './job-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

const codeKey=(claim:Claim)=>and(eq(codeJobs.workspaceId,claim.workspaceId),eq(codeJobs.jobId,claim.id));
const authorizedOwner=(claim:Pick<Claim,'workspaceId'|'authorizedOwnerId'|'actorId'>)=>and(eq(workspaces.id,claim.workspaceId),
  eq(workspaces.ownerId,claim.authorizedOwnerId??claim.actorId));

export async function readPortableCodePayload(db:PostgresJsDatabase,claim:Claim){
  const [row]=await db.select({payload:codeJobs.payload}).from(codeJobs)
    .innerJoin(jobs,and(eq(jobs.workspaceId,codeJobs.workspaceId),eq(jobs.id,codeJobs.jobId)))
    .innerJoin(workspaces,authorizedOwner(claim))
    .innerJoin(contacts,and(eq(contacts.workspaceId,jobs.workspaceId),eq(contacts.id,jobs.contactId),activeContact)).where(and(codeKey(claim),eq(jobs.kind,'code'),
      eq(jobs.status,'running'),eq(jobs.leaseToken,claim.leaseToken))).limit(1);
  return row?.payload;
}

type CodeOutcome={result:PortableCodeOutput}|{issue:'code_action_failed'|'code_output_invalid'|'authority_changed'};

export function finishPortableCodeJob(db:PostgresJsDatabase,claim:Claim,outcome:CodeOutcome){
  return db.transaction(async tx=>{
    const job=await lockClaim(tx,claim,'running');
    if(!job||job.kind!=='code')return false;
    const at=await jobClock(tx);
    const [owner]=await tx.select({id:workspaces.id}).from(workspaces)
      .innerJoin(contacts,and(eq(contacts.workspaceId,workspaces.id),eq(contacts.id,job.contactId),activeContact))
      .where(authorizedOwner(job)).for('share',{of:contacts}).limit(1);
    if(!owner||'issue' in outcome){
      await closeAttempt(tx,job,at,'failed','issue' in outcome&&owner?outcome.issue:'authority_changed');
      return false;
    }
    const [saved]=await tx.update(codeJobs).set({result:outcome.result}).where(codeKey(claim)).returning({jobId:codeJobs.jobId});
    if(!saved)throw Error('Code receipt unavailable.');
    await closeAttempt(tx,job,at,'succeeded',null);
    return true;
  });
}
