'use client';

import {useEffect,useState} from 'react';
import {portableRecordLabels,type PortableRecordKind} from '../lib/portable-records';

type Option={id:string;name:string;revision?:number};
type Page={records:{id:string;revision:number;data:{name:string;email?:string;domain?:string}}[];next:string|null};

export function PortableRecordPicker({kind,field,label,value,workspaceId,onSelect,emptyLabel,unansweredTickets,editableOnly}:{
  kind:PortableRecordKind|'tickets'|'leads'|'tasks';unansweredTickets?:boolean;editableOnly?:boolean;field:string;label:string;value:Option|null;workspaceId?:string;onSelect?:(option:Option|null)=>void;emptyLabel?:string;
}){
  const [selected,setSelected]=useState(value);
  const service=kind==='tickets'||kind==='leads';
  const singular=service||kind==='tasks'?kind.slice(0,-1):portableRecordLabels[kind].toLowerCase();
  const detail=kind==='companies'?'domain':kind==='contacts'?'email':undefined;
  const [search,setSearch]=useState('');
  const [results,setResults]=useState<Page|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    const query=new URLSearchParams(service?{}:{kind});
    if(kind==='tickets'&&unansweredTickets)query.set('response','unanswered');
    if(editableOnly){
      if(kind==='tickets')query.set('editableOnly','1');else query.set('owner','editable');
    }
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(search.trim())query.set('search',search.trim());
    const timer=setTimeout(async()=>{
      try{
        const response=await fetch((service?'/api/'+kind+'?':'/api/crm?')+query,{signal:controller.signal});
        if(!response.ok)throw Error();
        const page=await response.json() as Page;
        if(!controller.signal.aborted){setResults(page);setError(false);}
      }catch{
        if(!controller.signal.aborted){setResults(null);setError(true);}
      }
    },250);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[kind,service,search,workspaceId,unansweredTickets,editableOnly]);
  const options=results?.records.map(record=>({id:record.id,name:record.data.name,...(kind==='tickets'?{revision:record.revision}:{}),detail:record.data.domain??record.data.email}))??[];
  return <div>
    <label>Find a {singular}
      <input value={search} maxLength={120} onChange={event=>{setResults(null);setError(false);setSearch(event.target.value);}}
        onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/>
    </label>
    <label>{label}
      <select name={field} value={selected?.id??''} onChange={event=>{
        const option=options.find(option=>option.id===event.target.value)??null;
        setSelected(option);
        onSelect?.(option);
      }}>
        <option value="">{emptyLabel??'No '+singular}</option>
        {selected&&!options.some(option=>option.id===selected.id)&&<option value={selected.id}>{selected.name}</option>}
        {options.map(option=><option key={option.id} value={option.id}>
          {option.name+(option.detail?' · '+option.detail:'')}
        </option>)}
      </select>
    </label>
    {results?.next&&<small>Showing the first 25 matches. Search by name{detail&&' or '+detail} to narrow the list.</small>}
    {error&&<small role="status">Could not load {kind}. Change the search to try again.</small>}
  </div>;
}
