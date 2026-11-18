'use client';

import {useEffect,useRef,useState} from 'react';
import {portableContactFields,portableContactTextFields,type ContactRecord,type PortableContactTextField} from '../lib/portable-records';
import type {SharedRecordWriteScope} from '../lib/portable-workspace-access';

const labels={name:'Name',email:'Email',phone:'Phone number',title:'Job title',city:'City'};
const inputTypes={name:'text',email:'email',phone:'tel',title:'text',city:'text'};
type Edit={field:PortableContactTextField;value:string|null;revision:number};
type Notice={message:string;undo?:Edit};
type Failure={message:string;stale?:boolean};

export function PortableContactText({contact,scope,reloadHref,onSave,onEditAll,disabled}:{
  contact:ContactRecord;scope?:SharedRecordWriteScope;reloadHref:string;
  onSave:(record:ContactRecord)=>void;onEditAll:()=>void;onClose?:()=>void;disabled:boolean;
}){
  const [draft,setDraft]=useState<Edit&{value:string}>();
  const [saving,setSaving]=useState(false);
  const [failure,setFailure]=useState<Failure>();
  const [notice,setNotice]=useState<Notice>();
  const pending=useRef(false);
  useEffect(()=>{
    if(!notice)return;
    const timer=setTimeout(()=>setNotice(undefined),8000);
    return ()=>clearTimeout(timer);
  },[notice]);

  async function save(edit:Edit,undo=false){
    if(pending.current||disabled||failure?.stale)return;
    const parsed=portableContactFields.shape[edit.field].safeParse(edit.value??undefined);
    if(!parsed.success||(parsed.data!==undefined&&typeof parsed.data!=='string')){
      setFailure({message:'Enter a valid value for '+labels[edit.field]+'.'});
      return;
    }
    const previous=contact.data[edit.field]??null;
    if(!undo&&parsed.data===(previous??'')){
      setDraft(undefined);
      setFailure(undefined);
      return;
    }
    pending.current=true;
    setSaving(true);
    setFailure(undefined);
    setNotice(undefined);
    try{
      const query=scope?'?'+new URLSearchParams(scope):'';
      const response=await fetch('/api/crm'+query,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'patchContactText',id:contact.id,expectedRevision:edit.revision,field:edit.field,value:parsed.data??null}),
      });
      const {record,error,code}=await response.json() as {record?:ContactRecord;error?:string;code?:string};
      if(!response.ok||record?.id!==contact.id){
        setFailure({message:error??'Could not confirm the change. Reload the contact to check.',stale:code==='stale_revision'});
        return;
      }
      onSave(record);
      setDraft(undefined);
      setNotice(undo?{message:labels[edit.field]+' change undone.'}:{
        message:labels[edit.field]+' saved.',
        undo:{field:edit.field,value:previous,revision:record.revision},
      });
    }catch{
      setFailure({message:'Could not confirm the change. Reload the contact to check.'});
    }finally{
      pending.current=false;
      setSaving(false);
    }
  }

  const undo=notice?.undo;
  return <section className="portable-contact-text" aria-labelledby="portable-contact-text-title">
    <header><h2 id="portable-contact-text-title">Key information</h2>
      <div className="portable-contact-text-actions">
        <button type="button" disabled={saving||disabled||!!draft} onClick={onEditAll}>Edit all properties</button>
      </div>
    </header>
    <dl>{portableContactTextFields.map(field=><div key={field}>
      <dt>{labels[field]}</dt>
      <dd>{draft?.field===field?<input aria-label={labels[field]} type={inputTypes[field]} value={draft.value} autoFocus
        readOnly={saving||disabled} aria-invalid={failure?true:undefined}
        onChange={event=>setDraft({...draft,value:event.currentTarget.value})}
        onBlur={()=>void save(draft)}
        onKeyDown={event=>{
          if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}
          if(event.key==='Escape'&&!pending.current){setDraft(undefined);setFailure(undefined);}
        }}/>
        :<button type="button" aria-label={'Edit '+labels[field]} disabled={saving||disabled||!!draft}
          onClick={()=>{setFailure(undefined);setDraft({field,value:String(contact.data[field]??''),revision:contact.revision});}}>
          {String(contact.data[field]??'')||'Not set'}
        </button>}</dd>
    </div>)}
      <div><dt>Record owner</dt><dd>{contact.data.recordOwner?.label??'Unassigned'}</dd></div>
      <div><dt>Lifecycle stage</dt><dd>{contact.data.lifecycle}</dd></div>
    </dl>
    {failure&&<p role="alert">{failure.message}{failure.stale&&<> <a href={reloadHref}>Reload latest contact</a></>}</p>}
    {notice&&<div className="portable-property-notice">
      <span role="status">{notice.message}</span>
      {undo&&<button type="button" disabled={saving||disabled||!!draft} onClick={()=>void save(undo,true)}>Undo</button>}
    </div>}
  </section>;
}
