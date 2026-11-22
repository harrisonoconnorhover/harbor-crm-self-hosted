'use client';

import {createContext,useContext,useEffect,useId,useRef,useState} from 'react';
import {Anchor,BarChart3,Bookmark,BookOpen,BriefcaseBusiness,Building2,ChevronRight,CircleDollarSign,Database,
  GitBranch,Headphones,Menu,Megaphone,Settings,Users,X} from 'lucide-react';
import {isPortableTool,maxPortableBookmarks,portableToolNames,type PortableTool} from '../lib/portable-nav-tools';
import {PortableCrmSearch} from './portable-crm-search-ui';
import {PortableTaskReminders} from './portable-task-reminders-ui';
import {WorkspaceName} from './portable-workspace-format';
import './portable-crm-header.css';

type Page=PortableTool|'workspaces'|'getting-started'|'job-queue'|'api-access'|'settings'|'email-settings';
type Access={hiddenTools?:readonly PortableTool[];filesEnabled:boolean;calendarAvailable:boolean;marketingEnabled:boolean;sharedRole?:'editor'|'viewer';allRecords?:boolean;callsAvailable?:boolean;forecastAvailable?:boolean};
const NavigationOptions=createContext<Access>({filesEnabled:false,calendarAvailable:false,marketingEnabled:false});
export function PortableNavigationOptions({value,children}:{value:Access;children:React.ReactNode}){
  return <NavigationOptions.Provider value={value}>{children}</NavigationOptions.Provider>;
}

const sections=[
  {name:'CRM',icon:Users,tools:['contacts','companies','deals','tickets','tasks','segments','team-inbox','products','quotes','custom-objects','templates','snippets','calls','leads']},
  {name:'Marketing',icon:Megaphone,tools:['marketing','campaigns','forms','landing-pages','web-attribution']},
  {name:'Content',icon:BookOpen,tools:['landing-pages','files']},
  {name:'Sales',icon:BriefcaseBusiness,tools:['sales-workspace','sequences','meetings','calendar','forecast']},
  {name:'Revenue',icon:CircleDollarSign,tools:['quotes','invoices','payments','subscriptions']},
  {name:'Service',icon:Headphones,tools:['help-desk','tickets','team-inbox','knowledge','customer-portal']},
  {name:'Data management',icon:Database,tools:['integrations','duplicates','import','recycle-bin','data-management']},
  {name:'Automations',icon:GitBranch,tools:['workflows']},
  {name:'Reporting',icon:BarChart3,tools:['dashboards','reports','goals']},
] as const satisfies readonly {name:string;icon:typeof Users;tools:readonly PortableTool[]}[];

// Keep every home for tools listed in two sections, while returning one search result.
const toolSections=new Map<PortableTool,string[]>();
for(const section of sections){
  for(const tool of section.tools){
    const names=toolSections.get(tool);
    if(names)names.push(section.name);
    else toolSections.set(tool,[section.name]);
  }
}
// Some owner pages link to a tool inside another destination. Search either path.
const ownerToolPaths:Partial<Record<PortableTool,string>>={
  'web-attribution':'Reporting / Reports','data-management':'Settings',integrations:'Settings / Data management',import:'Settings / Data management',
  duplicates:'Settings / Data management','custom-objects':'Settings / Data management / Objects',
};
const searchAliases:Partial<Record<PortableTool,string>>={
  subscriptions:'recurring plans subscribers stripe billing', 'web-attribution':'web attribution', segments:'segments', 'team-inbox':'team inbox', sequences:'sales sequences', integrations:'connections providers email calendar gmail outlook api webhooks',
};

const scopedTools=new Set<PortableTool>(['segments','contacts','companies','deals','leads','tasks','tickets','help-desk','custom-objects','reports','dashboards','knowledge','sales-workspace','forecast','goals']);
const fullViewTools=new Set<PortableTool>(['team-inbox','snippets']);
const homes:Partial<Record<Page,string>>={tickets:'Service','team-inbox':'Service',quotes:'Revenue','landing-pages':'Content'};

function useBookmarks(workspaceId:string|undefined,opened:boolean){
  const endpoint='/api/navigation-bookmarks'+(workspaceId?'?'+new URLSearchParams({workspaceId}):'');
  const [items,setItems]=useState<PortableTool[]>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [retry,setRetry]=useState(0);
  const saving=useRef(false);
  const generation=useRef(0);
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    const version=generation.current;
    fetch(endpoint,{signal:controller.signal,cache:'no-store'}).then(async r=>{
      if(!r.ok)throw Error();
      const body=await r.json() as {items:unknown[]};
      if(!controller.signal.aborted&&version===generation.current&&!saving.current){setItems(body.items.filter(isPortableTool));setError('');}
    }).catch(()=>{if(!controller.signal.aborted&&version===generation.current)setError('Could not load bookmarks.');});
    return ()=>controller.abort();
  },[endpoint,opened,retry]);
  async function toggle(tool:PortableTool){
    if(!items||saving.current)return;
    generation.current++;saving.current=true;setBusy(true);setError('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool,pin:!items.includes(tool)})});
      const result=await response.json() as {items?:PortableTool[];error?:string};
      if(!response.ok||!result.items)throw Error(result.error||'Could not save bookmark.');
      setItems(result.items);
    }catch(e){setError(e instanceof Error?e.message:'Could not save bookmark.');}
    finally{saving.current=false;setBusy(false);}
  }
  return {items,busy,error,toggle,reload:()=>setRetry(n=>n+1)};
}

