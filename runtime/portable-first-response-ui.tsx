'use client';
import {useRef,useState,type FormEvent} from 'react';
import {responseDeadline,responseWorkingMs,responsePolicyInput,responseChannels,responseLabels,type ResponsePolicy} from '../lib/first-response';
import {workspaceDate} from '../lib/portable-account-defaults';
import {WorkspaceNumber,useWorkspaceDefaults} from './portable-workspace-format';
import {scheduledInstants} from '../lib/email/schedule';
import {slaPriorities} from '../lib/ticket-sla';
import type {PortableTicketRecord} from '../lib/portable-tickets';

const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const time=(mins:number)=>String(Math.floor(mins/60)%24).padStart(2,'0')+':'+String(mins%60).padStart(2,'0');
const minutes=(v:FormDataEntryValue|null)=>{const [h,m]=String(v).split(':').map(Number);return h*60+m;};
const endpoint='/api/ticket-sla?kind=first-response';


type DayHours=NonNullable<ResponsePolicy['calendar']['week'][number]>;
function readHours(form:FormData,key:string):DayHours{
  function readShift(openKey:string,closeKey:string){
    const open=minutes(form.get(openKey+key)),clock=minutes(form.get(closeKey+key));
    const until=clock===0?1440:clock;
    return {open,close:until<open?until+1440:until};
  }
  const first=readShift('open','close');
  if(!form.has('split'+key))return first;
  return {...first,second:readShift('secondOpen','secondClose')};
}
function SupportDay({day,fieldKey,hours,special}:{day:string;fieldKey:string;hours?:DayHours|null;
  special?:{date:string;remove:()=>void}}){
  const [enabled,setEnabled]=useState(Boolean(hours)),[split,setSplit]=useState(Boolean(hours?.second));
  const open=Boolean(special)||enabled;
  return <><tr>
    <td>{special?<label><input type="hidden" name="specialHourKey" value={fieldKey}/>Date<input type="date" aria-label={day} name={'date'+fieldKey} required defaultValue={special.date}/></label>:
      <label><input name={'day'+fieldKey} type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>{day}</label>}
      {open&&<label><input type="checkbox" aria-label={day+' second shift'} name={'split'+fieldKey} checked={split} onChange={e=>setSplit(e.target.checked)}/>
        Second shift</label>}</td>
    <td><input aria-label={day+' opening time'} name={'open'+fieldKey} type="time" disabled={!open} required defaultValue={time(hours?.open??540)}/></td>
    <td><input aria-label={day+' closing time'} name={'close'+fieldKey} type="time" disabled={!open} required defaultValue={time(hours?.close??1020)}/></td>
    {special&&<td><button type="button" onClick={special.remove} aria-label={'Remove '+day}>Remove</button></td>}
  </tr>{open&&split&&<tr>
    <td>{day} · second shift</td>
    <td><input aria-label={day+' second opening time'} name={'secondOpen'+fieldKey} type="time" required defaultValue={hours?.second?time(hours.second.open):''}/></td>
    <td><input aria-label={day+' second closing time'} name={'secondClose'+fieldKey} type="time" required defaultValue={hours?.second?time(hours.second.close):''}/></td>
  </tr>}</>;
}

function SpecialHours({saved,onChange}:{saved:ResponsePolicy['calendar']['specialHours'];onChange:()=>void}){
  const [rows,setRows]=useState(()=>(saved??[]).map((entry,i)=>({key:String(i),...entry})));
  return <fieldset><legend>Special hours</legend>
    <p>Replace the weekly schedule for a single date, including a normally closed day.</p>
    {rows.length>0&&<table><caption>Dates with special hours</caption><thead><tr><th>Date</th><th>From</th><th>Until</th><th>Action</th></tr></thead>
      <tbody>{rows.map((row,i)=><SupportDay key={row.key} fieldKey={'special'+row.key} day={'Special date '+(i+1)} hours={row.hours}
        special={{date:row.date,remove:()=>{onChange();setRows(previous=>previous.filter(entry=>entry.key!==row.key));}}}/>)}</tbody></table>}
    <button type="button" disabled={rows.length>=366} onClick={()=>{onChange();setRows([...rows,{key:crypto.randomUUID(),date:'',hours:{open:540,close:1020}}]);}}>Add special hours</button>
  </fieldset>;
}

