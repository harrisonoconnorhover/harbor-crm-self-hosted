'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Portable CRM uses document navigation for its paged lists. */

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {readPortableWorkflowRuns,readPortableWorkflows} from '../db/postgres/workflow-store';
import {jobDetailsHref,jobIssueLabel,jobStatusLabel} from '../lib/portable-job-labels';
import {lifecycles,schemas,taskTypes} from '../lib/crm';
import {portableCodeInputFields,portableCodeLimit,portableCodeOutputTypes,portableManualCodeDefinition} from '../lib/portable-workflow-code';
import type {DealPipeline} from '../lib/portable-deal-pipelines';
import type {PortableSegmentList} from '../lib/portable-segments';
import {portableWorkflowTask,portableNoteBranch,portableManualNoteSequence,portableManualNoteSequenceLimit,type PortableManualNoteSequence} from '../lib/portable-workflows';
import {PortableManualBatchReceipt,PortableManualNoteBatch} from './portable-manual-batch-ui';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';
import './portable-workflows.css';

type Workflow=Awaited<ReturnType<typeof readPortableWorkflows>>[number];
type RunPage=Awaited<ReturnType<typeof readPortableWorkflowRuns>>;
type NoteStep=PortableManualNoteSequence['steps'][number];
const newNoteStep=():NoteStep=>({id:crypto.randomUUID(),name:'',body:'',delayMinutes:0});
const time=(at:number)=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';
const runIssues={missing_contact:'Skipped · No primary contact',queue_full:'Skipped · Workspace job queue full',
  gmail_unavailable:'Skipped · Workflow Gmail unavailable for this edit',email_address_missing:'Skipped · No contact email',
  email_recipient_suppressed:'Skipped · '+jobIssueLabel('email_recipient_suppressed')};

function WorkflowSegmentPicker({initial,value}:{initial:PortableSegmentList;value:string}){
  const [selected,setSelected]=useState(value);
  const [search,setSearch]=useState('');
  const [query,setQuery]=useState('');
  const [page,setPage]=useState(initial);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [selectedName,setSelectedName]=useState(initial.segments.find(segment=>segment.id===value)?.name);
  async function find(text:string,after?:string){
    if(busy)return;
    setBusy(true);
    setError('');
    const params=new URLSearchParams({limit:'25',activeOnly:'true'});
    if(text.trim())params.set('q',text.trim());
    if(after)params.set('after',after);
    try{
      const response=await fetch('/api/segments?'+params,{cache:'no-store'});
      if(!response.ok)throw Error('Could not load active Contact segments.');
      setPage(await response.json() as PortableSegmentList);
      setQuery(text);
    }catch{setError('Could not load active Contact segments. Try again.');}
    finally{setBusy(false);}
  }
  return <>
    <label>Find an active Contact segment<input type="search" maxLength={120} value={search}
      onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{
        if(event.key==='Enter'){event.preventDefault();void find(search);}
      }}/></label>
    <button type="button" disabled={busy} onClick={()=>void find(search)}>Find segments</button>
    {page.next&&<button type="button" disabled={busy} onClick={()=>void find(query,page.next!)}>Next segment results</button>}
    {error&&<p role="alert">{error}</p>}
    <label>Active Contact segment<select name="segmentId" required value={selected} onChange={event=>{
      setSelected(event.target.value);
      setSelectedName(page.segments.find(segment=>segment.id===event.target.value)?.name);
    }}>
      <option value="">Choose a segment</option>
      {selected&&!page.segments.some(segment=>segment.id===selected)&&<option value={selected}>{selectedName??'Saved segment'}</option>}
      {page.segments.map(segment=><option key={segment.id} value={segment.id}>{segment.name}</option>)}
    </select></label>
  </>;
}

