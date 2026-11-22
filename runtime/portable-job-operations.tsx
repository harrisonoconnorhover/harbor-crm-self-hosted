'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Portable CRM uses document navigation for its paged lists. */
import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {QueueView,readOwnerQueue} from '../db/postgres/job-operations-store';
import {jobDetailsHref,jobIssueLabel,jobKindLabels,jobKinds,jobQueueViewLabels,jobStatusLabel,portableJobId,queueIssueLabels,queueIssues,type JobKind,type QueueIssue} from '../lib/portable-job-labels';
import {queuedRecipientBlockedNotice} from '../lib/email/suppression';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableSettingsLayout} from './portable-settings-layout';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type Page=Awaited<ReturnType<typeof readOwnerQueue>>;
type QueueFilters={kind?:JobKind;issue?:QueueIssue;contactId?:string;finishedFirst?:boolean};
type JobAction='retryNote'|'retryTask'|'cancelNote'|'cancelGmail'|'cancelTask'|'cancelEventWait'|'reviewGmail'|'reviewExternal'|'reviewFailed'|'reviewSuppressedGmail';
const views=jobQueueViewLabels;
const heartbeatLabels={missing:'No worker heartbeat recorded',invalid:'Worker heartbeat time is invalid',
  stale:'Worker has stopped reporting',fresh:'Worker reporting'};
const attentionLinks=[
  {issue:'needs_review',title:'Review outcomes',description:'Check failed jobs, unconfirmed actions and skipped email.'},
  {issue:'overdue',title:'Check overdue jobs',description:'See jobs that have been ready to run for at least five minutes.'},
  {issue:'expired_claim',title:'Check interrupted jobs',description:'See jobs whose worker claim expired. The outcome may still be unknown.'},
] as const;
const time=(at:number)=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';

function LastJobAttempt({job}:{job:Page['items'][number]}){
  const latest=job.receipts.at(-1);
  if(!latest)return <span>{job.attempts||'—'}</span>;
  const outcome=latest.outcome?jobIssueLabel(latest.outcome):latest.endedAt!==null?'Outcome unavailable':
    job.expiredClaim?'Claim expired':'In progress';
  return <>{outcome}<small className="portable-job-attempt-time">
    {time(latest.endedAt??latest.startedAt)} · Attempt {latest.number}
  </small></>;
}

function queueLink(view:QueueView,{kind,issue,contactId,finishedFirst}:QueueFilters={},after?:NonNullable<Page['next']>){
  const params=new URLSearchParams({view:'job-queue',queue:view});
  if(kind)params.set('jobKind',kind);
  if(view==='issues'&&issue)params.set('jobIssue',issue);
  if(contactId)params.set('jobContactId',contactId);
  if(finishedFirst)params.set('jobOrder','finished');
  if(after){
    params.set(finishedFirst?'afterFinishedAt':'afterAt',String(after.at));
    params.set('afterId',after.id);
  }
  return '/?'+params;
}

function JobReceiptLookup(){
  const input=useRef<HTMLInputElement>(null);
  const [invalid,setInvalid]=useState(false);
  function openReceipt(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const jobId=portableJobId.safeParse(input.current?.value.trim());
    if(!jobId.success){
      setInvalid(true);
      input.current?.focus();
      return;
    }
    window.location.assign(jobDetailsHref(jobId.data));
  }
  return <>
    <form aria-label="Find a job receipt" className="portable-job-filter" method="get" action="/" onSubmit={openReceipt}>
      <input type="hidden" name="view" value="job-queue"/>
      <label>Job ID
        <input ref={input} name="jobId" placeholder="Paste a job ID from the worker log" required
          autoComplete="off" spellCheck={false} size={28} aria-invalid={invalid||undefined}
          aria-describedby={invalid?'portable-job-id-error':undefined} onChange={()=>setInvalid(false)}/>
      </label>
      <button type="submit">Open receipt</button>
    </form>
    {invalid&&<p id="portable-job-id-error" role="alert">Enter the full job ID from the worker log, including hyphens.</p>}
  </>;
}

