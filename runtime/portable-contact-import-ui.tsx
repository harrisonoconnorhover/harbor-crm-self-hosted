'use client';

import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {portableCsvBytes,portableImportFields,portableImportName,type PortableCsvColumn,type PortableImportKind,
  type RecordImportPreview,type RecordImportResult} from '../lib/portable-contact-import';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import type {CustomValue} from '../lib/property-values';
import {portablePairedFields} from '../lib/portable-paired-import';
import './portable-contact-import.css';

type Source={csv:string;columns:PortableCsvColumn[]};
type Review={requestId:string;preview:RecordImportPreview;updateRows:number[];includeNew:boolean};
const submit=(body:unknown)=>fetch('/api/crm/import',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
});

const importGuidance={
  contacts:'Harbor matches contacts by email or exported Record ID. Review the differences and select the updates you want. Blank cells and ignored columns keep their saved values. Email and primary company stay unchanged on matches.',
  companies:'Match a company by its domain or exported Record ID. Review the proposed values and select the companies to update.',
  deals:'To update a deal, include its exported Record ID. A row without an ID creates a new deal, even if its name matches.',
  paired:'Map Contact · Email and Company · Domain. A row containing both links a new contact to that primary company. Harbor reuses a single matching company and skips existing contacts.',
} satisfies Record<PortableImportKind,string>;
const importSteps=['Upload CSV','Match columns','Review import'];
const rowStates={create:'New record',update:'Matched contact',skip:'Skipped',error:'Error'} as const;
function displayValue(value:CustomValue|null){
  return value===null||value===''?'Empty':Array.isArray(value)?value.join(', '):typeof value==='boolean'?(value?'Yes':'No'):String(value);
}
const focusStep=(element:HTMLElement|null)=>element?.focus();

