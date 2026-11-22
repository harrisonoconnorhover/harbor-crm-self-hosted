'use client';
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {isBeefreeDesign,type MarketingDesign,type MarketingDesignSummary} from '../lib/marketing-design';
import {createHarborEmailProject,harborEmailProjectSchema,parseSavedHarborEmail,type HarborEmailProject} from '../lib/harbor-email-design';
import {openBeefreeEditor,type DesignSession} from './portable-marketing-design-editor';
import {PortableNativeEmailDesigner} from './portable-native-email-designer';

const endpoint='/api/marketing/designs';
type Draft=Partial<MarketingDesign>&{id:string};
type RegisterExit=(guard:(()=>boolean)|null)=>void;
async function api<T>(suffix:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(endpoint+suffix,{cache:'no-store',...options});
  if(!response.ok){
    const result=await response.json() as {error?:string};
    throw Error(typeof result.error==='string'?result.error:'Could not reach the design library.');
  }
  return await response.json() as T;
}
const post=<T,>(body:object)=>api<T>('',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

function useDesignExit(dirty:boolean,busy:boolean,register:RegisterExit){
  const canLeave=useCallback(()=>!busy&&(!dirty||window.confirm('Leave this design and discard unsaved changes?')),[dirty,busy]);
  useEffect(()=>{
    register(canLeave);
    return ()=>register(null);
  },[canLeave,register]);
  useEffect(()=>{
    if(!dirty&&!busy)return;
    const warn=(event:BeforeUnloadEvent)=>event.preventDefault();
    window.addEventListener('beforeunload',warn);
    return ()=>window.removeEventListener('beforeunload',warn);
  },[dirty,busy]);
  return canLeave;
}

function NativeDesignForm({draft,initialProject,close,register}:{draft:Draft;initialProject:HarborEmailProject;close:()=>void;register:RegisterExit}){
  const [project,setProject]=useState(initialProject),[name,setName]=useState(draft.name??''),[subject,setSubject]=useState(draft.subject??'');
  const [revision,setRevision]=useState(draft.revision),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const inFlight=useRef(false);
  const canLeave=useDesignExit(dirty,saving,register);
  function changed(){setDirty(true);setError('');setNotice('');}
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(inFlight.current)return;
    const result=harborEmailProjectSchema.safeParse(project);
    if(!result.success){
      const issue=result.error.issues[0],block=issue?.path[0]==='blocks'&&typeof issue.path[1]==='number'?issue.path[1]+1:null;
      setError((block?'Block '+block+' — ':'')+(issue?.message??'Check the layout before saving.'));return;
    }
    inFlight.current=true;setSaving(true);setError('');setNotice('');
    try{
      const {design}=await post<{design:MarketingDesignSummary}>({action:'saveNative',id:draft.id,expectedRevision:revision,
        name,subject,project:result.data});
      setRevision(design.revision);setName(design.name);setSubject(design.subject);setDirty(false);setNotice('Design saved.');
      window.dispatchEvent(new Event('harbor:marketing-design-saved'));
    }catch(failure){setError(failure instanceof Error?failure.message:'Could not save the design.');}
    finally{inFlight.current=false;setSaving(false);}
  }
  return <div className="marketing-native-form">
    <button type="button" disabled={saving} onClick={()=>{if(canLeave())close();}}>Back to designs</button>
    <h3>{revision?'Edit email design':'New email design'}</h3>
    <form onSubmit={save}>
      <label>Design name<input name="name" value={name} onChange={e=>{setName(e.target.value);changed();}} required maxLength={120} disabled={saving}/></label>
      <label>Email subject<input name="subject" value={subject} onChange={e=>{setSubject(e.target.value);changed();}} required maxLength={200} disabled={saving}/></label>
      <button className="primary" type="submit" disabled={saving||Boolean(revision&&!dirty)}>{saving?'Saving…':'Save design'}</button>
      {notice&&<span role="status">{notice}</span>}
    </form>
    {error&&<p className="marketing-error" role="alert">{error}</p>}
    <PortableNativeEmailDesigner project={project} disabled={saving} onChange={next=>{setProject(next);changed();}}/>
  </div>;
}

