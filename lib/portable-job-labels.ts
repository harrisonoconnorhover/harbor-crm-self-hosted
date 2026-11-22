import {z} from 'zod';

export const jobStateLabels:Record<string,string>={queued:'Queued',running:'Running',dispatching:'Running',succeeded:'Completed',attention:'Needs attention',failed:'Failed',skipped:'Skipped'};
export function jobStatusLabel(status:string,issue:string|null|undefined){
  if(status==='skipped'&&(issue==='note_cancelled'||issue==='task_cancelled'||issue==='email_cancelled'||issue==='event_wait_cancelled'))return 'Cancelled';
  return jobStateLabels[status]??status;
}
export const queueViews=['issues','pending','waiting','completed','failed','skipped','recovery','all'] as const;
export type QueueView=typeof queueViews[number];
export const jobQueueViewLabels={
  issues:'Needs attention',pending:'Pending',waiting:'Waiting for stage',completed:'Completed',failed:'Failed',skipped:'Skipped',
  recovery:'Held after restore',all:'All jobs',
} as const satisfies Record<QueueView,string>;
export const jobKinds=['note','task','gmail','external','code'] as const;
export type JobKind=typeof jobKinds[number];
export const jobKindLabels:Record<JobKind,string>={note:'Note',task:'Create Task',gmail:'Scheduled email',external:'External action',code:'JavaScript action'};
export const queueIssues=['overdue','expired_claim','needs_review','failed','uncertain','suppressed_email'] as const;
export type QueueIssue=typeof queueIssues[number];
export const queueIssueLabels:Record<QueueIssue,string>={
  overdue:'Overdue jobs',expired_claim:'Expired claims',needs_review:'All unreviewed outcomes',
  failed:'Unreviewed failures',uncertain:'Unconfirmed outcomes',suppressed_email:'Skipped by do-not-email',
};
export const portableJobId=z.string().guid('Invalid uuid');
export const jobDetailsHref=(id:string)=>'/?'+new URLSearchParams({view:'job-queue',jobId:id});
const outcomes:Record<string,string>={code_action_failed:'JavaScript action failed',code_output_invalid:'JavaScript outputs did not match the declared types',succeeded:'Completed',lease_expired:'Worker stopped or ran out of time',
  processor_error:'Worker could not finish',authority_changed:'Contact access changed',
  external_adapter_unavailable:'External action unavailable',external_outcome_unknown:'External outcome unknown. Review before repeating.',
  workflow_disabled:'Workflow was turned off before dispatch',
  webhook_workflow_changed:'Webhook workflow was turned off or changed',
  webhook_destination_unavailable:'Webhook destination is unavailable',
  webhook_rate_limited:'Webhook receiver requested a slower delivery rate',
  webhook_rejected:'Webhook receiver rejected the request',
  gmail_workflow_changed:'Gmail workflow was turned off or changed',
  gmail_reauthorization_required:'Reconnect the scheduled Gmail mailbox before scheduling a new send',
  gmail_mailbox_unavailable:'Gmail mailbox unavailable or changed',
  event_wait_cancelled:'Cancelled while waiting for a lifecycle stage',note_cancelled:'Note cancelled before writing',task_cancelled:'Task cancelled before creation',email_cancelled:'Email cancelled before sending',email_schedule_expired:'Send window expired before dispatch',
  email_address_changed:'Contact email changed',email_recipient_suppressed:'Recipient is on the do-not-email list',
  segment_left:'Contact left the segment before the action ran',
  form_automation_changed:'Form automation, inquiry or Contact changed before the Note ran',
  restore_requires_reconciliation:'Restored external action. Check the original outcome before repeating.'};
export const jobIssueLabel=(outcome:string)=>outcomes[outcome]||outcome.replaceAll('_',' ');
