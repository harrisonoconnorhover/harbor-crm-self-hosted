'use client';

import {useEffect,useState} from 'react';
import type {PortableTaskCompletionPage} from '../lib/portable-tasks';

export function PortableTaskHistory({contactId,workspaceId}:{contactId:string;workspaceId?:string}){
  const [page,setPage]=useState<PortableTaskCompletionPage>();
  const [cursor,setCursor]=useState<PortableTaskCompletionPage['next']>(null);
  const [failed,setFailed]=useState(false);
  const [retry,setRetry]=useState(0);
  const query=new URLSearchParams({kind:'tasks',completionHistoryFor:contactId});
  if(workspaceId)query.set('workspaceId',workspaceId);
  if(cursor){
    query.set('afterAt',cursor.at);
    query.set('afterId',cursor.id);
    query.set('afterRevision',String(cursor.revision));
  }
  const endpoint='/api/crm?'+query;

  useEffect(()=>{
    const controller=new AbortController();
    fetch(endpoint,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as PortableTaskCompletionPage;
      if(!controller.signal.aborted){setPage(result);setFailed(false);}
    }).catch(()=>{if(!controller.signal.aborted){setPage(undefined);setFailed(true);}});
    return ()=>controller.abort();
  },[endpoint,retry]);

  function open(next:PortableTaskCompletionPage['next']){
    setPage(undefined);
    setFailed(false);
    setCursor(next);
  }

  return <section aria-label="Task completion history">
    <h2>Task completion history</h2>
    {failed?<p role="alert">Could not load task history. <button type="button" onClick={()=>setRetry(value=>value+1)}>Retry</button></p>:
      !page?<p>Loading task history…</p>:page.items.length===0?<p>No task completions on this page.</p>:
      <ul>{page.items.map(item=>{
        const link=new URLSearchParams({kind:'tasks',record:item.id});
        if(workspaceId)link.set('workspaceId',workspaceId);
        return <li key={item.id+':'+item.revision}>
          <a href={'/?'+link}>{item.name}</a> · Completed{item.actorName?' by '+item.actorName:''} ·{' '}
          <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time>
        </li>;
      })}</ul>}
    {cursor&&<button type="button" onClick={()=>open(null)}>Newest completions</button>}{' '}
    {page?.next&&<button type="button" onClick={()=>open(page.next)}>Older completions</button>}
  </section>;
}
