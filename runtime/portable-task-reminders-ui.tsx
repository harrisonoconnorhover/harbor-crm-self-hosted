'use client';

import {Bell,X} from 'lucide-react';
import {useEffect,useId,useRef,useState} from 'react';
import type {TaskReminder,TaskReminders} from '../lib/portable-task-reminders';
import './portable-task-reminders.css';

const refreshEvent='harbor:task-reminders-changed';
export const refreshTaskReminders=()=>window.dispatchEvent(new Event(refreshEvent));
const reminderKey=(item:TaskReminder)=>item.id+'@'+item.remindAt;
function dueLabel(item:TaskReminder){
  return new Date(item.dueAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}

export function PortableTaskReminders({workspaceId}:{workspaceId?:string}){
  const endpoint='/api/task-reminders'+(workspaceId?'?'+new URLSearchParams({workspaceId}):'');
  const [inbox,setInbox]=useState<TaskReminders|null>(null);
  const [open,setOpen]=useState(false),[hiddenNotice,setHiddenNotice]=useState('');
  const [readError,setReadError]=useState(''),[dismissError,setDismissError]=useState('');
  const [dismissing,setDismissing]=useState(''),[allowed,setAllowed]=useState(true);
  const surface=useRef<HTMLDivElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const panelId=useId();
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>;
    let current:AbortController|undefined;
    async function refresh(){
      clearTimeout(timer);
      current?.abort();
      if(document.hidden){setInbox(null);return;}
      const request=new AbortController();
      current=request;
      const started=performance.now();
      let delay:number|undefined=60_000;
      try{
        const response=await fetch(endpoint,{cache:'no-store',signal:request.signal});
        if(request.signal.aborted)return;
        if(response.status===401||response.status===403){
          delay=undefined;setAllowed(false);setInbox(null);setOpen(false);
          return;
        }
        if(!response.ok)throw Error();
        const result=await response.json() as TaskReminders;
        if(request.signal.aborted)return;
        setAllowed(true);setReadError('');setInbox(result);
        if(result.nextAt)delay=Math.min(delay,Math.max(250,Date.parse(result.nextAt)-Date.parse(result.serverNow)-(performance.now()-started)));
      }catch{
        if(request.signal.aborted)return;
        setInbox(null);setReadError('Could not load your task reminders.');
      }finally{
        if(!request.signal.aborted&&delay!==undefined)timer=setTimeout(refresh,delay);
      }
    }
    void refresh();
    window.addEventListener(refreshEvent,refresh);
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
    return ()=>{
      current?.abort();clearTimeout(timer);
      window.removeEventListener(refreshEvent,refresh);
      window.removeEventListener('focus',refresh);
      document.removeEventListener('visibilitychange',refresh);
    };
  },[endpoint]);
  useEffect(()=>{
    if(!open)return;
    const closeOutside=(event:PointerEvent)=>{
      if(event.target instanceof Node&&!surface.current?.contains(event.target))setOpen(false);
    };
    document.addEventListener('pointerdown',closeOutside);
    return ()=>document.removeEventListener('pointerdown',closeOutside);
  },[open]);

  function taskHref(id:string){
    const params=new URLSearchParams({kind:'tasks',record:id});
    if(workspaceId)params.set('workspaceId',workspaceId);
    return '/?'+params;
  }
  async function dismiss(item:TaskReminder){
    setDismissing(item.id);setDismissError('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({id:item.id,expectedRevision:item.revision})});
      if(!response.ok&&response.status!==404)throw Error();
      setInbox(previous=>previous&&({...previous,items:previous.items.filter(row=>row.id!==item.id)}));
    }catch{
      setOpen(true);setDismissError('Could not confirm this dismissal. Check the list and try again.');
    }finally{
      setDismissing('');refreshTaskReminders();
    }
  }

  if(!allowed)return null;
  const latest=inbox?.items[0],count=inbox?.items.length??0;
  const notice=latest&&!open&&hiddenNotice!==reminderKey(latest)?latest:null;
  return <div className="portable-reminder-control" ref={surface}
    onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);toggle.current?.focus();}}}>
    <button ref={toggle} type="button" className="portable-reminder-toggle" aria-label="Task reminders" title="Task reminders"
      aria-controls={panelId} aria-expanded={open} onClick={()=>{
        if(latest)setHiddenNotice(reminderKey(latest));
        setOpen(!open);
        if(!open)refreshTaskReminders();
      }}>
      <Bell size={17} aria-hidden="true"/>{count>0&&<span>{count}{inbox?.more?'+':''}</span>}
    </button>
    {open&&<section id={panelId} className="portable-reminder-panel" aria-label="Task reminders">
      <h2>Task reminders</h2>
      {readError?<p role="alert">{readError} <button type="button" onClick={refreshTaskReminders}>Retry</button></p>:
        !inbox?<p role="status">Checking reminders…</p>:count===0?<p>No task reminders due in this workspace.</p>:
        <ul>{inbox.items.map(item=><li key={item.id}>
          <div><a href={taskHref(item.id)}>{item.name}</a><small>Due <time dateTime={item.dueAt}>{dueLabel(item)}</time></small></div>
          <button type="button" aria-label={'Dismiss reminder for '+item.name} disabled={!!dismissing}
            onClick={()=>void dismiss(item)}>Dismiss</button>
        </li>)}</ul>}
      {inbox?.more&&<p>Showing the five most recent. Dismiss one to see earlier reminders.</p>}
      {dismissError&&<p role="alert">{dismissError}</p>}
    </section>}
    {notice&&<aside className="portable-reminder-toast" aria-label="Task reminder">
      <div role="status"><strong>Task reminder</strong><a href={taskHref(notice.id)}>{notice.name}</a>
        <small>Due <time dateTime={notice.dueAt}>{dueLabel(notice)}</time></small></div>
      <button type="button" className="portable-reminder-hide" aria-label="Hide reminder notice"
        onClick={()=>setHiddenNotice(reminderKey(notice))}><X size={16} aria-hidden="true"/></button>
      <button type="button" className="portable-reminder-dismiss" disabled={!!dismissing} onClick={()=>void dismiss(notice)}>Dismiss reminder</button>
    </aside>}
  </div>;
}
