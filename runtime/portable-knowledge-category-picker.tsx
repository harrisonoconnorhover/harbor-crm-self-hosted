'use client';

import {useEffect,useState,type ReactNode} from 'react';
import type {KnowledgeCategoryPage,PortableKnowledgeCategory} from '../lib/portable-knowledge';

export const categoryName=(category:PortableKnowledgeCategory)=>category.parentName?category.parentName+' › '+category.name:category.name;

export function CategoryBrowser({initial,status='active',parentsOnly,children}:{initial?:KnowledgeCategoryPage;status?:'active'|'archived';parentsOnly?:boolean;
  children:(items:PortableKnowledgeCategory[])=>ReactNode}){
  const [term,setTerm]=useState(''),[query,setQuery]=useState('');
  const [cursor,setCursor]=useState<KnowledgeCategoryPage['next']>(null),[retry,setRetry]=useState(0);
  const params=new URLSearchParams({status,limit:'25',q:query,...(parentsOnly?{topLevel:'1'}:{}),...(cursor??{})}).toString();
  const preloaded=!query&&!cursor?initial:undefined;
  const key=params+'#'+retry;
  const [result,setResult]=useState<{key:string;page?:KnowledgeCategoryPage}>();
  const page=preloaded??(result?.key===key?result.page:undefined);
  const error=!page&&result?.key===key;
  const loading=!page&&!error;
  useEffect(()=>{
    if(preloaded)return;
    const controller=new AbortController();
    fetch('/api/knowledge-base/categories?'+params,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as KnowledgeCategoryPage;
      if(!controller.signal.aborted)setResult({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[preloaded,params,key]);
  const search=()=>{setCursor(null);setQuery(term.trim());};
  return <>
    {(!initial||initial.next)&&<div>
      <label>Find categories<input type="search" maxLength={100} value={term} onChange={event=>setTerm(event.target.value)}
        onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();search();}}}/></label>
      <button type="button" onClick={search}>Search categories</button>
    </div>}
    {loading&&<p role="status">Loading categories…</p>}
    {error&&<p role="alert">Could not load categories. <button type="button" onClick={()=>setRetry(n=>n+1)}>Try again</button></p>}
    {children(loading||error?[]:page?.items??[])}
    {cursor&&<button type="button" disabled={loading} onClick={()=>setCursor(null)}>First categories</button>}
    {page?.next&&<button type="button" disabled={loading||error} onClick={()=>setCursor(page.next)}>More categories</button>}
  </>;
}

export function CategoryPicker({initial,selected,value,onChange,label,name,empty,parentsOnly,disabled}:{
  initial:KnowledgeCategoryPage;selected?:PortableKnowledgeCategory;value?:string|null;onChange?:(id:string)=>void;
  label:string;name?:string;empty:string;parentsOnly?:boolean;disabled?:boolean;
}){
  const [picked,setPicked]=useState(selected);
  const id=value===undefined?picked?.id:value;
  return <div role="group" aria-label={label+' choices'}><CategoryBrowser initial={parentsOnly&&initial.next?undefined:initial} parentsOnly={parentsOnly}>{items=>{
    const options=parentsOnly?items.filter(item=>!item.parentId):items;
    const current=picked?.id===id?picked:selected?.id===id?selected:undefined;
    return <label>{label}<select name={name} value={id??''} disabled={disabled} onChange={event=>{
      const next=event.target.value;
      setPicked(options.find(item=>item.id===next)??(next?current:undefined));onChange?.(next);
    }}><option value="">{empty}</option>
      {id&&!options.some(item=>item.id===id)&&<option value={id}>{current?categoryName(current):'Unavailable category'}</option>}
      {options.map(category=><option key={category.id} value={category.id}>{categoryName(category)}</option>)}
    </select></label>;
  }}</CategoryBrowser></div>;
}
