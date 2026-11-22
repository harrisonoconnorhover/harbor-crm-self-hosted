'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Links navigate the portable renderer. */
import {useRef,useState} from 'react';
import type {ContactRecord} from '../lib/portable-records';
import type {SalesEnrollment,SalesSequence,SalesSequenceStep} from '../lib/portable-sales-sequences';
import {sequenceRequest,stepDelay,stepKind,stepName,stepTimingLabel,useSequenceRead,type EnrollmentDetail,type LibraryPage,type Page} from './portable-sequence-data';
import {EnrollmentPanel,stamp,stateLabel} from './portable-sequence-receipt';
import './portable-sales-sequence.css';

type Assignee={id:string;label:string};
function SequencePlan({steps,start}:{steps:SalesSequenceStep[];start:number}){
  return <ol className="portable-sequence-plan" start={start+1}>{steps.slice(start).map(step=><li key={step.id}><strong>{stepName(step)}</strong>
    <span>{stepKind(step)} · {stepDelay(step.delayDays)}</span>
    {stepTimingLabel(step)&&<span>{stepTimingLabel(step)}</span>}</li>)}</ol>;
}

function EnrollmentForm({contact,finish}:{contact:ContactRecord;finish:(id?:string)=>void}){
  const [after,setAfter]=useState(''),[selected,setSelected]=useState(''),[refresh,setRefresh]=useState(0);
  const [assigneePage,setAssigneePage]=useState(0),[choice,setChoice]=useState<{member:Assignee;page:number}>();
  const [startId,setStartId]=useState('');
  const [review,setReview]=useState<{id:string;sequence:SalesSequence;start:number;recipient:string|null;sender:string|null;assignee:Assignee}>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const saving=useRef(false);
  const library=useSequenceRead<LibraryPage>(after?'after='+encodeURIComponent(after):'',refresh);
  const detail=useSequenceRead<{sequence:SalesSequence}>(selected?'sequenceId='+encodeURIComponent(selected):null,refresh);
  const sequence=detail?.value?.sequence;
  const start=sequence&&startId?sequence.steps.findIndex(step=>step.id===startId):0;
  const needsTasks=sequence?.steps.slice(start).some(step=>step.type==='task');
  const members=useSequenceRead<{items:Assignee[];next:number|null}>(sequence?'view=assignees&contactId='+contact.id+'&page='+assigneePage+(needsTasks?'':'&emailOnly=true'):null,refresh);
  const options=members?.value?.items??[];
  const selectedMember=options.find(person=>person.id===choice?.member.id)??(choice?.page!==assigneePage?choice?.member:undefined);
  const assignee=selectedMember??options.find(person=>person.id===contact.data.recordOwner?.userId)??options[0];
  function changeAssigneePage(page:number){
    if(assignee&&assignee.id!==choice?.member.id)setChoice({member:assignee,page:assigneePage});
    setAssigneePage(page);
  }
  const needsMail=start>=0&&sequence?.steps.slice(start).some(step=>step.type==='email');
  const recipient=needsMail?contact.data.email||null:null;
  const sender=library?.value?.readiness?.sender??null;
  async function enroll(){
    if(!review||saving.current)return;
    saving.current=true;setBusy(true);setError('');
    try{
      const {enrollment}=await sequenceRequest<EnrollmentDetail>('',{action:'enroll',id:review.id,contactId:contact.id,
        sequenceId:review.sequence.id,startStepId:review.sequence.steps[review.start].id,expectedRevision:review.sequence.revision,recipient:review.recipient,assigneeId:review.assignee.id});
      finish(enrollment.id);
    }catch(error){setError((error as Error).message);}
    finally{saving.current=false;setBusy(false);}
  }
  return <div className="portable-sequence-enroll">
    <h3>{review?'Review enrollment':'Enroll in sequence'}</h3>
    {review?<>
      <dl className="portable-sequence-review">
        <div><dt>Sequence</dt><dd>{review.sequence.name}</dd></div>
        <div><dt>Contact</dt><dd>{contact.data.name}</dd></div>
        {review.recipient&&<><div><dt>Recipient</dt><dd>{review.recipient}</dd></div>
          <div><dt>Sender</dt><dd>{review.sender}</dd></div></>}
        <div><dt>Task assignee</dt><dd>{review.assignee.label}</dd></div>
      </dl>
      {review.start>0&&<p>Start at step {review.start+1}. Earlier steps will be skipped.</p>}
      <SequencePlan steps={review.sequence.steps} start={review.start}/>
      <p className="portable-sequence-hint">Automatic steps require a worker with sales sequences enabled. Harbor stops the sequence when a new message from Gmail or Outlook is logged for this contact or a new Harbor meeting is confirmed. Inbox monitoring is manual.</p>
      <div className="portable-sequence-actions"><button type="button" className="portable-sequence-primary" disabled={busy} onClick={()=>void enroll()}>{busy?'Enrolling…':'Confirm enrollment'}</button>
        <button type="button" disabled={busy} onClick={()=>{setReview(undefined);setError('');setRefresh(n=>n+1);}}>Back</button></div>
    </>:<>
      {library?.error||detail?.error?<p role="alert">{library?.error??detail?.error}{' '}
        <button type="button" onClick={()=>setRefresh(n=>n+1)}>Try again</button></p>:!library?.value?<p role="status">Loading sequences…</p>:
        <>
          {library.value.items.length?<label>Sequence<select value={selected} onChange={e=>{setSelected(e.target.value);setChoice(undefined);setAssigneePage(0);setStartId('');setError('');}}>
            <option value="">Choose a sequence</option>{library.value.items.map(seq=><option key={seq.id} value={seq.id}>{seq.name}</option>)}</select></label>:
            <p>No saved sequences on this page. <a href="/?view=sequences">Open sales sequences</a></p>}
          <div className="portable-sequence-actions">
            {after&&<button type="button" onClick={()=>{setSelected('');setAfter('');}}>First sequences</button>}
            {library.value.next&&<button type="button" onClick={()=>{setSelected('');setAfter(library.value!.next!);}}>Next sequences</button>}
          </div>
          {selected&&!sequence?<p role="status">Loading steps…</p>:sequence&&<>
            {(sequence.steps.length>1||start<0)&&<label>Start at step<select value={sequence.steps[start]?.id??''} onChange={e=>{setStartId(e.target.value);setChoice(undefined);setAssigneePage(0);}}>
              {start<0&&<option value="" disabled>Choose a current step</option>}
              {sequence.steps.map((step,index)=><option key={step.id} value={step.id}>{index+1}. {stepKind(step)} · {stepName(step)}</option>)}
            </select></label>}
            {members?.error?<p role="alert">{members.error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>Retry assignees</button></p>:
              !members?.value?<p role="status">Loading task assignees…</p>:<>
                <label>Task assignee<select value={assignee?.id??''} disabled={!assignee} onChange={e=>{
                  const member=options.find(person=>person.id===e.target.value);
                  if(member)setChoice({member,page:assigneePage});
                }}>
                  {assignee&&!options.some(person=>person.id===assignee.id)&&<option value={assignee.id}>{assignee.label}</option>}
                  {!assignee&&<option value="">No eligible teammates</option>}
                  {options.map(member=><option key={member.id} value={member.id}>{member.label}</option>)}
                </select></label>
                <p className="portable-sequence-hint">Choose the workspace owner or a teammate who can edit this contact{needsTasks?' and their assigned tasks':''}.</p>
                <div className="portable-sequence-actions">
                  {assigneePage>0&&<button type="button" onClick={()=>changeAssigneePage(assigneePage-1)}>Previous assignees</button>}
                  {members.value.next!==null&&<button type="button" onClick={()=>changeAssigneePage(members.value!.next!)}>Next assignees</button>}
                </div>
              </>}
            {needsMail&&!recipient&&<p>Add an email address to this contact to enroll them in an email sequence.</p>}
            {needsMail&&!sender&&<p>Configure the workspace Gmail sender to enroll contacts in an email sequence.</p>}
            <button type="button" disabled={start<0||!members?.value||!assignee||Boolean(needsMail&&(!recipient||!sender))} onClick={()=>{
              if(assignee)setReview({id:crypto.randomUUID(),sequence,start,assignee,recipient,sender});
            }}>Review enrollment</button>
          </>}
        </>}
      <button type="button" onClick={()=>finish()}>Cancel enrollment</button>
    </>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}

export function PortableContactSequences({contact}:{contact:ContactRecord}){
  const [expanded,setExpanded]=useState(false),[form,setForm]=useState(false),[after,setAfter]=useState('');
  const [refresh,setRefresh]=useState(0),[selected,setSelected]=useState(''),[notice,setNotice]=useState('');
  const query=new URLSearchParams({contactId:contact.id,...(after?{after}:{})});
  const history=useSequenceRead<Page<SalesEnrollment>>(expanded?query.toString():null,refresh);
  return <section id="portable-sales-sequences" className="portable-record-panel portable-sequence-contact" aria-labelledby="contact-sequences-heading">
    <h2 id="contact-sequences-heading">Sales sequences</h2>
    <div className="portable-sequence-actions">
      <button type="button" onClick={()=>{setExpanded(true);setForm(true);setNotice('');}} disabled={form}>Enroll in sequence</button>
      <button type="button" aria-expanded={expanded} disabled={form} onClick={()=>{setExpanded(!expanded);setForm(false);}}>{expanded?'Hide enrollments':'View enrollments'}</button>
      <a href="/?view=sequences">Sequence library</a>
    </div>
    {notice&&<p role="status">{notice}</p>}
    {form&&<EnrollmentForm contact={contact} finish={id=>{
      setForm(false);if(id){setSelected(id);setAfter('');setRefresh(n=>n+1);setNotice('Contact enrolled.');}
    }}/>}
    {expanded&&!form&&<>
      {history?.error?<p role="alert">{history.error}</p>:!history?.value?<p role="status">Loading enrollments…</p>:
        history.value.items.length?<ul className="portable-sequence-list" aria-label="Contact enrollments">
          {history.value.items.map(item=><li key={item.id}><button type="button" aria-pressed={item.id===selected} onClick={()=>setSelected(item.id)}>{item.sequenceName}</button>
            <span>{stateLabel(item.state)} · {stamp(item.createdAt)}</span></li>)}</ul>:<p>No enrollments on this page.</p>}
      <div className="portable-sequence-actions"><button type="button" onClick={()=>setRefresh(n=>n+1)}>Refresh enrollments</button>
        {after&&<button type="button" onClick={()=>{setSelected('');setAfter('');}}>First enrollments</button>}
        {history?.value?.next&&<button type="button" onClick={()=>{setSelected('');setAfter(history.value!.next!);}}>Next enrollments</button>}
      </div>
      {selected&&<EnrollmentPanel key={selected} id={selected} refresh={refresh} changed={()=>setRefresh(n=>n+1)}/>}
    </>}
  </section>;
}
