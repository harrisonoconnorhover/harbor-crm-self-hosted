'use client';

import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';

type TemplateSummary={id:string;name:string;revision:number};
type TemplateText={subject:string;body:string};
type Template=TemplateSummary&TemplateText;
type TemplatePage={items:TemplateSummary[];next:string|null};
type TemplateDraft=TemplateText&{name:string};
type Editor={id:string;creating:boolean;draft?:TemplateDraft};
const endpoint='/api/email/templates';
const nameLimit=120;

// Bound the copy name to the save limit without splitting a surrogate pair.
function copyName(name:string){
  const copy=('Copy of '+name).slice(0,nameLimit);
  return (/[\uD800-\uDBFF]$/.test(copy)?copy.slice(0,-1):copy).trimEnd();
}

function useTemplateData<T>(path:string|null,refresh:number){
  const key=path?JSON.stringify([path,refresh]):null;
  const [result,setResult]=useState<{key:string;data?:T}>();

  useEffect(()=>{
    if(!path||!key)return;
    const controller=new AbortController();
    fetch(path,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const data=await response.json() as T;
      if(!controller.signal.aborted)setResult({key,data});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key});});
    return ()=>controller.abort();
  },[key,path]);

  return result?.key===key?result:undefined;
}

function TemplateList({selected,onSelect,refresh=0,disabled=false}:{
  selected?:string;onSelect:(id:string)=>void;refresh?:number;disabled?:boolean;
}){
  const [search,setSearch]=useState('');
  const [after,setAfter]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  const params=new URLSearchParams();
  if(search)params.set('search',search);
  if(after)params.set('after',after);
  const result=useTemplateData<TemplatePage>(endpoint+(params.size?'?'+params:''),refresh+retry);
  const next=result?.data?.next;

  function searchTemplates(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    setSearch(String(new FormData(event.currentTarget).get('search')??'').trim());
    setAfter(null);
  }

  return <>
    <form onSubmit={searchTemplates}>
      <label>Search templates<input type="search" name="search" maxLength={nameLimit} disabled={disabled}/></label>
      <button type="submit" disabled={disabled}>Search</button>
    </form>
    {!result?<p role="status">Loading templates…</p>:!result.data?<p role="alert">Could not load templates.{' '}
      <button type="button" disabled={disabled} onClick={()=>setRetry(value=>value+1)}>Retry</button>
    </p>:result.data.items.length?<ul>{result.data.items.map(item=><li key={item.id}>
      <button type="button" aria-pressed={item.id===selected} disabled={disabled} onClick={()=>onSelect(item.id)}>{item.name}</button>
    </li>)}</ul>:<p>{search?'No matching templates on this page.':'No templates on this page.'}</p>}
    {after&&<button type="button" disabled={disabled} onClick={()=>setAfter(null)}>First template page</button>}{' '}
    {next&&<button type="button" disabled={disabled} onClick={()=>setAfter(next)}>Next template page</button>}
  </>;
}

function TemplateDetail({id,contactId,refresh=0,children}:{
  id:string;contactId?:string;refresh?:number;children:(template:Template,missing:string[])=>ReactNode;
}){
  const [retry,setRetry]=useState(0);
  const params=new URLSearchParams({id});
  if(contactId)params.set('contactId',contactId);
  const result=useTemplateData<{template:Template;missing?:string[]}>(endpoint+'?'+params,refresh+retry);
  if(!result)return <p role="status">Loading template…</p>;
  if(!result.data?.template||(contactId&&!Array.isArray(result.data.missing)))return <p role="alert">Could not load this template.{' '}
    <button type="button" onClick={()=>setRetry(value=>value+1)}>Retry</button>
  </p>;
  return children(result.data.template,result.data.missing??[]);
}

