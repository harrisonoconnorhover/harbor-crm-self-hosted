'use client';

import {useState} from 'react';

export function PortableQuoteExportButton({href}:{href:string}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function download(){
    setBusy(true);
    setError('');
    try{
      const response=await fetch(href,{cache:'no-store'});
      if(!response.ok){
        const result=await response.json().catch(()=>null) as {error?:string}|null;
        throw new Error(result?.error??'Could not export quotes.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw new Error('Expected a quote CSV.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-quotes.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error instanceof Error?error.message:'Could not export quotes.');}
    finally{setBusy(false);}
  }
  return <><button type="button" onClick={()=>void download()} disabled={busy}>{busy?'Preparing CSV…':'Export CSV'}</button>
    {error&&<p role="alert">{error}</p>}</>;
}
