'use client';

import {useId,useState} from 'react';
import {conditionGroups,selectConditionalPath,workflowPathActions,type PathContact} from '../lib/portable-workflow-paths';
import {ArrowDown,ArrowUp,Trash2} from 'lucide-react';
import {supportTag,ticketTags} from '../lib/team-inbox';
import {standardExtensions} from '../lib/standard-properties';
import {lifecycles,schemas,taskTypes,ticketPriorities} from '../lib/crm';
import {maxPortableConditionGroups,maxPortablePathActions,workflowConditionFields,workflowFieldAvailable,workflowOperatorAvailable,validWorkflowAmount,validWorkflowDate,type PortableConditionalPaths} from '../lib/portable-workflows';

type Path=PortableConditionalPaths['paths'][number];
type Outcome=PortableConditionalPaths['otherwise'];
type Action=Outcome['action'];
type Rule=Path['conditions'][number];
type DraftRule=Rule&{key:string};
type DraftGroup={mode:Path['mode'];conditions:DraftRule[]};
type DraftPath=Omit<Path,'conditions'|'orGroups'>&DraftGroup&{orGroups?:DraftGroup[]};
export type ConditionalDraft={paths:DraftPath[];otherwise:Outcome};

const fields={name:'Contact name',email:'Email',title:'Job title',city:'City',lifecycle:'Lifecycle stage',
  dealName:'Deal name',dealAmount:'Deal amount',dealCloseDate:'Deal close date',ticketName:'Ticket name',ticketPriority:'Ticket priority',ticketSource:'Ticket source',ticketCategory:'Ticket category',ticketTags:'Ticket tags'};
const operators={has_tag:'has tag',lacks_tag:'does not have tag',eq:'is equal to',neq:'is not equal to',contains:'contains',not_contains:'does not contain',gte:'is at least',lte:'is at most',known:'is known',unknown:'is unknown'};
function operatorLabel(field:Rule['field'],operator:Rule['operator']){
  if(field==='dealCloseDate'&&operator==='gte')return 'is on or after';
  if(field==='dealCloseDate'&&operator==='lte')return 'is on or before';
  return operators[operator];
}
const newRule=():DraftRule=>({field:'lifecycle',operator:'eq',value:'Customer',key:crypto.randomUUID()});
const newNote=():Action=>({kind:'note',body:'',delayMinutes:0});
const newPath=():DraftPath=>({id:crypto.randomUUID(),name:'',mode:'all',conditions:[newRule()],action:newNote()});

// New IDs are allocated by the user's add/select actions. Persisted IDs render identically on the server and client.
export function newConditionalDraft():ConditionalDraft{
  return {paths:[newPath()],otherwise:{id:crypto.randomUUID(),name:'Otherwise',action:newNote()}};
}
export function savedConditionalDraft(saved:PortableConditionalPaths):ConditionalDraft{
  return {paths:saved.paths.map(path=>{
    const [first,...others]=conditionGroups(path).map((group,g)=>({mode:group.mode,
      conditions:group.conditions.map((rule,i)=>({...rule,key:path.id+'-'+g+'-'+i}))}));
    return {...path,...first,orGroups:others};
  }),otherwise:saved.otherwise};
}
function move<T>(items:T[],index:number,delta:number){
  const result=[...items];
  result.splice(index+delta,0,...result.splice(index,1));
  return result;
}

function ReorderButtons({noun,index,count,onMove,onRemove}:{noun:'path'|'condition'|'action';index:number;count:number;onMove:(by:number)=>void;onRemove:()=>void}){
  if(count===1&&noun!=='action')return null;
  return <div className="portable-path-tools">
    <button type="button" title={'Move '+noun+' up'} aria-label={'Move '+noun+' up'} disabled={index===0} onClick={()=>onMove(-1)}><ArrowUp size={16}/></button>
    <button type="button" title={'Move '+noun+' down'} aria-label={'Move '+noun+' down'} disabled={index===count-1} onClick={()=>onMove(1)}><ArrowDown size={16}/></button>
    <button type="button" title={'Remove '+noun} aria-label={'Remove '+noun} onClick={onRemove}><Trash2 size={16}/></button>
  </div>;
}

