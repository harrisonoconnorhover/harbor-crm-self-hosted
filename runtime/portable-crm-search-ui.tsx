'use client';

import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Search} from 'lucide-react';
import {SearchResults} from '../app/search-results';
import {portableRecordPath} from '../lib/portable-record-path';
import {objectPath} from '../lib/portable-custom-objects';
import {portableSearchInput,type PortableSearchCursor,type PortableSearchKind} from '../lib/crm-search';

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
    const search=portableSearchInput.safeParse(saved);
    if(search.success&&search.data.query)return search.data;
  }catch{return;}
}

type ToolLink={label:string;href:string;keywords?:string;sections?:string[]};
type SearchProps={account:string;workspaceId?:string;tools:ToolLink[]};

export function PortableCrmSearch({account,workspaceId,tools}:SearchProps){
  const entry=useSyncExternalStore(subscribe,savedEntry,serverSnapshot);
  const restored=restoreEntry(entry,account,workspaceId);
  return <SearchPanel key={JSON.stringify([account,workspaceId,!!restored])} account={account} workspaceId={workspaceId} tools={tools} restored={restored}/>;
}

function SearchPanel({account,workspaceId,tools,restored}:SearchProps&{restored?:ReturnType<typeof restoreEntry>}){
  const field=useRef<HTMLInputElement>(null);
  const disclosure=useRef<HTMLDetailsElement>(null);
  const [open,setOpen]=useState(Boolean(restored));
  const [query,setQuery]=useState(restored?.query??'');
  const [match,setMatch]=useState(restored?.match??'phrase');
  const [initialPosition,setInitialPosition]=useState(restored);
  function rememberSearch(position?:{kind?:PortableSearchKind;page:number;cursor?:PortableSearchCursor}){
    window.history.replaceState({...window.history.state,
      harborCrmSearch:JSON.stringify({account,workspaceId,query,match,...position})},'');
  }
  useEffect(()=>{
    if(!open)return;
    function dismiss(event:PointerEvent){
      const panel=disclosure.current;
      if(panel&&event.target instanceof Node&&!panel.contains(event.target))panel.open=false;
    }
    document.addEventListener('pointerdown',dismiss);
    return ()=>document.removeEventListener('pointerdown',dismiss);
  },[open]);

  return <section className="portable-global-search" aria-label="Find in Harbor">
    <details ref={disclosure} open={open} onBlur={event=>{
      if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;
    }} onKeyDown={event=>{
      if(event.key==='Escape'&&open&&disclosure.current){
        disclosure.current.open=false;
        disclosure.current.querySelector('summary')?.focus();
      }
    }} onToggle={event=>{
      const expanded=event.currentTarget.open;
      setOpen(expanded);
      if(expanded&&!restored)field.current?.focus();
      if(!expanded){
        setQuery('');
        setMatch('phrase');
        setInitialPosition(undefined);
        const state={...window.history.state};
        delete state.harborCrmSearch;
        window.history.replaceState(state,'');
      }
    }}>
    <summary><Search size={17} aria-hidden="true"/>Find in Harbor</summary>
    <label>Search CRM records
      <input ref={field} type="search" value={query} onChange={event=>setQuery(event.target.value)} maxLength={500}
        placeholder="Find records, tools, or settings"/>
    </label>
    {open&&query.trim()&&<ToolResults key={query} query={query} onFollow={()=>rememberSearch()} destinations={workspaceId?tools:[...ownerShortcuts,...tools]}/>}
    {open&&<SearchResults query={query} match={match} onMatchChange={value=>{setInitialPosition(undefined);setMatch(value);}} initialPosition={initialPosition}
      searchEndpoint={workspaceId?'/api/crm/search?'+new URLSearchParams({workspaceId}):undefined}
      recordHref={record=>record.kind==='custom-objects'?objectPath({objectId:record.objectId,record:record.id,workspaceId}):portableRecordPath(record.kind,record.id,workspaceId)}
      onFollow={rememberSearch}/>}
    </details>
  </section>;
}

const ownerShortcuts:ToolLink[]=[
  {label:'Users & Teams',sections:['Settings'],keywords:'users and teams members permissions departments',href:'/?view=settings&section=users-teams'},
  {label:'Account defaults',sections:['Settings / General'],keywords:'workspace name timezone currency language date number format',href:'/?view=settings&section=account-defaults'},
  {label:'Data quality',sections:['Settings / Data management'],keywords:'data quality health duplicates missing fields',href:'/?view=settings&section=data-quality'},
  {label:'Properties',sections:['Settings / Data management'],keywords:'properties custom fields',href:'/?view=settings&section=properties&kind=contacts'},
  {label:'Record access history',sections:['Settings / Workspace'],keywords:'employee audit record views file downloads exports',href:'/?view=record-access'},
  {label:'Email settings',sections:['Settings / Workspace'],href:'/?view=email-settings'},
  {label:'Objects',sections:['Settings / Data management'],keywords:'object settings',href:'/?view=settings&section=objects'},
  {label:'Team directory',sections:['Settings'],keywords:'workspace employees teammates membership access',href:'/?view=workspaces#team-directory'},
  {label:'Pipeline settings',sections:['Settings / Data management / Objects'],keywords:'pipelines deal stages',href:'/?view=settings&section=pipelines'},
  {label:'Job queue',sections:['Settings / Workspace'],href:'/?view=job-queue'},
  {label:'API access',sections:['Settings / Data management'],href:'/?view=api-access'},
  {label:'Getting started',sections:['Settings / Workspace'],href:'/?view=getting-started'},
];
function ToolResults({query,destinations,onFollow}:{query:string;destinations:ToolLink[];onFollow:()=>void}){
  const [expanded,setExpanded]=useState(false);
  const words=query.toLowerCase().split(/[\s/>→]+/).filter(Boolean);
  if(!words.length)return null;
  const direct:ToolLink[]=[],bySection:ToolLink[]=[];
  for(const tool of destinations){
    const terms=tool.label.toLowerCase()+' '+(tool.keywords??'');
    if(words.every(word=>terms.includes(word)))direct.push(tool);
    else if(tool.sections?.some(section=>{
      const path=section.toLowerCase()+' '+terms;
      return words.every(word=>path.includes(word));
    }))bySection.push(tool);
  }
  const matches=[...direct,...bySection];
  if(!matches.length)return null;
  function link(tool:ToolLink){
    return <a key={tool.href} className="search-result" href={tool.href}
      onClick={event=>{if(!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)onFollow();}}>{tool.label}</a>;
  }
  const initialCount=6;
  return <section aria-label="Matching tools"><h3 className="search-section-heading">Tools</h3>
    {matches.slice(0,initialCount).map(link)}
    {matches.length>initialCount&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded?'Show fewer tools':`Show all ${matches.length} tools`}
    </button>}
    {expanded&&matches.slice(initialCount).map(link)}
  </section>;
}
