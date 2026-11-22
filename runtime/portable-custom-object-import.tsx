'use client';

import './portable-contact-import.css';
import {useState} from 'react';
import type {ObjectDefinition} from '../lib/portable-custom-objects';
import {objectImportLimit,objectImportBytes,type ObjectCsvPreview} from '../lib/portable-object-import';
import type {RecordImportResult} from '../lib/portable-contact-import';
import type {CustomValue} from '../lib/property-values';

function display(value:CustomValue|null){
  if(value===null)return 'Empty';
  if(typeof value==='boolean')return value?'Yes':'No';
  return Array.isArray(value)?value.join('; '):String(value);
}

export function CustomObjectImport({type,list}:{type:{id:string;definition:ObjectDefinition};list:string}){
  const [csv,setCsv]=useState(''),[preview,setPreview]=useState<ObjectCsvPreview>(),[requestId,setRequestId]=useState('');
  const [retryOnly,setRetryOnly]=useState(false);
  const [result,setResult]=useState<RecordImportResult>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  function edit(value:string){
    setCsv(value);setPreview(undefined);setRequestId('');setResult(undefined);setError('');
  }
  async function submit(apply:boolean){
    if(busy)return;
    setBusy(true);setError('');
    if(apply)setRetryOnly(true);
    try{
      const response=await fetch('/api/custom-objects',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:apply?'apply_csv':'preview_csv',objectId:type.id,csv,...(apply?{requestId,review:preview?.review}:{})})});
      if(!response.ok){
        if(response.status>=400&&response.status<500)setRetryOnly(false);
        const body=await response.json() as {error?:string};
        if(response.status===409)setPreview(undefined);
        throw Error(body.error||'Could not read the spreadsheet.');
      }
      if(apply){setResult(await response.json() as RecordImportResult);setPreview(undefined);setRetryOnly(false);}
      else{setPreview(await response.json() as ObjectCsvPreview);setRequestId(crypto.randomUUID());}
    }catch(err){setError(err instanceof TypeError?'Connection interrupted. Try the same request again.':err instanceof Error?err.message:'Could not confirm the import.');}
    finally{setBusy(false);}
  }
  if(result)return <section aria-label="Import result"><p role="status">Imported {result.created} new, updated {result.updated??0}, skipped {result.skipped}.</p>
    <a href={list}>View records</a> · <button type="button" onClick={()=>edit('')}>Import another file</button></section>;
  return <section className="portable-csv-import" aria-label="Custom record import">
    <p>Use Name for new records and Harbor’s Record ID for updates. Blank cells keep existing values. Record owner is ignored. New records run any enabled creation workflows for this object.</p>
    <details><summary>Accepted columns</summary><ul><li>Name</li><li>Record ID</li>
      {type.definition.fields.map(field=><li key={field.id}>Property: {field.label}{field.required?' (required)':''}</li>)}</ul>
      <p>Use YYYY-MM-DD for dates, Yes or No for checkboxes, and semicolons between multiple choices.</p></details>
    <fieldset disabled={busy||retryOnly}><legend>Spreadsheet</legend><label className="portable-csv-upload">CSV file <input type="file" accept=".csv,text/csv" onChange={async event=>{
      const file=event.target.files?.[0];if(!file)return;
      edit('');
      if(file.size>objectImportBytes){setError('Choose a file of 250 KB or less.');return;}
      setBusy(true);try{edit(await file.text());}catch{setError('Could not read this file.');}finally{setBusy(false);}
    }}/></label>
      <label>CSV contents<textarea value={csv} rows={6} onChange={e=>edit(e.target.value)}/></label>
      <p>Up to {objectImportLimit} records per import.</p>
      <button type="button" disabled={!csv.trim()} onClick={()=>void submit(false)}>Preview changes</button>
    </fieldset>
    {error&&<p className="portable-csv-feedback" role="alert">{error}</p>}
    {preview&&<section className="portable-csv-review" aria-label="Import preview"><h2>Review changes</h2>
      <table><thead><tr><th>Row</th><th>Record</th><th>Action</th><th>Changes</th></tr></thead>
        <tbody>{preview.rows.map(r=><tr key={r.row}><td>{r.row}</td><th scope="row">{r.name||'—'}</th><td>{r.state}</td>
          <td>{r.error||(!r.changes.length?'No changes':<ul>{r.changes.map((change,i)=><li key={i}>{change.label}: {display(change.before)} → {display(change.after)}</li>)}</ul>)}</td></tr>)}</tbody></table>
      <button type="button" disabled={busy||preview.rows.some(r=>r.state==='error')||preview.rows.every(r=>r.state==='skip')} onClick={()=>void submit(true)}>{retryOnly&&!busy?'Retry the same import':'Apply import'}</button>
    </section>}
  </section>;
}
