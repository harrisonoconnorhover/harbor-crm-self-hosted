'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Document links preserve portable navigation and history. */
import {useRef,useState,type FormEvent} from 'react';
import {ArrowDown,ArrowUp,Plus,Trash2} from 'lucide-react';
import {reminderChoices} from '../lib/portable-task-reminders';
import {openEnrollmentState,enrollmentUrl,maxSequenceTaskMinutes,salesEnrollmentStates,type EnrollmentPageQuery,type SalesEnrollment,type SalesSequence,type SalesSequenceStep} from '../lib/portable-sales-sequences';
import {PortableCrmHeader} from './portable-crm-header';
import {sequenceRequest,useSequenceRead,type LibraryPage,type Page} from './portable-sequence-data';
import {EnrollmentPanel,issueLabel,stamp,stateLabel} from './portable-sequence-receipt';
import './portable-sales-sequence.css';

type Draft=Pick<SalesSequence,'id'|'revision'|'name'|'steps'>;
const channels=['Email','Call','LinkedIn','To-do'] as const;
type Channel=typeof channels[number];
function newStep(channel:Channel):SalesSequenceStep{
  const id=crypto.randomUUID();
  return channel==='Email'?{id,type:'email',subject:'',body:'',delayDays:0}:
    {id,type:'task',taskType:channel,title:'',notes:'',delayDays:0};
}
function SequenceEditor({draft,finish}:{draft:Draft;finish:(saved?:boolean)=>void}){
  const [name,setName]=useState(draft.name),[steps,setSteps]=useState(draft.steps);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const saving=useRef(false);
  function replace(index:number,step:SalesSequenceStep){setSteps(current=>current.map((old,i)=>i===index?step:old));}
  function move(index:number,delta:number){
    setSteps(current=>{const reordered=[...current];[reordered[index],reordered[index+delta]]=[current[index+delta],current[index]];return reordered;});
  }
  async function save(event:FormEvent){
    event.preventDefault();if(saving.current)return;
    saving.current=true;setBusy(true);setError('');
    try{await sequenceRequest('',{action:'save',id:draft.id,expectedRevision:draft.revision,name,steps});finish(true);}
    catch(error){setError((error as Error).message);}
    finally{saving.current=false;setBusy(false);}
  }
  return <form className="portable-sequence-editor" onSubmit={save}>
    <h2>{draft.revision?'Edit sequence':'New sequence'}</h2>
    <fieldset disabled={busy}>
      <label>Sequence name<input required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label>
      {steps.map((step,index)=><fieldset key={step.id} className="portable-sequence-step"><legend>Step {index+1}</legend>
        <div className="portable-sequence-fields">
          <label>Channel<select value={step.type==='email'?'Email':step.taskType} onChange={event=>{
            const channel=event.target.value as Channel;
            replace(index,step.type==='task'&&channel!=='Email'?{...step,taskType:channel}:
              {...newStep(channel),id:step.id,delayDays:step.delayDays});
          }}>{channels.map(channel=><option key={channel}>{channel}</option>)}</select></label>
          <label>Delay (days)<input type="number" min="0" max="90" step="1" required value={step.delayDays} onChange={event=>replace(index,{...step,delayDays:Number(event.target.value)})}/></label>
        </div>
        {step.type==='email'?<>
          <label>Subject<input required maxLength={200} value={step.subject} onChange={event=>replace(index,{...step,subject:event.target.value})}/></label>
          <label>Email body<textarea required maxLength={8000} rows={4} value={step.body} onChange={event=>replace(index,{...step,body:event.target.value})}/></label>
        </>:<>
          <label>Task title<input required maxLength={160} value={step.title} onChange={event=>replace(index,{...step,title:event.target.value})}/></label>
          <label>Task instructions<textarea maxLength={2000} value={step.notes} onChange={event=>replace(index,{...step,notes:event.target.value})}/></label>
          <label>Deadline<select value={step.timing?'timed':'date'} onChange={event=>replace(index,{...step,
            timing:event.target.value==='timed'?{dueAfterMinutes:60,reminderMinutes:15}:undefined})}>
            <option value="date">Date only</option><option value="timed">Timed from assignment</option>
          </select></label>
          {step.timing&&<div className="portable-sequence-fields">
            <label>Minutes after assignment<input type="number" min={step.timing.reminderMinutes??0} max={maxSequenceTaskMinutes} step="1" required
              defaultValue={step.timing.dueAfterMinutes} onChange={event=>
                replace(index,{...step,timing:{...step.timing,dueAfterMinutes:Number(event.target.value)}})}/></label>
            <label>In-app reminder<select value={step.timing.reminderMinutes??''} onChange={event=>{
              const reminder=reminderChoices.find(item=>String(item.minutes)===event.target.value);
              replace(index,{...step,timing:{dueAfterMinutes:step.timing!.dueAfterMinutes,reminderMinutes:reminder?.minutes}});
            }}>
              <option value="">No reminder</option>
              {reminderChoices.map(item=>
                <option key={item.minutes} value={item.minutes} disabled={item.minutes>step.timing!.dueAfterMinutes}>{item.label}</option>)}
            </select></label>
          </div>}
          <p className="portable-sequence-hint">The sequence waits until the assignee completes this task.</p>
        </>}
        <div className="portable-sequence-actions">
          <button type="button" disabled={index===0} aria-label={'Move step '+(index+1)+' up'} onClick={()=>move(index,-1)}><ArrowUp size={15}/></button>
          <button type="button" disabled={index===steps.length-1} aria-label={'Move step '+(index+1)+' down'} onClick={()=>move(index,1)}><ArrowDown size={15}/></button>
          <button type="button" disabled={steps.length===1} aria-label={'Remove step '+(index+1)} onClick={()=>setSteps(current=>current.filter(item=>item.id!==step.id))}><Trash2 size={15}/></button>
        </div>
      </fieldset>)}
      <div className="portable-sequence-actions">
        <button type="button" disabled={steps.length>=20} onClick={()=>setSteps(current=>[...current,newStep('Email')])}><Plus size={15}/>Add step</button>
      </div>
      {error&&<p role="alert">{error}</p>}
      <div className="portable-sequence-actions"><button type="submit">{busy?'Saving…':'Save sequence'}</button>
        <button type="button" onClick={()=>finish()}>Cancel</button></div>
    </fieldset>
  </form>;
}