function PathAction({action,change,destinations,first}:{action:Action;change:(action:Action)=>void;destinations:string[];first:boolean}){
  const hintId=useId();
  const {delayMinutes,waitForLifecycle}=action;
  const destination=action.kind==='webhook'&&destinations.includes(action.destination)?action.destination:'';
  function selectAction(kind:string){
    const timing={delayMinutes,waitForLifecycle};
    if(kind==='webhook')change({kind,destination:'',...timing});
    else if(kind==='task')change({kind,task:{name:'',taskType:'To-do',priority:'Medium'},...timing});
    else change({kind:'note',body:'',...timing});
  }
  return <div className="portable-path-action">
    <label className="portable-path-wide">Then<select value={action.kind} onChange={e=>selectAction(e.target.value)}>
      <option value="note">Create a Note</option><option value="task">Create a Task</option><option value="webhook">Send a webhook</option>
    </select></label>
    <label>Wait for lifecycle stage<select value={waitForLifecycle??''} aria-describedby={waitForLifecycle?hintId:undefined}
      onChange={e=>change({...action,waitForLifecycle:lifecycles.find(stage=>stage===e.target.value)})}>
      <option value="">No wait</option>
      {lifecycles.map(stage=><option key={stage}>{stage}</option>)}
    </select></label>
    <label>{waitForLifecycle?'Delay in minutes after stage entry':'Delay in minutes'}<input type="number" min={0} max={43200} step={1} required value={delayMinutes}
      onChange={e=>change({...action,delayMinutes:Number(e.target.value)})}/></label>
    {waitForLifecycle&&<p id={hintId} className="portable-path-wide">The contact must enter {waitForLifecycle} {first?'after enrollment':'after the preceding action succeeds'}. The delay starts when they enter that stage.</p>}
    {action.kind==='note'?<label className="portable-path-wide">Note text<textarea required rows={2} maxLength={2000} value={action.body}
      onChange={e=>change({...action,body:e.target.value})}/></label>:action.kind==='webhook'?<>
      <label className="portable-path-wide">Destination<select required value={destination}
        onChange={e=>change({...action,destination:e.target.value})}>
        <option value="">Choose a destination</option>
        {destinations.map(name=><option key={name} value={name}>{name}</option>)}
      </select></label>
      {action.destination&&!destination&&<p className="portable-path-wide">The saved destination “{action.destination}” is unavailable. Choose a configured destination or change the action.</p>}
      {!destinations.length&&<p className="portable-path-wide">Ask your Harbor operator to configure a webhook destination for this workspace, then refresh this page.</p>}
    </>:<>
      <label className="portable-path-wide">Task name<input required maxLength={160} value={action.task.name}
        onChange={e=>change({...action,task:{...action.task,name:e.target.value}})}/></label>
      <label>Task type<select value={action.task.taskType} onChange={e=>change({...action,task:{...action.task,taskType:e.target.value as typeof action.task.taskType}})}>
        {taskTypes.map(type=><option key={type}>{type}</option>)}</select></label>
      <label>Priority<select value={action.task.priority} onChange={e=>change({...action,task:{...action.task,priority:e.target.value as typeof action.task.priority}})}>
        {schemas.tasks.shape.priority.removeDefault().options.map(priority=><option key={priority}>{priority}</option>)}</select></label>
    </>}
  </div>;
}

const actionLabels={note:'Create a Note',task:'Create a Task',webhook:'Send a webhook'};
const actionDetail=(action:Action)=>action.kind==='note'?action.body:action.kind==='task'?action.task.name:action.destination;

function actionEditorId(editorId:string,id:string){return editorId+'-action-'+id;}
function focusAction(editorId:string,id:string){
  document.getElementById(actionEditorId(editorId,id))?.querySelector('select')?.focus();
}

function PathActions({outcome,editorId,change,destinations}:{outcome:Outcome;editorId:string;
  change:(updates:Partial<Pick<Outcome,'action'|'then'>>)=>void;destinations:string[]}){
  const extras=outcome.then??[];
  function setExtras(next:NonNullable<Outcome['then']>){change({then:next.length?next:undefined});}
  function add(){
    const id=crypto.randomUUID();
    setExtras([...extras,{id,action:newNote()}]);
    requestAnimationFrame(()=>focusAction(editorId,id));
  }
  function remove(index:number){
    setExtras(extras.filter((_,i)=>i!==index));
    const next=extras[index+1]??extras[index-1];
    requestAnimationFrame(()=>focusAction(editorId,next?.id??outcome.id));
  }
  return <>
    {workflowPathActions(outcome).map(({id,action},i)=><div key={id} role="group" aria-label={'Action '+(i+1)} id={actionEditorId(editorId,id)}>
      {extras.length>0&&<div className="portable-ordered-action-heading"><strong>{i===0?'First action':'Action '+(i+1)}</strong>
        {i>0&&<ReorderButtons noun="action" index={i-1} count={extras.length}
          onMove={delta=>setExtras(move(extras,i-1,delta))} onRemove={()=>remove(i-1)}/>}
      </div>}
      <PathAction first={i===0} destinations={destinations} action={action}
        change={next=>i===0?change({action:next}):setExtras(extras.map(step=>step.id===id?{...step,action:next}:step))}/>
    </div>)}
    {extras.length<maxPortablePathActions-1&&<button type="button" className="portable-branch-add" onClick={add}>Add action</button>}
  </>;
}

