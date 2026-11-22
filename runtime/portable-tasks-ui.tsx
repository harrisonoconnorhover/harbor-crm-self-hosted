'use client';

import {effectiveMemberToolPolicy,type ToolPolicies} from '../lib/portable-tool-permissions';
import {useCallback,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import type {PortableOutreach} from '../lib/portable-contact-activities';
import {PortableAircall} from './portable-aircall';
import {useRouter} from 'next/navigation';
import {TaskDeadlineFields} from '../app/task-deadline';
import {taskDeadlineLabel,taskDeadlineValue,type TaskDeadline} from '../lib/task-deadline';
import {taskRepeatLabel,taskRepeatSchema,type TaskRepeat} from '../lib/task-repeat';
import type {RecordScope} from '../lib/portable-workspace-access';
import {taskOutreachKinds,isPortableTaskDateView,portableTaskDateViews,portableTaskPriorities,portableTaskStatuses,portableTaskTypes,taskLinkFields,taskLinkTarget,type PortableTaskQuery,type PortableTaskRecord} from '../lib/portable-tasks';
import {portableRecordKind,portableRecordLabels,recordSearchLimit,type PortableRecordKind} from '../lib/portable-records';
import {objectPath} from '../lib/portable-custom-objects';
import {PortableTaskQueues} from './portable-task-queues-ui';
import type {PortableTaskQueue} from '../lib/portable-task-queues';
import {NO_QUEUE} from '../lib/task-queues';
import {standardTaskViews} from '../lib/shared-task-navigation';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableRecycleAction,portableRecycleBinLink} from './portable-contact-recycle-ui';
import {PortableCrmHeader} from './portable-crm-header';
import {reminderChoices} from '../lib/portable-task-reminders';
import {refreshTaskReminders} from './portable-task-reminders-ui';
import './portable-contacts.css';
import './portable-tasks.css';

type TaskStatus=PortableTaskRecord['data']['status'];
type Choice={id:string;label:string};
type LinkedTarget={kind:PortableRecordKind;id:string};
type LinkedRecord=LinkedTarget&{name:string};
type TaskView=PortableTaskQuery['taskView'];
type TaskAssignee=PortableTaskQuery['taskAssignee'];
type TaskFilters={status?:TaskStatus;taskView?:TaskView|null;taskZone?:string;taskAssignee?:TaskAssignee|null;
  taskPriority?:PortableTaskQuery['taskPriority']|null;taskType?:PortableTaskQuery['taskType']|null;
  related?:LinkedTarget|null;after?:string;record?:string;taskQueueId?:string;search?:string|null};
type Props={
  email:string;
  workspaceId?:string;
  grant?:{id:string;role:'viewer'|'editor';contactOutreach?:boolean;editScope:RecordScope;viewScope:RecordScope;toolPolicies?:ToolPolicies};
  records:PortableTaskRecord[];
  next:string|null;
  paged?:boolean;
  search?:string;
  initialRecord?:PortableTaskRecord;
  customSource?:{objectId:string;recordId:string;archivedAt:string|null};
  initialNextTaskId?:string;
  startNewTask?:boolean;
  assignees:Choice[];
  taskQueues:PortableTaskQueue[];
  taskQueueId?:string;
  taskView?:TaskView;
  taskZone?:string;
  taskAssignee?:TaskAssignee;
  taskPriority?:PortableTaskQuery['taskPriority'];
  taskType?:PortableTaskQuery['taskType'];
  status?:TaskStatus;
  related?:LinkedRecord;
};
const browserTaskZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const defaultTaskZone=()=>'UTC';
const subscribeTaskZone=()=>()=>{};

const linkNames={contacts:'contactName',companies:'companyName',deals:'dealName'} as const;
function linkedTaskRecord(task:PortableTaskRecord):LinkedRecord|null{
  const target=taskLinkTarget(task);
  return target?{...target,name:task[linkNames[target.kind]]??portableRecordLabels[target.kind]}:null;
}

