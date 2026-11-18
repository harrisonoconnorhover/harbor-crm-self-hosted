'use client';

import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import type {PortableFileSort} from '../db/postgres/portable-file-library-store';
import type {PortableFolderWrite} from '../lib/portable-file-folders';

type Folder={id:string;name:string;revision:number};
type ManagedFolder=Folder&{parentId:string|null};
type FolderPage={folders:Folder[];next:string|null};
type MoveFile={contactId:string;fileId:string;versionId:string;folderId:string|null;locationRevision:number};
const endpoint='/api/file-folders';
const nameLimit=120;

function folderPath(search:string|undefined,folder:string,sort:PortableFileSort,contactId?:string){
  const params=new URLSearchParams({view:'files'});
  if(search)params.set('search',search);
  params.set('folder',folder);
  if(sort!=='default')params.set('sort',sort);
  if(contactId)params.set('contactId',contactId);
  return '/?'+params;
}

function FolderPages({refresh,parentId,renderFolder}:{refresh?:number;parentId?:string;renderFolder:(folder:Folder)=>ReactNode}){
  const [after,setAfter]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  const [loaded,setLoaded]=useState<{key:string;page?:FolderPage}>();
  const key=JSON.stringify([after,parentId,retry,refresh]);
  const result=loaded?.key===key?loaded:undefined;
  const next=result?.page?.next;

  useEffect(()=>{
    const controller=new AbortController();
    const params=new URLSearchParams();
    if(after)params.set('after',after);
    if(parentId)params.set('parentId',parentId);
    fetch(endpoint+(params.size?'?'+params:''),{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const page=await response.json() as FolderPage;
      if(!controller.signal.aborted)setLoaded({key,page});
    }).catch(()=>{if(!controller.signal.aborted)setLoaded({key});});
    return ()=>controller.abort();
  },[after,parentId,key]);

  return <>
    {!result?<p role="status">Loading folders…</p>:!result.page?<p role="alert">
      Could not load folders. <button type="button" onClick={()=>setRetry(value=>value+1)}>Retry</button>
    </p>:result.page.folders.length?<ul>{result.page.folders.map(folder=><li key={folder.id}>{renderFolder(folder)}</li>)}</ul>:
      <p>No folders on this page.</p>}
    {after&&<button type="button" onClick={()=>setAfter(null)}>First folder page</button>}{' '}
    {next&&<button type="button" onClick={()=>setAfter(next)}>Next folder page</button>}
  </>;
}

function useFolderMutation(){
  const pending=useRef(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  async function save(input:PortableFolderWrite,success:string){
    if(pending.current)return false;
    pending.current=true;
    setBusy(true);setError('');setStatus('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      if(!response.ok){
        const result=await response.json().catch(()=>null) as {error?:string}|null;
        throw Error(result?.error||'Could not save the change.');
      }
      setStatus(success);
      return true;
    }catch(error){
      setError(error instanceof Error?error.message:'Could not save the change.');
      return false;
    }finally{
      pending.current=false;
      setBusy(false);
    }
  }
  return {busy,error,status,save};
}

export function PortableFileFolders({folder,search,sort,contactId}:{folder:ManagedFolder|null;search?:string;sort:PortableFileSort;contactId?:string}){
  const router=useRouter();
  const [open,setOpen]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [moving,setMoving]=useState(false);
  const creation=useRef<{id:string;name:string}|null>(null);
  const {busy,error,status,save}=useFolderMutation();

  async function moveFolder(parentId:string|null){
    if(!folder)return;
    if(await save({action:'moveFolder',id:folder.id,expectedRevision:folder.revision,parentId},'Folder moved.')){
      setRefresh(value=>value+1);
      router.refresh();
    }
  }

  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{folder?'Browse and manage subfolders':'Browse and manage folders'}</summary>
    {open&&<FolderPages key={folder?.id??'root'} parentId={folder?.id??'root'} refresh={refresh}
      renderFolder={entry=><a href={folderPath(search,entry.id,sort,contactId)}>{entry.name}</a>}/>}
    <form onSubmit={async event=>{
      event.preventDefault();
      const name=String(new FormData(event.currentTarget).get('name')??'').trim();
      if(!name)return;
      const draft=creation.current?.name===name?creation.current:{id:crypto.randomUUID(),name};
      creation.current=draft;
      if(await save({action:'create',...draft,parentId:folder?.id??null},'Folder created.')){
        creation.current=null;
        window.location.assign(folderPath(search,draft.id,sort,contactId));
      }
    }}>
      <label>{folder?'New subfolder name':'New folder name'}<input name="name" maxLength={nameLimit} required/></label>
      <button type="submit" disabled={busy}>{folder?'Create subfolder':'Create folder'}</button>
    </form>
    {folder&&<form key={folder.id+':'+folder.revision} onSubmit={async event=>{
      event.preventDefault();
      const name=String(new FormData(event.currentTarget).get('name')??'').trim();
      if(!name)return;
      if(await save({action:'rename',id:folder.id,expectedRevision:folder.revision,name},'Folder renamed.')){
        setRefresh(value=>value+1);
        router.refresh();
      }
    }}>
      <label>Folder name<input name="name" defaultValue={folder.name} maxLength={nameLimit} required/></label>
      <button type="submit" disabled={busy}>Rename folder</button>{' '}
      <button type="button" disabled={busy} onClick={async()=>{
        if(window.confirm('Delete the empty folder “'+folder.name+'”?')&&
          await save({action:'remove',id:folder.id,expectedRevision:folder.revision},'Folder deleted.')){
          window.location.assign(folderPath(search,folder.parentId??'root',sort,contactId));
        }
      }}>Delete empty folder</button>
    </form>}
    {folder&&<details onToggle={event=>setMoving(event.currentTarget.open)}>
      <summary>Move this folder</summary>
      {moving&&<>
        <button type="button" disabled={busy||folder.parentId===null} onClick={()=>void moveFolder(null)}>Move folder to Root</button>
        <FolderPages refresh={refresh} renderFolder={destination=><button type="button"
          disabled={busy||destination.id===folder.id||destination.id===folder.parentId}
          onClick={()=>void moveFolder(destination.id)}>Move folder to {destination.name}</button>}/>
      </>}
    </details>}
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}

export function PortableFileMove({file,name,filtered}:{file:MoveFile;name:string;filtered:boolean}){
  const router=useRouter();
  const details=useRef<HTMLDetailsElement>(null);
  const [open,setOpen]=useState(false);
  const {busy,error,status,save}=useFolderMutation();

  async function move(folderId:string|null){
    const {contactId,fileId,versionId,locationRevision}=file;
    if(await save({action:'move',contactId,fileId,versionId,expectedRevision:locationRevision,folderId},'File moved.')){
      if(details.current)details.current.open=false;
      if(filtered)document.getElementById('portable-files-title')?.focus();
      else details.current?.querySelector('summary')?.focus();
      router.refresh();
    }
  }

  return <>
    <details ref={details} onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary aria-label={'Move '+name}>Move</summary>
      {open&&<>
        <button type="button" disabled={busy||file.folderId===null} onClick={()=>void move(null)}>Move to Root</button>
        <FolderPages renderFolder={folder=><button type="button" disabled={busy||file.folderId===folder.id}
          onClick={()=>void move(folder.id)}>Move to {folder.name}</button>}/>
        {error&&<p role="alert">{error}</p>}
      </>}
    </details>
    {status&&<p role="status">{status}</p>}
  </>;
}