function readPolicyDraft(f:FormData,revision:number){
  const week=weekdays.map((_,i)=>f.has('day'+i)?readHours(f,String(i)):null);
  const specialHours=f.getAll('specialHourKey').map(String).map(key=>({date:f.get('date'+key),hours:readHours(f,key)}));
  const targets=Object.fromEntries(slaPriorities.map(p=>[p,f.get(p)?Number(f.get(p)):null]));
  return responsePolicyInput.safeParse({revision,enabled:f.has('enabled'),targets,calendar:{week,
    zone:f.get('zone'),...(specialHours.length?{specialHours}:{}),holidays:String(f.get('holidays')).split(/[\s,]+/).filter(Boolean)}});
}

function sampleInstant(local:string,zone:string,label:string){
  const instants=scheduledInstants(local,zone);
  if(instants.length===0)throw Error(`${label} does not exist in ${zone}. Choose another local time.`);
  if(instants.length>1)throw Error(`${label} occurs twice in ${zone}. Choose a time outside the repeated hour.`);
  return Date.parse(instants[0]);
}

type TargetPreview={message:string}|{due:string;zone:string;workingMinutes?:number;onTime?:boolean};
function previewTarget(policy:ResponsePolicy,sample:FormData):TargetPreview{
  const priority=slaPriorities.find(p=>p===sample.get('priority'));
  if(!priority)throw Error('Choose a ticket priority.');
  if(!policy.enabled)return {message:'Tracking is off. New tickets would have no first-response deadline.'};
  const target=policy.targets[priority];
  if(target===null)return {message:`No first-response target is set for ${priority} tickets.`};
  const {calendar}=policy;
  const start=sampleInstant(String(sample.get('arrival')),calendar.zone,'The opening time');
  const due=responseDeadline(calendar,start,target),result={due,zone:calendar.zone};
  const reply=String(sample.get('reply')??'');
  if(!reply)return result;
  const end=sampleInstant(reply,calendar.zone,'The reply time');
  if(end<start)throw Error('Choose a reply time on or after the ticket opened.');
  if(end-start>2*366*86400000)throw Error('For this preview, choose a reply within two years of opening.');
  return {...result,workingMinutes:responseWorkingMs(calendar,start,end)/60000,onTime:end<=Date.parse(due)};
}
export function ResponseSettings(){
  const [policy,setPolicy]=useState<ResponsePolicy|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const draftForm=useRef<HTMLFormElement>(null);
  const defaults=useWorkspaceDefaults();
  const [preview,setPreview]=useState<TargetPreview|null>(null),[sampleError,setSampleError]=useState('');
  function clearPreview(){setPreview(null);setSampleError('');}
  function simulate(event:FormEvent<HTMLFormElement>){
    event.preventDefault();clearPreview();
    if(!policy||!draftForm.current?.reportValidity())return;
    const draft=readPolicyDraft(new FormData(draftForm.current),policy.revision);
    if(!draft.success){setSampleError(draft.error.issues[0].message);return;}
    try{setPreview(previewTarget(draft.data,new FormData(event.currentTarget)));}
    catch(e){setSampleError((e as Error).message);}
  }
  async function request(input?:ResponsePolicy){
    clearPreview();setBusy(true);setError('');setNotice('');
    try{
      const res=await fetch(endpoint,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{cache:'no-store'});
      const data=await res.json() as ResponsePolicy&{error?:string};
      if(!res.ok)throw Error(data.error??'Could not open response targets.');
      setPolicy(data);if(input)setNotice('First-response targets saved.');
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!policy)return;
    const f=new FormData(event.currentTarget);
    const result=readPolicyDraft(f,policy.revision);
    if(!result.success){setError(result.error.issues[0].message);return;}
    void request(result.data);
  }
  return <details onToggle={e=>{if(e.currentTarget.open&&!policy&&!busy)void request();}}>
    <summary>First-response targets and support hours</summary>
    {error&&<p role="alert">{error} <button type="button" onClick={()=>void request()}>Reload settings</button></p>}
    {notice&&<p role="status">{notice}</p>}
    {policy&&<><form ref={draftForm} key={policy.revision} onChange={clearPreview} onSubmit={save}><fieldset disabled={busy}>
      <label><input type="checkbox" name="enabled" defaultChecked={policy.enabled}/>Track first responses on new tickets</label>
      <p>Targets count working minutes. Leave a priority blank to skip it. Existing tickets keep their original schedule.</p>
      {slaPriorities.map(p=><label key={p}>{p} response target (minutes)<input name={p} type="number" min={1} defaultValue={policy.targets[p]??''}/></label>)}
      <label>Support time zone<input name="zone" required defaultValue={policy.calendar.zone} placeholder="America/New_York"/></label>
      <table><caption>Weekly support hours</caption><thead><tr><th>Open day</th><th>From</th><th>Until</th></tr></thead><tbody>
        {weekdays.map((day,i)=><SupportDay key={day} day={day} fieldKey={String(i)} hours={policy.calendar.week[i]}/>)}
      </tbody></table>
      <p>An earlier closing time ends the shift the next morning. Midnight closes the shift at the end of its starting day.</p>
      <label>Holiday closures (YYYY-MM-DD, one per line)<textarea name="holidays" defaultValue={policy.calendar.holidays.join('\n')}/></label>
      <SpecialHours saved={policy.calendar.specialHours} onChange={clearPreview}/>
      <button>Save first-response targets</button>
    </fieldset></form>
      <details><summary>Preview a ticket deadline</summary>
        <p>Use the support time zone above. The preview uses your unsaved hours and targets.</p>
        <form aria-label="Preview a ticket deadline" onChange={clearPreview} onSubmit={simulate}><fieldset disabled={busy}>
          <label>Sample priority<select name="priority" defaultValue="High">{slaPriorities.map(p=><option key={p}>{p}</option>)}</select></label>
          <label>Ticket opened<input type="datetime-local" name="arrival" required/></label>
          <label>First reply (optional)<input type="datetime-local" name="reply"/></label>
          <button>Preview deadline</button>
        </fieldset></form>
        {sampleError&&<p role="alert">{sampleError}</p>}
        {preview&&<p role="status">{'message' in preview?preview.message:<>
          Reply deadline <time dateTime={preview.due}>{defaults?workspaceDate(preview.due,{...defaults,timeZone:preview.zone}):new Intl.DateTimeFormat(undefined,{timeZone:preview.zone,dateStyle:'medium',timeStyle:'long'}).format(new Date(preview.due))}</time> ({preview.zone})
          {preview.workingMinutes!==undefined&&<> · {preview.onTime?responseLabels.met:responseLabels.late} · <WorkspaceNumber value={preview.workingMinutes}/> working minutes</>}
        </>}</p>}
      </details></>}
  </details>;
}
export function TicketTime({value,day=false}:{value:string;day?:boolean}){
  const settings=useWorkspaceDefaults();
  if(settings)return <time dateTime={value} title={settings.timeZone}>{workspaceDate(value,settings,!day)}</time>;
  const iso=new Date(value).toISOString();
  return <time dateTime={value} title="UTC">{day?iso.slice(0,10):iso.slice(0,16).replace('T',' ')+' UTC'}</time>;
}

