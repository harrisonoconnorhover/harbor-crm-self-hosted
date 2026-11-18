"use client";
import {useEffect,useState} from 'react';
import type {Kind} from '@/lib/crm';import type {FilterField} from '@/lib/filters';import {Dialog} from './workspace-tools';
export function HistoryExportDialog({kind,field,onClose}:{kind:Kind;field:FilterField;onClose:()=>void}){
 const [limit,setLimit]=useState(kind==='contacts'?45:20),[sources,setSources]=useState(true),[authors,setAuthors]=useState(true),[ready,setReady]=useState(false),[error,setError]=useState(''),[count,setCount]=useState(0);
 const url='/api/property-history-export?'+new URLSearchParams({kind,field:field.id,limit:String(limit),sources:sources?'1':'0',authors:authors?'1':'0'});
 useEffect(()=>{const controller=new AbortController();setReady(false);setError('');fetch(url+'&preview=1',{signal:controller.signal,cache:'no-store'}).then(async res=>{const data=await res.json() as {error?:string;records:number};if(!res.ok)throw Error(data.error||'Could not prepare export.');if(!controller.signal.aborted){setCount(data.records);setReady(true);}}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not prepare export.');});return()=>controller.abort();},[url]);
 return <Dialog title={`Export property history · ${field.label}`} busy={false} onClose={onClose}><div className="tool-body">
  <p>Download one CSV row per record that has or previously had a value. Current and prior values appear newest to oldest, with change dates in UTC.</p>
  <label className="form-field">Previous values per record<input aria-label="Previous values per record" type="number" min={1} max={50} value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
  <label className="history-export-source"><input type="checkbox" checked={sources} onChange={e=>setSources(e.target.checked)}/> Include source information</label>
  <label className="history-export-source"><input type="checkbox" checked={authors} onChange={e=>setAuthors(e.target.checked)}/> Include author IDs and names</label>
  <p className="muted">Unknown dates and authors stay blank. Author names reflect what was recorded at the time of the change. The file flags omitted older values, gaps and excluded secondary merge history. Calculated properties cannot be exported. Records are read as the export runs.</p>
  <details><summary>Restore a prior value using this file</summary><p>Keep Record ID and the value column you want, preserving its header. Import up to 500 rows using Update existing records, then review the changes. Keep marked column headers and cell contents unchanged. Harbor removes spreadsheet-safe text: prefixes when importing. <code>~empty</code> clears a value; a blank historical slot leaves it unchanged. Removed choices or required fields may need correction; stages may require their matching pipeline column.</p></details>
  {error&&<p role="alert" className="form-error">{error}</p>}
  <footer className="history-footer"><button className="secondary" onClick={onClose}>Back</button>{ready?<><span>{count.toLocaleString()} records to check · CSV</span><a className="primary" href={url} download>Download CSV</a></>:!error?<span>Preparing export…</span>:null}</footer>
 </div></Dialog>;
}