const copyLabels={link:'job link',id:'job ID'} as const;
type CopyTarget=keyof typeof copyLabels;

function JobReceiptCopy({jobId}:{jobId:string}){
  const latest=useRef(0);
  const [result,setResult]=useState<{target:CopyTarget;manual?:string}|null>(null);
  async function copy(target:CopyTarget){
    const attempt=++latest.current;
    const value=target==='link'?new URL(jobDetailsHref(jobId),window.location.origin).href:jobId;
    let copied=false;
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(value);
        copied=true;
      }
    }catch{copied=false;}
    if(attempt===latest.current)setResult(copied?{target}:{target,manual:value});
  }
  return <>
    <p>
      <button type="button" onClick={()=>void copy('link')}>Copy job link</button>{' '}
      <button type="button" onClick={()=>void copy('id')}>Copy job ID</button>
    </p>
    {result&&(result.manual===undefined
      ?<p role="status">{result.target==='link'?'Job link copied.':'Job ID copied.'}</p>
      :<div role="alert">
        <p>Could not copy the {copyLabels[result.target]}. Select it below and copy it manually.</p>
        <label>{result.target==='link'?'Job link':'Job ID'}
          <input key={result.target} readOnly value={result.manual} autoFocus size={Math.min(result.manual.length,80)}
            spellCheck={false} onFocus={event=>event.currentTarget.select()}/>
        </label>
      </div>)}
  </>;
}