export function PortableCrmHeader({email,page,workspaceId,tasksHref,formsHref,recycleHref,currentHref,filesEnabled,calendarAvailable}:{
  email:string;page:Page;workspaceId?:string;tasksHref?:string;formsHref?:string;recycleHref?:string;
  filesEnabled?:boolean;calendarAvailable?:boolean;currentHref?:string;
}){
  const access=useContext(NavigationOptions);
  const [mobile,setMobile]=useState(false);
  const [opened,setOpened]=useState<string|null>(null);
  const nav=useRef<HTMLElement>(null),menu=useRef<HTMLButtonElement>(null);
  const prefix=useId();
  const pins=useBookmarks(workspaceId,opened!==null);
  function scoped(href:string){
    if(!workspaceId)return href;
    const url=new URL(href,'https://harbor.invalid');
    url.searchParams.set('workspaceId',workspaceId);
    return url.pathname+url.search+url.hash;
  }

  function available(tool:PortableTool){
    if(workspaceId&&access.hiddenTools?.includes(tool))return false;
    if(tool==='files')return workspaceId?!!access.sharedRole&&access.filesEnabled:filesEnabled??access.filesEnabled;
    if(tool==='recycle-bin')return !workspaceId||access.sharedRole==='editor';
    if(workspaceId&&(tool==='forecast'||tool==='goals'))return Boolean(access.forecastAvailable);
    if(workspaceId&&tool==='calls')return Boolean(access.callsAvailable);
    if(workspaceId)return scopedTools.has(tool)||Boolean(access.allRecords&&fullViewTools.has(tool))||
      (tool==='duplicates'||tool==='meetings')&&access.sharedRole==='editor';
    if(tool==='calendar')return calendarAvailable??access.calendarAvailable;
    if(tool==='marketing'||tool==='campaigns')return access.marketingEnabled;
    return true;
  }
  function href(tool:PortableTool,canonical=false){
    if(!canonical&&tool===page&&currentHref)return currentHref;
    switch(tool){
      case 'integrations':case 'data-management':return '/?view=settings&section='+tool;
      case 'contacts':return scoped('/');
      case 'companies':case 'deals':case 'leads':return scoped('/?kind='+tool);
      case 'tasks':return !canonical&&tasksHref?tasksHref:scoped('/?kind=tasks');
      case 'tickets':return scoped('/tickets');
      case 'help-desk':return scoped('/tickets?response=unanswered&sort=response_due');
      case 'products':case 'quotes':return '/'+tool;
      case 'forms':return !canonical&&formsHref?formsHref:'/?view=forms';
      case 'recycle-bin':return !canonical&&recycleHref?recycleHref:scoped('/?view=recycle-bin');
      default:return scoped('/?view='+tool);
    }
  }
  const home=homes[page]??sections.find(s=>s.tools.some(tool=>tool===page))?.name;
  useEffect(()=>{
    if(!opened&&!mobile)return;
    function outside(event:PointerEvent){
      if(event.target instanceof Node&&!nav.current?.contains(event.target)&&!menu.current?.contains(event.target)){
        setOpened(null);setMobile(false);
      }
    }
    document.addEventListener('pointerdown',outside);
    return ()=>document.removeEventListener('pointerdown',outside);
  },[opened,mobile]);

  useEffect(()=>{
    const drawer=nav.current;
    if(!mobile||!opened||!drawer||!menu.current?.getClientRects().length)return;
    const category=drawer.querySelector<HTMLButtonElement>('.portable-nav-category[aria-expanded="true"]');
    const section=category?.parentElement?.getBoundingClientRect();
    if(!section)return;
    const bounds=drawer.getBoundingClientRect();
    // Scroll just the drawer. For a long section, keep its heading and first links together.
    const headingOffset=section.top-bounds.top;
    if(headingOffset<0)drawer.scrollTop+=headingOffset;
    else if(section.bottom>bounds.bottom)drawer.scrollTop+=Math.min(headingOffset,section.bottom-bounds.bottom);
  },[mobile,opened]);

  function row(tool:PortableTool,favorite=false){
    const pinned=pins.items?.includes(tool)??false;
    const label=portableToolNames[tool];
    const full=!pinned&&pins.items?.length===maxPortableBookmarks;
    return <li key={tool}>
      {available(tool)?<a href={href(tool,favorite)} aria-current={page===tool?'page':undefined}>{label}</a>:<span>{label}</span>}
      <button type="button" className="portable-pin" aria-label={(pinned?'Unpin ':'Pin ')+label}
        aria-pressed={pinned} disabled={!pins.items||pins.busy||full} title={full?'Five bookmarks saved':pinned?'Remove bookmark':'Add bookmark'}
        onClick={()=>void pins.toggle(tool)}><Bookmark size={15} fill={pinned?'currentColor':'none'}/></button>
    </li>;
  }
  const menus=[{name:'Bookmarks',icon:Bookmark,tools:pins.items??[]},...sections];

  return <><header className="portable-crm-header">
    <div className="portable-brand-area">
      <button type="button" className="portable-menu-toggle" ref={menu} aria-expanded={mobile} aria-controls={prefix+'-nav'} aria-label={mobile?'Close navigation':'Open navigation'}
        onClick={()=>{setMobile(!mobile);setOpened(null);if(!mobile)requestAnimationFrame(()=>nav.current?.querySelector('button')?.focus());}}>
        {mobile?<X/>:<Menu/>}</button>
      <span className="portable-crm-brand"><Anchor aria-hidden="true"/>Harbor</span>
    </div>
    <PortableCrmSearch account={email} workspaceId={workspaceId} tools={[
      {label:'Workspaces',href:scoped('/?view=workspaces')},
      {label:'Settings',href:scoped('/?view=settings')},
      ...Array.from(toolSections).filter(([tool])=>available(tool)).map(([tool,sectionNames])=>({
        label:portableToolNames[tool],href:href(tool,true),keywords:searchAliases[tool],
        sections:!workspaceId&&ownerToolPaths[tool]?[...sectionNames,ownerToolPaths[tool]]:sectionNames,
      })),
    ]}/>
    <div className="portable-crm-account">
      <a href={scoped('/?view=workspaces')} aria-label="Workspaces" title="Workspaces" aria-current={page==='workspaces'?'page':undefined}><Building2/><span className="workspace-switcher-name"><WorkspaceName fallback="Workspaces"/></span></a>
      <a href={scoped('/?view=settings')} aria-label="Settings" title="Settings" aria-current={['settings','integrations','data-management','job-queue','getting-started','api-access','email-settings'].includes(page)?'page':undefined}><Settings/></a>
      <PortableTaskReminders key={email+':'+(workspaceId??'')} workspaceId={workspaceId}/>
      <details className="portable-account-menu"><summary aria-label={'Account, '+email} title={email}>{email.charAt(0).toUpperCase()}</summary>
        <div><span>{email}</span><a href="/auth/sign-out">Sign out</a></div></details>
    </div>
  </header>
  <nav className="portable-side-nav" aria-label="Main navigation" ref={nav} id={prefix+'-nav'} data-mobile-open={mobile||undefined}
    onBlur={e=>{if(e.relatedTarget&&e.relatedTarget!==menu.current&&!e.currentTarget.contains(e.relatedTarget)){setOpened(null);setMobile(false);}}}
    onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();if(opened){
      nav.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();setOpened(null);
    }else if(mobile){setMobile(false);menu.current?.focus();}}}}>
    {menus.map(({name,icon:Icon,tools},index)=>{
      const favorites=name==='Bookmarks',active=opened===name;
      const destinations=tools.filter(available);
      const unavailable=favorites?tools.filter(tool=>!available(tool)):[];
      return <div key={name} className="portable-nav-section">
        <button type="button" className="portable-nav-category" aria-expanded={active} aria-controls={prefix+index}
          data-current={home===name||undefined} onClick={()=>setOpened(active?null:name)}>
          <Icon aria-hidden="true"/><span>{name}</span><ChevronRight aria-hidden="true"/>
        </button>
        <div id={prefix+index} className="portable-nav-panel" hidden={!active} aria-label={name+' tools'}>
          <div className="portable-nav-title">{name}</div>
          {destinations.length?<ul>{destinations.map(tool=>row(tool,favorites))}</ul>:
            <p>{favorites?(pins.items?'Pin up to five tools using the bookmark beside each name.':pins.error?'Bookmarks unavailable.':'Loading bookmarks…'):'No tools available in this workspace.'}</p>}
          {unavailable.length>0&&<details className="portable-unavailable-pins"><summary>Unavailable bookmarks ({unavailable.length})</summary>
            <ul>{unavailable.map(tool=>row(tool,true))}</ul></details>}
          {active&&pins.error&&<p role="alert">{pins.error} <button type="button" onClick={pins.reload}>Retry</button></p>}
        </div>
      </div>;
    })}
  </nav></>;
}
