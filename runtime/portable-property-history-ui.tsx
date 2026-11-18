'use client';

import {useEffect,useState} from 'react';
import {portableHistoryFields,type PortablePropertyChange,type PortablePropertyHistoryPage} from '../lib/portable-property-history';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import type {PortableRecordKind} from '../lib/portable-records';

function display(value:PortablePropertyChange['value'],empty:string){
  return value===null?empty:Array.isArray(value)?value.join('; '):typeof value==='boolean'?(value?'Yes':'No'):String(value);
}

export function PortablePropertyHistory({kind,id,workspaceId,customProperties}:{
  kind:PortableRecordKind;id:string;workspaceId?:string;customProperties:PortableCustomProperty[];
}){
  const fields=portableHistoryFields(kind,customProperties);
  const [open,setOpen]=useState(false);
  const [field,setField]=useState(fields[0][0]);
  const [before,setBefore]=useState<number|null>(null);
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;page?:PortablePropertyHistoryPage}>();
  const params=new URLSearchParams({kind,history:id,field});
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(before!==null)params.set('before',String(before));
  const key=params.toString();
  const visible=result?.key===key?result:undefined;
  const ownerHistory=field==='owner';
  const empty=ownerHistory?'Unassigned':'—';

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch('/api/crm?'+key,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as PortablePropertyHistoryPage;
      if(!controller.signal.aborted)setResult({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[open,key,retry]);

  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Property history</summary>
    <label>Property <select value={field} onChange={event=>{setField(event.target.value);setBefore(null);}}>
      {fields.map(([id,label])=><option value={id} key={id}>{label}</option>)}
    </select></label>
    {open&&<>
      {!visible?<p role="status">Loading changes…</p>:!visible.page?<p role="alert">Could not load property history.{' '}
        <button type="button" onClick={()=>{setResult(undefined);setRetry(n=>n+1);}}>Retry</button>
      </p>:visible.page.items.length===0?<p>No saved changes for this property.</p>:<ul>
        {visible.page.items.map(change=><li key={change.revision}>
          {display(change.previous,empty)} → {display(change.value,empty)}
          {ownerHistory&&change.previous!==null&&change.previous===change.value&&' · Owners share a display name'}
          {' · '}{change.actorName?'Changed by '+change.actorName:'Change author unavailable'} ·{' '}
          <time dateTime={change.occurredAt}>{new Date(change.occurredAt).toLocaleString()}</time>
        </li>)}
      </ul>}
      {before!==null&&<button type="button" onClick={()=>setBefore(null)}>Newest changes</button>}{' '}
      {visible?.page?.next!=null&&<button type="button" onClick={()=>setBefore(visible.page!.next)}>Older changes</button>}
    </>}
  </details>;
}
