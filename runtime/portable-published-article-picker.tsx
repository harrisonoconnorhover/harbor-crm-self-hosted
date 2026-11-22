'use client';
import {useEffect,useState} from 'react';
import {PublishedTopicFilter} from './portable-published-topic-filter';
import type {workspaceHelpArticles} from '../db/postgres/help-center-store';

import './portable-published-article-picker.css';

type Results=Awaited<ReturnType<typeof workspaceHelpArticles>>;
export function PublishedArticlePicker({workspaceId,action,onSelect}:{
  workspaceId?:string;action:'Insert'|'Attach';onSelect:(item:Results['items'][number])=>void;
}){
  const [open,setOpen]=useState(false),[term,setTerm]=useState(''),[after,setAfter]=useState('');
  const [topic,setTopic]=useState('');
  const [result,setResult]=useState<Results|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      const params=new URLSearchParams({articles:'1',...(workspaceId?{workspaceId}:{}),...(topic?{topic}:{}),...(term.trim()?{q:term.trim()}:{}),...(after?{after}:{})});
      try{
        const response=await fetch('/api/team-inbox?'+params,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error();
        const page:Results=await response.json();
        if(!controller.signal.aborted)setResult(page);
      }catch{if(!controller.signal.aborted)setError(true);}
    },160);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[open,term,topic,after,retry,workspaceId]);
  function reset(){setResult(null);setError(false);}
  return <details onToggle={e=>{reset();setOpen(e.currentTarget.open);}}>
    <summary>{action} help article</summary>
    {open&&<div className="published-article-picker">
      <label>Find a published article<input type="search" maxLength={200} value={term} onChange={e=>{
        reset();setTerm(e.target.value);setAfter('');
      }}/></label>
      <PublishedTopicFilter workspaceId={workspaceId} initialTopic={topic} onChange={value=>{
        reset();setAfter('');setTopic(value);
      }}/>
      {result?.suggested&&<h3>Similar articles</h3>}
      {error?<p role="alert">Could not load help articles. <button type="button" onClick={()=>{reset();setRetry(n=>n+1);}}>Retry</button></p>:
        !result?<p role="status">Loading articles…</p>:!result.center?<p>This workspace’s public help center is closed.</p>:
        result.items.length?<ul>{result.items.map(item=><li key={item.id}>
          <div><a href={item.path} target="_blank" rel="noreferrer">{item.title}</a>
            {item.topic&&<small> · {item.topic}</small>}{item.subtitle&&<p>{item.subtitle}</p>}</div>
          <button type="button" aria-label={action+' '+item.title} onClick={()=>onSelect(item)}>{action} link</button>
        </li>)}</ul>:<p>No matching published articles.</p>}
      {after&&<button type="button" onClick={()=>{reset();setAfter('');}}>First results</button>}
      {result?.next&&<button type="button" onClick={()=>{reset();setAfter(result.next!);}}>More results</button>}
    </div>}
  </details>;
}