function Definitions(){
  const [after,setAfter]=useState(''),[refresh,setRefresh]=useState(0),[id,setId]=useState('');
  const [draft,setDraft]=useState<Draft>(),[notice,setNotice]=useState('');
  const list=useSequenceRead<LibraryPage>(after?'after='+encodeURIComponent(after):'',refresh);
  const detail=useSequenceRead<{sequence:SalesSequence}>(id?'sequenceId='+encodeURIComponent(id):null,refresh);
  return <>
      <header className="portable-contacts-heading"><h2>Sequence library</h2>
        {!id&&!draft&&<button type="button" onClick={()=>{setNotice('');setDraft({id:crypto.randomUUID(),name:'',revision:0,steps:[newStep('Email')]});}}>New sequence</button>}
      </header>
      {notice&&<p role="status">{notice}</p>}
      {draft||detail?.value?<SequenceEditor key={draft?.id??id} draft={draft??detail!.value!.sequence} finish={saved=>{
        setDraft(undefined);setId('');if(saved){setRefresh(n=>n+1);setAfter('');setNotice('Sequence saved.');}
      }}/>:id?<><p role={detail?.error?'alert':'status'}>{detail?.error??'Loading sequence…'}</p>
        <button type="button" onClick={()=>setId('')}>Back to sequences</button></>:
        list?.error?<p role="alert">{list.error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>Try again</button></p>:
        !list?.value?<p role="status">Loading sequences…</p>:<>
          {list.value.items.length?<ul className="portable-sequence-list" aria-label="Saved sequences">{list.value.items.map(item=>
            <li key={item.id}><button type="button" onClick={()=>{setNotice('');setId(item.id);}}>{item.name}</button>
              <span>{item.stepCount} {item.stepCount===1?'step':'steps'}</span></li>)}</ul>:<p>No saved sequences on this page.</p>}
          <div className="portable-sequence-actions">{after&&<button onClick={()=>setAfter('')}>First sequences</button>}
            {list.value.next&&<button onClick={()=>setAfter(list.value!.next!)}>Next sequences</button>}</div>
        </>}
  </>;
}

function Enrollments({query}:{query:EnrollmentPageQuery}){
  const {state,after,enrollmentId,bookingId,assignee}=query;
  const [refresh,setRefresh]=useState(0);
  const params=new URLSearchParams({view:'enrollments',state});
  if(after)params.set('after',after);
  if(assignee)params.set('assignee',assignee);
  if(bookingId)params.set('bookingId',bookingId);
  const list=useSequenceRead<Page<SalesEnrollment>&{booking?:{email:string;title:string;cancelled:boolean}}>(enrollmentId?null:params.toString(),refresh);
  const reload=()=>setRefresh(n=>n+1);
  if(enrollmentId)return <>
    <a href={enrollmentUrl(state,{after,assignee,bookingId})}>Back to {stateLabel(state).toLowerCase()} enrollments</a>
    <EnrollmentPanel key={enrollmentId} id={enrollmentId} refresh={refresh} changed={reload} showContact/>
  </>;
  return <section aria-label="Enrollment queue">
    {list?.value?.booking&&<header>
      <h2>{list.value.booking.title}{list.value.booking.cancelled?' (cancelled)':''}</h2>
      <p>Contacts currently using {list.value.booking.email}</p>
      <a href={enrollmentUrl(state)}>Clear booking filter</a>
    </header>}
    <nav className="portable-sequence-filters" aria-label="Enrollment status">
      {salesEnrollmentStates.map(item=><a key={item} href={enrollmentUrl(item,{bookingId,assignee:openEnrollmentState(item)?assignee:undefined})} aria-current={state===item?'page':undefined}>{stateLabel(item)}</a>)}
    </nav>
    {openEnrollmentState(state)&&!bookingId&&<div className="portable-sequence-actions">
      {assignee?<><span>Unavailable assignees</span><a href={enrollmentUrl(state)}>Clear assignee filter</a></>:
        <a href={enrollmentUrl(state,{assignee:'unavailable'})}>Unavailable assignees</a>}
    </div>}
    {list?.error?<p role="alert">{list.error} <button onClick={reload}>Try again</button></p>:
      !list?.value?<p role="status">Loading enrollments…</p>:
      list.value.items.length?<ul className="portable-sequence-queue" aria-label={stateLabel(state)+' enrollments'}>
        {list.value.items.map(item=><li key={item.id}>
          <div><a href={enrollmentUrl(state,{after,assignee,bookingId,enrollmentId:item.id})}>{item.contactName} · {item.sequenceName}</a>
            {item.issue&&<p>{issueLabel(item.issue)}</p>}</div>
          <small>{item.assigneeLabel} · Enrolled {stamp(item.createdAt)}</small>
        </li>)}
      </ul>:<p>{assignee?'No enrollments with unavailable assignees on this page.':state==='attention'?'No enrollments need attention on this page.':'No '+stateLabel(state).toLowerCase()+' enrollments on this page.'}</p>}
    <div className="portable-sequence-actions">
      <button type="button" onClick={reload}>Refresh enrollments</button>
      {after&&<a href={enrollmentUrl(state,{bookingId,assignee})}>First page</a>}
      {list?.value?.next&&<a href={enrollmentUrl(state,{after:list.value.next,bookingId,assignee})}>Next page</a>}
    </div>
  </section>;
}

export function PortableSalesSequenceLibrary({email,enrollments}:{email:string;enrollments?:EnrollmentPageQuery}){
  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="sequences"/>
    <section className="portable-sequence-library" aria-labelledby="sequence-heading">
      <h1 id="sequence-heading">Sales sequences</h1>
      <nav className="portable-sequence-tabs" aria-label="Sales sequence views">
        <a href="/?view=sequences" aria-current={!enrollments?'page':undefined}>Library</a>
        <a href={enrollmentUrl('attention')} aria-current={enrollments?'page':undefined}>Enrollments</a>
      </nav>
      {enrollments?<Enrollments query={enrollments}/>:<Definitions/>}
    </section>
  </main>;
}
