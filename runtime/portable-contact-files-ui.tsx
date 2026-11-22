'use client';

import {WorkspaceNumber} from './portable-workspace-format';
import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useState,type FormEvent} from 'react';
import {MAX_ATTACHMENT_BYTES} from '../lib/activity-attachments';

type Entry={id:string;versionId:string;name:string;size:number};
type Page={files:Entry[];next:string|null};
type Version=Entry&{revision:number;createdAt:string};
type VersionPage={versions:Version[];next:number|null};
type Attempt={file:File;fileId:string;versionId:string;expectedVersion?:string};
const fileHref=(base:string,entry:Pick<Entry,'id'|'versionId'>)=>base+'&fileId='+entry.id+'&versionId='+entry.versionId;

function FileVersionHistory({base,entry}:{base:string;entry:Entry}){
  const [open,setOpen]=useState(false);
  const [before,setBefore]=useState<number>();
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{page?:VersionPage}>();

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const query=new URLSearchParams({versionsFor:entry.id});
    if(before!==undefined)query.set('beforeRevision',String(before));
    fetch(base+'&'+query,{signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as VersionPage;
      if(!controller.signal.aborted)setResult({page});
    }).catch(()=>{if(!controller.signal.aborted)setResult({});});
    return ()=>controller.abort();
  },[base,before,entry.id,open,retry]);

  function pageTo(revision?:number){
    setResult(undefined);
    setBefore(revision);
  }
  const page=result?.page;
  const next=page?.next;

  return <details className="portable-file-version-history" onToggle={event=>{
    setOpen(event.currentTarget.open);
    if(!event.currentTarget.open)pageTo();
  }}>
    <summary aria-label={'Version history for '+entry.name}>Version history</summary>
    {open&&(!result?<p role="status">Loading file versions…</p>:!page?
      <p role="alert">Could not load file versions.{' '}
        <button type="button" onClick={()=>{setResult(undefined);setRetry(value=>value+1);}}>Retry</button>
      </p>:<>
        {page.versions.length?<ol>{page.versions.map((version,index)=><li key={version.versionId}>
          Version {version.revision}{before===undefined&&index===0?' (current)':''}{' · '}
          <a href={fileHref(base,version)}>{version.name}</a> (<WorkspaceNumber value={version.size}>{version.size.toLocaleString()}</WorkspaceNumber> bytes)
          {' · '}<time dateTime={version.createdAt}><WorkspaceDate value={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</WorkspaceDate></time>
        </li>)}</ol>:<p>No older versions on this page.</p>}
        {before!==undefined&&<button type="button" onClick={()=>pageTo()}>Latest versions</button>}{' '}
        {next!=null&&<button type="button" onClick={()=>pageTo(next)}>Older versions</button>}
      </>)}
  </details>;
}