function fieldOptions(field:Rule['field']):readonly string[]|undefined{
  if(field==='lifecycle')return lifecycles;
  if(field==='ticketPriority')return ticketPriorities;
  if(field==='ticketSource'||field==='ticketCategory')return standardExtensions.tickets.find(property=>property.id===field)?.options;
}
const isEqualityComparison=(operator:Rule['operator'])=>operator==='eq'||operator==='neq';

function Condition({rule,trigger,change}:{rule:DraftRule;trigger:string;change:(rule:DraftRule)=>void}){
  const options=fieldOptions(rule.field);
  const available=workflowFieldAvailable(rule.field,trigger);
  const needsValue=rule.operator!=='known'&&rule.operator!=='unknown';
  return <>
    <label>Property<select required value={available?rule.field:''} onChange={e=>{
      const field=e.target.value as Rule['field'];
      const operator=workflowOperatorAvailable(field,rule.operator)?rule.operator:field==='ticketTags'?'has_tag':'eq';
      change({...rule,field,operator,
        value:isEqualityComparison(operator)?(field==='lifecycle'?'Customer':fieldOptions(field)?.[0]??''):''});
    }}>{!available&&<option value="" disabled>{fields[rule.field]} requires a different trigger</option>}
      {workflowConditionFields.filter(field=>workflowFieldAvailable(field,trigger)).map(field=><option key={field} value={field}>{fields[field]}</option>)}</select></label>
    <label>Operator<select value={rule.operator} onChange={e=>{
      const operator=e.target.value as Rule['operator'];
      const value=operator==='unknown'||operator==='known'?'':options&&isEqualityComparison(operator)?(options.find(option=>option===rule.value)??(rule.field==='lifecycle'?'Customer':options[0])):rule.value;
      change({...rule,operator,value});
    }}>{(Object.keys(operators) as Rule['operator'][]).filter(op=>workflowOperatorAvailable(rule.field,op)).map(op=>
      <option key={op} value={op}>{operatorLabel(rule.field,op)}</option>)}</select></label>
    {needsValue&&(options&&isEqualityComparison(rule.operator)&&options.includes(rule.value)?<label>Value<select value={rule.value} onChange={e=>change({...rule,value:e.target.value})}>
      {options.map(option=><option key={option}>{option}</option>)}</select></label>:<label>Value<input required maxLength={rule.field==='ticketTags'?40:240} {...(rule.field==='dealAmount'?{type:'number',min:0,max:1e12,step:'any'}:rule.field==='dealCloseDate'?{type:'date'}:{})}
      value={rule.value} onChange={e=>change({...rule,value:e.target.value})}/></label>)}
  </>;
}

