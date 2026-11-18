'use client';

import {useEffect,useState} from 'react';
import {ChevronRight} from 'lucide-react';

type Item={id:string;data:{name:string}};
type Preview={records:Item[];next:string|null};

export function PortableLinkedRecords({kind,field,id,workspaceId,href,recordHref,addHref}:{
  kind:'contacts'|'deals';field:'companyId'|'primaryContactId';id:string;workspaceId?:string;
  href:string;recordHref:(id:string)=>string;addHref?:string;
}){
  const [page,setPage]=useState<Preview|'unavailable'>();
  useEffect(()=>{
    const controller=new AbortController();
    const query=new URLSearchParams({kind,[field]:id,limit:'3',...(workspaceId?{workspaceId}:{})});
    fetch('/api/crm?'+query,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as Preview;
      if(!controller.signal.aborted)setPage(result);
    }).catch(()=>{if(!controller.signal.aborted)setPage('unavailable');});
    return ()=>controller.abort();
  },[kind,field,id,workspaceId]);

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
