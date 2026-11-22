import {sequenceRepCanEditContact,sequenceRepCanWorkTasks} from './sales-sequence-access';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {SalesSequenceStep} from '../../lib/portable-sales-sequences';
import {portableTaskFields} from '../../lib/portable-tasks';
import {jobClock} from './job-store';
import {salesEnrollments as enrollments,salesSequenceActivations as activations,salesSequenceSteps as steps} from './sales-sequence-schema';
import {salesSequenceExitCandidate} from './sales-sequence-exit';
import {enqueueGmail} from './scheduled-gmail-store';
import {savePortableTask} from './task-store';

type Db=PostgresJsDatabase;
type Candidate={
  workspace_id:string;enrollment_id:string;step_id:string;position:number;definition:SalesSequenceStep;step_state:'ready'|'queued';
  actor_id:string;assignee_id:string;contact_id:string;recipient:string|null;sender:string;issue:string|null;
  due_at:string;completed_at:string|null;exit_signal:string|null;delivery_confirmed:boolean|null;
};

// Only a due action, an invalidated enrollment, or the exact linked task/job becoming
// actionable can win a turn. An open task never consumes the worker's next pass.
function eligibleSteps(db:Db,at:number,keys?:Pick<Candidate,'workspace_id'|'step_id'>){
  return sql`SELECT e.workspace_id,e.id AS enrollment_id,s.id AS step_id,s.position,s.definition,s.state AS step_state,
    e.actor_id,e.assignee_id,e.contact_id,e.recipient,e.sender,s.due_at,checks.issue,exit_test.signal AS exit_signal,
    CASE WHEN m.dispatch_started_at IS NOT NULL OR j.status='succeeded' THEN
      j.status='succeeded' AND m.provider_id IS NOT NULL AND m.dispatch_started_at IS NOT NULL END AS delivery_confirmed,
    CASE WHEN s.job_id IS NOT NULL THEN j.finished_at ELSE floor(extract(epoch FROM t.completed_at)*1000)::bigint END AS completed_at
    FROM private_workspaces w JOIN portable_sales_enrollments e ON e.workspace_id=w.id AND e.state='active'
    JOIN portable_sales_sequence_activations a ON (a.workspace_id,a.enrollment_id)=(e.workspace_id,e.id)
    JOIN portable_sales_sequence_steps s ON (s.workspace_id,s.enrollment_id)=(e.workspace_id,e.id) AND s.state IN ('ready','queued')
    LEFT JOIN contacts c ON (c.workspace_id,c.id)=(e.workspace_id,e.contact_id) AND c.archived_at IS NULL
    LEFT JOIN portable_tasks t ON (t.workspace_id,t.id)=(s.workspace_id,s.task_id)
    LEFT JOIN portable_jobs j ON (j.workspace_id,j.id)=(s.workspace_id,s.job_id)
    LEFT JOIN portable_scheduled_gmail m ON (m.workspace_id,m.job_id)=(s.workspace_id,s.job_id)
    CROSS JOIN LATERAL (SELECT ${salesSequenceExitCandidate} AS signal) exit_test
    CROSS JOIN LATERAL (SELECT CASE
      WHEN m.dispatch_started_at IS NOT NULL AND j.status IN ('attention','failed','skipped') THEN 'Scheduled email requires review: '||coalesce(j.issue,j.status)
      WHEN j.status='succeeded' AND (m.provider_id IS NULL OR m.dispatch_started_at IS NULL) THEN 'Gmail acceptance could not be confirmed.'
      WHEN w.owner_id<>e.actor_id THEN 'The workspace owner changed.'
      WHEN c.id IS NULL THEN 'The enrolled contact is unavailable.'
      WHEN e.recipient IS NOT NULL AND lower(trim(c.data->>'email')) IS DISTINCT FROM e.recipient THEN 'The contact email address changed.'
      WHEN e.recipient IS NOT NULL AND EXISTS (SELECT 1 FROM portable_email_suppressions b
        WHERE b.workspace_id=e.workspace_id AND b.email=e.recipient) THEN 'The contact is on the do-not-email list.'
      WHEN e.assignee_id<>w.owner_id AND NOT ${sequenceRepCanEditContact(db,sql`e.assignee_id`,sql`e.workspace_id`,sql`e.contact_id`)} THEN 'The assigned teammate is unavailable.'
      WHEN s.definition->>'type'='task' AND t.completed_at IS NULL AND e.assignee_id<>w.owner_id
        AND NOT ${sequenceRepCanWorkTasks(db,sql`e.assignee_id`,sql`e.workspace_id`)} THEN 'The assigned teammate can no longer edit tasks.'
      WHEN s.state='queued' AND s.definition->>'type'='task' AND (t.id IS NULL OR t.archived_at IS NOT NULL OR
        t.contact_id IS DISTINCT FROM e.contact_id OR t.assignee_id IS DISTINCT FROM e.assignee_id) THEN 'The linked task is unavailable or its assignment changed.'
      WHEN s.state='queued' AND s.definition->>'type'='email' AND (j.id IS NULL OR j.kind<>'gmail' OR m.job_id IS NULL
        OR j.contact_id IS DISTINCT FROM e.contact_id OR m.recipient IS DISTINCT FROM e.recipient OR m.sender<>e.sender)
        THEN 'The scheduled email is unavailable.'
      WHEN j.status IN ('failed','attention','skipped') THEN 'Scheduled email requires review: '||coalesce(j.issue,j.status)
      END AS issue) checks
    WHERE (checks.issue IS NOT NULL OR exit_test.signal IS NOT NULL OR (s.state='ready' AND s.due_at<=${at}) OR
      (s.state='queued' AND (t.completed_at IS NOT NULL OR j.status='succeeded')))
    AND (m.dispatch_started_at IS NULL OR j.status IN ('succeeded','attention','failed','skipped'))
    ${keys?sql`AND e.workspace_id=${keys.workspace_id} AND s.id=${keys.step_id}`:sql``}
    ORDER BY w.last_sales_sequence_at NULLS FIRST,s.due_at,s.id LIMIT 1 FOR NO KEY UPDATE OF w SKIP LOCKED`;
}

