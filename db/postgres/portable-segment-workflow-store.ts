import {and,asc,eq,gt,inArray,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {ContactFields} from '../../lib/portable-records';
import type {PortableSegmentDefinition} from '../../lib/portable-segments';
import type {PortableWorkflowDefinition} from '../../lib/portable-workflows';
import {activeContact} from './contact-visibility';
import {contacts} from './contact-schema';
import {availableJobSlots,jobClock} from './job-store';
import {portableJobs as jobs,portableTaskJobs} from './job-schema';
import {portableSegmentMatch} from './portable-segment-match';
import {portableSegments as segments} from './portable-segment-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';
import {dealWorkflowActivations as activations,dealWorkflowRuns as runs,dealWorkflows as workflows,
  manualWorkflowRuns as manualRuns,segmentWorkflowMembers as members,segmentWorkflowScans as scans} from './workflow-schema';

export const portableSegmentScanPageSize=25;
const scanInterval=60_000;
const nextPageDelay=1_000;
const capacityDelay=10_000;
const retryDelay=30_000;
const databaseTime=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint`;
const scanDue=sql`${scans.nextAt}<=${databaseTime} AND (${scans.retryAt} IS NULL OR ${scans.retryAt}<=${databaseTime})`;

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

// Restore and merge hold the workspace lock. Record changes they introduced
// without treating them as enrollment transitions.
export async function recordSegmentMembershipWithoutEnrollment(tx:Tx,workspaceId:string,contactId:string,previousData?:ContactFields){
  const rules=await tx.select({workflowId:scans.workflowId,epoch:scans.epoch,criteria:segments.criteria})
    .from(scans)
    .innerJoin(activations,and(eq(activations.workspaceId,scans.workspaceId),eq(activations.workflowId,scans.workflowId)))
    .innerJoin(workflows,and(eq(workflows.workspaceId,scans.workspaceId),eq(workflows.id,scans.workflowId),
      eq(workflows.revision,scans.workflowRevision)))
    .innerJoin(segments,and(eq(segments.workspaceId,scans.workspaceId),eq(segments.revision,scans.segmentRevision),eq(segments.mode,'active'),
      sql`${segments.id}::text=${workflows.definition}->>'segmentId'`))
    .where(and(eq(scans.workspaceId,workspaceId),sql`${workflows.definition}->>'trigger'='contact_segment'`));
  if(!rules.length)return;

  const previous=previousData?sql`${JSON.stringify(previousData)}::jsonb`:undefined;
  const matches=sql.join(rules.map(rule=>{
    // For a merge, leave a pending transition from an earlier edit alone if the match is unchanged.
    const wasMatch=previous?sql`coalesce(${portableSegmentMatch(previous,rule.criteria)},false)`:sql`NULL::boolean`;
    return sql`(${rule.workflowId}::uuid,${rule.epoch}::uuid,coalesce(${portableSegmentMatch(contacts.data,rule.criteria)},false),${wasMatch})`;
  }),sql`, `);
  await tx.execute(sql`
    WITH reconciled AS (
      SELECT ${contacts.workspaceId} AS workspace_id,${contacts.id} AS contact_id,
        rule.workflow_id,rule.epoch,rule.matches
      FROM ${contacts} CROSS JOIN LATERAL (VALUES ${matches}) AS rule(workflow_id,epoch,matches,matched_before)
      WHERE ${contacts.workspaceId}=${workspaceId} AND ${contacts.id}=${contactId}
        AND (rule.matched_before IS NULL OR rule.matched_before<>rule.matches)
    ), cleared AS (
      DELETE FROM ${members} AS member USING reconciled
      WHERE member.workspace_id=reconciled.workspace_id AND member.workflow_id=reconciled.workflow_id
        AND member.contact_id=reconciled.contact_id AND NOT reconciled.matches
    )
    INSERT INTO ${members} (workspace_id,workflow_id,contact_id,epoch)
    SELECT workspace_id,workflow_id,contact_id,epoch FROM reconciled WHERE matches
    ON CONFLICT (workspace_id,workflow_id,contact_id) DO UPDATE SET epoch=excluded.epoch
  `);
}

export function scanPortableSegmentWorkflow(db:PostgresJsDatabase){
  return db.transaction(async tx=>{
    // Admission, configuration changes and job claims all take the workspace
    // lock first. Skip a busy workspace, including one selected by another worker.
    const [selected]=await tx.select({workspaceId:scans.workspaceId,workflowId:scans.workflowId})
      .from(scans).innerJoin(workspaces,and(eq(workspaces.id,scans.workspaceId),eq(workspaces.ownerId,scans.ownerId)))
      .innerJoin(activations,and(eq(activations.workspaceId,scans.workspaceId),eq(activations.workflowId,scans.workflowId)))
      .innerJoin(workflows,and(eq(workflows.workspaceId,scans.workspaceId),eq(workflows.id,scans.workflowId)))
      .innerJoin(segments,and(eq(segments.workspaceId,scans.workspaceId),eq(segments.mode,'active'),
        sql`${segments.id}::text=${workflows.definition}->>'segmentId'`))
      .where(and(scanDue,
        sql`${workflows.definition}->>'trigger'='contact_segment'`))
      // Retried scans take their retry's turn without losing their original overdue deadline.
      .orderBy(asc(sql`greatest(${scans.nextAt},${scans.retryAt})`),asc(scans.workspaceId),asc(scans.workflowId)).limit(1)
      .for('no key update',{of:workspaces,skipLocked:true});
    if(!selected)return 'idle';

    // Refresh the joined authority and definition after acquiring the lock.
    const [due]=await tx.select({scan:scans,definition:workflows.definition,
      workflowRevision:workflows.revision,segmentRevision:segments.revision,criteria:segments.criteria})
      .from(scans)
      .innerJoin(activations,and(eq(activations.workspaceId,scans.workspaceId),eq(activations.workflowId,scans.workflowId)))
      .innerJoin(workflows,and(eq(workflows.workspaceId,scans.workspaceId),eq(workflows.id,scans.workflowId)))
      .innerJoin(workspaces,and(eq(workspaces.id,scans.workspaceId),eq(workspaces.ownerId,scans.ownerId)))
      .innerJoin(segments,and(eq(segments.workspaceId,scans.workspaceId),eq(segments.mode,'active'),
        sql`${segments.id}::text=${workflows.definition}->>'segmentId'`))
      .where(and(eq(scans.workspaceId,selected.workspaceId),eq(scans.workflowId,selected.workflowId),
        scanDue,
        sql`${workflows.definition}->>'trigger'='contact_segment'`));
    const definition=due?.definition;
    if(!due||definition?.trigger!=='contact_segment')return 'idle';
    try{
      // The savepoint covers the entire page, including effects and cursor.
      await tx.transaction(async page=>{
        // Leave time to save a retry before the worker's five-second connection deadline.
        await page.execute(sql`SET LOCAL statement_timeout = '3s'`);
        await commitSegmentPage(page,due.scan,definition,due.criteria,due.workflowRevision,due.segmentRevision);
      });
      return 'scanned';
    }catch{
      // Keep the original due time so monitoring can still see a stalled scan.
      await tx.update(scans).set({waitingForCapacity:false,retryAt:await jobClock(tx)+retryDelay})
        .where(and(eq(scans.workspaceId,selected.workspaceId),eq(scans.workflowId,selected.workflowId)));
      return 'retry';
    }
  });
}

async function commitSegmentPage(tx:Tx,scan:typeof scans.$inferSelect,definition:Extract<PortableWorkflowDefinition,{trigger:'contact_segment'}>,
  criteria:PortableSegmentDefinition['criteria'],workflowRevision:number,segmentRevision:number){
  const {workspaceId,workflowId,ownerId}=scan;
  const changed=scan.workflowRevision!==workflowRevision||scan.segmentRevision!==segmentRevision;
  const epoch=changed?crypto.randomUUID():scan.epoch;
  const baseline=changed||scan.baseline;
  const leaving=definition.segmentEvent==='left';
  let cursor=changed?null:scan.cursor;

  // Both receipt indexes start with workspace, workflow and Contact. Keep
  // history out of the page joins so repeated runs cannot multiply rows.
  const previouslyEnrolled=!baseline&&definition.enrollment==='once'?sql<boolean>`
    CASE WHEN ${leaving?sql`${members.epoch}=${epoch}::uuid`:sql`${members.epoch} IS DISTINCT FROM ${epoch}::uuid`} THEN COALESCE(
      (SELECT true FROM ${runs} WHERE ${runs.workspaceId}=${workspaceId} AND ${runs.workflowId}=${workflowId}
        AND ${runs.contactId}=${contacts.id} AND ${runs.jobId} IS NOT NULL LIMIT 1),
      (SELECT true FROM ${manualRuns} WHERE ${manualRuns.workspaceId}=${workspaceId}
        AND ${manualRuns.workflowId}=${workflowId} AND ${manualRuns.contactId}=${contacts.id} LIMIT 1),
      false
    ) ELSE false END
  `:sql<boolean>`false`;
  const page=await tx.select({id:contacts.id,revision:contacts.revision,epoch:members.epoch,receipt:runs.id,
    previouslyEnrolled,active:sql<boolean>`(${activeContact})`,
    matches:sql<boolean>`coalesce((${activeContact}) AND (${portableSegmentMatch(contacts.data,criteria)}),false)`})
    .from(contacts).leftJoin(members,and(eq(members.workspaceId,workspaceId),eq(members.workflowId,workflowId),
      eq(members.contactId,contacts.id)))
    .leftJoin(runs,and(eq(runs.workspaceId,workspaceId),eq(runs.workflowId,workflowId),eq(runs.contactId,contacts.id),
      eq(runs.contactRevision,contacts.revision)))
    .where(and(eq(contacts.workspaceId,workspaceId),cursor?gt(contacts.id,cursor):undefined))
    .orderBy(asc(contacts.id)).limit(portableSegmentScanPageSize+1);

  const at=await jobClock(tx),scheduledFor=at+definition.delayMinutes*60_000;
  const joined:(typeof members.$inferInsert)[]=[],left:string[]=[];
  const queued:(typeof jobs.$inferInsert)[]=[],receipts:(typeof runs.$inferInsert)[]=[];
  const tasks:(typeof portableTaskJobs.$inferInsert)[]=[];
  let slots:number|undefined;
  let waitingForCapacity=false;
  for(const contact of page.slice(0,portableSegmentScanPageSize)){
    const entered=contact.matches&&contact.epoch!==epoch;
    const exited=contact.active&&!contact.matches&&contact.epoch===epoch;
    if(!baseline&&(leaving?exited:entered)&&!contact.receipt&&!contact.previouslyEnrolled){
      slots??=await availableJobSlots(tx,workspaceId);
      if(!slots){
        waitingForCapacity=true;
        break;
      }
      slots--;
      const id=crypto.randomUUID();
      // Exits keep their schedule after a rejoin. Entries check for supersession.
      const task=definition.actionKind==='task'?definition.task:null;
      queued.push({workspaceId,id,contactId:contact.id,actorId:ownerId,authorizedOwnerId:ownerId,
        kind:task?'task':'note',...(!leaving?{segmentEntryRevision:contact.revision,segmentCriteria:criteria}:{}),
        body:definition.actionKind==='task'?definition.task.name:definition.body,
        scheduledFor,availableAt:scheduledFor,createdAt:at});
      if(task)tasks.push({workspaceId,jobId:id,payload:task});
      receipts.push({workspaceId,id,workflowId,workflowRevision,workflowName:definition.name,contactId:contact.id,
        contactRevision:contact.revision,jobId:id,createdAt:at});
    }
    if(entered)joined.push({workspaceId,workflowId,contactId:contact.id,epoch});
    if(!contact.matches&&contact.epoch)left.push(contact.id);
    cursor=contact.id;
  }

  if(queued.length){
    await tx.insert(jobs).values(queued);
    if(tasks.length)await tx.insert(portableTaskJobs).values(tasks);
    await tx.insert(runs).values(receipts);
  }
  if(joined.length)await tx.insert(members).values(joined)
    .onConflictDoUpdate({target:[members.workspaceId,members.workflowId,members.contactId],set:{epoch}});
  if(left.length)await tx.delete(members).where(and(eq(members.workspaceId,workspaceId),eq(members.workflowId,workflowId),
    inArray(members.contactId,left)));
  const more=waitingForCapacity||page.length>portableSegmentScanPageSize;
  // Page scheduling advances independently of the original deadline for the whole scan.
  await tx.update(scans).set({workflowRevision,segmentRevision,epoch,waitingForCapacity,cursor:more?cursor:null,
    cycleDueAt:more?(scan.cycleDueAt??scan.nextAt):null,
    baseline:more&&baseline,retryAt:waitingForCapacity?at+capacityDelay:null,
    nextAt:waitingForCapacity?scan.nextAt:at+(more?nextPageDelay:scanInterval)})
    .where(and(eq(scans.workspaceId,workspaceId),eq(scans.workflowId,workflowId)));
}
