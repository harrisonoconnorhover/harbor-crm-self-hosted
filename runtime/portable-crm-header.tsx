'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Keep document navigation for editor leave prompts. */

import {PortableCrmSearch} from './portable-crm-search-ui';
import {PortableTaskReminders} from './portable-task-reminders-ui';
import {Anchor,Building2,ContactRound,Ellipsis,GitBranch,Handshake,ListChecks,Users} from 'lucide-react';
import {createContext,useContext,useEffect,useRef} from 'react';
import './portable-crm-header.css';

const primary=[
  {id:'contacts',label:'Contacts',href:'/',icon:ContactRound},
  {id:'companies',label:'Companies',href:'/?kind=companies',icon:Building2},
  {id:'deals',label:'Deals',href:'/?kind=deals',icon:Handshake},
  {id:'tasks',label:'Tasks',href:'/?kind=tasks',icon:ListChecks},
] as const;
type Page=(typeof primary)[number]['id']|'workflows'|'forms'|'email-settings'|'job-queue'|'calendar'|'workspaces'|'getting-started'|'leads'|'tickets'|'segments'|'files'|'products'|'quotes'|'invoices'|'reports'|'dashboards'|'knowledge'|'api-access';
type Destination={label:string;href:string;id?:Page};
const NavigationOptions=createContext({filesEnabled:false,calendarAvailable:false});
export function PortableNavigationOptions({value,children}:{value:{filesEnabled:boolean;calendarAvailable:boolean};children:React.ReactNode}){
  return <NavigationOptions.Provider value={value}>{children}</NavigationOptions.Provider>;
}

export function PortableCrmHeader({email,page,workspaceId,tasksHref,formsHref,recycleHref,currentHref,filesEnabled,calendarAvailable}:{
  email:string;page:Page;workspaceId?:string;tasksHref?:string;formsHref?:string;recycleHref?:string;
  filesEnabled?:boolean;calendarAvailable?:boolean;currentHref?:string;
}){
  const more=useRef<HTMLDetailsElement>(null);
  const configured=useContext(NavigationOptions);
  useEffect(()=>{
    const closeOutside=(event:PointerEvent)=>{
      const disclosure=more.current;
      if(disclosure?.open&&event.target instanceof Node&&!disclosure.contains(event.target))disclosure.open=false;
    };
    document.addEventListener('pointerdown',closeOutside);
    return ()=>document.removeEventListener('pointerdown',closeOutside);
  },[]);

  function scoped(href:string){
    if(!workspaceId)return href;
    return href+(href.includes('?')?'&':'?')+new URLSearchParams({workspaceId});
  }

  const records:Destination[]=[
    {id:'leads',href:scoped('/?kind=leads'),label:'Leads'},
    {id:'tickets',href:scoped('/tickets'),label:'Tickets'},
  ];
  if(recycleHref)records.push({href:recycleHref,label:'Recycle Bin'});
  if(!workspaceId){
    records.push({id:'segments',href:'/?view=segments',label:'Segments'});
    if(filesEnabled??configured.filesEnabled)records.push({id:'files',href:'/?view=files',label:'Files'});
  }
  const settings:Destination[]=[
    {id:'forms',href:formsHref??'/?view=forms',label:'Forms'},
    {id:'knowledge',href:'/?view=knowledge',label:'Knowledge base'},
    {id:'email-settings',href:'/?view=email-settings',label:'Email settings'},
    {id:'job-queue',href:'/?view=job-queue',label:'Job queue'},
    {id:'api-access',href:'/?view=api-access',label:'API access'},
    {id:'getting-started',href:'/?view=getting-started',label:'Getting started'},
  ];
  if(calendarAvailable??configured.calendarAvailable)settings.push({id:'calendar',href:'/?view=calendar',label:'Calendar'});
  const groups:{name:string;links:Destination[]}[]=workspaceId?[{name:'Records',links:records},{name:'Sales and reporting',links:[{id:'dashboards',href:scoped('/?view=dashboards'),label:'Dashboards'}]}]:[
    {name:'Records',links:records},
    {name:'Sales and reporting',links:[
      {id:'products',href:'/products',label:'Products'},{id:'quotes',href:'/quotes',label:'Quotes'},{id:'invoices',href:'/?view=invoices',label:'Invoices'},
      {id:'reports',href:'/?view=reports',label:'Reports'},{id:'dashboards',href:'/?view=dashboards',label:'Dashboards'},
    ]},
    {name:'Tools and settings',links:settings},
  ];

  const secondaryActive=groups.some(({links})=>links.some(({id})=>id===page));
  return <><header className="portable-crm-header">
    <span className="portable-crm-brand"><Anchor aria-hidden="true"/>Harbor</span>
    <nav aria-label="CRM records">
      {primary.map(({id,label,href,icon:Icon})=><a key={id} href={id==='tasks'&&tasksHref?tasksHref:scoped(href)}
        aria-current={page===id?'page':undefined}><Icon aria-hidden="true"/>{label}</a>)}
      {!workspaceId&&<a href="/?view=workflows" aria-current={page==='workflows'?'page':undefined}><GitBranch aria-hidden="true"/>Workflows</a>}
      <a href="/?view=workspaces" aria-current={page==='workspaces'?'page':undefined}><Users aria-hidden="true"/>Workspaces</a>
      <details ref={more} className="portable-crm-more" onKeyDown={event=>{
        if(event.key!=='Escape'||!event.currentTarget.open)return;
        event.preventDefault();
        event.currentTarget.open=false;
        event.currentTarget.querySelector('summary')?.focus();
      }} onBlur={event=>{
        if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;
      }}>
        <summary data-current={secondaryActive||undefined}><Ellipsis aria-hidden="true"/>More</summary>
        <div className="portable-crm-more-panel" data-shared={workspaceId?true:undefined}>
          {groups.map(({name,links})=><div key={name}>
            {!workspaceId&&<p>{name}</p>}
            {links.map(({href,label,id})=><a key={href} href={id===page&&currentHref?currentHref:href} aria-current={id===page?'page':undefined}>{label}</a>)}
          </div>)}
        </div>
      </details>
    </nav>
    <div className="portable-crm-account">
      <PortableTaskReminders key={email+':'+(workspaceId??'')} workspaceId={workspaceId}/>
      <span className="portable-crm-account-mark" aria-hidden="true">{email.charAt(0).toUpperCase()}</span>
      <span className="portable-crm-account-email" title={email}>{email}</span>
      <a href="/auth/sign-out">Sign out</a>
    </div>
  </header>
    <PortableCrmSearch account={email} workspaceId={workspaceId}/>
  </>;
}
