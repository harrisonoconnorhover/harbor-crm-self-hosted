'use client';

// Dashboard record links use a full document navigation and recheck workspace access.
/* eslint-disable @next/next/no-html-link-for-pages */
import {useEffect,useState} from 'react';
import type {DealsWithoutFollowUp} from '../db/postgres/deal-follow-up-store';
import {portableRecordPath} from '../lib/portable-record-path';
import {taskLinkTarget,type PortableTaskRecord} from '../lib/portable-tasks';

type OverduePage={records:PortableTaskRecord[];next:string|null};
type OverdueResult={page:OverduePage;zone:string}|{error:string;accessLost:boolean};
const countLabel=(shown:number,more:boolean)=>more?`${shown} shown · more available`:String(shown);

function dueLabel(task:PortableTaskRecord,zone:string){
  if(task.data.dueAt)return new Intl.DateTimeFormat(undefined,{
    dateStyle:'medium',timeStyle:'short',timeZone:zone,
  }).format(new Date(task.data.dueAt));
  // Date-only tasks keep their calendar day in the viewer's time zone.
  if(task.data.dueDate)return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeZone:'UTC'})
    .format(new Date(task.data.dueDate+'T12:00:00Z'));
}

export function PortableFollowUpPanel({workspaceId,deals}:{workspaceId?:string;deals:DealsWithoutFollowUp}){
  const [overdue,setOverdue]=useState<OverdueResult>();
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const request=new AbortController();
    async function load(){
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
      const query=new URLSearchParams({kind:'tasks',taskView:'overdue',taskZone:zone,limit:'5'});
      if(workspaceId)query.set('workspaceId',workspaceId);
      try{
        const response=await fetch('/api/crm?'+query,{cache:'no-store',signal:request.signal});
        if(!response.ok){
          const accessLost=[401,403,404].includes(response.status);
          if(!request.signal.aborted)setOverdue({error:accessLost?'This workspace is no longer available.':'Could not load overdue tasks.',accessLost});
          return;
        }
        const page=await response.json() as OverduePage;
        if(!request.signal.aborted)setOverdue({page,zone});
      }catch{
        if(!request.signal.aborted)setOverdue({error:'Could not load overdue tasks.',accessLost:false});
      }
    }
    void load();
    return ()=>request.abort();
  },[workspaceId,attempt]);
  const loaded=overdue&&'page' in overdue?overdue:undefined;
  const list=loaded?new URLSearchParams({kind:'tasks',taskView:'overdue',taskZone:loaded.zone}):undefined;
  if(list&&workspaceId)list.set('workspaceId',workspaceId);
  return <section className="portable-follow-up" aria-labelledby="portable-follow-up-title">
    <h2 id="portable-follow-up-title">Team follow-up</h2>
    {overdue&&'error' in overdue&&overdue.accessLost?<p role="alert">{overdue.error} <a href="/?view=workspaces">Open Workspaces</a></p>:
      <div className="portable-follow-up-grid">
        <article>
          <header><h3>Overdue tasks</h3>{loaded&&<span>{countLabel(loaded.page.records.length,!!loaded.page.next)}</span>}</header>
          {!overdue?<p role="status">Loading overdue tasks…</p>:'error' in overdue?<p role="alert">{overdue.error}{' '}
            <button type="button" onClick={()=>{setOverdue(undefined);setAttempt(n=>n+1);}}>Retry</button></p>:
            overdue.page.records.length?<ul>{overdue.page.records.map(task=>{
              const linked=taskLinkTarget(task),linkedName=task.contactName??task.companyName??task.dealName;
              return <li key={task.id}>
                <a href={portableRecordPath('tasks',task.id,workspaceId)}>{task.data.name}</a>
                <small>{task.assigneeLabel??'Unassigned'} · Due {dueLabel(task,overdue.zone)}
                  {linked&&linkedName&&<> · <a href={portableRecordPath(linked.kind,linked.id,workspaceId)}>{linkedName}</a></>}</small>
              </li>;
            })}</ul>:<p>No overdue tasks.</p>}
          {list&&<a className="portable-follow-up-all" href={'/?'+list}>View all overdue tasks</a>}
        </article>
        <article>
          <header><h3>Deals without a next step</h3><span>{countLabel(deals.items.length,deals.hasMore)}</span></header>
          <p>Open deals with no written next step or open task, oldest first.</p>
          {deals.items.length?<ul>{deals.items.map(deal=><li key={deal.id}>
            <a href={portableRecordPath('deals',deal.id,workspaceId)}>{deal.name}</a>
            <small>{deal.stage} · Created <time dateTime={deal.createdAt}>{new Date(deal.createdAt).toISOString().slice(0,10)}</time></small>
          </li>)}</ul>:<p>Every open deal has a next step, or the pipeline is empty.</p>}
        </article>
      </div>}
  </section>;
}