function BeefreeDesignEditor({draft,configured,close,register}:{draft:Draft;configured:boolean;close:()=>void;register:RegisterExit}){
  const form=useRef<HTMLFormElement>(null);
  const container='harbor-design-'+useId().replace(/[^a-zA-Z0-9_-]/g,'');
  const controller=useRef<ReturnType<typeof openBeefreeEditor>|null>(null);
  const [record,setRecord]=useState(draft);
  const [source,setSource]=useState<{project?:string}|null>(null);
  const [ready,setReady]=useState(false),[preview,setPreview]=useState(false);
  const [changed,setChanged]=useState(false),[saving,setSaving]=useState(false);
  const [notice,setNotice]=useState(''),[error,setError]=useState('');
  const pending=useRef(false),editNumber=useRef(0);
  const [importing,setImporting]=useState(false);
  const canLeave=useDesignExit(changed,saving||importing,register);
  function markChanged(){editNumber.current++;setChanged(true);setNotice('');}
  const latest=useRef<(project:string,html:string)=>void>(()=>{});
  async function store(project:string,html:string){
    if(pending.current||!form.current?.reportValidity())return;
    const data=new FormData(form.current);
    const design={id:record.id,name:String(data.get('name')),subject:String(data.get('subject')),
      plainText:String(data.get('plainText')),project,html};
    const saveNumber=editNumber.current;
    pending.current=true;setSaving(true);setError('');setNotice('');
    try{
      const result=await post<{design:MarketingDesignSummary}>({action:'save',...design,expectedRevision:record.revision});
      setRecord({...design,...result.design});
      const clean=saveNumber===editNumber.current;
      setChanged(!clean);setNotice(clean?'Design saved.':'Earlier edits saved. Save again to include your latest changes.');
      window.dispatchEvent(new Event('harbor:marketing-design-saved'));
    }catch(failure){setError(failure instanceof Error?failure.message:'Could not save the design.');}
    finally{pending.current=false;setSaving(false);}
  }
  useEffect(()=>{latest.current=store;});
  useEffect(()=>{
    if(!source)return;
    const editor=openBeefreeEditor(container,source.project,()=>post<DesignSession>({action:'session'}),{
      ready:()=>{setReady(true);setError('');},changed:markChanged,
      saved:(project,html)=>latest.current(project,html),error:setError,
    });
    controller.current=editor;
    return ()=>{editor.close();controller.current=null;};
  },[container,source]);

  async function importFiles(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(importing||saving||!form.current?.reportValidity())return;
    const data=new FormData(event.currentTarget),json=data.get('projectFile'),html=data.get('htmlFile');
    if(!(json instanceof File)||!(html instanceof File))return;
    if(json.size>1024*1024||html.size>1024*1024){setError('Choose export files of 1 MiB or less each.');return;}
    setImporting(true);setError('');
    try{const [project,output]=await Promise.all([json.text(),html.text()]);await store(project,output);}
    catch{setError('Could not read the export files. Choose them again.');}
    finally{setImporting(false);}
  }
  function back(){
    if(canLeave())close();
  }
  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(source)controller.current?.save();
    else if(record.project&&record.html)void store(record.project,record.html);
  }
  return <div>
    <button type="button" disabled={saving||importing} onClick={back}>Back to designs</button>
    <h3>{draft.revision?'Edit design':'New email design'}</h3>
    <form ref={form} onSubmit={save} onChange={markChanged}>
      <fieldset disabled={saving}>
        <label>Design name<input name="name" defaultValue={draft.name} required maxLength={120}/></label>
        <label>Email subject<input name="subject" defaultValue={draft.subject} required maxLength={200}/></label>
        <label>Plain-text version (optional)<textarea name="plainText" defaultValue={draft.plainText} maxLength={65536}/></label>
      </fieldset>
      {!source&&configured&&<button type="button" disabled={saving||importing} onClick={()=>{
        setError('');setNotice('');setReady(false);setPreview(false);setSource({project:record.project});
      }}>Open Beefree editor</button>}{' '}
      {(source||record.revision!==undefined)&&<button type="submit" disabled={saving||Boolean(source&&!ready)}>{saving?'Saving…':'Save design'}</button>}{' '}
      {source&&<button type="button" disabled={saving} onClick={()=>{
        if(changed&&!window.confirm('Close the editor and discard unsaved layout changes?'))return;
        setSource(null);setReady(false);setError('');
      }}>Close editor</button>}{' '}
      {record.html&&<button type="button" aria-expanded={preview} onClick={()=>setPreview(!preview)}>
        {preview?'Hide preview':'Preview saved email'}</button>}
    </form>
    {record.revision&&!configured&&<p>This design uses Beefree. Connect its editor to change the layout.</p>}
    {!record.revision&&!source&&<details open={!configured||undefined}><summary>Import an existing Beefree email</summary>
      <form onSubmit={importFiles}>
        <p>Choose the editable JSON and rendered HTML from the same email export.</p>
        <label>Beefree project (.json)<input type="file" name="projectFile" accept=".json,application/json" required/></label>
        <label>Rendered email (.html)<input type="file" name="htmlFile" accept=".html,.htm,text/html" required/></label>
        <button type="submit" disabled={saving||importing}>Save imported design</button>
      </form>
    </details>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {source&&<>{!ready&&!error&&<p role="status">Opening Beefree…</p>}
      <div id={container} style={{minHeight:'36rem',height:'75vh',width:'100%'}}/></>}
    {preview&&record.html&&<iframe title="Saved marketing email preview" sandbox="" referrerPolicy="no-referrer"
      style={{height:'34rem',width:'100%',border:'1px solid currentColor'}}
      srcDoc={'<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; base-uri \'none\'; form-action \'none\'">'+record.html}/>}
  </div>;
}

