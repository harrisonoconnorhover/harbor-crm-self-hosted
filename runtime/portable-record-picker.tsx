'use client';

import {useEffect,useState} from 'react';
import {portableRecordLabels,type CompanyRecord,type ContactRecord,type DealRecord,type PortableRecordKind} from '../lib/portable-records';

type Option={id:string;name:string};
type Page={records:(CompanyRecord|ContactRecord|DealRecord)[];next:string|null};

export function PortableRecordPicker({kind,field,label,value,workspaceId,onSelect,emptyLabel}:{
  kind:PortableRecordKind;field:string;label:string;value:Option|null;workspaceId?:string;onSelect?:(option:Option|null)=>void;emptyLabel?:string;
}){
  const [selected,setSelected]=useState(value);
  const singular=portableRecordLabels[kind].toLowerCase();
  const detail=kind==='companies'?'domain':kind==='contacts'?'email':undefined;
  const [search,setSearch]=useState('');
  const [results,setResults]=useState<Page|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    const query=new URLSearchParams({kind});
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(search.trim())query.set('search',search.trim());
    const timer=setTimeout(async()=>{
      try{
        const response=await fetch('/api/crm?'+query,{signal:controller.signal});
        if(!response.ok)throw Error();
        const page=await response.json() as Page;
        if(!controller.signal.aborted){setResults(page);setError(false);}
      }catch{
        if(!controller.signal.aborted){setResults(null);setError(true);}
      }
    },250);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[kind,search,workspaceId]);
  const options=results?.records.map(record=>({id:record.id,name:record.data.name,detail:'domain' in record.data?record.data.domain:'email' in record.data?record.data.email:undefined}))??[];
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
