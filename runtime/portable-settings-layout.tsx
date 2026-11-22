'use client';

import {useEffect,useRef,type ReactNode} from 'react';
import './portable-settings-layout.css';

const groups=[
  {title:'',items:[
    ['overview','Overview','/?view=settings'],
    ['users-teams','Users & Teams','/?view=settings&section=users-teams'],
    ['properties','Properties','/?view=settings&section=properties'],
  ]},
  {title:'General',items:[
    ['account-defaults','Account defaults','/?view=settings&section=account-defaults'],
  ]},
  {title:'Data management',items:[
    ['data-management','Data management','/?view=settings&section=data-management'],
    ['data-quality','Data quality','/?view=settings&section=data-quality'],
    ['objects','Objects','/?view=settings&section=objects'],
    ['pipelines','Pipelines','/?view=settings&section=pipelines'],
    ['integrations','Integrations','/?view=settings&section=integrations'],
    ['api-access','API access','/?view=api-access'],
  ]},
  {title:'Workspace',items:[
    ['record-access','Record access history','/?view=record-access'],
    ['email-settings','Email settings','/?view=email-settings'],
    ['getting-started','Getting started','/?view=getting-started'],
    ['job-queue','Job queue','/?view=job-queue'],
  ]},
] as const;
type SettingsId=(typeof groups)[number]['items'][number][0];
export function PortableSettingsLayout({active,workspaceId,children}:{active:SettingsId;workspaceId?:string;children:ReactNode}){
  const navigation=useRef<HTMLElement>(null);
  useEffect(()=>{
    const strip=navigation.current;
    const link=strip?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    if(!strip||!link)return;
    // Move only the Settings strip so a URL fragment keeps its position in the page.
    const observer=new ResizeObserver(()=>{
      if(strip.scrollWidth<=strip.clientWidth)return;
      const bounds=strip.getBoundingClientRect(),item=link.getBoundingClientRect();
      if(item.left<bounds.left)strip.scrollLeft+=Math.floor(item.left-bounds.left)-8;
      else if(item.right>bounds.right)strip.scrollLeft+=Math.ceil(item.right-bounds.right)+8;
    });
    observer.observe(strip);
    return ()=>observer.disconnect();
  },[active,workspaceId]);
  return <div className="portable-settings-layout">
    <nav ref={navigation} aria-label="Settings navigation" className="portable-settings-navigation">
      <strong>Settings</strong>
      {groups.map(group=>{
        const items=group.items.filter(([id])=>!workspaceId||id==='overview');
        if(!items.length)return null;
        return <div key={group.title}>
          {group.title&&group.title!=='Data management'&&<h2>{group.title}</h2>}
          {items.map(([id,label,href])=><a key={id} href={workspaceId?href+'&workspaceId='+encodeURIComponent(workspaceId):href}
            data-level={id==='pipelines'?2:group.title==='Data management'&&id!=='data-management'?1:undefined}
            aria-current={id===active?'page':undefined}>{workspaceId?'Your access':label}</a>)}
        </div>;
      })}
    </nav>
    <div className="portable-settings-pane">{children}</div>
  </div>;
}