function WorkflowFields({pipelines,segments,workflow,gmailAvailable,codeAvailable,onDraftChange}:{
  pipelines:DealPipeline[];segments:PortableSegmentList;workflow?:Workflow;gmailAvailable:boolean;codeAvailable:boolean;onDraftChange:()=>void;
}){
  const definition=workflow?.definition;
  const segment=definition?.trigger==='contact_segment'?definition:undefined;
  const savedExit=segment&&'segmentEvent' in segment&&segment.segmentEvent==='left';
  const [trigger,setTrigger]=useState(savedExit?'contact_segment_left':definition?.trigger??'deal_stage');
  const segmentExit=trigger==='contact_segment_left';
  const segmentTrigger=trigger==='contact_segment'||segmentExit;
  const [actionKind,setActionKind]=useState(definition?.actionKind??'note');
  const canShowGmail=gmailAvailable||definition?.actionKind==='gmail';
  const gmail=trigger==='contact_lifecycle'&&canShowGmail&&actionKind==='gmail';
  const manual=trigger==='manual_contact',created=trigger==='contact_created',assigned=trigger==='contact_owner_assigned';
  const canShowCode=codeAvailable||definition?.actionKind==='code';
  const code=manual&&canShowCode&&actionKind==='code';
  const dealStage=trigger==='deal_stage';
  const hasLifecycleBranch=manual||created||assigned||dealStage;
  const task=actionKind==='task';
  const sequence=manual&&actionKind==='note_sequence';
  const branch=hasLifecycleBranch&&actionKind==='note_branch';
  const [steps,setSteps]=useState<NoteStep[]>(definition?.actionKind==='note_sequence'?definition.steps:[]);
  function updateStep(id:string,patch:Partial<NoteStep>){
    setSteps(previous=>previous.map(step=>step.id===id?{...step,...patch}:step));
  }
  function selectAction(value:string){
    if(value==='note_sequence'&&!steps.length)setSteps([newNoteStep(),newNoteStep()]);
    setActionKind(value==='task'||value==='note_sequence'||value==='note_branch'||value==='code'||value==='gmail'?value:'note');
  }
  const savedCode=definition?.actionKind==='code'?definition:undefined;
  const savedBranch=definition?.actionKind==='note_branch'?definition:undefined;
  const savedTask=definition?.actionKind==='task'?definition.task:undefined;
  const stageRule=definition&&(!definition.trigger||definition.trigger==='deal_stage')?definition:undefined;
  const [pipelineId,setPipelineId]=useState(stageRule?.pipelineId??pipelines[0].id);
  const pipeline=pipelines.find(item=>item.id===pipelineId)??pipelines[0];
  return <>
    <label>Workflow name<input name="name" maxLength={80} required defaultValue={definition?.name}/></label>
    <label>Trigger<select name="trigger" value={trigger} onChange={event=>{
      const value=event.target.value;
      if(value==='manual_contact'||value==='contact_created'||value==='contact_owner_assigned'||value==='contact_lifecycle'||value==='contact_segment'||value==='contact_segment_left'||
        value==='deal_stage')setTrigger(value);
    }}>
      <option value="deal_stage">Deal enters a stage</option>
      <option value="contact_created">Contact is created in the CRM</option>
      <option value="contact_owner_assigned">Existing Contact gets a new owner</option>
      <option value="contact_lifecycle">Contact enters a lifecycle stage</option>
      <option value="contact_segment">Contact joins an active segment</option>
      <option value="contact_segment_left">Contact leaves an active segment</option>
      <option value="manual_contact">Manual contact selection</option>
    </select></label>
    {trigger==='contact_lifecycle'?<label>Lifecycle stage<select name="lifecycle"
      defaultValue={definition?.trigger==='contact_lifecycle'?definition.lifecycle:'Customer'}>
      {lifecycles.map(lifecycle=><option key={lifecycle}>{lifecycle}</option>)}
    </select></label>:segmentTrigger?<>
      <WorkflowSegmentPicker initial={segments} value={segment?.segmentId??''}/>
      <label>Enrollment<select name="enrollment" defaultValue={segment?segment.enrollment??'every_event':'once'}>
        <option value="once">Once per contact</option>
        <option value="every_event">{segmentExit?'Every observed exit':'Every observed entry'}</option>
      </select></label>
      <p>The first pass checks Contacts in pages to establish a baseline without queuing actions.</p>
      {segmentExit?<p>Later checks queue the action when a Contact who was in the segment is observed outside it.
        Only active Contacts count, which excludes archived and deleted records. A queued exit action keeps its schedule if the Contact rejoins.</p>:
        <p>Later checks queue actions for newly observed members. The worker can skip an entry action if the Contact leaves before it runs.</p>}
      <p>Once per contact counts each earlier run of this workflow as soon as it was queued, even if its action was later skipped.</p>
    </>:trigger==='contact_created'?<p>Run when a Contact is first saved in the CRM. Imports and public forms follow their own rules.</p>:assigned?
      <p>Run when a CRM edit assigns or reassigns the owner of an existing Contact.</p>
    :manual?null:<>
      <label>Pipeline<select name="pipelineId" value={pipeline.id} onChange={event=>setPipelineId(event.target.value)}>
        {pipelines.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>When a deal moves to<select name="stageId" key={pipeline.id}
        defaultValue={stageRule?.pipelineId===pipeline.id?stageRule.stageId:undefined}>
        {pipeline.stages.map(stage=><option key={stage.id} value={stage.id}>{stage.name}</option>)}
      </select></label>
    </>}
    {!code&&!sequence&&!branch&&<label>Delay in minutes<input name="delayMinutes" type="number" min={0} max={43_200} required
      defaultValue={definition&&'delayMinutes' in definition?definition.delayMinutes:0}/></label>}
    <label>Action
      <select name="actionKind" value={task?'task':sequence?'note_sequence':branch?'note_branch':code?'code':gmail?'gmail':'note'} onChange={event=>selectAction(event.target.value)}>
        <option value="note">Create a Note</option>
        <option value="task">Create a Task</option>
        {manual&&<option value="note_sequence">Run a Note sequence</option>}
        {hasLifecycleBranch&&<option value="note_branch">Choose a Note by lifecycle stage</option>}
        {manual&&canShowCode&&<option value="code" disabled={!codeAvailable}>Run JavaScript</option>}
        {trigger==='contact_lifecycle'&&canShowGmail&&<option value="gmail">Send a Gmail email</option>}
      </select>
    </label>
    {gmail&&<>
      <p>Harbor emails the contact’s saved address after an owner changes the lifecycle stage. Turn the workflow off to stop queued emails before dispatch.</p>
      <label>Email subject<input name="subject" required maxLength={200} defaultValue={definition?.actionKind==='gmail'?definition.subject:''}/></label>
    </>}
    {task?<>
      <p>After the saved delay, Harbor creates a Task linked to {trigger==='deal_stage'?'the deal’s primary Contact':'the Contact'} and assigns it to the workspace owner.</p>
      <label>Task name<input name="taskName" required maxLength={160} defaultValue={savedTask?.name}/></label>
      <label>Task type<select name="taskType" defaultValue={savedTask?.taskType??'To-do'}>
        {taskTypes.map(type=><option key={type}>{type}</option>)}
      </select></label>
      <label>Priority<select name="taskPriority" defaultValue={savedTask?.priority??'Medium'}>
        {schemas.tasks.shape.priority.removeDefault().options.map(priority=><option key={priority}>{priority}</option>)}
      </select></label>
      <label>Due date<input name="taskDueDate" type="date" defaultValue={savedTask?.dueDate??''}/></label>
      <label className="portable-note-text">Task notes<textarea name="taskNotes" maxLength={2000} defaultValue={savedTask?.notes??''}/></label>
    </>:sequence?<>
      <p>Each Note runs after its delay and the successful completion of the previous step. Turning this workflow Off blocks new runs. To stop an existing run, cancel its queued or running Note from the Job queue.</p>
      <input type="hidden" name="sequenceSteps" value={JSON.stringify(steps)}/>
      {steps.map((step,index)=><fieldset key={step.id} className="portable-workflow-note-step"><legend>Note {index+1}</legend>
        <label>Action name<input required maxLength={80} value={step.name} onChange={event=>updateStep(step.id,{name:event.target.value})}/></label>
        <label>{index===0?'Minutes after enrollment':'Minutes after previous Note'}<input type="number" min={0} max={43_200} required
          value={step.delayMinutes} onChange={event=>updateStep(step.id,{delayMinutes:Number(event.target.value)})}/></label>
        <label className="portable-note-text">Note for the contact<textarea required maxLength={2000} value={step.body}
          onChange={event=>updateStep(step.id,{body:event.target.value})}/></label>
        {steps.length>2&&<button type="button" onClick={()=>{
          setSteps(previous=>previous.filter(item=>item.id!==step.id));
          onDraftChange();
        }}>Remove Note {index+1}</button>}
      </fieldset>)}
      {steps.length<portableManualNoteSequenceLimit&&<button type="button" onClick={()=>{
        setSteps(previous=>[...previous,newNoteStep()]);
        onDraftChange();
      }}>Add Note</button>}
    </>:branch?<div className="portable-workflow-branch">
      <p>{dealStage?'Harbor uses the primary Contact’s lifecycle when the Deal moves into this stage.':
        created?'Harbor chooses one Note based on the Contact’s lifecycle when the record is first saved.':
        assigned?'Harbor chooses one Note based on the lifecycle saved with the new owner.':
          'Harbor chooses one Note based on the selected Contact’s lifecycle stage when you queue the run.'}</p>
      <label>Lifecycle stage to match<select name="lifecycle" defaultValue={savedBranch?.lifecycle??'Customer'}>
        {lifecycles.map(lifecycle=><option key={lifecycle}>{lifecycle}</option>)}
      </select></label>
      <div className="portable-workflow-branch-paths">
        {(['match','otherwise'] as const).map(path=><fieldset className="portable-workflow-note-step" key={path}>
          <legend>{path==='match'?'When the stage matches':'Otherwise'}</legend>
          <label>Delay in minutes<input name={path+'DelayMinutes'} type="number" min={0} max={43_200} required
            defaultValue={savedBranch?.[path].delayMinutes??0}/></label>
          <label className="portable-note-text">Note for the Contact<textarea name={path+'Body'} maxLength={2000} required
            defaultValue={savedBranch?.[path].body}/></label>
        </fieldset>)}
      </div>
    </div>:code?<>
      <p>Run one calculation on the selected contact. Harbor stores declared outputs in run history.</p>
      <label>Input mappings, one name=property per line
        <textarea name="inputs" maxLength={300} defaultValue={savedCode?.inputs.map(({name,field})=>name+'='+field).join('\n')??'name=name'}/>
      </label>
      <p>Contact properties {portableCodeInputFields.join(', ')}.</p>
      <label>Output declarations, one name=type per line
        <textarea name="outputs" required maxLength={450} defaultValue={savedCode?.outputs.map(({name,type})=>name+'='+type).join('\n')??'normalizedName=string'}/>
      </label>
      <p>Output types {portableCodeOutputTypes.join(', ')}.</p>
      <label>JavaScript
        <textarea name="code" required rows={8} maxLength={portableCodeLimit}
          defaultValue={savedCode?.code??'return { normalizedName: event.inputFields.name.trim() };'}/>
      </label>
    </>:<label className="portable-note-text">{gmail?'Plain-text message':trigger==='deal_stage'?'Note for the deal’s primary contact':'Note for the contact'}
      <textarea name="body" maxLength={2000} required defaultValue={definition&&'body' in definition?definition.body:undefined}/>
    </label>}
  </>;
}

function declarations(value:FormDataEntryValue|undefined){
  return String(value??'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
    const parts=line.split('=').map(part=>part.trim());
    return parts.length===2?parts:['',''];
  });
}

