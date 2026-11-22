'use client';
import {WorkspaceDate} from './portable-workspace-format';
import {useRef,useState} from 'react';
import type {SalesEnrollmentStep} from '../lib/portable-sales-sequences';
import {sequenceRequest,stepKind,stepName,stepTimingLabel,useSequenceRead,type EnrollmentDetail} from './portable-sequence-data';

const states:Record<string,string>={active:'Active',completed:'Completed',stopped:'Stopped',attention:'Needs attention',
  waiting:'Waiting',ready:'Ready',queued:'Queued',succeeded:'Completed',failed:'Failed',uncertain:'Needs reconciliation'};
export function stateLabel(state:string){return states[state]??state.replaceAll('_',' ');}
export function issueLabel(issue:string){
  if(issue==='Scheduled email requires review: external_outcome_unknown')return 'Delivery is unconfirmed. Check the email job before contacting this person again.';
  if(issue==='sequence_reply_logged')return 'A received Gmail message was logged for this contact.';
  if(issue==='sequence_outlook_reply_logged')return 'A received Outlook message was logged for this contact.';
  if(issue==='sequence_meeting_booked')return 'A Harbor meeting was booked for this contact.';
  return issue.replaceAll('_',' ');
}
export function stamp(value:string|number){return <WorkspaceDate value={value}/>;}

function EnrollmentReceipt({step}:{step:SalesEnrollmentStep}){
  const timing=stepTimingLabel(step.definition);
  return <li><strong>{stepName(step.definition)}</strong>
    <span>{stepKind(step.definition)} · {stateLabel(step.state)}</span>
    {timing&&<span>{timing}</span>}
    {step.finishedAt?<span>Finished {stamp(step.finishedAt)}</span>:step.dueAt&&<span>Step scheduled for {stamp(step.dueAt)}</span>}
    {step.taskId&&<a href={'/?kind=tasks&record='+encodeURIComponent(step.taskId)}>Open task</a>}
    {step.jobId&&<a href={'/?view=job-queue&jobId='+encodeURIComponent(step.jobId)}>Email job{step.jobState?' · '+stateLabel(step.jobState):''}</a>}
    {step.issue&&<span>{issueLabel(step.issue)}</span>}
  </li>;
}

export function EnrollmentPanel({id,refresh,changed,showContact=false}:{id:string;refresh:number;changed:()=>void;showContact?:boolean}){
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const saving=useRef(false);
  const detail=useSequenceRead<EnrollmentDetail>('enrollmentId='+encodeURIComponent(id),refresh);
  async function stop(){
    if(saving.current)return;
    saving.current=true;setBusy(true);setError('');
    try{await sequenceRequest('',{action:'stop',id});setConfirm(false);changed();}
    catch(error){setError((error as Error).message);}
    finally{saving.current=false;setBusy(false);}
  }
  if(detail?.error)return <p role="alert">{detail.error} <button onClick={changed}>Try again</button></p>;
  if(!detail?.value)return <p role="status">Loading enrollment…</p>;
  const {enrollment,steps}=detail.value;
  const firstNumber=(steps[0]?.position??0)+1;
  return <article className="portable-sequence-receipt"><h3>{enrollment.sequenceName}</h3>
    {showContact&&<p>{enrollment.contactAvailable?<a href={'/?contact='+enrollment.contactId}>{enrollment.contactName}</a>:enrollment.contactName}
      {' · '}<a href={'/?'+new URLSearchParams({view:'record-access',kind:'contacts',record:enrollment.contactId})}>Contact access history</a></p>}
    <p><strong>{stateLabel(enrollment.state)}</strong>{enrollment.assigneeLabel&&' · '+enrollment.assigneeLabel}</p>
    {enrollment.recipient&&<p>{enrollment.sender} → {enrollment.recipient}</p>}
    {enrollment.bookingStopPending&&<p>A team meeting was booked. Further outreach is stopped. The worker will update the step history.</p>}
    {!enrollment.activeActivation&&enrollment.state==='active'&&<p>Processing is inactive for this enrollment.</p>}
    {enrollment.issue&&<p>{issueLabel(enrollment.issue)}</p>}
    {firstNumber>1&&<p>Started at step {firstNumber}. Earlier steps were skipped.</p>}
    <ol className="portable-sequence-plan" start={firstNumber}>{steps.map(step=><EnrollmentReceipt key={step.id} step={step}/>)}</ol>
    {(enrollment.state==='active'||enrollment.state==='attention')&&(confirm?<div>
      <p>{enrollment.issue==='Scheduled email requires review: external_outcome_unknown'?
        'Stop the remaining steps? The unconfirmed email will still need review in Job queue.':
        'Stop the remaining steps? A message already in delivery may still arrive.'}</p>
      <div className="portable-sequence-actions"><button type="button" disabled={busy} onClick={()=>void stop()}>Confirm stop</button>
        <button type="button" disabled={busy} onClick={()=>setConfirm(false)}>Keep enrollment</button></div>
    </div>:<button type="button" onClick={()=>setConfirm(true)}>Stop enrollment</button>)}
    {error&&<p role="alert">{error}</p>}
  </article>;
}