export function PortableRecordImport({kind,customProperties,initiallyOpen=false}:{kind:PortableImportKind;customProperties:PortableCustomProperty[];initiallyOpen?:boolean}){
  const title=portableImportName(kind),recordName=title.toLowerCase();
  const singular={contacts:'contact',companies:'company',deals:'deal',paired:'row'}[kind];
  const fields=kind==='paired'?portablePairedFields():portableImportFields(kind,customProperties,true);
  const router=useRouter();
  const input=useRef<HTMLInputElement>(null);
  const [file,setFile]=useState<File|null>(null);
  const [source,setSource]=useState<Source|null>(null);
  const [review,setReview]=useState<Review|null>(null);
  const [busy,setBusy]=useState(false);
  const [retryOnly,setRetryOnly]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const step=review?2:source?1:0;
  const newCount=review?.includeNew?review.preview.created:0,updateCount=review?.updateRows.length??0;

  async function preview(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!file)return;
    setBusy(true);
    setReview(null);
    setError('');
    setStatus('');
    try{
      if(!source){
        if(file.size>portableCsvBytes)throw Error(`Choose a ${title} CSV of up to 250 KB.`);
        const csv=await file.text();
        const response=await submit({action:'columns',kind,csv,...(kind!=='paired'?{reviewMatches:true}:{})});
        if(!response.ok)throw Error((await response.json() as {error?:string}).error||'Could not read the CSV columns.');
        const {columns}=await response.json() as {columns:PortableCsvColumn[]};
        setSource({csv,columns});
        return;
      }
      const response=await submit({action:'preview',kind,csv:source.csv,mapping:source.columns.map(column=>column.target),
        ...(kind!=='paired'?{reviewMatches:true}:{})});
      if(!response.ok)throw Error((await response.json() as {error?:string}).error||'Could not preview this CSV.');
      setReview({requestId:crypto.randomUUID(),preview:await response.json() as RecordImportPreview,updateRows:[],includeNew:true});
    }catch(error){setError(error instanceof Error?error.message:'Could not preview this CSV.');}
    finally{setBusy(false);}
  }

  async function commit(){
    if(!review||!source)return;
    setBusy(true);
    setRetryOnly(true);
    setError('');
    try{
      const response=await submit({action:'import',kind,csv:source.csv,mapping:source.columns.map(column=>column.target),
        requestId:review.requestId,review:review.preview.review,...(kind!=='paired'?{
          reviewMatches:true,updateRows:review.updateRows,includeNew:review.includeNew}:{})});
      if(!response.ok){
        if(response.status===409)setReview(null);
        if(response.status>=400&&response.status<500)setRetryOnly(false);
        throw Error((await response.json() as {error?:string}).error||'Could not confirm the import. Retry the same request.');
      }
      const result=await response.json() as RecordImportResult;
      setStatus(result.paired
        ?`Created ${result.paired.contacts} contacts and ${result.paired.companies} companies. Reused ${result.paired.reusedCompanies} companies.`
        :result.updated?`Created ${result.created} · Updated ${result.updated} · Skipped ${result.skipped}.`:
        `Imported ${result.created} ${result.created===1?({contacts:'contact',companies:'company',deals:'deal',paired:'row'}[kind]):recordName}. Skipped ${result.skipped}.`);
      setReview(null);
      setSource(null);
      setRetryOnly(false);
      setFile(null);
      if(input.current)input.current.value='';
      router.refresh();
    }catch(error){setError(error instanceof Error?error.message:'Could not confirm the import. Retry the same request.');}
    finally{setBusy(false);}
  }

  return <details id={kind==='paired'?'portable-paired-import':'portable-record-import'} open={initiallyOpen||undefined}>
    <summary>{`Import ${title} CSV`}</summary>
    <div className="portable-csv-import">
      <ol className="portable-csv-steps" aria-label="Import steps">
        {importSteps.map((label,index)=><li key={label} aria-current={index===step?'step':undefined}>{label}</li>)}
      </ol>
      <p className="portable-csv-guidance">Up to 500 rows in one CSV file of up to 250 KB. {importGuidance[kind]}</p>
      <form onSubmit={preview}>
        <label className="portable-csv-upload">{title} CSV<input ref={input} type="file" accept=".csv,text/csv" required disabled={busy||retryOnly} onChange={event=>{
          setFile(event.currentTarget.files?.[0]??null);setSource(null);setReview(null);setError('');setStatus('');
        }}/></label>
        {source&&<fieldset className="portable-csv-mapping" disabled={busy||retryOnly}>
          <legend ref={focusStep} tabIndex={-1}>Column mapping</legend>
          <p>Match each CSV column to a property or choose Ignore column.</p>
          <ul>{source.columns.map(({header,target},index)=><li key={index}>
            <label>
              <span><span className="portable-csv-column-number">Column {index+1} · </span>{header||'Blank header'}</span>
              <select value={target} onChange={event=>{
                const target=event.currentTarget.value;
                setSource({...source,columns:source.columns.map((column,position)=>position===index?{...column,target}:column)});
                setReview(null);
                setError('');
              }}>
                <option value="">Ignore column</option>
                {fields.map(([id,label])=><option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          </li>)}</ul>
        </fieldset>}
        <button type="submit" disabled={busy||!file||!!review}>{source?'Preview import':'Map columns'}</button>
      </form>
      {review&&<section className="portable-csv-review" aria-label={title+' import review'}>
        <div className="portable-csv-review-heading">
          <h2 ref={focusStep} tabIndex={-1}>Review {recordName}</h2>
          <p><strong>{review.preview.created}</strong> to create, {!!review.preview.updates&&<><strong>{review.preview.updates}</strong> with changes to review, </>}
            <strong>{review.preview.skipped}</strong> skipped, <strong>{review.preview.errors}</strong> {review.preview.errors===1?'error':'errors'}.</p>
          {review.preview.paired&&<p>{review.preview.paired.contacts} new contacts · {review.preview.paired.companies} new companies · {review.preview.paired.reusedCompanies} existing companies</p>}
        </div>
        {!!review.preview.updates&&<div className="portable-csv-match-help">
          <p><strong>Choose which {recordName} to update.</strong> Only selected rows change. Blank cells keep their saved values. To leave a column unchanged for everyone, choose <b>Ignore column</b> above and preview again.</p>
          {review.preview.created>0&&<label className="portable-csv-choice"><input type="checkbox" checked={review.includeNew} disabled={busy||retryOnly}
            onChange={event=>setReview({...review,includeNew:event.target.checked})}/>
            Also create {review.preview.created} new {review.preview.created===1?singular:recordName}</label>}
        </div>}
        <ul className="portable-csv-review-rows">{review.preview.rows.map(row=>{
          const attributes=row.state==='create'?[row.email,row.domain,row.pipeline,row.stage].filter(Boolean).join(' · '):'';
          return <li key={row.object?row.object+':'+row.row:row.row}>
            <div className="portable-csv-row-heading">
              <span>Row {row.row}{row.object&&' · '+row.object}</span>
              <span className="portable-csv-row-state" data-state={row.state}>{row.state==='update'?'Matched '+singular:rowStates[row.state]}</span>
            </div>
            {row.state==='create'
              ?<div className="portable-csv-row-values"><strong>{row.name}</strong>
                {attributes&&<> · {attributes}</>}
                {row.company&&<> · Primary company: {row.company}</>}
                {row.custom&&<ul>{row.custom.map(({label,value})=><li key={label}>{label}{' · '}
                  {Array.isArray(value)?value.join(', '):typeof value==='boolean'?(value?'Yes':'No'):value}
                </li>)}</ul>}
              </div>
              :row.state==='update'?<div className="portable-csv-update">
                <label className="portable-csv-choice"><input type="checkbox" checked={review.updateRows.includes(row.row)} disabled={busy||retryOnly}
                  onChange={event=>setReview({...review,updateRows:event.target.checked?[...review.updateRows,row.row]:review.updateRows.filter(n=>n!==row.row)})}/>
                  <span>Update <strong>{row.name}</strong> <small>{row.email??row.identifier}</small></span></label>
                <dl className="portable-csv-changes">{row.changes.map(change=><div key={change.field}>
                  <dt>{change.label}</dt><dd><span>In Harbor</span>{displayValue(change.before)}</dd>
                  <dd><span>From CSV</span>{displayValue(change.after)}</dd>
                </div>)}</dl>
              </div>:<p>{row.message}</p>}
          </li>;
        })}</ul>
        <div className="portable-csv-review-footer">
          <button type="button" disabled={busy||!!review.preview.errors||!(newCount||updateCount)} onClick={commit}>
            {retryOnly&&!busy?'Retry this import':review.preview.updates?'Apply selected changes':'Import '+recordName}</button>
          {!!review.preview.updates&&<span role="status">{newCount} to create · {updateCount} to update</span>}
          {review.preview.errors>0?<p>Fix the errors in your CSV or column mapping before importing.</p>:
            !review.preview.created&&!review.preview.updates&&<p>There are no new records or updates in this preview.</p>}
        </div>
      </section>}
      {error&&<p className="portable-csv-feedback" role="alert">{error}</p>}
      <p className="portable-csv-feedback" role="status">{status}</p>
    </div>
  </details>;
}
