'use client';

import {useEffect,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {objectPath} from '../lib/portable-custom-objects';
import type {PortableRecordKind} from '../lib/portable-records';

type Item={id:string;data:{name:string}};
type Preview={records:Item[];next:string|null};

function useLinkedPreview<T>(url:string){
  const [page,setPage]=useState<T|'unavailable'>();
  useEffect(()=>{
    const controller=new AbortController();
    fetch(url,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as T;
      if(!controller.signal.aborted)setPage(result);
    }).catch(()=>{if(!controller.signal.aborted)setPage('unavailable');});
    return ()=>controller.abort();
  },[url]);
  return page;
}

export function PortableLinkedRecords({kind,field,id,workspaceId,href,recordHref,addHref}:{
  kind:'contacts'|'deals';field:'companyId'|'primaryContactId';id:string;workspaceId?:string;
  href:string;recordHref:(id:string)=>string;addHref?:string;
}){
  const query=new URLSearchParams({kind,[field]:id,limit:'3',...(workspaceId?{workspaceId}:{})});
  const page=useLinkedPreview<Preview>('/api/crm?'+query);

  return <div className="portable-linked-record-group">
    <h3><a href={href}>{kind==='contacts'?'Linked contacts':'Linked deals'}</a></h3>
    {page==='unavailable'?<p>Could not load this preview.</p>:page?.records.length?
      <ul>{page.records.map(record=><li key={record.id}><a href={recordHref(record.id)}>
        <span>{record.data.name}</span><ChevronRight size={15} aria-hidden="true"/>
      </a></li>)}</ul>:<p>{page?'No linked '+kind+'.':'Loading linked '+kind+'…'}</p>}
    {page&&page!=='unavailable'&&page.next&&<a className="portable-record-action" href={href}>View all linked {kind}</a>}
    {addHref&&<a className="portable-record-action" href={addHref}>Add deal</a>}
  </div>;
}

export function PortableLinkedCustomRecords({kind,id,workspaceId}:{kind:PortableRecordKind;id:string;workspaceId?:string}){
  const params={kind,target:id,...workspaceId?{workspaceId}:{}};
  const href=objectPath(params);
  const page=useLinkedPreview<{items:{id:string;objectId:string;recordId:string;name:string;typeName:string}[];next:string|null}>(
    '/api/custom-objects?'+new URLSearchParams({...params,preview:'1'}));
  return <section className="portable-linked-record-group" aria-label="Linked custom records">
    <h3><a href={href}>Linked custom records</a></h3>
    {page==='unavailable'?<p>Could not load this preview.</p>:page?.items.length?
      <ul>{page.items.map(row=><li key={row.id}>
        <a href={objectPath({workspaceId,objectId:row.objectId,record:row.recordId})}>
          <span>{row.name} · {row.typeName}</span><ChevronRight size={15} aria-hidden="true"/>
        </a>
      </li>)}</ul>:<p>{page?'No linked custom records.':'Loading linked custom records…'}</p>}
    {page&&page!=='unavailable'&&page.next&&<a className="portable-record-action" href={href}>View all linked custom records</a>}
  </section>;
}
