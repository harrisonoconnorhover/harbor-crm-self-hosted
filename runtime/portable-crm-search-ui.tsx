'use client';

import {useState,useSyncExternalStore} from 'react';
import {Search} from 'lucide-react';
import {SearchResults} from '../app/search-results';
import {portableRecordPath} from '../lib/portable-record-path';
import {searchInput} from '../lib/crm-search';

const subscribe=()=>()=>{};
const serverSnapshot=()=>null;
function savedEntry(){
  const entry=window.history.state?.harborCrmSearch;
  return typeof entry==='string'?entry:null;
}

function restoreEntry(entry:string|null,account:string,workspaceId?:string){
  if(!entry)return;
  try{
    const saved:unknown=JSON.parse(entry);
    if(!saved||typeof saved!=='object'||!('account' in saved)||saved.account!==account)return;
    if(('workspaceId' in saved?saved.workspaceId:undefined)!==workspaceId)return;
    const search=searchInput.safeParse(saved);
    if(search.success&&search.data.query)return search.data;
  }catch{return;}
}

export function PortableCrmSearch({account,workspaceId}:{account:string;workspaceId?:string}){
  const entry=useSyncExternalStore(subscribe,savedEntry,serverSnapshot);
  const restored=restoreEntry(entry,account,workspaceId);
  return <SearchPanel key={JSON.stringify([account,workspaceId,!!restored])} account={account} workspaceId={workspaceId} restored={restored}/>;
}

function SearchPanel({account,workspaceId,restored}:{account:string;workspaceId?:string;restored?:ReturnType<typeof restoreEntry>}){
  const [open,setOpen]=useState(Boolean(restored));
  const [query,setQuery]=useState(restored?.query??'');
  const [initialPosition,setInitialPosition]=useState(restored);
  return <section className="portable-global-search" aria-label="Find in Harbor">
    <details open={open} onToggle={event=>{
      const expanded=event.currentTarget.open;
      setOpen(expanded);
      if(!expanded){
        setQuery('');
        setInitialPosition(undefined);
        const state={...window.history.state};
        delete state.harborCrmSearch;
        window.history.replaceState(state,'');
      }
    }}>
    <summary><Search size={17} aria-hidden="true"/>Find in Harbor</summary>
    <label>Search CRM records
      <input type="search" value={query} onChange={event=>setQuery(event.target.value)} maxLength={500}
        placeholder="Search contacts, companies, deals, tasks, leads and tickets"/>
    </label>
    {open&&<SearchResults query={query} initialPosition={initialPosition}
      searchEndpoint={workspaceId?'/api/crm/search?'+new URLSearchParams({workspaceId}):undefined}
      recordHref={(kind,id)=>portableRecordPath(kind,id,workspaceId)}
      onNavigate={(_kind,_id,position)=>{
        // Keep this entry's search out of the URL and fetch fresh results on return.
        window.history.replaceState({...window.history.state,
          harborCrmSearch:JSON.stringify({account,workspaceId,query,...position})},'');
      }}/>}
    </details>
  </section>;
}
