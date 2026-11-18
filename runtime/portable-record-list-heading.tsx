'use client';

import {useState,type ReactNode} from 'react';
import {ChevronDown,Plus,Settings2,ArrowDownUp} from 'lucide-react';
import './portable-record-list.css';

type Props={title:string;singular:string;onAdd?:()=>void;disabled:boolean;transfers?:ReactNode;exportOnly?:boolean;settings?:ReactNode;readOnly:boolean};

export function PortableRecordListHeading({title,singular,onAdd,disabled,transfers,exportOnly,settings,readOnly}:Props){
  const [panel,setPanel]=useState<'transfer'|'settings'>();
  return <>
    <div className="portable-contacts-heading portable-list-heading">
      <h1 id="portable-contacts-title">{title}</h1>
      <div className="portable-list-actions">
        {settings&&<button type="button" aria-expanded={panel==='settings'} aria-controls="portable-list-settings"
          onClick={()=>setPanel(panel==='settings'?undefined:'settings')}><Settings2 size={16} aria-hidden="true"/>{readOnly?'Your access':'List settings'}</button>}
        {transfers&&<button type="button" aria-expanded={panel==='transfer'} aria-controls="portable-list-transfer"
          onClick={()=>setPanel(panel==='transfer'?undefined:'transfer')}><ArrowDownUp size={16} aria-hidden="true"/>{exportOnly?'Export':'Import / export'}<ChevronDown size={14} aria-hidden="true"/></button>}
        {onAdd&&<button type="button" className="portable-list-add" onClick={onAdd} disabled={disabled}>
          <Plus size={16} aria-hidden="true"/>{'Add '+singular}</button>}
      </div>
    </div>
    {transfers&&<section id="portable-list-transfer" className="portable-list-panel" aria-label="Import and export" hidden={panel!=='transfer'}>
      {transfers}
    </section>}
    {settings&&<section id="portable-list-settings" className="portable-list-panel" aria-label="List settings" hidden={panel!=='settings'}>
      {settings}
    </section>}
  </>;
}
