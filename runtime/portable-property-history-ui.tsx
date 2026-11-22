'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useState} from 'react';
import './portable-property-history.css';
import {portableHistoryFields,type PortableHistoryCursor,type PortablePropertyChange,type PortablePropertyHistoryPage,type PortableRecordHistoryPage} from '../lib/portable-property-history';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import type {PortableRecordKind} from '../lib/portable-records';

function display(value:PortablePropertyChange['value'],empty:string){
  return value===null?empty:Array.isArray(value)?value.join('; '):typeof value==='boolean'?(value?'Yes':'No'):String(value);
}

type HistoryPage={items:PortableRecordHistoryPage['items'];next:PortableHistoryCursor|number|null};
export function PortablePropertyHistory({kind,id,workspaceId,customProperties,hiddenStandardFields}:{
  kind:PortableRecordKind;id:string;workspaceId?:string;customProperties:PortableCustomProperty[];hiddenStandardFields:string[];
}){
  const fields=portableHistoryFields(kind,customProperties).filter(([id])=>!hiddenStandardFields.includes(id));
  const [open,setOpen]=useState(false);
  const [field,setField]=useState('');
  const [search,setSearch]=useState('');
  const [draft,setDraft]=useState('');
  const [before,setBefore]=useState<HistoryPage['next']>(null);
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;page?:HistoryPage}>();
  const params=new URLSearchParams({kind,history:id});
  if(field)params.set('field',field);
  else if(search)params.set('search',search);
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(before!==null){
    params.set('before',String(typeof before==='number'?before:before.revision));
    if(typeof before==='object')params.set('afterField',before.field);
  }
  const key=params.toString();
  const label=fields.find(([id])=>id===field)?.[1]??'';
  const visible=result?.key===key?result:undefined;
  function chooseField(next:string){setField(next);setBefore(null);}

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch('/api/crm?'+key,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      let page:HistoryPage;
      if(field){
        const data=await response.json() as PortablePropertyHistoryPage;
        page={items:data.items.map(item=>({...item,field,label})),next:data.next};
      }else page=await response.json() as PortableRecordHistoryPage;
      if(!controller.signal.aborted)setResult({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[open,key,retry,field,label]);

  return <details id="portable-property-history" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Property history</summary>
      <div className="portable-history-filters"><label>Property <select value={field} onChange={event=>chooseField(event.target.value)}>
        <option value="">All properties</option>
        {fields.map(([id,label])=><option value={id} key={id}>{label}</option>)}
      </select></label>
      {!field&&<form role="search" onSubmit={event=>{event.preventDefault();setSearch(draft.trim());setBefore(null);}}>
        <label>Search property history <input type="search" maxLength={120} value={draft}
          placeholder="Property, value, or person" onChange={event=>setDraft(event.target.value)}/></label>
        <button type="submit">Search</button>
        {search&&<button type="button" onClick={()=>{setSearch('');setDraft('');setBefore(null);}}>Clear search</button>}
      </form>}</div>
    {open&&<>
      {!visible?<p role="status">Loading changes…</p>:!visible.page?<p role="alert">Could not load property history.{' '}
        <button type="button" onClick={()=>{setResult(undefined);setRetry(n=>n+1);}}>Retry</button>
      </p>:visible.page.items.length===0?<p>{field?'No saved changes for this property.':search?'No matching changes.':'No saved property changes.'}</p>:<ul className="portable-history-entries">
        {visible.page.items.map(change=>{
          const owner=change.field==='owner',empty=owner?'Unassigned':'—';
          return <li key={change.revision+':'+change.field}>
            {!field&&<><button type="button" aria-label={'View '+change.label+' history'} onClick={()=>chooseField(change.field)}>{change.label}</button>{' '}</>}
            <span>{display(change.previous,empty)} → {display(change.value,empty)}</span>
            {owner&&change.previous!==null&&change.previous===change.value&&' · Owners share a display name'}
            <small>{change.actorName?'Changed by '+change.actorName:'Change author unavailable'} ·{' '}
            <time dateTime={change.occurredAt}><WorkspaceDate value={change.occurredAt}>{new Date(change.occurredAt).toLocaleString()}</WorkspaceDate></time></small>
          </li>;
        })}
      </ul>}
      {before!==null&&<button type="button" onClick={()=>setBefore(null)}>Newest changes</button>}{' '}
      {visible?.page?.next!=null&&<button type="button" onClick={()=>setBefore(visible.page!.next)}>Older changes</button>}
    </>}
  </details>;
}
