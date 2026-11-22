'use client';

import {useEffect,useState,type FormEvent} from 'react';
import type {readPortableAssociations} from '../db/postgres/portable-association-store';
import {portableRecordKind,portableRecordLabels,type PortableRecordKind} from '../lib/portable-records';
import type {PortableAssociationAction} from '../lib/portable-associations';
import {PortableRecordPicker} from './portable-record-picker';

type Page=NonNullable<Awaited<ReturnType<typeof readPortableAssociations>>>;
export function PortableAssociations({kind,id,workspaceId,grantId,readOnly,limitedEdit,recordHref}:{
  recordHref:(kind:PortableRecordKind,id:string)=>string;
  kind:PortableRecordKind;id:string;workspaceId?:string;grantId?:string;readOnly:boolean;limitedEdit:boolean;
}){
  const params=new URLSearchParams({kind,id});
  if(workspaceId)params.set('workspaceId',workspaceId);
  const endpoint='/api/associations?'+params;
  const [page,setPage]=useState<Page>();
  const [after,setAfter]=useState<string>();
  const [revision,setRevision]=useState(0);
  const [editing,setEditing]=useState<{id:string;original:string[];fields:string[]}>();
  const [linkFormVersion,setLinkFormVersion]=useState(0);
  const [targetKind,setTargetKind]=useState<PortableRecordKind>(kind==='companies'?'contacts':'companies');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');

  useEffect(()=>{
    const controller=new AbortController();
    fetch(endpoint+(after?'&after='+after:''),{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as Page;
      if(!controller.signal.aborted)setPage(result);
    }).catch(()=>{
      if(controller.signal.aborted)return;
      setPage(undefined);
      setError('Could not load associations.');
    });
    return ()=>controller.abort();
  },[endpoint,after,revision]);

  async function save(action:PortableAssociationAction){
    setBusy(true);
    setError('');
    setStatus('');
    try{
      const writeEndpoint=grantId?endpoint+'&'+new URLSearchParams({grantId}):endpoint;
      const response=await fetch(writeEndpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
      if(!response.ok){
        const body=await response.json() as {error?:string};
        if(response.status===409&&action.action!=='link'){
          setEditing(undefined);
          setPage(undefined);
          setRevision(value=>value+1);
        }
        setError(body.error||'Could not save the association.');
        return;
      }
      if(action.action!=='relabel')setAfter(undefined);
      setEditing(undefined);
      setRevision(value=>value+1);
      if(action.action==='link')setLinkFormVersion(value=>value+1);
      setStatus(action.action==='link'?'Records linked.':action.action==='relabel'?'Labels saved.':'Association removed.');
    }catch{setError('Could not confirm the change. Try the same request again.');}
    finally{setBusy(false);}
  }

  function link(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const data=new FormData(event.currentTarget),targetId=String(data.get('target')??'');
    if(!targetId){setError('Choose a record to link.');return;}
    const labels=String(data.get('labels')??'').split(',').map(value=>value.trim()).filter(Boolean);
    void save({action:'link',target:{kind:targetKind,id:targetId},labels});
  }

  return <section className="portable-additional-associations" aria-label="Additional associations">
    <h2>Additional associations</h2>
    {page&&!page.items.length&&<p>No additional associations on this page.</p>}
    {page?.items.length?<ul>{page.items.map(({id:linkId,target,labels,readOnly:targetReadOnly})=><li key={linkId}>
      <a href={recordHref(target.kind,target.id)}>{target.name}</a>
      <p>{[portableRecordLabels[target.kind],...labels].join(' · ')}</p>
      {!readOnly&&!targetReadOnly&&(editing?.id===linkId?
        <form aria-label={'Edit labels for '+target.name} onSubmit={event=>{
          event.preventDefault();
          void save({action:'relabel',linkId,expectedLabels:editing.original,labels:editing.fields.map(field=>field.trim()).filter(Boolean)});
        }}>
          <fieldset disabled={busy} className="portable-association-fields">
            {editing.fields.map((field,index)=><div key={index}>
              <label htmlFor={linkId+'-label-'+index}>Label {index+1}</label>
              <textarea id={linkId+'-label-'+index} rows={1} maxLength={80} value={field} onChange={event=>setEditing({...editing,
                fields:editing.fields.map((value,i)=>i===index?event.target.value:value)})}/>
            </div>)}
            <div className="portable-link-actions">
              {editing.fields.length<5&&<button type="button" onClick={()=>setEditing({...editing,fields:[...editing.fields,'']})}>Add label</button>}
              <button type="submit">Save labels</button>
              <button type="button" onClick={()=>setEditing(undefined)}>Cancel</button>
            </div>
          </fieldset>
        </form>:
        <div className="portable-link-actions">
          <button type="button" aria-label={'Edit labels for '+target.name} disabled={busy} onClick={()=>{
            setError('');setStatus('');setEditing({id:linkId,original:labels,fields:labels.length?[...labels]:['']});
          }}>Edit labels</button>
          <button type="button" aria-label={'Remove link to '+target.name} disabled={busy}
            onClick={()=>void save({action:'unlink',linkId,expectedLabels:labels})}>Remove link</button>
        </div>)}
    </li>)}</ul>:null}
    {after&&<button type="button" onClick={()=>setAfter(undefined)}>First links</button>}{' '}
    {page?.next&&<button type="button" onClick={()=>setAfter(page.next??undefined)}>More links</button>}
    {!readOnly&&<details><summary>Add association</summary>
      <form key={linkFormVersion} onSubmit={link}>
      <fieldset className="portable-association-fields" disabled={busy}>
        <label>Record type<select value={targetKind} onChange={event=>{
          const value=portableRecordKind.safeParse(event.target.value);
          if(value.success)setTargetKind(value.data);
        }}>{portableRecordKind.options.map(value=><option key={value} value={value}>{portableRecordLabels[value]}</option>)}</select></label>
        <PortableRecordPicker key={targetKind} kind={targetKind} editableOnly={limitedEdit} field="target" label="Record to link" value={null} workspaceId={workspaceId}/>
        <label>Labels (optional, comma separated)<input name="labels" maxLength={400}/></label>
        <button type="submit">Link record</button>
      </fieldset>
      </form>
    </details>}
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