export function ResponseDetail({record,readOnly,busy,write,workspaceId}:{workspaceId?:string;record:PortableTicketRecord;readOnly:boolean;busy:boolean;write:(v:unknown)=>Promise<void>}){
  const [error,setError]=useState('');
  const settings=useWorkspaceDefaults();
  const r=record.firstResponse;
  if(!r)return <p>No first-response target was applied when this ticket was created.</p>;
  const zone=settings?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
  const workingMinutes=Math.round((r.workingMs??0)/6000)/10;
  function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();const form=new FormData(e.currentTarget);setError('');
    const local=String(form.get('at')||''),dates=local?scheduledInstants(local,zone):[];
    if(local&&dates.length!==1){setError('Choose an unambiguous response time.');return;}
    void write({action:'first_response',id:record.id,expectedRevision:record.revision,channel:form.get('channel'),summary:form.get('summary'),at:dates[0]});
  }
  return <section aria-label="First response"><h2>First response</h2><p>{responseLabels[r.status]} · {r.targetMinutes} working-minute target</p>
    <p>Reply deadline <TicketTime value={r.dueAt}/></p>
    {r.respondedAt?<p>{r.channel} · <TicketTime value={r.respondedAt}/> · <WorkspaceNumber value={workingMinutes}/> working minutes<br/>{r.summary}
      {r.recordedBy&&<> · Logged by {r.recordedBy}</>}
      {r.inboxConversationId&&r.inboxReplyId&&<> · <a href={'/?'+new URLSearchParams({view:'team-inbox',id:r.inboxConversationId,messageId:r.inboxReplyId,...(workspaceId?{workspaceId}:{})})}>View original reply</a></>}</p>:
      !readOnly&&<details><summary>Log first customer response</summary>
        <form onSubmit={submit}><fieldset disabled={busy}>
          <label>Response channel<select name="channel">{responseChannels.map(c=><option key={c}>{c}</option>)}</select></label>
          <label>Reply time in {zone} (leave blank for now)<input name="at" type="datetime-local"/></label>
          <label>What did you tell the customer?<textarea name="summary" required maxLength={1000}/></label>
          {error&&<p role="alert">{error}</p>}<button>Log completed response</button>
        </fieldset></form></details>}
  </section>;
}
