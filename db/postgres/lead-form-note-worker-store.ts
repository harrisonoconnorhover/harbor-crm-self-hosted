import {and,asc,eq,exists,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {authorizedLeadFormNote,availableJobSlots,jobClock} from './job-store';
import {portableJobs as jobs} from './job-schema';
import {leadFormNoteSources as sources} from './lead-form-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';

const databaseTime=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint`;
const due=sql`${sources.state}='waiting' AND ${sources.nextAt}<=${databaseTime}
  AND (${sources.retryAt} IS NULL OR ${sources.retryAt}<=${databaseTime})`;

export function promotePortableFormNote(db:PostgresJsDatabase){
  return db.transaction(async tx=>{
    const eligible=tx.select({id:sources.inquiryId}).from(sources)
      .where(and(eq(sources.workspaceId,workspaces.id),due));
    const [workspace]=await tx.select({id:workspaces.id}).from(workspaces).where(exists(eligible))
      .orderBy(sql`${workspaces.lastFormNotePromotionAt} ASC NULLS FIRST`,asc(workspaces.id))
      .limit(1).for('no key update',{of:workspaces,skipLocked:true});
    if(!workspace)return 'idle';
    // Recheck the bounded workspace queue after locking it and keep retry
    // order separate from the original due time used for overdue alerts.
    const withinWorkspace=and(eq(sources.workspaceId,workspace.id),due);
    const [source]=await tx.select().from(sources).where(withinWorkspace)
      .orderBy(asc(sql`greatest(${sources.nextAt},${sources.retryAt})`),asc(sources.inquiryId)).limit(1);
    if(!source)return 'idle';
    const scope=and(withinWorkspace,eq(sources.inquiryId,source.inquiryId));
    // Preserve this turn even when a full queue or a failed savepoint prevents promotion.
    await tx.update(workspaces).set({lastFormNotePromotionAt:sql`clock_timestamp()`}).where(eq(workspaces.id,workspace.id));
    const at=await jobClock(tx);
    try{
      return await tx.transaction(async page=>{
        // Leave time to defer the Note before the worker's five-second database deadline.
        await page.execute(sql`SET LOCAL statement_timeout = '3s'`);
        const target=await authorizedLeadFormNote(page,source);
        if(!target){
          await page.update(sources).set({state:'skipped',nextAt:null,retryAt:null,issue:'form_automation_changed'}).where(scope);
          return 'skipped';
        }
        if(!await availableJobSlots(page,source.workspaceId)){
          // At most the workspace's pending cap. Let other due workspaces take the next pass.
          await page.update(sources).set({retryAt:at+10_000}).where(withinWorkspace);
          return 'waiting';
        }
        const [job]=await page.insert(jobs).values({workspaceId:source.workspaceId,id:source.jobId,
          contactId:target.contactId,actorId:source.ownerId,authorizedOwnerId:source.ownerId,
          kind:'note',body:target.body,createdAt:at,scheduledFor:at,availableAt:at})
          .onConflictDoNothing({target:[jobs.workspaceId,jobs.id]}).returning({id:jobs.id});
        await page.update(sources).set({state:job?'queued':'skipped',nextAt:null,retryAt:null,issue:job?null:'form_note_id_conflict'}).where(scope);
        return job?'queued':'skipped';
      });
    }catch{
      await tx.update(sources).set({retryAt:at+30_000}).where(scope);
      return 'retry';
    }
  });
}
