'use client';

import {useEffect,useState} from 'react';
import type {landingLinkChoices} from '../db/postgres/landing-page-store';

type Choices=Awaited<ReturnType<typeof landingLinkChoices>>;

export function LandingLinkPicker({source,current,onSelect}:{source:string;current:string;onSelect:(id:string)=>void}){
  const [q,setQuery]=useState(''),[after,setAfter]=useState(''),[retry,setRetry]=useState(0);
  const [choices,setChoices]=useState<Choices|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const cancel=new AbortController();
    const params=new URLSearchParams({exclude:source,...(current?{current}:{}),...(q.trim()?{q:q.trim()}:{}),...(after?{after}:{})});
    const timer=setTimeout(async()=>{
      try{
        const response=await fetch('/api/landing-pages?'+params,{cache:'no-store',signal:cancel.signal});
        if(!response.ok)throw Error();
        const result:Choices=await response.json();
        if(!cancel.signal.aborted){setChoices(result);setFailed(false);}
      }catch{if(!cancel.signal.aborted)setFailed(true);}
    },150);
    return ()=>{cancel.abort();clearTimeout(timer);};
  },[source,current,q,after,retry]);
  function reset(){setFailed(false);setChoices(null);}
  const options=choices?.items??[];
  return <>
    <label>Find a landing page<input type="search" value={q} maxLength={120} onChange={e=>{
      reset();setQuery(e.target.value);setAfter('');
    }}/></label>
    <label>Linked landing page<select value={current} onChange={e=>onSelect(e.target.value)}>
      <option value="">Choose a published page</option>
      {current&&!options.some(item=>item.id===current)&&<option value={current}>
        {choices?.current?choices.current.title+' · /'+choices.current.slug:choices?'Previously selected page (unpublished)':'Selected page'}
      </option>}
      {options.map(item=><option key={item.id} value={item.id}>{item.title} · /{item.slug}</option>)}
    </select></label>
    {failed?<p role="alert">Could not load pages. <button type="button" onClick={()=>{reset();setRetry(v=>v+1);}}>Retry</button></p>:
      !choices?<p role="status">Loading pages…</p>:!options.length&&<p>No matching published pages.</p>}
    {after&&<button type="button" onClick={()=>{reset();setAfter('');}}>First pages</button>}
    {choices?.next&&<button type="button" onClick={()=>{reset();setAfter(choices.next!);}}>More pages</button>}
  </>;
}