export function PortableEmailTemplates({standalone=false}:{standalone?:boolean}){
  const Heading=standalone?'h1':'h2';
  const [editor,setEditor]=useState<Editor|null>(null);
  const [refresh,setRefresh]=useState(0);
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const pending=useRef(false);

  function choose(next:Editor|null){
    if(busy||(dirty&&!window.confirm('Discard unsaved template changes?')))return;
    setEditor(next);
    setDirty(false);
    setNotice('');
    setError('');
  }

  async function write(method:'PUT'|'DELETE',payload:object){
    if(pending.current)return;
    pending.current=true;
    setBusy(true);setNotice('');setError('');
    try{
      const response=await fetch(endpoint,{method,headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json() as {template?:Template;ok?:boolean;error?:string};
      if(!response.ok)throw Error(result.error||'Could not save the template change.');
      if(method==='PUT'){
        if(!result.template)throw Error('Could not confirm the template change. Refresh and try again.');
        setEditor({id:result.template.id,creating:false});
        setNotice('Template saved.');
      }else{
        if(!result.ok)throw Error('Could not confirm deletion. Refresh and try again.');
        setEditor(null);
        setNotice('Template deleted.');
      }
      setDirty(false);
      setRefresh(value=>value+1);
    }catch(error){setError(error instanceof Error?error.message:'Could not save the template change.');}
    finally{pending.current=false;setBusy(false);}
  }

  function renderEditor(id:string,template?:Template,draft?:TemplateDraft){
    const initial=template??draft;
    return <form className="portable-email-template-editor" key={id+':'+(template?.revision??'new')} onChange={()=>setDirty(true)} onSubmit={event=>{
      event.preventDefault();
      const values=new FormData(event.currentTarget);
      void write('PUT',{id,name:String(values.get('name')??'').trim(),subject:String(values.get('subject')??''),
        body:String(values.get('body')??''),...(template?{expectedRevision:template.revision}:{})});
    }}>
      <h3>{template?'Edit template':draft?'Duplicate template':'New template'}</h3>
      {draft&&<p>This copy is unsaved. Select Save template to create it.</p>}
      <fieldset disabled={busy}>
        <label>Template name<input name="name" defaultValue={initial?.name} required maxLength={nameLimit}/></label>
        <label>Subject<input name="subject" defaultValue={initial?.subject} required maxLength={200}/></label>
        <label>Plain-text message<textarea name="body" defaultValue={initial?.body} required maxLength={8000}/></label>
      </fieldset>
      <button type="submit" disabled={busy}>{busy?'Saving…':'Save template'}</button>{' '}
      {template&&<button type="button" disabled={busy} onClick={()=>{
        choose({id:crypto.randomUUID(),creating:true,
          draft:{name:copyName(template.name),subject:template.subject,body:template.body}});
      }}>Duplicate template</button>}{' '}
      {template&&<button type="button" disabled={busy} onClick={()=>{
        if(window.confirm('Delete “'+template.name+'”?'))void write('DELETE',{id,expectedRevision:template.revision});
      }}>Delete template</button>}{' '}
      <button type="button" disabled={busy} onClick={()=>choose(null)}>Cancel</button>
    </form>;
  }

  return <section aria-label="Email templates" className={standalone?'portable-settings-content':undefined}>
    <div className="portable-email-section-heading">
      <div><Heading>Email templates</Heading><p>Save reusable plain-text subjects and messages.</p></div>
      <button type="button" className="portable-email-primary" disabled={busy} onClick={()=>choose({id:crypto.randomUUID(),creating:true})}>New template</button>
    </div>
    <TemplateList selected={editor?.id} onSelect={id=>{if(editor?.id!==id)choose({id,creating:false});}}
      refresh={refresh} disabled={busy}/>
    {editor?.creating?renderEditor(editor.id,undefined,editor.draft):editor&&<TemplateDetail id={editor.id} refresh={refresh}>
      {template=>renderEditor(template.id,template)}
    </TemplateDetail>}
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    <details className="portable-email-template-help">
      <summary>Template placeholders</summary>
      <p>Use <code>{'{{record.name}}'}</code>, <code>{'{{record.email}}'}</code>, <code>{'{{contact.name}}'}</code>,{' '}
        <code>{'{{contact.email}}'}</code>, or <code>{'{{sender.name}}'}</code> to personalize a message. For a fallback, use{' '}
        <code>{'{{contact.name|there}}'}</code>.</p>
    </details>
  </section>;
}

export function PortableEmailTemplatePicker({contactId,disabled,onApply}:{
  contactId:string;disabled:boolean;onApply:(template:TemplateText)=>void;
}){
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState<string>();
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Use an email template</summary>
    {open&&<>
      <TemplateList selected={selected} onSelect={setSelected}/>
      {selected&&<TemplateDetail id={selected} contactId={contactId}>{(template,missing)=><section aria-label="Template preview">
        <h3>Preview {template.name}</h3>
        <p><strong>Subject:</strong> {template.subject}</p>
        <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{template.body}</p>
        {missing.length>0&&<p role="status">Missing values for <code>{missing.join(', ')}</code>. Fill in the missing values or choose a template with fallbacks.</p>}
        <p>Applying replaces the draft subject and message. Review the draft before scheduling.</p>
        <button type="button" disabled={disabled||missing.length>0} onClick={()=>onApply(template)}>Apply template to draft</button>
      </section>}</TemplateDetail>}
    </>}
  </details>;
}
