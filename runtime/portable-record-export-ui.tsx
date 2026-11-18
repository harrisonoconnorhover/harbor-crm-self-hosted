'use client';

import {useState} from 'react';
import type {PortableRecordKind} from '../lib/portable-records';

export function PortableRecordExport({kind,listLink}:{kind:PortableRecordKind;listLink:string}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function download(){
    setBusy(true);
    setError('');
    try{
      const query=new URL(listLink,window.location.origin).searchParams;
      query.set('export','csv');
      const result=await fetch('/api/crm?'+query);
      if(!result.ok){
        const body=await result.json() as {error?:string};
        setError(body.error||'Could not export this record list.');
        return;
      }
      if(!result.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected a CSV download.');
      const url=URL.createObjectURL(await result.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-'+kind+'.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch{setError('Could not export this record list. Try again.');}
    finally{setBusy(false);}
  }

  return <div><button type="button" onClick={download} disabled={busy}>{busy?'Preparing CSV…':'Export CSV'}</button>
    {error&&<p role="alert">{error}</p>}</div>;
}
