'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {readManualNoteBatch} from '../db/postgres/manual-workflow-batch-store';
import {jobIssueLabel,jobStateLabels} from '../lib/portable-job-labels';
import {portableManualBatchLimit} from '../lib/portable-workflows';
import {PortableRecordPicker} from './portable-record-picker';

type Choice={id:string;name:string};
type Receipt=NonNullable<Awaited<ReturnType<typeof readManualNoteBatch>>>;

export function PortableManualNoteBatch({workflowId,revision,disabled,onReceipt}:{
  workflowId:string;revision:number;disabled:boolean;onReceipt:(id:string)=>void;
}){
  const submitting=useRef(false);
  const pending=useRef<{key:string;id:string}|null>(null);
  const [contacts,setContacts]=useState<Choice[]>([]);
  const [choice,setChoice]=useState<Choice|null>(null);
  const [pickerKey,setPickerKey]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const unavailable=disabled||busy;
  const canAdd=!!choice&&contacts.length<portableManualBatchLimit&&!contacts.some(contact=>contact.id===choice.id);

  function add(){
    if(!choice||!canAdd)return;
    setContacts([...contacts,choice]);
    setChoice(null);
    setPickerKey(key=>key+1);
    setError('');
  }

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(submitting.current||unavailable||contacts.length<2)return;
    submitting.current=true;
    setBusy(true);
    setError('');
    const contactIds=contacts.map(contact=>contact.id).sort();
    const key=['harbor-manual-note-batch',workflowId,revision,...contactIds].join(':');
    let id=pending.current?.key===key?pending.current.id:null;
    try{id??=sessionStorage.getItem(key);}catch{}
    id??=crypto.randomUUID();
    pending.current={key,id};
    try{sessionStorage.setItem(key,id);}catch{}
    try{
      const response=await fetch('/api/workflows',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'runContactBatch',id,workflowId,workflowRevision:revision,contactIds})});
      const result=await response.json() as {error?:string;batch?:{id:string}};
      if(!response.ok){setError(result.error??'Could not queue the Note batch.');return;}
      if(result.batch?.id!==id)throw Error();
      pending.current=null;
      try{sessionStorage.removeItem(key);}catch{}
      setContacts([]);
      setChoice(null);
      setPickerKey(key=>key+1);
      onReceipt(id);
    }catch{setError('Could not confirm this batch. Retry with the same contacts to check its receipt.');}
    finally{submitting.current=false;setBusy(false);}
  }

  return <details>
    <summary>Run a Note for multiple contacts</summary>
    <p>Choose 2 to {portableManualBatchLimit} contacts. Harbor queues one Note per contact after the entire selection passes its checks.</p>
    <form onSubmit={submit}>
      <fieldset disabled={unavailable}>
        <PortableRecordPicker key={pickerKey} kind="contacts" field="batchCandidate" label="Contact to add" value={null} onSelect={setChoice}/>
        <button type="button" onClick={add} disabled={!canAdd}>Add contact to batch</button>
        <ul>{contacts.map(contact=><li key={contact.id}>{contact.name}{' '}
          <button type="button" aria-label={'Remove '+contact.name}
            onClick={()=>setContacts(contacts.filter(item=>item.id!==contact.id))}>Remove</button>
        </li>)}</ul>
      </fieldset>
      <button type="submit" disabled={unavailable||contacts.length<2}>Queue Note batch</button>
      {error&&<p role="alert">{error}</p>}
    </form>
  </details>;
}

export function PortableManualBatchReceipt({batchId,onClose}:{batchId:string;onClose:()=>void}){
  const [receipt,setReceipt]=useState<Receipt|null>(null);
  const [error,setError]=useState(false);
  const [refresh,setRefresh]=useState(0);

  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/workflows?'+new URLSearchParams({batchId}),{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as {batch:Receipt};
      if(!controller.signal.aborted){setReceipt(result.batch);setError(false);}
    }).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[batchId,refresh]);

  return <section aria-label="Manual Note batch receipt">
    <h2>Manual Note batch receipt</h2>
    <p>Batch ID <code>{batchId}</code></p>
    <button type="button" onClick={()=>{setError(false);setRefresh(value=>value+1);}}>Refresh batch status</button>{' '}
    <button type="button" onClick={onClose}>Close receipt</button>
    {error?<p role="alert">Could not load this batch receipt.</p>:!receipt?<p role="status">Loading batch…</p>:<>
      <p>{receipt.workflowName} · {receipt.runs.length} contacts</p>
      <ul>{receipt.runs.map(run=><li key={run.id}>
        {run.contactName} · {jobStateLabels[run.status]} · {run.attempts} attempts{' '}
        <code>{run.jobId}</code>
        {run.issue&&<> · {jobIssueLabel(run.issue)}</>}
      </li>)}</ul>
    </>}
  </section>;
}
