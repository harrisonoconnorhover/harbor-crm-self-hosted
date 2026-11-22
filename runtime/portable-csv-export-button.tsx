'use client';

import {useState} from 'react';

export function PortableCsvExportButton({href,filename}:{href:string;filename:string}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function download(){
    setBusy(true);
    setError('');
    try{
      const response=await fetch(href,{cache:'no-store'});
      if(!response.ok){
        const result=await response.json().catch(()=>null) as {error?:string}|null;
        throw new Error(result?.error??'Could not export these records.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw new Error('Expected a CSV download.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download=filename;
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error instanceof Error?error.message:'Could not export these records.');}
    finally{setBusy(false);}
  }
  return <><button type="button" onClick={()=>void download()} disabled={busy}>{busy?'Preparing CSV…':'Export CSV'}</button>
    {error&&<p role="alert">{error}</p>}</>;
}
