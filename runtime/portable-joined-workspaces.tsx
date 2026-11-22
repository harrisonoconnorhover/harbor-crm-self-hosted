'use client';

import {useRef,useState,type ReactNode} from 'react';
import type {WorkspaceRole} from '../lib/portable-workspace-access';

type Workspace={meetingsVisible?:boolean;id:string;ownerEmail:string;role:WorkspaceRole;grantId:string;backupAdmin:boolean};
type Page={items:Workspace[];next:string|null};

export function JoinedWorkspaceList({initial,current,actions}:{initial:Page;current?:string;actions?:(workspace:Workspace)=>ReactNode}){
  const [result,setResult]=useState<Page>();
  const [query,setQuery]=useState('');
  const [applied,setApplied]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [later,setLater]=useState(false);
  const pending=useRef(false);
  const page=result??initial;
  async function load(q:string,after?:string){
    if(pending.current)return;
    pending.current=true;
    setBusy(true);
    setError('');
    try{
      const params=new URLSearchParams({joined:'1',q,...(after?{after}:{}),...(current?{current}:{})});
      const response=await fetch('/api/workspaces?'+params,{cache:'no-store'});
      if(!response.ok)throw Error(response.status===404?'Workspace access changed. Reopen Workspaces.':'Could not load workspaces. Try again.');
      const body:Page=await response.json();
      setResult(body);
      setLater(Boolean(after));
      setApplied(q);
      setQuery(q);
    }catch(e){setError(e instanceof Error?e.message:'Could not load workspaces. Try again.');}
    finally{pending.current=false;setBusy(false);}
  }
  return <div className="portable-joined-workspaces">
    {initial.next&&<form onSubmit={e=>{e.preventDefault();void load(query.trim());}}>
      <label>Find a shared workspace<input type="search" maxLength={254} value={query} disabled={busy}
        placeholder="Workspace owner’s email" onChange={e=>setQuery(e.target.value)}/></label>
      <button type="submit" disabled={busy}>Search workspaces</button>
    </form>}
    {error&&<p role="alert">{error}</p>}
    {page.items.length?<ul>{page.items.map(workspace=><li key={workspace.id}>
      <a href={'/?workspaceId='+workspace.id}>Workspace from {workspace.ownerEmail}</a>
      {' · '}{workspace.role==='editor'?'Editor':'Viewer'}{actions?.(workspace)}
    </li>)}</ul>:(!current||applied)&&<p>{applied?'No matching shared workspaces.':'No workspaces shared with you.'}</p>}
    {later&&<button type="button" disabled={busy} onClick={()=>void load(applied)}>First workspaces</button>}
    {page.next&&<button type="button" disabled={busy} onClick={()=>void load(applied,page.next!)}>Next workspaces</button>}
  </div>;
}
