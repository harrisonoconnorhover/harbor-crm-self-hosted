'use client';

import {useEffect,useState} from 'react';
import type {workspaceHelpTopics} from '../db/postgres/help-center-store';

type TopicPage=Awaited<ReturnType<typeof workspaceHelpTopics>>;

export function PublishedTopicFilter({workspaceId,initialTopic='',onChange}:{
  workspaceId?:string;initialTopic?:string;onChange?:(topic:string)=>void;
}){
  const [topic,setTopic]=useState(initialTopic);
  const [open,setOpen]=useState(false),[after,setAfter]=useState('');
  const [page,setPage]=useState<TopicPage|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const query=new URLSearchParams({articles:'topics',...(workspaceId?{workspaceId}:{}),...(after?{afterTopic:after}:{})});
    async function load(){
      try{
        const response=await fetch('/api/team-inbox?'+query,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error();
        const result:TopicPage=await response.json();
        if(!controller.signal.aborted)setPage(result);
      }catch{if(!controller.signal.aborted)setFailed(true);}
    }
    void load();
    return ()=>controller.abort();
  },[open,after,retry,workspaceId]);
  function reset(){setPage(null);setFailed(false);}
  function select(value:string){setTopic(value);onChange?.(value);}
  return <div>
    {!onChange&&topic&&<input type="hidden" name="topic" value={topic}/>}
    <button type="button" aria-expanded={open} onClick={()=>{reset();setOpen(!open);setAfter('');}}>{topic?'Topic · '+topic:'Filter by topic'}</button>
    {open&&<>
      <label>Published topic<select aria-label="Published topic" value={topic} onChange={e=>select(e.target.value)}>
        <option value="">All topics</option>
        {topic&&!page?.topics.includes(topic)&&<option>{topic}</option>}
        {page?.topics.map(value=><option key={value}>{value}</option>)}
      </select></label>
      {failed?<p role="alert">Could not load topics. <button type="button" onClick={()=>{reset();setRetry(retry+1);}}>Retry</button></p>:
        !page?<p role="status">Loading topics…</p>:!page.topics.length&&<p>No published topics on this page.</p>}
      {after&&<button type="button" onClick={()=>{reset();setAfter('');}}>First topics</button>}
      {page?.next&&<button type="button" onClick={()=>{reset();setAfter(page.next!);}}>More topics</button>}
    </>}
  </div>;
}