function WorkflowMap({draft,trigger,triggerLabel,editorId}:{draft:ConditionalDraft;trigger:string;triggerLabel:string;editorId:string}){
  const [testing,setTesting]=useState(false);
  const [sample,setSample]=useState<Omit<PathContact,'ticketTags'>>({});
  const [sampleTagText,setSampleTagText]=useState('');
  const rules=draft.paths.flatMap(path=>conditionGroups(path).flatMap(group=>group.conditions));
  const fieldsUsed=[...new Set(rules.map(rule=>rule.field))];
  const ready=rules.every(rule=>workflowFieldAvailable(rule.field,trigger)&&(rule.operator==='known'||rule.operator==='unknown'||
    (rule.field==='dealAmount'?validWorkflowAmount(rule.value):rule.field==='dealCloseDate'?validWorkflowDate(rule.value):rule.field==='ticketTags'?supportTag.safeParse(rule.value).success:rule.value.trim().length>0)));
  const tags=ticketTags.safeParse(fieldsUsed.includes('ticketTags')?sampleTagText.split('\n').map(tag=>tag.trim()).filter(Boolean):[]);
  const winner=testing&&ready&&tags.success?selectConditionalPath(draft,{...sample,ticketTags:tags.data}):undefined;
  const mapId=useId();
  function edit(id:string,target:'path'|'action'){
    if(target==='action')focusAction(editorId,id);
    else document.getElementById(editorId+id)?.querySelector('input')?.focus();
  }
  return <section className="portable-workflow-map" aria-label="Workflow map">
    <header><h3>Workflow map</h3><button type="button" aria-expanded={testing} aria-controls={mapId}
      onClick={()=>setTesting(!testing)}>{testing?'Close test':'Test paths'}</button></header>
    <p className="portable-map-trigger">{triggerLabel}</p>
    <ol className="portable-map-paths">
      {[...draft.paths,draft.otherwise].map((path,i)=>{
        const branch=i<draft.paths.length?draft.paths[i]:undefined;
        const name=path.name.trim()||(branch?'Unnamed path':'Otherwise');
        const steps=workflowPathActions(path);
        const prefix=branch?(i===0?'If':'Else if'):'Otherwise';
        return <li key={path.id} data-match={winner?.id===path.id||undefined}>
          <button type="button" className="portable-map-rule" aria-label={'Edit '+name+' path'} aria-controls={editorId+path.id}
            aria-describedby={branch?mapId+path.id+'-rules':undefined} onClick={()=>edit(path.id,'path')}>
            <strong>{prefix}{name!==prefix&&' · '+name}</strong>
            {branch&&<span id={mapId+path.id+'-rules'}>{conditionGroups(branch).map(({conditions,mode})=>{
              const label=conditions.map(rule=>[fields[rule.field],operatorLabel(rule.field,rule.operator),rule.value].filter(Boolean).join(' ')).join(mode==='all'?' AND ':' OR ');
              return branch.orGroups?.length&&conditions.length>1?'('+label+')':label;
            }).join(' OR ')}</span>}
          </button>
          <div className="portable-map-actions">{steps.map(({id,action},index)=>
            <button type="button" key={id} className="portable-map-result" aria-label={'Edit '+name+' action'+(steps.length>1?' '+(index+1):'')}
              aria-controls={actionEditorId(editorId,id)} aria-describedby={mapId+id+'-action'} onClick={()=>edit(id,'action')}>
              {action.waitForLifecycle&&<span>Wait for {action.waitForLifecycle}</span>}
              {action.delayMinutes>0&&<span>Delay {action.delayMinutes} min</span>}
              <strong id={mapId+id+'-action'}>{steps.length>1&&(index+1)+'. '}{actionLabels[action.kind]}</strong>
              {actionDetail(action)&&<span className="portable-map-detail">{actionDetail(action)}</span>}
            </button>)}</div>
        </li>;
      })}
    </ol>
    <div id={mapId} hidden={!testing}>
      {testing&&<div className="portable-path-test" onChange={e=>e.stopPropagation()} onKeyDown={e=>{
        if(e.key==='Enter'&&e.target instanceof HTMLInputElement)e.preventDefault();
      }}>
        <p>Try sample property values. This check runs in your browser.</p>
        <div>{fieldsUsed.map(field=><label key={field}><span id={mapId+'-sample-'+field}>Sample {fields[field].toLowerCase()}</span>
          {field==='ticketTags'?<><textarea aria-labelledby={mapId+'-sample-'+field} aria-describedby={mapId+'-tag-hint'} rows={2}
            value={sampleTagText} onChange={e=>setSampleTagText(e.target.value)}/><small id={mapId+'-tag-hint'}>Enter one tag per line.</small></>:fieldOptions(field)?<select aria-labelledby={mapId+'-sample-'+field} value={sample[field]??''} onChange={e=>setSample({...sample,[field]:e.target.value})}>
            <option value="">Unknown</option>{fieldOptions(field)?.map(option=><option key={option}>{option}</option>)}</select>:
            <input type={field==='dealCloseDate'?'date':'text'} maxLength={240} inputMode={field==='dealAmount'?'decimal':undefined} value={sample[field]??''} onChange={e=>setSample({...sample,[field]:e.target.value})}/>}
        </label>)}</div>
        <output aria-live="polite">{!tags.success?'Use up to ten distinct sample tags of 40 characters each.':winner?'Selected path: '+(winner.name.trim()||'Unnamed path'):'Choose available properties and enter their comparison values to test these paths.'}</output>
        {winner?.then&&<ol aria-label="Selected actions">{workflowPathActions(winner).map(({id,action})=>
          <li key={id}>{actionLabels[action.kind]}{actionDetail(action)&&' · '+actionDetail(action)}</li>)}</ol>}
      </div>}
    </div>
  </section>;
}

