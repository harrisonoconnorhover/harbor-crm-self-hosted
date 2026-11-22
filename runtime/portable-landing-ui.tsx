'use client';

import {useEffect,useRef,useState,type DragEvent} from 'react';
import Link from 'next/link';
import {LandingLinkPicker} from './portable-landing-link-picker';
import {prepareLandingImage} from './portable-landing-image';
import {landingDocument} from '../lib/landing-document';
import {landingDraft,landingForOrigin,maxLandingBlocks,type LandingBlock,type LandingChange,type LandingDraft,type LandingPage} from '../lib/portable-landing';
import './portable-landing.css';

const empty:LandingDraft={title:'',slug:'',description:'',accent:'#17696b',blocks:[]};
type Kind=LandingBlock['type'];
type Drag={add:Kind}|{move:string};
const names={heading:'Heading',text:'Paragraph',columns:'Two columns',quote:'Quotation',image:'Image',button:'Call to action',form:'Lead form'};
type FormOption={id:string;title:string;enabled:boolean;embedOrigin?:string};
export function PortableLandingEditor({page,id,copiedDraft,listPath,initialForms,domains,origin,initialUrl}:{page?:LandingPage;id:string;copiedDraft?:LandingDraft;
  listPath:string;initialForms:FormOption[];domains:string[];origin:string;initialUrl:string|null}){
  const [forms,setForms]=useState(initialForms),[previewOrigin,setPreviewOrigin]=useState(domains[0]??origin);
  const [refreshing,setRefreshing]=useState(false),[formStatus,setFormStatus]=useState('');
  async function refreshForms(){
    setRefreshing(true);setFormStatus('');
    try{
      const response=await fetch('/api/lead-forms',{cache:'no-store'});
      if(!response.ok)throw Error();
      const result=await response.json() as {forms:{id:string;enabled:boolean;definition:{title:string;embedOrigin?:string}}[]};
      setForms(result.forms.map(f=>({id:f.id,enabled:f.enabled,title:f.definition.title,embedOrigin:f.definition.embedOrigin})));
      setFormStatus('Form settings refreshed.');
    }catch{setFormStatus('Could not refresh form settings. The previous preview is still shown.');}
    finally{setRefreshing(false);}
  }
  const [saved,setSaved]=useState(page),[draft,setDraft]=useState(page?.draft??copiedDraft??empty),[busy,setBusy]=useState(false);
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[drag,setDrag]=useState<Drag|null>(null);
  const [before,setBefore]=useState(''),[dropAt,setDropAt]=useState<number|null>(null);
  const list=useRef<HTMLDivElement>(null),focusNew=useRef<string|null>(null);
  useEffect(()=>{
    if(focusNew.current){
      list.current?.querySelector<HTMLElement>('[data-id="'+focusNew.current+'"] :is(input,textarea,select)')?.focus();
      focusNew.current=null;
    }
  },[draft.blocks]);
  const [live,setLive]=useState(initialUrl);
  const dirty=JSON.stringify(draft)!==JSON.stringify(saved?.draft??copiedDraft??empty);
  useEffect(()=>{
    if(!dirty)return;
    const warn=(event:BeforeUnloadEvent)=>event.preventDefault();
    window.addEventListener('beforeunload',warn);return ()=>window.removeEventListener('beforeunload',warn);
  },[dirty]);
  function field<K extends keyof LandingDraft>(key:K,value:LandingDraft[K]){setDraft(prev=>({...prev,[key]:value}));}
  function replace(block:LandingBlock){field('blocks',draft.blocks.map(item=>item.id===block.id?block:item));}
  async function uploadPicture(id:string,file:File){
    setBusy(true);setMessage('Preparing picture…');setError('');
    try{
      const picture=await prepareLandingImage(file);
      setDraft(prev=>({...prev,blocks:prev.blocks.map(b=>b.type==='image'&&b.id===id?{...b,...picture}:b)}));
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not read that picture.');}
    finally{setBusy(false);setMessage('');}
  }
  function add(type:Kind,at:number){
    if(busy||draft.blocks.length>=maxLandingBlocks||type==='form'&&!forms.length)return;
    const id=crypto.randomUUID();
    let block:LandingBlock;
    if(type==='form')block={id,type,label:'Contact us',formId:forms[0].id};
    else if(type==='button')block={id,type,label:'',target:{url:''}};
    else if(type==='image')block={id,type,jpeg:'',alt:'',caption:'',width:1,height:1};
    else if(type==='columns')block={id,type,left:{heading:'',text:''},right:{heading:'',text:''}};
    else block={id,type,text:''};
    focusNew.current=id;
    field('blocks',[...draft.blocks.slice(0,at),block,...draft.blocks.slice(at)]);
  }
  function move(from:number,to:number){
    if(from===to||from<0||to<0||to>=draft.blocks.length)return;
    const next=draft.blocks.slice(),[row]=next.splice(from,1);next.splice(to,0,row);field('blocks',next);
  }
  function startDrag(event:DragEvent,source:Drag){
    event.dataTransfer.effectAllowed='add' in source?'copy':'move';
    event.dataTransfer.setData('application/x-harbor-section','add' in source?source.add:source.move);
    setDrag(source);
  }
  function endDrag(){setDrag(null);setDropAt(null);}
  function target(event:DragEvent,index:number,drop:boolean){
    if(!drag||busy)return;
    event.preventDefault();
    const rect=event.currentTarget.getBoundingClientRect();
    const at=index+(index<draft.blocks.length&&event.clientY>=rect.top+rect.height/2?1:0);
    if(!drop){event.dataTransfer.dropEffect='add' in drag?'copy':'move';setDropAt(at);return;}
    if('add' in drag)add(drag.add,at);
    else {
      const from=draft.blocks.findIndex(block=>block.id===drag.move);
      move(from,at>from?at-1:at);
    }
    endDrag();
  }
  async function change(action:LandingChange['action']){
    if(busy)return;
    setError('');setMessage('');
    const cleanedDraft={...draft,redirectFrom:draft.redirectFrom?.map(address=>address.trim()).filter(Boolean)};
    if(action==='save'){
      const checked=landingDraft.safeParse(cleanedDraft);
      if(!checked.success){setError(checked.error.issues.map(issue=>issue.path.join(' · ')+': '+issue.message).join(' '));return;}
    }
    setBusy(true);
    try{
      const data={action,id,revision:saved?.revision??0,...(action==='save'?{draft:cleanedDraft}:{})};
      const response=await fetch('/api/landing-pages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      const result=await response.json() as LandingPage&{publicUrl:string|null;error?:string};
      if(!response.ok)throw Error(result.error??'Could not confirm this change.');
      setSaved(result);setDraft(result.draft);setLive(result.publicUrl);
      if(!saved)window.history.replaceState(window.history.state,'',listPath+'&edit='+id);
      setMessage(action==='publish'?'Page published.':action==='withdraw'?'Page withdrawn.':'Draft saved.');
    }catch(e){setError(e instanceof Error?e.message:'Could not confirm this change. Reload the page to check.');}
    finally{setBusy(false);}
  }
  return <section className="landing-editor">
    <Link href={listPath} prefetch={false}>Landing pages</Link><h1>{saved?.draft.title??(copiedDraft?'Duplicate landing page':'Create landing page')}</h1>
    {copiedDraft&&!saved&&<p>Choose a new page address. This draft uses the original page’s forms. You can change them before publishing.</p>}
    <p>{!live?'Private draft':saved?.draftRevision===saved?.publishedRevision?'Published':'Unpublished edits'}
      {dirty?' · Unsaved changes':''}{live&&<> · <a target="_blank" rel="noreferrer" href={live}>View published page</a></>}</p>
     {saved?.lastPublished&&!dirty&&JSON.stringify(saved.lastPublished)!==JSON.stringify(draft)&&
      <button disabled={busy} onClick={()=>{if(saved.lastPublished)setDraft(saved.lastPublished);}}>Use last published content in draft</button>}
    <div className="landing-columns"><fieldset disabled={busy}><legend>Page content</legend>
      <label>Page title<input value={draft.title} maxLength={120} onChange={e=>field('title',e.target.value)}/></label>
      <label>Page address<input value={draft.slug} placeholder="spring-open-house" maxLength={72} onChange={e=>field('slug',e.target.value)}/></label>
        {saved?.publishedSlug&&saved.publishedSlug!==draft.slug&&!draft.redirectFrom?.includes(saved.publishedSlug)&&
          <button type="button" onClick={()=>field('redirectFrom',[...(draft.redirectFrom??[]).filter(Boolean),saved.publishedSlug!])}>Keep /{saved.publishedSlug} working</button>}
      <details><summary>Previous page addresses</summary>
        <p>After publication, visitors to these addresses will arrive at this page. Campaign tags follow the visitor.</p>
        <label>Previous addresses (one per line)<textarea value={(draft.redirectFrom??[]).join('\n')} placeholder="spring-open-house"
          onChange={e=>field('redirectFrom',e.target.value?e.target.value.split('\n'):undefined)}/></label>
      </details>
      <label>Introduction<textarea value={draft.description} maxLength={300} onChange={e=>field('description',e.target.value)}/></label>
      <details className="landing-search-settings"><summary>Search and link previews</summary>
        <label>Search title<input value={draft.searchTitle??''} placeholder={draft.title||'Use page title'} maxLength={120}
          onChange={e=>field('searchTitle',e.target.value)}/></label>
        <label>Search description<textarea value={draft.searchDescription??''} placeholder={draft.description||'Use introduction'} maxLength={300}
          onChange={e=>field('searchDescription',e.target.value)}/></label>
        <label><input type="checkbox" checked={!!draft.excludeFromSearch} onChange={e=>field('excludeFromSearch',e.target.checked)}/>
          Ask search engines to leave this page out of results</label>
        <p>Anyone with the published link can open it.</p>
      </details>
      <label>Accent color<input type="color" value={draft.accent} onChange={e=>field('accent',e.target.value)}/></label>
      <fieldset className="landing-palette"><legend>Add a section</legend>
        {draft.blocks.length>0&&<label>Insert position<select value={draft.blocks.some(b=>b.id===before)?before:''} onChange={e=>setBefore(e.target.value)}>
          <option value="">End of page</option>{draft.blocks.map((block,i)=><option key={block.id} value={block.id}>Before {i+1}. {names[block.type]}</option>)}
        </select></label>}
        <div className="landing-tools">{(Object.keys(names) as Kind[]).map(type=>{
          const disabled=busy||draft.blocks.length>=maxLandingBlocks||type==='form'&&!forms.length;
          return <button type="button" key={type} draggable={!disabled} disabled={disabled}
            onDragStart={e=>startDrag(e,{add:type})} onDragEnd={endDrag} onClick={()=>{
              const at=draft.blocks.findIndex(b=>b.id===before);
              add(type,at<0?draft.blocks.length:at);
            }}>Add {names[type].toLowerCase()}</button>;
        })}</div>
        {!forms.length&&<Link href="/?view=forms" prefetch={false}>Create a lead form</Link>}
      </fieldset>
      <div ref={list} className="landing-block-list" onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget instanceof Node?e.relatedTarget:null))setDropAt(null);}}>
      {draft.blocks.map((b,i)=><div key={b.id} data-id={b.id} className="landing-block"
        data-insert-before={dropAt===i||undefined} onDragOver={e=>target(e,i,false)} onDrop={e=>target(e,i,true)}>
        <div className="landing-block-actions"><strong draggable={!busy} onDragStart={e=>startDrag(e,{move:b.id})}
          onDragEnd={endDrag} title="Drag to reorder">{names[b.type]}</strong>
          <button type="button" disabled={!i} aria-label={'Move section '+(i+1)+' up'} onClick={()=>move(i,i-1)}>↑</button>
          <button type="button" disabled={i===draft.blocks.length-1} aria-label={'Move section '+(i+1)+' down'} onClick={()=>move(i,i+1)}>↓</button>
          <button type="button" aria-label={'Remove section '+(i+1)} onClick={()=>field('blocks',draft.blocks.filter(row=>row.id!==b.id))}>Remove</button></div>
        {b.type==='image'?<>
          <label>{b.jpeg?'Replace picture':'Choose picture'}<input type="file" accept="image/jpeg,image/png,image/webp"
            onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void uploadPicture(b.id,file);}}/></label>
          <label>Alt text<input value={b.alt} maxLength={300} onChange={e=>replace({...b,alt:e.target.value})}/></label>
          <label>Caption (optional)<input value={b.caption} maxLength={300} onChange={e=>replace({...b,caption:e.target.value})}/></label>
        </>:b.type==='columns'?(['left','right'] as const).map(side=><fieldset key={side}><legend>{side==='left'?'First column':'Second column'}</legend>
          <label>Heading<input value={b[side].heading} maxLength={160} onChange={e=>replace({...b,[side]:{...b[side],heading:e.target.value}})}/></label>
          <label>Paragraph<textarea value={b[side].text} maxLength={2000} onChange={e=>replace({...b,[side]:{...b[side],text:e.target.value}})}/></label>
        </fieldset>):b.type==='button'?<>
          <label>Button text<input value={b.label} maxLength={70} onChange={e=>replace({...b,label:e.target.value})}/></label>
          <label>Button destination<select value={'url' in b.target?'website':'pageId' in b.target?'page':'section'} onChange={e=>replace({...b,
            target:e.target.value==='website'?{url:''}:e.target.value==='page'?{pageId:''}:{sectionId:''}})}>
            <option value="website">Website address</option><option value="section">Section on this page</option><option value="page">Harbor landing page</option>
          </select></label>
          {'url' in b.target?<label>Website address<input type="url" placeholder="https://…" value={b.target.url} maxLength={2048}
            onChange={e=>replace({...b,target:{url:e.target.value}})}/></label>:
            'pageId' in b.target?<LandingLinkPicker source={id} current={b.target.pageId} onSelect={pageId=>replace({...b,target:{pageId}})}/>:
            <label>Page section<select value={b.target.sectionId} onChange={e=>replace({...b,target:{sectionId:e.target.value}})}>
              <option value="">Choose a section</option>
              {draft.blocks.map((section,index)=>section.type==='button'?null:
                <option key={section.id} value={section.id}>{index+1}. {names[section.type]} · {section.type==='form'?section.label:
                  section.type==='image'?section.alt:section.type==='columns'?section.left.heading||section.left.text.slice(0,60):section.text.slice(0,60)}</option>)}
            </select></label>}
        </>:b.type==='form'?<><label>Display form<select value={b.display??'button'} onChange={e=>replace({...b,display:e.target.value==='inline'?'inline':'button'})}>
          <option value="button">Open from a button</option><option value="inline">Show on this page</option></select></label>
          <label>{b.display==='inline'?'Form heading':'Button label'}<input value={b.label} maxLength={70} onChange={e=>replace({...b,label:e.target.value})}/></label>
          <label>Lead form<select value={b.formId} onChange={e=>replace({...b,formId:e.target.value})}>{forms.map(f=>
            <option key={f.id} value={f.id}>{f.title}{f.enabled?'':' (closed)'}</option>)}</select></label>
          {b.display==='inline'&&<p>Embed website: {forms.find(f=>f.id===b.formId)?.embedOrigin||'None selected'}. Other websites show a button.{' '}
            <a href={'/?view=forms&formId='+b.formId} target="_blank" rel="noreferrer">Edit form settings</a></p>}</>:
          <label>{names[b.type]} text<textarea value={b.text} maxLength={b.type==='text'?4000:b.type==='quote'?1000:160} onChange={e=>replace({...b,text:e.target.value})}/></label>}
      </div>)}
      {(drag||!draft.blocks.length)&&<div className="landing-drop-end" data-insert-before={dropAt===draft.blocks.length||undefined}
        onDragOver={e=>target(e,draft.blocks.length,false)} onDrop={e=>target(e,draft.blocks.length,true)}>{drag?'Drop section here':'Drag a section here or choose one above.'}</div>}
      </div>
    </fieldset><aside><h2>Preview</h2>
      {domains.length>0&&<label>Preview address<select value={previewOrigin} onChange={e=>setPreviewOrigin(e.target.value)}>
        {[...domains,origin].map(address=><option key={address} value={address}>{address}</option>)}
      </select></label>}
      {draft.blocks.some(block=>block.type==='form')&&<button type="button" disabled={refreshing} onClick={()=>void refreshForms()}>
        {refreshing?'Refreshing…':'Refresh form settings'}</button>}
      {formStatus&&<p role="status">{formStatus}</p>}
      <iframe title="Landing page preview" sandbox="" srcDoc={landingDocument(landingForOrigin(draft,
        new Map(forms.filter(f=>f.enabled).map(f=>[f.id,f.embedOrigin??null])),previewOrigin),origin,true)}/>
    </aside></div>
    <div className="landing-tools"><button disabled={busy||!dirty} onClick={()=>void change('save')}>Save draft</button>
      <button disabled={busy||dirty||!saved||saved.draftRevision===saved.publishedRevision} onClick={()=>void change('publish')}>Publish saved page</button>
      {live&&<button disabled={busy||dirty} onClick={()=>void change('withdraw')}>Withdraw page</button>}</div>
    {message&&(!dirty||busy)&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