export async function runSalesSequencePass(db:Db){
  if(process.env.HARBOR_SEQUENCE_WORKER_ENABLED!=='true')return 'idle';
  return db.transaction(async tx=>{
    const at=await jobClock(tx);
    const [first]=await tx.execute<Candidate>(eligibleSteps(tx,at));
    if(!first)return 'idle';
    // Get a fresh statement snapshot after obtaining the workspace lock. Stop, record edits,
    // task writes and Gmail claims all take this lock before changing their dependent rows.
    const [step]=await tx.execute<Candidate>(eligibleSteps(tx,at,first));
    if(!step)return 'idle';
    const {workspace_id:workspaceId,enrollment_id:enrollmentId,step_id:id,definition}=step;
    const enrollment=and(eq(enrollments.workspaceId,workspaceId),eq(enrollments.id,enrollmentId));
    const current=and(eq(steps.workspaceId,workspaceId),eq(steps.id,id));
    const activation=and(eq(activations.workspaceId,workspaceId),eq(activations.enrollmentId,enrollmentId));
    await tx.execute(sql`UPDATE private_workspaces SET last_sales_sequence_at=${at} WHERE id=${workspaceId}`);
    async function attention(issue:string){
      await tx.update(steps).set({state:'attention',issue,finishedAt:at}).where(current);
      await tx.update(enrollments).set({state:'attention',issue,finishedAt:at}).where(enrollment);
      await tx.delete(activations).where(activation);
      return 'attention' as const;
    }
    const exit=step.exit_signal;
    if(step.delivery_confirmed===false)return attention(step.issue??'Gmail acceptance could not be confirmed.');
    if(exit){
      // Preserve a confirmed delivery when a reply arrived while the provider call was in flight.
      if(step.delivery_confirmed){
        await tx.update(steps).set({state:'completed',finishedAt:Number(step.completed_at)}).where(current);
      }
      await tx.update(steps).set({state:'stopped',issue:exit,finishedAt:at}).where(and(eq(steps.workspaceId,workspaceId),
        eq(steps.enrollmentId,enrollmentId),sql`${steps.state} IN ('waiting','ready','queued')`));
      await tx.update(enrollments).set({state:'stopped',issue:exit,finishedAt:at}).where(enrollment);
      await tx.delete(activations).where(activation);
      return 'stopped';
    }
    if(step.issue)return attention(step.issue);
    if(step.step_state==='ready'){
      if(definition.type==='email'){
        if(!step.recipient)return attention('The contact needs an email address.');
        const outcome=await enqueueGmail(tx,{workspaceId,contactId:step.contact_id},step.actor_id,step.sender,
          {id,scheduledFor:at,subject:definition.subject,body:definition.body,recipient:step.recipient});
        if(outcome==='full'){
          await tx.update(steps).set({dueAt:at+60_000}).where(current);
          return 'deferred';
        }
        if(outcome!=='ok')return attention('Could not schedule email: '+outcome);
        await tx.update(steps).set({state:'queued',jobId:id}).where(current);
      }else{
        const timing=definition.timing;
        const due=new Date(timing?at+timing.dueAfterMinutes*60_000:Number(step.due_at)).toISOString();
        const data=portableTaskFields.parse({name:definition.title,taskType:definition.taskType,notes:definition.notes,
          dueDate:due.slice(0,10),...(timing&&{dueTime:due.slice(11,16),dueTimeZone:'UTC',reminderMinutes:timing.reminderMinutes})});
        const task=await savePortableTask(tx,step.actor_id,{action:'save',kind:'tasks',assigneeId:step.assignee_id,
          contactId:step.contact_id,data},undefined,id);
        if('error' in task)return attention('Could not create the assigned task: '+task.error);
        await tx.update(steps).set({state:'queued',taskId:id}).where(current);
      }
      return 'queued';
    }
    const completedAt=Number(step.completed_at);
    await tx.update(steps).set({state:'completed',finishedAt:completedAt}).where(current);
    const advanced=await tx.update(steps).set({state:'ready',
      dueAt:sql`${completedAt}::bigint+(${steps.definition}->>'delayDays')::bigint*86400000`}).where(and(
      eq(steps.workspaceId,workspaceId),eq(steps.enrollmentId,enrollmentId),eq(steps.position,step.position+1),eq(steps.state,'waiting')
    )).returning({id:steps.id});
    if(advanced.length)return 'advanced';
    await tx.update(enrollments).set({state:'completed',finishedAt:completedAt}).where(enrollment);
    await tx.delete(activations).where(activation);
    return 'completed';
  });
}