function ConditionGroup({group,trigger,update}:{group:DraftGroup;trigger:string;update:(updates:Partial<DraftGroup>)=>void}){
  return <>
    <label className="portable-path-match">Match<select value={group.mode} onChange={e=>update({mode:e.target.value as Path['mode']})}>
      <option value="all">All conditions</option><option value="any">Any condition</option>
    </select></label>
    {group.conditions.map((rule,i)=><div role="group" aria-label={'Condition '+(i+1)} className="portable-condition-row" key={rule.key}>
      <Condition trigger={trigger} rule={rule} change={updated=>update({conditions:group.conditions.map(row=>row.key===rule.key?updated:row)})}/>
      <ReorderButtons noun="condition" index={i} count={group.conditions.length}
        onMove={delta=>update({conditions:move(group.conditions,i,delta)})}
        onRemove={()=>update({conditions:group.conditions.filter(row=>row.key!==rule.key)})}/>
    </div>)}
    {group.conditions.length<4&&<button type="button" className="portable-branch-add" onClick={()=>update({conditions:[...group.conditions,newRule()]})}>Add condition</button>}
  </>;
}

export function ConditionalPathEditor({draft,change,contactLabel,trigger,triggerLabel,destinations}:{trigger:string;triggerLabel:string;draft:ConditionalDraft;change:(draft:ConditionalDraft)=>void;contactLabel:string;destinations:string[]}){
  const {paths,otherwise}=draft;
  const editorId=useId();
  function updatePath(id:string,updates:Partial<DraftPath>){
    change({...draft,paths:paths.map(path=>path.id===id?{...path,...updates}:path)});
  }
  const payload={paths:paths.map(path=>{
    const [first,...others]=conditionGroups(path).map(group=>({mode:group.mode,conditions:group.conditions.map(({field,operator,value})=>({field,operator,value}))}));
    return {...path,...first,orGroups:others.length?others:undefined};
  }),otherwise};
  return <section className="portable-conditional" aria-label="Conditional paths">
    <input type="hidden" name="conditionalPlan" value={JSON.stringify(payload)}/>
    <p>At enrollment, Harbor checks {trigger==='deal_stage'?'the deal and ':trigger==='ticket_status'?'the ticket and ':''}{contactLabel} against these paths in order and runs the first match.</p>
    {([...paths,otherwise].some(path=>workflowPathActions(path).some(step=>step.action.kind==='webhook')))&&
      <p>Turn this workflow Off before editing its webhooks. Harbor skips queued webhooks when you turn it Off, including those waiting for a lifecycle stage. They stay skipped when you turn it on again. A delivery already in progress may still arrive.</p>}
    <WorkflowMap trigger={trigger} draft={draft} triggerLabel={triggerLabel} editorId={editorId}/>
    <div className="portable-branch-flow">
      {paths.map((path,p)=><fieldset className="portable-path-card" key={path.id} id={editorId+path.id}>
        <legend>{p===0?'If':'Else if'}</legend>
        <div className="portable-path-heading">
          <label>Path name<input required maxLength={80} value={path.name} onChange={e=>updatePath(path.id,{name:e.target.value})}/></label>
          <ReorderButtons noun="path" index={p} count={paths.length}
            onMove={delta=>change({...draft,paths:move(paths,p,delta)})} onRemove={()=>change({...draft,paths:paths.filter(row=>row.id!==path.id)})}/>
        </div>
        <ConditionGroup trigger={trigger} group={path} update={updates=>updatePath(path.id,updates)}/>
        {(path.orGroups??[]).map((group,g)=><fieldset key={g} className="portable-alternative-group">
          <legend>OR group {g+2}</legend>
          <ConditionGroup trigger={trigger} group={group} update={updates=>updatePath(path.id,{orGroups:path.orGroups?.map((item,i)=>i===g?{...item,...updates}:item)})}/>
          <button type="button" onClick={()=>updatePath(path.id,{orGroups:path.orGroups?.filter((_,i)=>i!==g)})}>Remove group</button>
        </fieldset>)}
        {(path.orGroups?.length??0)<maxPortableConditionGroups-1&&<button type="button" className="portable-branch-add"
          onClick={()=>updatePath(path.id,{orGroups:[...(path.orGroups??[]),{mode:'all',conditions:[newRule()]}]})}>Add OR group</button>}
        <PathActions destinations={destinations} editorId={editorId} outcome={path} change={updates=>updatePath(path.id,updates)}/>
      </fieldset>)}
      {paths.length<5&&<button type="button" className="portable-branch-add" onClick={()=>change({...draft,paths:[...paths,newPath()]})}>Add path</button>}
      <fieldset className="portable-path-card" id={editorId+otherwise.id}><legend>Otherwise</legend>
        <label>Path name<input required maxLength={80} value={otherwise.name} onChange={e=>change({...draft,otherwise:{...otherwise,name:e.target.value}})}/></label>
        <PathActions destinations={destinations} editorId={editorId} outcome={otherwise} change={updates=>change({...draft,otherwise:{...otherwise,...updates}})}/>
      </fieldset>
    </div>
  </section>;
}