function TaskRecordPicker({value,workspaceId}:{value:LinkedRecord|null;workspaceId?:string}){
  const [kind,setKind]=useState<PortableRecordKind>(value?.kind??'contacts');
  return <>
    <label>Linked record type<select name="relatedKind" value={kind}
      onChange={event=>setKind(portableRecordKind.parse(event.target.value))}>
      {portableRecordKind.options.map(item=><option key={item} value={item}>{portableRecordLabels[item]}</option>)}
    </select></label>
    <PortableRecordPicker key={kind} kind={kind} field="relatedId" label="Linked record"
      value={value?.kind===kind?value:null} workspaceId={workspaceId}/>
  </>;
}

function TaskTable({records,queues,canAssign,busy,taskHref,linkedHref,onBusy,onAssigned}:{
  records:PortableTaskRecord[];queues:PortableTaskQueue[];canAssign:boolean;busy:boolean;
  taskHref:(id:string)=>string;linkedHref:(target:LinkedRecord)=>string;
  onBusy:(busy:boolean)=>void;onAssigned:(changed:number)=>void;
}){
  const submitting=useRef(false);
  const [selected,setSelected]=useState(new Map<string,number>());
  const [destination,setDestination]=useState('');
  const [error,setError]=useState('');
  const queueNames=new Map(queues.map(queue=>[queue.id,queue.name]));

  async function assign(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!canAssign||busy||submitting.current||!selected.size||!destination)return;
    submitting.current=true;
    onBusy(true);
    setError('');
    try{
      const response=await fetch('/api/task-queues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        action:'assign',queueId:destination===NO_QUEUE?null:destination,
        tasks:[...selected].map(([id,expectedRevision])=>({id,expectedRevision})),
      })});
      const result=await response.json() as {changed?:number;error?:string};
      if(!response.ok||result.changed===undefined){
        setError(result.error??'Could not assign the selected tasks.');
        return;
      }
      setSelected(new Map());
      setDestination('');
      onAssigned(result.changed);
    }catch{
      setError('Could not confirm the assignment. Refresh the list to check.');
    }finally{
      submitting.current=false;
      onBusy(false);
    }
  }

  if(!records.length)return <p>No tasks on this page.</p>;
  return <>
    {canAssign&&selected.size>0&&<form onSubmit={assign} aria-label="Assign selected tasks to a queue">
      <span>{selected.size} selected on this page</span>
      <fieldset disabled={busy}>
        <label>Assign to queue <select value={destination} onChange={event=>setDestination(event.target.value)}>
          <option value="">Choose a queue</option><option value={NO_QUEUE}>No queue</option>
          {queues.map(queue=><option key={queue.id} value={queue.id}>{queue.name}</option>)}
        </select></label>
        <button type="submit" disabled={!destination}>Apply queue</button>
        <button type="button" onClick={()=>{setSelected(new Map());setError('');}}>Clear selection</button>
      </fieldset>
      {error&&<p role="alert">{error}</p>}
    </form>}
    <div className="portable-contacts-table"><table>
      <thead><tr>{canAssign&&<th scope="col">Select</th>}<th>Name</th>{canAssign&&<th>Queue</th>}
        <th>Task type</th><th>Status</th><th>Priority</th><th>Due date</th><th>Assigned to</th><th>Linked record</th></tr></thead>
      <tbody>{records.map(task=>{
        const link=linkedTaskRecord(task);
        return <tr key={task.id}>
          {canAssign&&<td><input type="checkbox" aria-label={'Select '+task.data.name} checked={selected.has(task.id)} disabled={busy}
            onChange={event=>{
              const checked=event.currentTarget.checked;
              setSelected(previous=>{
                const next=new Map(previous);
                if(checked)next.set(task.id,task.revision);
                else next.delete(task.id);
                return next;
              });
            }}/></td>}
          <th scope="row"><a href={taskHref(task.id)}>{task.data.name}</a></th>
          {canAssign&&<td>{task.queueId?queueNames.get(task.queueId)??'Unavailable queue':'No queue'}</td>}
          <td>{task.data.taskType}</td><td>{task.data.status}{task.inactiveSequenceTask&&!task.completedAt&&<><br/><small>Sequence step inactive</small></>}</td><td>{task.data.priority}</td><td>{task.data.dueDate?taskDeadlineLabel(task.data):'—'}{task.data.repeat&&<><br/><small>{taskRepeatLabel(task.data)}</small></>}</td>
          <td>{task.assigneeLabel??'—'}</td>
          <td>{link?<a href={linkedHref(link)}>{link.name}</a>:'—'}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}

export function PortableTasks({email,workspaceId,grant,records,next,paged,search,initialRecord,customSource,initialNextTaskId,startNewTask,assignees,status,related,taskQueues,taskQueueId,taskView,taskZone,taskAssignee,taskPriority,taskType}:Props){
  const router=useRouter();
  const browserZone=useSyncExternalStore(subscribeTaskZone,browserTaskZone,defaultTaskZone);
  const submitting=useRef(false);
  const editorForm=useRef<HTMLFormElement>(null);
  const taskName=useRef<HTMLInputElement|null>(null);
  const focusNewTask=useCallback((input:HTMLInputElement|null)=>{
    taskName.current=input;
    input?.focus();
  },[]);
  const [editing,setEditing]=useState<PortableTaskRecord|'new'|null>(initialRecord??(startNewTask?'new':null));
  const [saving,setSaving]=useState(false);
  const [archiving,setArchiving]=useState(false);
  const [assigning,setAssigning]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportError,setExportError]=useState('');
  const busy=saving||archiving||assigning;
  const [deadline,setDeadline]=useState<TaskDeadline>(()=>taskDeadlineValue(initialRecord?.data??{}));
  const [repeat,setRepeat]=useState<TaskRepeat|null>(initialRecord?.data.repeat??null);
  const [nextTaskId,setNextTaskId]=useState<string>();
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const current=editing==='new'?null:editing;
  const visibleNextTaskId=initialRecord?(current?.id===initialRecord.id?initialNextTaskId:undefined):nextTaskId;
  const policy=grant&&effectiveMemberToolPolicy(grant,'tasks');
  const restrictedEdit=!!policy&&policy.edit!=='all';
  const readOnly=!!workspaceId&&(grant?.role!=='editor'||(editing==='new'?!policy?.create:policy?.edit==='none'||current?.editable===false));
  const currentLink=current?linkedTaskRecord(current):null;
  const currentAssignee=current?.assigneeId;
  const inactiveAssignee=currentAssignee&&!assignees.some(choice=>choice.id===currentAssignee);
  const completed=current?.data.status==='Completed';
  const assigneeReview=taskView==='unavailable-assignee';

  function crmLink(kind:PortableRecordKind,id?:string){
    const query=new URLSearchParams();
    if(kind!=='contacts')query.set('kind',kind);
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(id)query.set(kind==='contacts'?'contact':'record',id);
    return query.size?'/?'+query:'/';
  }

  function taskParams({related:target=related,taskQueueId:queue=taskQueueId,taskView:view=taskView,taskZone:zone=taskZone,
    taskAssignee:assignee=taskAssignee,taskPriority:priority=taskPriority,taskType:type=taskType,search:term=search,...filters}:TaskFilters={}){
    const query=new URLSearchParams({kind:'tasks'});
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(target)query.set(taskLinkFields[target.kind],target.id);
    if(queue)query.set('taskQueueId',queue);
    if(term)query.set('search',term);
    if(priority)query.set('taskPriority',priority);
    if(type)query.set('taskType',type);
    if(view)query.set('taskView',view);
    if(isPortableTaskDateView(view)){
      query.set('taskZone',zone??'UTC');
      if(assignee)query.set('taskAssignee',assignee);
    }
    for(const [key,value] of Object.entries(filters)){
      if(value)query.set(key,value);
    }
    return query;
  }

  function taskLink(filters?:TaskFilters){
    return '/?'+taskParams(filters);
  }

  async function downloadTasks(){
    setExporting(true);
    setExportError('');
    try{
      const filters=taskParams({status});
      filters.delete('taskQueueId');
      if(taskQueueId)filters.set('queueId',taskQueueId);
      filters.set('export','csv');
      const response=await fetch('/api/crm?'+filters);
      if(!response.ok){
        const body=await response.json() as {error?:string};
        throw Error(body.error??'Could not export tasks.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected a CSV download.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-tasks.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){
      setExportError(error instanceof Error?error.message:'Could not export tasks.');
    }finally{
      setExporting(false);
    }
  }

  function showEditor(value:typeof editing){
    setEditing(value);
    setDeadline(taskDeadlineValue(value&&value!=='new'?value.data:{}));
    setRepeat(value&&value!=='new'?value.data.repeat??null:null);
    setNextTaskId(undefined);
    setNotice('');
    setError('');
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    await saveValues(new FormData(event.currentTarget,(event.nativeEvent as SubmitEvent).submitter));
  }

  async function saveValues(values:FormData,call?:(PortableOutreach&{providerId:number})){
    if(submitting.current||archiving)return false;
    const assignee=String(values.get('assigneeId')??'');
    const linkedId=String(values.get('relatedId')??'');
    const linked=linkedId?{kind:values.get('relatedKind'),id:linkedId}:null;
    const priorLink=taskLinkTarget(current??{});
    const linkUnchanged=linked?.kind===priorLink?.kind&&linked?.id===priorLink?.id;
    const logging=Boolean(call)||values.has('logOutreach');
    const nextStatus=logging?'Completed':values.get('status')??current?.data.status??'Not started';
    const summary=String(values.get('outreachSummary')??'').trim()||call?.summary;
    const channel=call?'Call':values.get('outreachKind');
    if(logging&&!channel){setError('Choose the channel you used.');return false;}
    if(logging&&(!summary||!linkUnchanged)){
      setError(!summary?'Enter what happened before logging outreach.':'Save the new contact link before logging outreach.');return false;
    }
    const reminder=values.get('reminderMinutes');
    const scope=workspaceId&&grant?'?'+new URLSearchParams({workspaceId,grantId:grant.id}):'';
    submitting.current=true;
    setSaving(true);
    setNextTaskId(undefined);
    setNotice('');
    setError('');
    try{
      const response=await fetch('/api/crm'+scope,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          action:'save',kind:'tasks',
          ...(logging?{outreach:{contactId:current?.contactId,kind:channel,summary,
            ...(call?{aircall:{callId:call.providerId,occurredAt:call.occurredAt}}:{})}}:{}),
          data:{name:values.get('name'),taskType:values.get('taskType'),priority:values.get('priority'),
            ...taskDeadlineValue(deadline),reminderMinutes:reminder===null||reminder==='off'?null:Number(reminder),
            repeat,notes:values.get('notes'),status:nextStatus},
          ...(!workspaceId?{queueId:values.get('queueId')||null}:{}),
          assigneeId:current&&assignee===(current.assigneeId??'')?undefined:assignee||(!current&&restrictedEdit?undefined:null),
          related:linkUnchanged?undefined:linked,
          ...(current?{id:current.id,expectedRevision:current.revision}:{}),
        }),
      });
      const result=await response.json() as {record?:PortableTaskRecord;nextTaskId?:string;error?:string};
      if(!response.ok||!result.record){
        setError(result.error??'Could not save the task.');
        return false;
      }
      const saved=result.record;
      refreshTaskReminders();
      setEditing(saved);
      setDeadline(taskDeadlineValue(saved.data));
      setRepeat(saved.data.repeat??null);
      setNextTaskId(result.nextTaskId);
      const changedStatus=current&&nextStatus!==current.data.status;
      setNotice(logging?'Outreach logged and task completed.':changedStatus?(nextStatus==='Completed'?'Task completed.':'Task reopened.'):(current?'Task saved.':'Task added.'));
      const statusChanged=!!status&&saved.data.status!==status;
      const priorityChanged=!!taskPriority&&saved.data.priority!==taskPriority;
      const typeChanged=!!taskType&&saved.data.taskType!==taskType;
      const linkChanged=!!related&&saved[taskLinkFields[related.kind]]!==related.id;
      const queueChanged=!!taskQueueId&&saved.queueId!==(taskQueueId===NO_QUEUE?null:taskQueueId);
      const leftMyTasks=(taskView==='mine'||taskAssignee==='me')&&initialRecord&&
        (saved.assigneeId!==initialRecord.assigneeId||saved.completedAt!==null);
      const resolvedAssignment=assigneeReview&&initialRecord&&
        (saved.assigneeId!==initialRecord.assigneeId||saved.completedAt!==null);
      if(resolvedAssignment){
        setEditing(null);
        router.replace(taskLink());
      }else if((startNewTask&&!current)||
        initialRecord&&(initialRecord.id!==saved.id||statusChanged||priorityChanged||typeChanged||linkChanged||queueChanged||leftMyTasks)){
        router.replace(taskLink({record:saved.id,status:statusChanged?undefined:status,related:linkChanged?null:related,
          taskPriority:priorityChanged?null:taskPriority,taskType:typeChanged?null:taskType,
          taskQueueId:queueChanged?'':taskQueueId,taskView:leftMyTasks&&taskView==='mine'?null:taskView,
          taskAssignee:leftMyTasks?null:taskAssignee}));
      }else{
        router.refresh();
      }
      return true;
    }catch{
      setError('Could not confirm the save. Refresh the list to check.');
      return false;
    }finally{
      setSaving(false);
      submitting.current=false;
    }
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="tasks" workspaceId={workspaceId} tasksHref={taskLink({taskView:null})}
      recycleHref={readOnly?undefined:portableRecycleBinLink('tasks',workspaceId)}/>
    <section aria-labelledby="portable-tasks-title">
      <div className="portable-contacts-heading">
        <h1 id="portable-tasks-title">{related?'Tasks for '+related.name:'Tasks'}</h1>
        {(!workspaceId||policy?.create)&&!assigneeReview&&<button type="button" disabled={busy} onClick={()=>{if(editing==='new')taskName.current?.focus();else showEditor('new');}}>Add task</button>}
      </div>
      {workspaceId&&<p>Shared workspace · {readOnly?'View only':'Editor'}</p>}
      {current?.inactiveSequenceTask&&!completed&&<p>This sequence step is no longer active. No follow-up is due from this task.</p>}
      {current?.linkedInProfile&&<p><a href={current.linkedInProfile} target="_blank" rel="noreferrer">
        Open {current.contactName||'contact'} on LinkedIn</a></p>}
      {customSource&&current&&current.id===initialRecord?.id&&<p>{customSource.archivedAt?'Source record archived':
        <a href={objectPath({objectId:customSource.objectId,record:customSource.recordId,workspaceId})}>Open source record</a>}</p>}
      {related&&<p><a href={crmLink(related.kind,related.id)}>Back to {related.name}</a></p>}
      <p role="status">{notice}{visibleNextTaskId&&<> <a href={taskLink({record:visibleNextTaskId,related:null,taskQueueId:'',taskView:null,taskPriority:null,taskType:null,search:null})}>Open next task</a></>}</p>
      {editing&&!readOnly&&<form ref={editorForm} className="portable-task-editor" key={current?'editor:'+current.id+':'+current.revision:'editor:new'} onSubmit={save} aria-labelledby="portable-task-editor-title">
        <h2 id="portable-task-editor-title">{current?'Edit task':'New task'}</h2>
        {current&&<p>{current.data.status}{current.completedAt&&<> · Completed <time dateTime={current.completedAt}>
          {new Date(current.completedAt).toISOString().slice(0,16).replace('T',' ')} UTC</time></>}</p>}
        <fieldset disabled={busy}>
          <label>Name<input ref={editing==='new'?focusNewTask:undefined} name="name" defaultValue={current?.data.name} maxLength={160} required/></label>
          <label>Task type<select name="taskType" defaultValue={current?.data.taskType??'To-do'}>
            {portableTaskTypes.map(type=><option key={type}>{type}</option>)}
          </select></label>
          <label>Priority<select name="priority" defaultValue={current?.data.priority??'Medium'}>
            {portableTaskPriorities.map(priority=><option key={priority}>{priority}</option>)}
          </select></label>
          <TaskDeadlineFields value={deadline} onChange={setDeadline} disabled={busy}/>
          {deadline.dueTime&&<label>Task reminder
            <select name="reminderMinutes" defaultValue={current?.data.reminderMinutes??(current?.data.dueTime?'off':'0')}>
              <option value="off">No reminder</option>
              {reminderChoices.map(({minutes,label})=><option key={minutes} value={minutes}>{label}</option>)}
            </select>
            <small>Shows in Harbor for the assignee, or for the workspace owner if unassigned.</small>
          </label>}
          <label className="portable-task-repeat-option"><input type="checkbox" checked={!!repeat} onChange={event=>setRepeat(event.currentTarget.checked
            ?{every:1,unit:'weeks',timeZone:deadline.dueTimeZone||Intl.DateTimeFormat().resolvedOptions().timeZone}:null)}/>
            Set to repeat</label>
          {repeat&&<>
            <label>Repeat every<input type="number" required min={1} max={365} step={1} value={repeat.every}
              onChange={event=>setRepeat({...repeat,every:Number(event.currentTarget.value)})}/></label>
            <label>Repeat interval<select value={repeat.unit} onChange={event=>setRepeat({...repeat,
              unit:taskRepeatSchema.shape.unit.parse(event.currentTarget.value)})}>
              {taskRepeatSchema.shape.unit.options.map(unit=><option key={unit}>{unit}</option>)}
            </select></label>
            {!(deadline.dueTime&&deadline.dueTimeZone)&&<label>Repeat time zone<input required value={repeat.timeZone}
              onChange={event=>setRepeat({...repeat,timeZone:event.currentTarget.value})}/></label>}
            <small>Completing this task creates the next occurrence. Overdue tasks also repeat when background Task processing is enabled. Missed intervals are skipped.</small>
          </>}
          <label>Assigned to<select name="assigneeId" defaultValue={currentAssignee??''}>
            {(!restrictedEdit||current&&!currentAssignee)&&<option value="">Unassigned</option>}
            {restrictedEdit&&!current&&<option value="">Assign to me</option>}
            {inactiveAssignee&&<option value={currentAssignee}>{current?.assigneeLabel??'Former assignee'} (unavailable)</option>}
            {assignees.map(({id,label})=><option key={id} value={id}>{label}</option>)}
          </select></label>
          {!workspaceId&&<label>Queue <select name="queueId" defaultValue={current?.queueId??(!current&&taskQueueId!==NO_QUEUE?taskQueueId:'')??''}>
            <option value="">No queue</option>
            {taskQueues.map(queue=><option key={queue.id} value={queue.id}>{queue.name}</option>)}
          </select></label>}
          <TaskRecordPicker value={current?currentLink:related??null} workspaceId={workspaceId}/>
          <label className="portable-note-text">Notes<textarea name="notes" defaultValue={current?.data.notes} maxLength={2000}/></label>
        </fieldset>
        {currentLink&&<p><a href={crmLink(currentLink.kind,currentLink.id)}>{currentLink.name}</a></p>}
        {error&&<p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{saving?'Saving…':'Save task'}</button>{' '}
        {current&&<><button type="submit" name="status" value={completed?'Not started':'Completed'} disabled={busy}>
          {completed?'Reopen task':'Mark complete'}
        </button>{' '}</>}
        <button type="button" disabled={busy} onClick={()=>{
          if(initialRecord&&current)router.push(taskLink({status}));
          else if(startNewTask&&related&&!current){
            showEditor(null);
            router.replace(crmLink(related.kind,related.id));
          }
          else showEditor(initialRecord??null);
        }}>{current?'Close task':'Cancel'}</button>
        {current?.contactId&&!completed&&!current.inactiveSequenceTask&&(!workspaceId||grant?.contactOutreach)&&<details>
          <summary>Log outreach and complete task</summary>
          <p>Record the outreach you just made to {current.contactName||'the linked contact'}.</p>
          {current.id===initialRecord?.id&&current.contactId===initialRecord.contactId&&current.data.taskType==='Call'&&initialRecord.dialPhone&&
            <PortableAircall key={current.id+':'+initialRecord.dialPhone} phone={initialRecord.dialPhone}
              saving={busy} logLabel="Log answered call and complete task" onLog={async (call,providerId)=>{
                const form=editorForm.current;
                return form&&form.reportValidity()?saveValues(new FormData(form),{...call,providerId}):false;
              }}/>}
          <label>Outreach channel<select name="outreachKind" defaultValue={current.data.taskType==='To-do'?'':current.data.taskType}>
            <option value="">Choose a channel</option>{taskOutreachKinds.map(kind=><option key={kind}>{kind}</option>)}</select></label>
          <label>What happened?<textarea name="outreachSummary" maxLength={2000} rows={2}/></label>
          <button type="submit" name="logOutreach" value="1" disabled={busy}>Log outreach and complete</button>
        </details>}
      </form>}
      {!readOnly&&current&&policy?.delete!==false&&<PortableRecycleAction key={current.id+':'+current.revision} action="archive"
        kind="tasks" scope={workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined} id={current.id} revision={current.revision} name={current.data.name}
        repeating={Boolean(current.data.repeat&&current.data.dueDate)} disabled={saving} onBusy={setArchiving}
        onDone={(_id,nextId)=>{
          refreshTaskReminders();
          showEditor(null);
          if(initialRecord)router.replace(taskLink({status}));
          else{
            setNotice(nextId?'Task archived. The next occurrence is ready.':'Task archived.');
            setNextTaskId(nextId);
            router.refresh();
          }
        }}/>}
      {readOnly&&current&&<section aria-label="Task details">
        <h2>{current.data.name}</h2>
        <dl>
          <dt>Status</dt><dd>{current.data.status}</dd>
          <dt>Task type</dt><dd>{current.data.taskType}</dd>
          <dt>Priority</dt><dd>{current.data.priority}</dd>
          <dt>Due date</dt><dd>{taskDeadlineLabel(current.data)}{current.data.repeat&&<><br/>{taskRepeatLabel(current.data)}</>}</dd>
          {current.data.dueTime&&<><dt>Task reminder</dt>
            <dd>{reminderChoices.find(choice=>choice.minutes===current.data.reminderMinutes)?.label??'No reminder'}</dd></>}
          <dt>Assigned to</dt><dd>{current.assigneeLabel??'Unassigned'}</dd>
          <dt>Linked record</dt><dd>{currentLink?<a href={crmLink(currentLink.kind,currentLink.id)}>{currentLink.name}</a>:'No linked record'}</dd>
          {current.completedAt&&<><dt>Completed</dt><dd><time dateTime={current.completedAt}>
            {new Date(current.completedAt).toISOString().slice(0,16).replace('T',' ')} UTC</time></dd></>}
          <dt>Notes</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{current.data.notes||'—'}</dd>
        </dl>
        <a href={taskLink({status})}>Back to task list</a>
      </section>}
      <form className="portable-task-search" method="get" action="/" role="search">
        {[...taskParams({status,search:null})].map(([name,value])=><input key={name} type="hidden" name={name} value={value}/>)}
        <label>Search tasks<input key={search??''} type="search" name="search" defaultValue={search}
          maxLength={recordSearchLimit} placeholder="Title or notes"/></label>
        <button type="submit">Search</button>
        {search&&<a href={taskLink({status,search:null})}>Clear search</a>}
      </form>
      <nav aria-label="Task filters">
        <a href={taskLink({taskView:null})} aria-current={!status&&!taskView?'page':undefined}>{standardTaskViews.open}</a>
        <a href={taskLink({taskView:'mine'})} aria-current={taskView==='mine'?'page':undefined}>{standardTaskViews.mine}</a>
        <a href={taskLink({taskView:'unavailable-assignee'})} aria-current={assigneeReview?'page':undefined}>Unavailable assignees</a>
        {portableTaskDateViews.map(item=><a key={item} href={taskLink({taskView:item,taskZone:taskZone??browserZone})}
          aria-current={taskView===item?'page':undefined}>{standardTaskViews[item]}</a>)}
        {portableTaskStatuses.map(item=><a key={item} href={taskLink({status:item,taskView:null})}
          aria-current={status===item?'page':undefined}>{item}</a>)}
      </nav>
      {assigneeReview&&<p>Open tasks assigned to people who can no longer edit tasks in this workspace.</p>}
      {isPortableTaskDateView(taskView)&&<p>Task dates shown for {taskZone??'UTC'}.</p>}
      <div className="portable-task-list-filters">
        <label>Task priority filter <select value={taskPriority??''} onChange={event=>
          router.push(taskLink({status,taskPriority:portableTaskPriorities.find(item=>item===event.target.value)??null}))}>
          <option value="">All priorities</option>
          {portableTaskPriorities.map(item=><option key={item} value={item}>{item}</option>)}
        </select></label>
        <label>Task type filter <select value={taskType??''} onChange={event=>
          router.push(taskLink({status,taskType:portableTaskTypes.find(item=>item===event.target.value)??null}))}>
          <option value="">All task types</option>
          {portableTaskTypes.map(item=><option key={item} value={item}>{item}</option>)}
        </select></label>
        {isPortableTaskDateView(taskView)&&<label>Task assignee filter <select value={taskAssignee??''} onChange={event=>
            router.push(taskLink({taskAssignee:event.target.value==='me'?'me':null}))}>
            <option value="">All assignees</option><option value="me">Assigned to me</option>
          </select></label>}
        {!workspaceId&&<label>Task queue filter <select value={taskQueueId??''} onChange={event=>router.push(taskLink({status,taskQueueId:event.target.value}))}>
            <option value="">All queues</option><option value={NO_QUEUE}>No queue</option>
            {taskQueues.map(queue=><option key={queue.id} value={queue.id}>{queue.name}</option>)}
          </select></label>}
      </div>
      {!workspaceId&&<>
        <PortableTaskQueues queues={taskQueues}/>
        <button type="button" disabled={exporting} onClick={downloadTasks}>{exporting?'Preparing CSV…':'Export CSV'}</button>
        {exportError&&<p role="alert">{exportError}</p>}
      </>}
      <TaskTable key={JSON.stringify([taskLink({status}),editing!==null,records.map(task=>task.id)])}
        records={records} queues={taskQueues} canAssign={!workspaceId&&!editing} busy={busy}
        taskHref={id=>taskLink({status,record:id})} linkedHref={link=>crmLink(link.kind,link.id)}
        onBusy={setAssigning} onAssigned={changed=>{
          setNotice(changed===0?'The selected tasks already have that queue assignment.':changed===1?'Queue updated for 1 task.':'Queue updated for '+changed+' tasks.');
          router.refresh();
        }}/>
      {(paged||next)&&<nav aria-label="Task pages">
        {paged&&<a href={taskLink({status})}>First page</a>}
        {next&&<a href={taskLink({status,after:next})}>Next page</a>}
      </nav>}
    </section>
  </main>;
}