export function PortableContactFiles({recordId,workspaceId,grantId,readOnly,canCreate=true,canReplace=true}:{recordId:string;workspaceId?:string;grantId?:string;readOnly:boolean;canCreate?:boolean;canReplace?:boolean}){
  const [page,setPage]=useState<Page>();
  const [after,setAfter]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [file,setFile]=useState<File>();
  const [replace,setReplace]=useState('');
  const [attempt,setAttempt]=useState<Attempt>();
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [saved,setSaved]=useState<Pick<Entry,'id'|'versionId'>>();
  const params=new URLSearchParams({recordId});
  if(workspaceId)params.set('workspaceId',workspaceId);
  const base='/api/record-attachments?'+params;

  useEffect(()=>{
    const controller=new AbortController();
    fetch(base+(after?'&after='+after:''),{signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw Error();
        setPage(await response.json() as Page);
      }).catch(()=>{if(!controller.signal.aborted)setError('Could not load contact files.');});
    return ()=>controller.abort();
  },[base,after,refresh]);

  async function upload(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!file||file.size<1||file.size>MAX_ATTACHMENT_BYTES){setError('Choose a file of up to 10 MB.');return;}
    const form=event.currentTarget;
    const current=page?.files.find(row=>row.id===replace);
    if(current?!canReplace:!canCreate){setError('Choose a permitted file operation.');return;}
    const pending=attempt??{file,fileId:current?.id??crypto.randomUUID(),versionId:crypto.randomUUID(),expectedVersion:current?.versionId};
    setAttempt(pending);
    setSaving(true);
    setError('');
    setSaved(undefined);
    try{
      const query=new URLSearchParams({fileId:pending.fileId,versionId:pending.versionId});
      if(grantId)query.set('grantId',grantId);
      if(pending.expectedVersion)query.set('expectedVersion',pending.expectedVersion);
      const response=await fetch(base+'&'+query,{method:'POST',body:pending.file,
        headers:{'content-type':'application/octet-stream','x-harbor-file-name':encodeURIComponent(pending.file.name)}});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        setError(result.error||'Could not save file.');
        if(response.status===409){setAttempt(undefined);setRefresh(value=>value+1);}
        return;
      }
      const result=await response.json() as {file?:Entry};
      if(result.file?.id!==pending.fileId||result.file.versionId!==pending.versionId)throw Error('The saved file version could not be confirmed.');
      form.reset();
      setFile(undefined);
      setReplace('');
      setAttempt(undefined);
      setAfter('');
      setRefresh(value=>value+1);
      setSaved(result.file);
    }catch{setError('Could not confirm the upload. Retry to check the same version.');}
    finally{setSaving(false);}
  }

  function goTo(next:string){
    setAfter(next);
    setPage(undefined);
    setReplace('');
    setAttempt(undefined);
    setError('');
  }

  return <section id="portable-contact-files" className="portable-record-panel" aria-label="Contact files" tabIndex={-1}>
    <h2>Contact files</h2>
    <a href={'/?'+new URLSearchParams({view:'files',contactId:recordId,...(workspaceId?{workspaceId}:{})})}>View in Files library</a>
    {!page&&!error&&<p>Loading files…</p>}
    {page&&(page.files.length?<ul>{page.files.map(entry=><li key={entry.id}>
      <a href={fileHref(base,entry)}>{entry.name}</a> (<WorkspaceNumber value={entry.size}>{entry.size.toLocaleString()}</WorkspaceNumber> bytes){' '}
      {!workspaceId&&<a href={'/?'+new URLSearchParams({view:'record-access',action:'document',kind:'contacts',record:recordId,file:entry.id})}
        aria-label={'Download history for '+entry.name}>Download history</a>}
      <FileVersionHistory key={entry.versionId} base={base} entry={entry}/>
    </li>)}</ul>:<p>No files on this page.</p>)}
    {after&&<button type="button" disabled={saving} onClick={()=>goTo('')}>First files</button>}{' '}
    {page?.next&&<button type="button" disabled={saving} onClick={()=>goTo(page.next!)}>Next files</button>}
    {!readOnly&&(canCreate||canReplace&&!!page?.files.length)&&<form onSubmit={upload}>
      <fieldset disabled={saving}>
        <label>Save as<select value={replace} onChange={event=>{setReplace(event.target.value);setAttempt(undefined);}}>
          {canCreate?<option value="">New file</option>:<option value="" disabled>Choose a file to replace</option>}
          {canReplace&&page?.files.map(entry=><option key={entry.id} value={entry.id}>Replace {entry.name}</option>)}
        </select></label>
        <label>File<input type="file" required onChange={event=>{setFile(event.target.files?.[0]);setAttempt(undefined);}}/></label>
      </fieldset>
      <button type="submit" disabled={saving||!canCreate&&!replace}>{saving?'Uploading…':'Upload file'}</button>
    </form>}
    {error&&<p role="alert">{error}</p>}
    {saved&&<p role="status">File saved. <a href={fileHref(base,saved)}>Download saved file</a></p>}
  </section>;
}
