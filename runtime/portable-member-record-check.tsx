'use client';

import {useEffect,useId,useState} from 'react';
import {memberRecordTools,memberToolNames} from '../lib/portable-tool-permissions';
import {CustomRecordPicker} from './portable-custom-link-picker';
import {PortableRecordPicker} from './portable-record-picker';

type RecordKind=typeof memberRecordTools[number];

function AccessResult({kind,recordId,memberId,objectId}:{kind:RecordKind;recordId:string;memberId:string;objectId?:string}){
  const [message,setMessage]=useState('Checking access…');
  const [checking,setChecking]=useState(true);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    async function check(){
      try{
        const response=await fetch('/api/workspaces',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},
          body:JSON.stringify({action:'check_member_record',memberId,kind,recordId,objectId})});
        if(!response.ok)throw Error(response.status===404?'This teammate or record is no longer available.':'Could not check record access.');
        const {canView,canEdit}=await response.json() as {canView:boolean;canEdit:boolean};
        if(!controller.signal.aborted)setMessage(canEdit?'Can view and edit':canView?'Can view only':'No record access');
      }catch(error){
        if(!controller.signal.aborted){
          setMessage(error instanceof Error?error.message:'Could not check record access.');
        }
      }finally{if(!controller.signal.aborted)setChecking(false);}
    }
    void check();
    return ()=>controller.abort();
  },[memberId,kind,recordId,objectId,attempt]);
  return <><p role="status">{message}</p><button type="button" disabled={checking} onClick={()=>{
    setMessage('Checking access…');setChecking(true);setAttempt(attempt+1);
  }}>Check again</button></>;
}

export function MemberRecordCheck({memberId}:{memberId:string}){
  const [open,setOpen]=useState(false);
  const id=useId();
  const [kind,setKind]=useState<RecordKind>('contacts');
  const [selected,setSelected]=useState<{id:string;name:string;objectId?:string}|null>(null);
  return <div><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>Check a specific record</button>
    {open&&<><label htmlFor={id}>Record type</label><select id={id} value={kind} onChange={event=>{
      setKind(event.target.value as RecordKind);setSelected(null);
    }}>{memberRecordTools.map(option=><option key={option} value={option}>{memberToolNames[option]}</option>)}</select>
      {kind==='custom-objects'?<CustomRecordPicker action="Check access" onPick={(objectId,id,name)=>setSelected({objectId,id,name})}/>:
        <PortableRecordPicker key={kind} kind={kind} field="previewRecord" label="Record to check" value={selected} onSelect={setSelected} emptyLabel="Choose a record"/>}
      {selected&&<>{selected.objectId&&<p>{selected.name}</p>}<AccessResult key={memberId+kind+(selected.objectId??'')+selected.id} objectId={selected.objectId} kind={kind} memberId={memberId} recordId={selected.id}/></>}
    </>}
  </div>;
}