export function PortableWorkflows({email,pipelines,segments,workflows,history,runWorkflowId,runDealId,runIssue,gmailAvailable,codeAvailable}:{
  email:string;gmailAvailable:boolean;codeAvailable:boolean;pipelines:DealPipeline[];segments:PortableSegmentList;
  workflows:Workflow[];history:RunPage;runWorkflowId?:string;runDealId?:string;runIssue?:'queue_full';
}){
  const router=useRouter();
  const [selected,setSelected]=useState('');
  const [busy,setBusy]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [draftVersion,setDraftVersion]=useState(0);
  const [error,setError]=useState('');
  const [status,setStatus]=useState<{message:string;jobId?:string}>();
  const [contactPickerKey,setContactPickerKey]=useState(0);
  const [batchId,setBatchId]=useState<string|null>(null);
  const requestId=useRef<string|null>(null);
  const pendingRun=useRef<{key:string;id:string}|null>(null);
  const saving=useRef(false);
  const workflow=workflows.find(item=>item.id===selected);
  const selectedCode=workflow?.definition.actionKind==='code';
  const selectedSequence=workflow?.definition.actionKind==='note_sequence';
  const selectedBranch=workflow?.definition.actionKind==='note_branch';
  const selectedTask=workflow?.definition.actionKind==='task';
  const chosen=workflow?.definition;
  const canBatch=workflow?.enabled&&chosen?.trigger==='manual_contact'&&
    (!chosen.actionKind||chosen.actionKind==='note')&&chosen.delayMinutes===0;
  useEffect(()=>{
    if(!dirty&&!busy)return;
    const warn=(event:BeforeUnloadEvent)=>{
      event.preventDefault();
      event.returnValue='';
    };
    window.addEventListener('beforeunload',warn);
    return ()=>window.removeEventListener('beforeunload',warn);
  },[dirty,busy]);
  function runPageLink(cursor?:NonNullable<RunPage['next']>,issue:'all'|'queue_full'=runIssue??'all',dealId=runDealId??null){
    const params=new URLSearchParams({view:'workflows'});
    if(runWorkflowId)params.set('runWorkflowId',runWorkflowId);
    if(dealId)params.set('runDealId',dealId);
    if(issue==='queue_full')params.set('runIssue',issue);
    if(cursor){params.set('afterAt',String(cursor.at));params.set('afterId',cursor.id);}
    return '/?'+params;
  }

  function showBatch(id:string){
    setBatchId(id);
    router.refresh();
  }

  function canDiscardDraft(){
    return !saving.current&&(!dirty||window.confirm('Discard unsaved workflow changes?'));
  }

  function resetDraft(){
    requestId.current=null;
    setDirty(false);
    setDraftVersion(value=>value+1);
    setError('');
    setStatus(undefined);
  }

  function choose(id:string){
    if(id===selected&&(id||!dirty)||!canDiscardDraft())return;
    resetDraft();
    setSelected(id);
  }

  async function action(body:unknown,message:string,id?:string,onSuccess?:(response:Response)=>Promise<string>){
    if(saving.current)return;
    saving.current=true;
    setBusy(true);
    setStatus(undefined);
    setError('');
    try{
      const response=await fetch('/api/workflows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        setError(result.error||'Could not update the workflow.');
        return;
      }
      const jobId=await onSuccess?.(response);
      if(id){
        setSelected(id);
        setDirty(false);
      }
      setStatus({message,jobId});
      router.refresh();
    }catch{setError('Could not confirm the change. Refresh to check before trying again.');}
    finally{saving.current=false;setBusy(false);}
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const fields=Object.fromEntries(new FormData(event.currentTarget));
    const segmentTrigger=fields.trigger==='contact_segment'||fields.trigger==='contact_segment_left';
    const trigger=segmentTrigger?'contact_segment':fields.trigger;
    const segmentFields=segmentTrigger?{segmentId:fields.segmentId,enrollment:fields.enrollment,
      segmentEvent:fields.trigger==='contact_segment_left'?'left':undefined}:{};
    let definition:unknown={...fields,trigger,delayMinutes:Number(fields.delayMinutes),...segmentFields};
    if(fields.actionKind==='task'){
      const parsed=portableWorkflowTask.safeParse({name:fields.name,trigger,actionKind:'task',...segmentFields,
        ...(trigger==='contact_lifecycle'?{lifecycle:fields.lifecycle}:{}),
        ...(trigger==='deal_stage'?{pipelineId:fields.pipelineId,stageId:fields.stageId}:{}),
        delayMinutes:Number(fields.delayMinutes),task:{name:fields.taskName,taskType:fields.taskType,
          priority:fields.taskPriority,dueDate:fields.taskDueDate,notes:fields.taskNotes}});
      if(!parsed.success){setError('Check the Task name, delay, and due date.');return;}
      definition=parsed.data;
    }else if(fields.actionKind==='note_sequence'){
      const parsed=portableManualNoteSequence.safeParse({
        name:fields.name,trigger:fields.trigger,actionKind:fields.actionKind,steps:JSON.parse(String(fields.sequenceSteps??'[]')),
      });
      if(!parsed.success){
        setError('Check each Note name, delay, and text.');
        return;
      }
      definition=parsed.data;
    }else if(fields.actionKind==='note_branch'){
      const parsed=portableNoteBranch.safeParse({
        name:fields.name,trigger:fields.trigger,actionKind:fields.actionKind,lifecycle:fields.lifecycle,
        ...(trigger==='deal_stage'?{pipelineId:fields.pipelineId,stageId:fields.stageId}:{}),
        match:{body:fields.matchBody,delayMinutes:Number(fields.matchDelayMinutes)},
        otherwise:{body:fields.otherwiseBody,delayMinutes:Number(fields.otherwiseDelayMinutes)},
      });
      if(!parsed.success){
        setError('Check the lifecycle stage and both Notes, including their delays.');
        return;
      }
      definition=parsed.data;
    }else if(fields.actionKind==='code'){
      const parsed=portableManualCodeDefinition.safeParse({
        name:fields.name,trigger:fields.trigger,actionKind:'code',code:fields.code,
        inputs:declarations(fields.inputs).map(([name,field])=>({name,field})),
        outputs:declarations(fields.outputs).map(([name,type])=>({name,type})),
      });
      if(!parsed.success){
        setError('Check the code, input mappings, and output declarations.');
        return;
      }
      definition=parsed.data;
    }
    const id=workflow?.id??(requestId.current??=crypto.randomUUID());
    void action({action:'save',id,revision:workflow?.revision??0,definition},'Workflow saved.',id);
  }

  function runContact(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(dirty||!workflow?.enabled||workflow.definition.trigger!=='manual_contact'||selectedCode&&!codeAvailable||saving.current)return;
    const contactId=new FormData(event.currentTarget).get('contactId');
    if(typeof contactId!=='string'||!contactId){setStatus(undefined);setError(selectedCode?'Choose the contact for this calculation.':selectedSequence?
      'Choose the contact for this Note sequence.':selectedTask?'Choose the Contact for this Task.':'Choose the contact who should receive the Note.');return;}
    const key=['harbor-manual-workflow',workflow.id,workflow.revision,contactId].join(':');
    let id=pendingRun.current?.key===key?pendingRun.current.id:null;
    try{id??=sessionStorage.getItem(key);}catch{}
    id??=crypto.randomUUID();
    pendingRun.current={key,id};
    try{sessionStorage.setItem(key,id);}catch{}
    const runId=id;
    void action({action:'runContact',id:runId,workflowId:workflow.id,workflowRevision:workflow.revision,contactId},
      (selectedCode?'Manual JavaScript request recorded. Run ID ':selectedSequence?'Manual Note sequence recorded. Run ID ':selectedTask?'Manual Task request recorded. Run ID ':'Manual Note request recorded. Run ID ')+runId+'.',undefined,async response=>{
        const receipt=await response.json() as {run?:{id:string;jobId:string}};
        if(receipt.run?.id!==runId||receipt.run.jobId!==runId)throw Error('The run receipt could not be confirmed.');
        pendingRun.current=null;
        try{sessionStorage.removeItem(key);}catch{}
        setContactPickerKey(value=>value+1);
        return receipt.run.jobId;
      });
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="workflows"/>
    <section>
      <div className="portable-contacts-heading"><h1>Workflows</h1><a href="/?view=job-queue">Job queue</a></div>
      <p>Schedule follow-up actions from CRM changes, active segments, or a Contact you select.</p>
      {gmailAvailable&&<p>For lifecycle changes made by the workspace owner, you can also schedule a plain-text Gmail email.</p>}
      <p>New workflows start Off. Turning one Off stops new runs. Notes and Tasks already queued keep their schedule.</p>
      <div className="portable-workflow-switcher">
        <button type="button" disabled={busy} onClick={()=>choose('')}>New workflow</button>
        {workflows.map(item=><button type="button" key={item.id} disabled={busy} aria-pressed={item.id===selected}
          onClick={()=>choose(item.id)}>{item.definition.name} · {item.enabled?'On':'Off'}
          {item.definition.trigger==='contact_owner_assigned'&&' · Contact owner assignment'}
          {item.definition.actionKind==='note_branch'&&' · Lifecycle branch'}
          {item.enabled&&item.baseline&&' · Building segment baseline'}
          {item.enabled&&item.waitingForCapacity&&' · Waiting for job queue capacity'}
          {item.enabled&&item.scanOverdue&&' · Segment check overdue'}
          {item.enabled&&item.retryingScan&&' · Retrying failed segment check'}
        </button>)}
      </div>
      {status&&!status.jobId&&<p role="status">{status.message}</p>}
      {error&&<p role="alert">{error}</p>}
      <h2>{workflow?'Edit workflow':'New workflow'}</h2>
      <form className="portable-workflow-editor" key={(workflow?workflow.id+':'+workflow.revision:'new')+':'+draftVersion}
        onSubmit={save} onChange={event=>{
          if(!(event.target instanceof HTMLInputElement&&event.target.type==='search'))setDirty(true);
        }}>
        <fieldset disabled={busy||selectedCode&&!codeAvailable}><WorkflowFields pipelines={pipelines} segments={segments} workflow={workflow}
          gmailAvailable={gmailAvailable} codeAvailable={codeAvailable} onDraftChange={()=>setDirty(true)}/></fieldset>
        <button type="submit" disabled={busy||selectedCode&&!codeAvailable}>Save workflow</button>
        {dirty&&<p role="status">Unsaved workflow changes.</p>}
      </form>
      {workflow&&<button type="button" disabled={busy||selectedCode&&!codeAvailable&&!workflow.enabled} onClick={()=>{
        if(!canDiscardDraft())return;
        void action({action:'setEnabled',id:workflow.id,revision:workflow.revision,enabled:!workflow.enabled},
          workflow.enabled?'Workflow turned off.':'Workflow turned on.',workflow.id);
      }}>
        {workflow.enabled?'Turn off':'Turn on'}
      </button>}
      {workflow?.definition.trigger==='manual_contact'&&<section aria-label="Manual contact run">
        <h2>Run for one contact</h2>
        {selectedCode&&!codeAvailable?<p>JavaScript actions are unavailable in this deployment.</p>:workflow.enabled?<form onSubmit={runContact}>
          <fieldset disabled={busy||dirty}>
            <PortableRecordPicker key={workflow.id+':'+contactPickerKey} kind="contacts" field="contactId" label={selectedCode?'Contact for this JavaScript action':selectedSequence?'Contact for this Note sequence':selectedTask?'Contact for this Task':'Contact for this Note'} value={null}/>
          </fieldset>
          <p>{selectedCode?'Harbor queues one calculation with the selected contact values.':selectedSequence?
            'Harbor queues the first Note and waits for each Note to finish before scheduling the next.':selectedBranch?
            'Harbor chooses the Note and its delay using the Contact’s lifecycle stage when you queue this run.':selectedTask?
            'Harbor queues one Task for the selected Contact using this workflow’s saved fields and delay.':
            'Harbor queues one Note for the selected contact using this workflow’s saved delay.'}</p>
          <button type="submit" disabled={busy||dirty}>{selectedCode?'Queue JavaScript for selected contact':selectedSequence?'Queue Note sequence for selected contact':selectedTask?'Queue Task for selected contact':'Queue Note for selected contact'}</button>
        </form>:<p>{selectedCode?'Turn this workflow on to queue a calculation.':selectedSequence?'Turn this workflow on to queue a Note sequence.':selectedTask?'Turn this workflow on to queue a Task.':'Turn this workflow on to queue a Note. Manual workflows run when you choose a contact.'}</p>}
        {status?.jobId&&<p role="status">{status.message}{' '}
          <a href={jobDetailsHref(status.jobId)}>{selectedSequence?'View first Note job':'View job'}</a>
        </p>}
      </section>}
      {workflow&&canBatch&&<PortableManualNoteBatch key={workflow.id+':'+workflow.revision} workflowId={workflow.id}
        revision={workflow.revision} disabled={busy||dirty} onReceipt={showBatch}/>}
      {batchId&&<PortableManualBatchReceipt key={batchId} batchId={batchId} onClose={()=>setBatchId(null)}/>}
      <h2 id="recent-runs">Recent runs</h2>
      {runDealId&&<p>Showing runs for this Deal.{' '}
        <a href={runPageLink(undefined,runIssue,null)+'#recent-runs'}>Clear Deal filter</a>
      </p>}
      <nav aria-label="Run outcomes">
        <a href={runPageLink(undefined,'all')+'#recent-runs'} aria-current={!runIssue?'page':undefined}>All runs</a>{' '}
        <a href={runPageLink(undefined,'queue_full')+'#recent-runs'} aria-current={runIssue?'page':undefined}>Missed runs to review</a>
      </nav>
      {runIssue&&<p>Open the source record to follow up, then mark the missed run reviewed.</p>}
      <form className="portable-workflow-runs-filter" method="get" action="/" aria-label="Filter recent runs">
        <input type="hidden" name="view" value="workflows"/>
        {runDealId&&<input type="hidden" name="runDealId" value={runDealId}/>}
        {runIssue&&<input type="hidden" name="runIssue" value={runIssue}/>}
        <label>Workflow<select key={runWorkflowId??''} name="runWorkflowId" defaultValue={runWorkflowId??''}>
          <option value="">All workflows</option>
          {workflows.map(({id,definition})=><option key={id} value={id}>{definition.name}</option>)}
          {runWorkflowId&&!workflows.some(({id})=>id===runWorkflowId)&&<option value={runWorkflowId}>Unavailable workflow</option>}
        </select></label>
        <button type="submit">Apply filter</button>
      </form>
      <button type="button" disabled={busy} onClick={()=>{
        if(!canDiscardDraft())return;
        if(dirty)resetDraft();
        router.refresh();
      }}>Refresh runs</button>
      {history.runs.length?<ul>{history.runs.map(run=><li key={run.id}>
        <strong>{run.workflowName}</strong> · {run.dealId
          ? <a href={'/?kind=deals&record='+run.dealId}>{run.dealName??'Open Deal'}</a>
          : run.contactId ? <a href={'/?contact='+run.contactId}>{run.contactName??'Open Contact'}</a> : 'Record unavailable'}
        {' · '}{run.manual?'Manual · ':''}{run.jobKind==='gmail'&&run.jobStatus==='succeeded'?'Accepted by Gmail':
          run.issue?runIssues[run.issue]:jobStatusLabel(run.jobStatus??'attention',run.jobIssue)}
        <p>{time(run.createdAt)}{run.scheduledFor!==null&&<> · Scheduled {time(run.scheduledFor)}</>}
          {run.attempts!==null&&<> · {run.attempts} {run.attempts===1?'attempt':'attempts'}</>}</p>
        {run.issue==='missing_contact'&&<p>Add a primary contact for future runs. Complete this missed follow-up manually.</p>}
        {run.issue==='queue_full'&&<p>
          {run.operatorReviewedAt!==undefined?'Reviewed '+time(run.operatorReviewedAt):
            <button type="button" disabled={busy} onClick={()=>void action({action:'reviewQueueFullRun',id:run.id},
              'Missed run marked reviewed.')}>Mark reviewed</button>}
        </p>}
        {run.jobId&&<details><summary>Run details</summary>
          <p><a href={jobDetailsHref(run.jobId)}>View job</a></p><p>{run.sequence?'Latest job ID':'Job ID'} <code>{run.jobId}</code></p>
          {run.jobIssue&&<p>{jobIssueLabel(run.jobIssue)}</p>}
          {run.batchId&&<button type="button" onClick={()=>setBatchId(run.batchId!)}>Open batch receipt</button>}
          {run.codeOutput&&<><h3>JavaScript outputs</h3><pre>{JSON.stringify(run.codeOutput,null,2)}</pre></>}
          {run.jobKind==='task'&&run.jobStatus==='succeeded'&&<p><a href={'/?'+new URLSearchParams({kind:'tasks',record:run.jobId})}>Open created Task</a></p>}
          {run.sequence&&<ol>{run.sequence.map(step=><li key={step.id}>
            <strong>{step.name}</strong> · {step.status?jobStatusLabel(step.status,step.issue):
              run.jobStatus==='queued'||run.jobStatus==='running'?'Waiting for earlier Notes':'Not reached'}
            {step.scheduledFor!==null&&<> · Scheduled {time(step.scheduledFor)}</>}
            {step.jobId&&<p>Job ID <code>{step.jobId}</code> · {step.attempts} {step.attempts===1?'attempt':'attempts'} · <a href={jobDetailsHref(step.jobId)}>View step job</a></p>}
            {step.issue&&<p>{jobIssueLabel(step.issue)}</p>}
          </li>)}</ol>}
        </details>}
      </li>)}</ul>:<p>No runs on this page.</p>}
      <nav aria-label="Run pages">
        <a href={runPageLink()}>Latest runs</a>
        {history.next&&<a href={runPageLink(history.next)}>Older runs</a>}
      </nav>
    </section>
  </main>;
}