export function PortableJobOperations({email,view,kind,issue,page,focused,finishedFirst}:{email:string;view:QueueView;kind?:JobKind;issue?:QueueIssue;page:Page;focused:boolean;finishedFirst:boolean}){
  const router=useRouter();
  const requesting=useRef(false);
  const [pendingId,setPendingId]=useState<string|null>(null);
  const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
  const outstanding=attentionLinks.filter(link=>page.attention[link.issue]);
  const filters={kind,issue,contactId:page.contact?.id,finishedFirst};
  const receipt=focused?page.items[0]:undefined;
  const source=receipt?.sourceDealWorkflow;
  const ticketSource=receipt?.sourceTicketWorkflow;
  async function act(job:Page['items'][number],action:JobAction){
    if(requesting.current)return;
    const retry=action==='retryNote'||action==='retryTask';
    const review=action==='reviewGmail',external=action==='reviewExternal',failed=action==='reviewFailed',suppressed=action==='reviewSuppressedGmail';
    const label=action==='cancelEventWait'?'waiting workflow action and stop the rest of its path':job.kind==='gmail'?'scheduled email':job.kind==='task'?'scheduled Task':'scheduled Note';
    if(!retry&&!window.confirm(review
      ?'Mark this email reviewed? Its delivery will stay unconfirmed, and Harbor will keep it from sending again.'
      :external?'Mark this external action reviewed? Its outcome will stay unconfirmed.'
      :suppressed?'Mark this skipped email reviewed? Its do-not-email result and attempt will stay in history.'
        :failed?'Mark this failed job reviewed? Its failure and attempts will stay in history.'
        :'Cancel this '+label+'?'))return;
    requesting.current=true;
    setPendingId(job.id);
    setNotice(null);
    try{
      const response=await fetch('/api/background-jobs?'+new URLSearchParams({recordId:job.contactId}),{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id:job.id,...(failed||suppressed?{attempts:job.attempts}:{})}),
      });
      const result=await response.json() as {error?:string;result?:string};
      if(!response.ok){
        setNotice({text:result.error||'Could not save this change.',error:true});
        return;
      }
      const message=review?'Review recorded. Delivery is still unconfirmed.'
        :external?'Review recorded. The external outcome is still unconfirmed.'
        :suppressed?'Skipped email marked reviewed.':failed?'Failure marked reviewed.'
        :retry?(result.result==='already'?'A retry was already requested.':'Retry queued.'):'Cancellation saved.';
      setNotice({text:message,error:false});
      router.refresh();
    }catch{setNotice({text:'Could not confirm the change. Try again to check the same job.',error:true});}
    finally{requesting.current=false;setPendingId(null);}
  }
  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="job-queue"/>
    <PortableSettingsLayout active="job-queue">
    <section>
      <div className="portable-contacts-heading"><h1>{focused?'Job details':'Job queue'}</h1>
        {focused?<><a href={queueLink('issues')}>Back to Job queue</a>
          {receipt&&<a href={jobDetailsHref(receipt.id)}>Refresh receipt</a>}</>
          :<a href={queueLink(view,filters)}>Refresh queue</a>}</div>
      <p><strong>{heartbeatLabels[page.workerHeartbeat]}</strong>
        {page.lastHeartbeatAt!==null&&page.workerHeartbeat!=='invalid'&&<> · Last heartbeat {time(page.lastHeartbeatAt)}</>}
        {page.lastSuccessfulPollAt!==null&&page.queuePoll!=='invalid'&&<> · Last successful job poll {time(page.lastSuccessfulPollAt)}</>}</p>
      {page.workerHeartbeat==='fresh'&&page.queuePoll!=='fresh'&&<p role="status">
        Worker is running, but Harbor has no recent successful job poll.
      </p>}
      {source&&<section aria-label="Workflow source">
        <p>Workflow <strong>{source.workflowName}</strong></p>
        <nav aria-label="Source Deal links">
          {source.dealArchived?<span>{source.dealName} (archived)</span>:
            <a href={'/?'+new URLSearchParams({kind:'deals',record:source.dealId})}>{source.dealName}</a>}
          <a href={'/?'+new URLSearchParams({view:'workflows',runDealId:source.dealId})+'#recent-runs'}>View Deal workflow runs</a>
        </nav>
      </section>}
      {ticketSource&&<section aria-label="Workflow source">
        <p>Workflow <strong>{ticketSource.workflowName}</strong></p>
        <nav aria-label="Source Ticket links">
          {ticketSource.archived?<span>{ticketSource.ticketName} (archived)</span>:
            <a href={'/tickets?id='+ticketSource.ticketId}>{ticketSource.ticketName}</a>}
          <a href={'/?view=workflows&runWorkflowId='+ticketSource.workflowId+'#recent-runs'}>View workflow runs</a>
        </nav>
      </section>}
      {receipt&&<JobReceiptCopy key={receipt.id} jobId={receipt.id}/>}
      {!focused&&<p>Open a job to see its attempts and available next steps.</p>}
      {page.missedWorkflowRuns&&<p role="status">
        <a href="/?view=workflows&runIssue=queue_full#recent-runs">Review workflows skipped by a full queue</a>.
      </p>}
      {page.dueNoteWithoutWorker&&<p role="status">
        <strong>Scheduled Notes are due.</strong> Harbor has no recent healthy queue check.{' '}
        <a href={queueLink('pending',{kind:'note'})}>Review pending Notes</a> and check the worker logs.
      </p>}
      {page.dueTaskWithoutWorker&&<p role="status">
        <strong>Scheduled Tasks are due.</strong> Harbor has no recent poll from a worker that can create Tasks.{' '}
        <a href={queueLink('pending',{kind:'task'})}>Review pending Tasks</a> and check that the worker is running without Notes-only mode.
      </p>}
      {page.mailWithoutWorker&&<p role="status">
        <strong>{page.mailWithoutWorker==='due'?'Scheduled email is due.':'Scheduled email is waiting.'}</strong>{' '}
        No recent poll from a worker configured for Gmail.{' '}
        <a href={queueLink('pending',{kind:'gmail'})}>Review pending emails</a> and check the Gmail worker setup.
      </p>}
      {page.overdueTaskRepeat&&<p role="status">
        <strong>Repeating tasks are overdue.</strong> Some tasks are still waiting for their next occurrence.{' '}
        <a href="/?kind=tasks">Open Tasks</a> and check that a worker is configured to process repeating tasks.
      </p>}
      {notice&&<p role={notice.error?'alert':'status'}>{notice.text}</p>}
      {!focused&&<>
        <JobReceiptLookup/>
        <section className="portable-job-overview" aria-labelledby="portable-job-overview-title">
          <h2 id="portable-job-overview-title">Queue overview</h2>
          {outstanding.length?<ul>{outstanding.map(link=><li key={link.issue}>
            <a href={queueLink('issues',{issue:link.issue})}>{link.title}</a>
            <p>{link.description}</p>
          </li>)}</ul>:<p>No unreviewed outcomes, overdue jobs or interrupted jobs.</p>}
        </section>
        <nav aria-label="Queue status">
          {(Object.keys(views) as QueueView[]).map(key=><a key={key} href={queueLink(key,{...filters,finishedFirst:key===view&&finishedFirst})}
            aria-current={key===view?'page':undefined}>{views[key]}</a>)}
        </nav>
        <form className="portable-job-filter" method="get" action="/">
          <input type="hidden" name="view" value="job-queue"/>
          <input type="hidden" name="queue" value={view}/>
          <PortableRecordPicker key={page.contact?.id} kind="contacts" field="jobContactId" label="Contact" value={page.contact} emptyLabel="All Contacts"/>
          <label>Job type
            <select name="jobKind" defaultValue={kind??''}>
              <option value="">All job types</option>
              {jobKinds.map(key=><option key={key} value={key}>{jobKindLabels[key]}</option>)}
            </select>
          </label>
          {view==='issues'&&<label>Issue
            <select name="jobIssue" defaultValue={issue??''}>
              <option value="">All issues</option>
              {queueIssues.map(key=><option key={key} value={key}>{queueIssueLabels[key]}</option>)}
            </select>
          </label>}
          {view==='completed'&&<label>Order
            <select name="jobOrder" defaultValue={finishedFirst?'finished':''}>
              <option value="">Newest created</option>
              <option value="finished">Newest finished</option>
            </select>
          </label>}
          <button type="submit">Filter</button>
        </form>
      </>}
      {!focused&&view==='recovery'&&<p>These jobs were held when Harbor restored a backup. Check the original outcome in the destination system before marking a job reviewed.</p>}
      {page.items.length?<div className="portable-contacts-table"><table>
        <thead><tr><th scope="col">Contact</th><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Scheduled</th><th scope="col">Last attempt</th></tr></thead>
        <tbody>{page.items.map(job=><tr key={job.id}>
            <th scope="row">{job.contactArchived?job.contactName+' (archived)'
              :<a href={'/?contact='+job.contactId+'#portable-contact-jobs'}>{job.contactName}</a>}</th>
            <td>{focused?jobKindLabels[job.kind]:<a href={jobDetailsHref(job.id)}>{jobKindLabels[job.kind]}</a>} <details open={focused||undefined}><summary>Run details</summary><p>Job ID <code>{job.id}</code></p>
              <p>Recorded actor {job.actorEmail}</p>
              {job.gmailReceipt&&<p>Gmail receipt <code>{job.gmailReceipt}</code></p>}
              {job.hasCreatedTask&&<p><a href={'/?'+new URLSearchParams({kind:'tasks',record:job.id})}>Open created Task</a></p>}
              {job.operatorRetryAt!==null&&<p>Owner requested retry {time(job.operatorRetryAt)}</p>}
              {job.operatorReviewedAt!==null&&<p>Owner reviewed {time(job.operatorReviewedAt)}</p>}
              {job.gmailSearch&&<>
                <p>Paste this search into the original sender’s Gmail.</p>
                <code className="portable-job-gmail-search">{job.gmailSearch}</code>
                <p>If the search is empty, delivery is still unconfirmed. Harbor keeps the email on hold.</p>
                {focused&&job.gmailReconcileCommand&&<>
                  <p>To check Sent and record a matching Gmail receipt, run this in the configured Gmail worker environment. This command cannot send the email.</p>
                  <code className="portable-job-gmail-search">{job.gmailReconcileCommand}</code>
                </>}
              </>}
              {job.receipts.length?<ol>{job.receipts.map(receipt=><li key={receipt.number}>
                Started {time(receipt.startedAt)}
                {receipt.endedAt!==null&&<> · Ended {time(receipt.endedAt)}</>}
                {' · '}{receipt.outcome?jobIssueLabel(receipt.outcome):'In progress'}
              </li>)}</ol>:<p>No attempts yet.</p>}
            </details></td>
            <td>{job.kind==='gmail'&&job.status==='succeeded'?'Accepted by Gmail'
              :job.status==='attention'&&job.operatorReviewedAt!==null?(job.kind==='gmail'?'Delivery unconfirmed · reviewed':'Outcome unconfirmed · reviewed')
                :job.operatorReviewedAt!==null&&['failed','skipped'].includes(job.status)?jobStatusLabel(job.status,job.issue)+' · reviewed':jobStatusLabel(job.status,job.issue)}
              {job.overdue&&<> · Overdue</>}{job.expiredClaim&&<> · Worker claim expired</>}
              {job.issue&&<p>{jobIssueLabel(job.issue)}</p>}
              {job.sendWindowElapsed&&<p>Send window passed. Check the final receipt after the worker processes this job.</p>}
              {job.canReview&&job.status==='attention'&&<p>{job.kind==='gmail'?'Check the original send before marking this job reviewed.':'Check the result in the destination system before marking this job reviewed.'}</p>}
              {job.canRetry&&<p>Retry queues one more attempt for this job.</p>}
              {job.expiredClaim&&<p>Check that the worker is running. An expired claim does not confirm the outcome.</p>}
              {job.recipientBlocked&&<p>{queuedRecipientBlockedNotice}</p>}
              {job.canReview&&<p><button type="button" disabled={pendingId!==null}
                onClick={()=>void act(job,job.status==='skipped'?'reviewSuppressedGmail':job.status==='failed'?'reviewFailed':job.kind==='external'?'reviewExternal':'reviewGmail')}>
                {pendingId===job.id?'Saving…':'Mark reviewed'}</button></p>}
              {job.canRetry&&<p><button type="button" disabled={pendingId!==null} onClick={()=>void act(job,job.kind==='task'?'retryTask':'retryNote')}>
                {pendingId===job.id?'Queueing…':job.kind==='task'?'Retry Task':'Retry Note'}</button></p>}
              {job.canCancel&&<p><button type="button" disabled={pendingId!==null}
                onClick={()=>void act(job,job.kind==='external'?'cancelEventWait':job.kind==='gmail'?'cancelGmail':job.kind==='task'?'cancelTask':'cancelNote')}>
                {pendingId===job.id?'Cancelling…':job.kind==='external'?'Cancel waiting action':job.kind==='gmail'?'Cancel email':job.kind==='task'?'Cancel Task':'Cancel Note'}</button></p>}</td>
            <td>{job.waitForLifecycle
              ?job.status==='queued'?'Waiting for '+job.waitForLifecycle:'—'
              :time(job.scheduledFor)}
              {job.sendDeadline!==null&&<p>Send window ends {time(job.sendDeadline)}</p>}
              {job.status==='queued'&&job.overdue&&<p>Waiting since {time(job.operatorRetryAt??job.scheduledFor)}</p>}
              {job.status==='queued'&&job.attempts>0&&<p>Next attempt {time(job.availableAt)}</p>}
              {job.expiredClaim&&job.leaseUntil!==null&&<p>Claim expired {time(job.leaseUntil)}</p>}
              {job.finishedAt!==null&&<p>Finished {time(job.finishedAt)}</p>}</td>
            <td><LastJobAttempt job={job}/></td>
          </tr>)}</tbody>
      </table></div>:<p>No jobs in this view.</p>}
      {page.next&&<nav aria-label="Job pages"><a href={queueLink(view,filters,page.next)}>Older jobs</a></nav>}
    </section>
    </PortableSettingsLayout>
  </main>;
}