export function PortableMarketingDesigns({registerExit}:{registerExit:RegisterExit}){
  const [after,setAfter]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
  type Page={items:MarketingDesignSummary[];next:string|null;configured:boolean};
  const [library,setLibrary]=useState<{key:string;page?:Page;error?:string}>();
  const key=JSON.stringify([after,refresh]);
  const page=library?.key===key?library.page:undefined;
  const [draft,setDraft]=useState<{record:Draft;native:HarborEmailProject|null}|null>(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    if(draft)return;
    void api<Page>(after?'?after='+encodeURIComponent(after):'',{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setLibrary({key,page:value});})
      .catch(failure=>{if(!controller.signal.aborted)setLibrary({key,error:failure instanceof Error?failure.message:'Could not load designs.'});});
    return ()=>controller.abort();
  },[after,key,draft]);
  async function edit(id:string){
    setOpening(true);setError('');
    try{
      const {design}=await api<{design:MarketingDesign}>('?id='+encodeURIComponent(id));
      const native=parseSavedHarborEmail(design.project);
      if(!native&&!isBeefreeDesign(design.project))throw Error('This version of Harbor cannot edit the saved layout.');
      setDraft({record:design,native});
    }
    catch(failure){setError(failure instanceof Error?failure.message:'Could not open the design.');}
    finally{setOpening(false);}
  }
  const problem=error||(library?.key===key&&library.error);
  return <section aria-label="Marketing email designs">
    <h2>Email designs</h2>
    {draft?.native?<NativeDesignForm key={draft.record.id} draft={draft.record} initialProject={draft.native} register={registerExit} close={()=>setDraft(null)}/>:
      draft?<BeefreeDesignEditor key={draft.record.id} draft={draft.record} configured={Boolean(page?.configured)} register={registerExit} close={()=>setDraft(null)}/>:<>
      {problem&&<p role="alert">{problem} <button type="button" onClick={()=>{setError('');setRefresh(value=>value+1);}}>Retry</button></p>}
      {!problem&&!page&&<p role="status">Loading designs…</p>}
      {page&&<>
        <div className="tool-actions">
          <button type="button" className="primary" disabled={opening} onClick={()=>setDraft({record:{id:crypto.randomUUID()},native:createHarborEmailProject('blank')})}>New design</button>
          <button type="button" disabled={opening} onClick={()=>setDraft({record:{id:crypto.randomUUID()},native:null})}>
            {page.configured?'Use Beefree':'Import Beefree design'}</button>
        </div>
        {page.items.length?<ul>{page.items.map(item=><li key={item.id}><button type="button" disabled={opening} onClick={()=>void edit(item.id)}>
          {item.name}</button> · {item.subject}</li>)}</ul>:<p>No email designs on this page.</p>}
        {after&&<button type="button" disabled={opening} onClick={()=>setAfter(null)}>First page</button>}{' '}
        {page.next&&<button type="button" disabled={opening} onClick={()=>setAfter(page.next)}>Next page</button>}
      </>}
    </>}
  </section>;
}
