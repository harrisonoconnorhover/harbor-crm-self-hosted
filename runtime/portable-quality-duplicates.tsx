'use client';

import {useState} from 'react';
import {WorkspaceNumber} from './portable-workspace-format';
import {portableDuplicatesLink,type PortableDuplicatePage} from '../lib/portable-duplicates';

export function QualityDuplicates(){
  const [result,setResult]=useState<Pick<PortableDuplicatePage,'total'|'limited'>[]>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function check(){
    setBusy(true);setError('');
    try{
      const counts=await Promise.all((['contacts','companies'] as const).map(async kind=>{
        const response=await fetch('/api/duplicates?kind='+kind,{cache:'no-store'});
        if(!response.ok)throw Error();
        const page=await response.json() as PortableDuplicatePage;
        return {total:page.total,limited:page.limited};
      }));
      setResult(counts);
    }catch{setError('Could not check duplicates. Open the review or try again.');}
    finally{setBusy(false);}
  }
  return <>
    <p>Find matching contacts and companies. Dismissed pairs stay out of the suggestions.</p>
    <div className="quality-links">
      <a href={portableDuplicatesLink('contacts')}>Review contact duplicates</a>
      <a href={portableDuplicatesLink('companies')}>Review company duplicates</a>
    </div>
    <button type="button" disabled={busy} onClick={()=>void check()}>{busy?'Checking…':'Check suggested pairs'}</button>
    {error&&<p role="alert">{error}</p>}
    {result&&!error&&<p role="status"><WorkspaceNumber value={result[0].total}/>{result[0].limited?'+':''} contact pairs · <WorkspaceNumber value={result[1].total}/>{result[1].limited?'+':''} company pairs</p>}
  </>;
}
