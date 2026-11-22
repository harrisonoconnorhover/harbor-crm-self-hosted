'use client';

import {CategoryBrowser,CategoryPicker,categoryName} from './portable-knowledge-category-picker';
import {HelpCenterControls} from './portable-help-center-ui';
import {useEffect,useRef,useState} from 'react';
import {ArticleEditor} from '../app/article-editor';
import type {listPortableArticles,readPortableArticle,readPortableArticleHistory,readPortableArticleVersion} from '../db/postgres/knowledge-store';
import {articleVersionLabel,emptyArticle,normalizeArticleHtml,type articleMutation} from '../lib/knowledge-base';
import {portableArticleCopyPath,portableArticlePath,type portableArticleCopy,type KnowledgeCategoryPage,type PortableKnowledgeCategory} from '../lib/portable-knowledge';
import type {z} from 'zod';
import '../app/knowledge-base.css';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type Article=Awaited<ReturnType<typeof readPortableArticle>>;
type History=Awaited<ReturnType<typeof readPortableArticleHistory>>;
type Version=Awaited<ReturnType<typeof readPortableArticleVersion>>;
type List=Awaited<ReturnType<typeof listPortableArticles>>;
type Mutation=z.infer<typeof articleMutation>;
type Copy=ReturnType<typeof portableArticleCopy>&{sourceId:string;sourceTitle:string};
type Filters={match?:'phrase'|'words';status:'draft'|'archived'|'all';q:string;categoryId?:string};
type Categories={categories:KnowledgeCategoryPage;selectedCategory?:PortableKnowledgeCategory};
const api='/api/knowledge-base';
const articlePath=(id:string)=>portableArticlePath+'&article='+id;
const date=(time:number)=>new Date(time).toISOString().slice(0,10);

async function articleRequest<T>(params:URLSearchParams,body?:Mutation):Promise<T>{
  const response=await fetch(api+(params.size?'?'+params:''),{
    ...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),
    cache:'no-store',
  });
  if(!response.ok){
    const result=await response.json() as {error?:string};
    throw new Error(result.error??'Could not confirm the article request.');
  }
  return await response.json() as T;
}

function ArticlePreview({title,subtitle,bodyHtml}:{title:string;subtitle:string;bodyHtml:string}){
  let html:string;
  try{html=normalizeArticleHtml(bodyHtml).bodyHtml;}
  catch(error){return <p role="alert">{(error as Error).message}</p>;}
  return <section className="article-preview" aria-label="Private draft preview">
    <h2>{title||'Untitled article'}</h2>{subtitle&&<p>{subtitle}</p>}
    <div className="article-content" dangerouslySetInnerHTML={{__html:html}}/>
  </section>;
}

function EditArticle({initial,copy,categories,selectedCategory}:Categories&{initial?:Article;copy?:Copy}){
  const [saved,setSaved]=useState(initial);
  const [content,setContent]=useState(initial?.content??copy?.content??emptyArticle);
  const [tags,setTags]=useState((initial??copy)?.content.tags.join(', ')??'');
  // An unsaved copy counts as an edit, so leaving warns and Save draft is available.
  const [dirty,setDirty]=useState(!!copy);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [preview,setPreview]=useState(false);
  const [history,setHistory]=useState<History>();
  const [version,setVersion]=useState<Version>();
  const newId=useRef<string>(undefined);
  const archived=!!saved?.archivedAt;

  useEffect(()=>{
    if(!dirty)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);
    return ()=>window.removeEventListener('beforeunload',warn);
  },[dirty]);

  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');setNotice('');
    try{await action();}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }

  function save(action:Mutation,message:string){
    return run(async()=>{
      const {item}=await articleRequest<{item:Article}>(new URLSearchParams(),action);
      setSaved(item);setContent(item.content);setTags(item.content.tags.join(', '));setDirty(false);
      setHistory(undefined);setVersion(undefined);setNotice(message);
      if(!saved)window.history.replaceState(window.history.state,'',articlePath(item.id));
    });
  }

  function saveDraft(){
    const id=saved?.id??(newId.current??=crypto.randomUUID());
    return save({action:'save',id,revision:saved?.revision??0,
      content:{...content,tags:tags===content.tags.join(', ')?content.tags:tags.split(',').map(tag=>tag.trim()).filter(Boolean)}},'Draft saved.');
  }

  function loadHistory(before?:number){
    if(!saved)return;
    const params=new URLSearchParams({id:saved.id,history:'1'});
    if(before)params.set('before',String(before));
    return run(async()=>{
      const result=await articleRequest<History>(params);
      setHistory(result);setVersion(undefined);
    });
  }

  function viewVersion(revision:number){
    if(!saved)return;
    return run(async()=>{
      const {item}=await articleRequest<{item:Version}>(new URLSearchParams({id:saved.id,version:String(revision)}));
      setVersion(item);
    });
  }

  return <>
    <div className="portable-contacts-heading">
      <h1>{archived?'Archived article':saved?'Edit article':copy?'Duplicate draft':'New article'}</h1>
      <a href={portableArticlePath}>Back to articles</a>
    </div>
    <p>{archived?'Restore this article to drafts to edit it.':'Changes stay private until you publish the saved version.'}
      {saved&&' · Version '+saved.revision}</p>
    {saved&&<HelpCenterControls key={saved.id+'-'+saved.revision} article={saved} dirty={dirty}/>}
    {copy&&!saved&&<p role="note">Unsaved copy of <a href={articlePath(copy.sourceId)}>{copy.sourceTitle}</a>.
      {' '}Nothing is saved until you click Save draft.
      {copy.categoryCleared&&' The original category is no longer active, so choose another.'}</p>}
    <nav aria-label="Article actions">
      <button type="button" disabled={busy||archived||!dirty} onClick={saveDraft}>Save draft</button>
      <button type="button" disabled={busy} aria-pressed={preview&&!history} onClick={()=>{setPreview(!preview||!!history);setHistory(undefined);}}>Preview</button>
      {saved&&<>
        <button type="button" disabled={busy} aria-pressed={!!history} onClick={()=>history?setHistory(undefined):loadHistory()}>Version history</button>
        {!archived&&<button type="button" disabled={busy||dirty} title={dirty?'Save or discard your changes first.':undefined}
          onClick={()=>window.location.assign(portableArticleCopyPath(saved.id))}>Duplicate draft</button>}
        <button type="button" disabled={busy||dirty} onClick={()=>save(
          {action:'archive',id:saved.id,revision:saved.revision,archived:!archived},
          archived?'Article restored to drafts.':'Article archived.',
        )}>{archived?'Restore to drafts':'Archive'}</button>
      </>}
    </nav>
    {notice&&<p role="status">{notice}</p>}
    {error&&<p role="alert">{error}</p>}
    {history&&saved?<section aria-label="Version history">
      <h2>Version history</h2>
      <ul>{history.items.map(item=><li key={item.revision}>
        <button type="button" disabled={busy} onClick={()=>viewVersion(item.revision)}>Version {item.revision} · {item.title}</button>
        {' · '+articleVersionLabel(item)+' · '+date(item.savedAt)+(item.current?' · Current':'')}
      </li>)}</ul>
      {history.next&&<button type="button" disabled={busy} onClick={()=>loadHistory(history.next??undefined)}>Older versions</button>}
      {version&&<>
        <ArticlePreview {...version.content}/>
        {!archived&&version.revision<saved.revision&&<button type="button" disabled={busy||dirty} onClick={()=>save(
          {action:'restore',id:saved.id,revision:saved.revision,sourceRevision:version.revision},'Earlier version restored to drafts.',
        )}>Restore version {version.revision}</button>}
      </>}
    </section>:preview||archived?<ArticlePreview {...content}/>:<div className="article-edit-layout">
      <div>
        <label>Article title<input maxLength={200} value={content.title} disabled={busy}
          onChange={event=>{setContent({...content,title:event.target.value});setDirty(true);}}/></label>
        <label>Subtitle<input maxLength={400} value={content.subtitle} disabled={busy}
          onChange={event=>{setContent({...content,subtitle:event.target.value});setDirty(true);}}/></label>
        <ArticleEditor value={content.bodyHtml} disabled={busy}
          onChange={bodyHtml=>{setContent(current=>({...current,bodyHtml}));setDirty(true);}}/>
      </div>
      <aside className="article-settings">
        <h2>Article settings</h2>
        <CategoryPicker initial={categories} selected={selectedCategory} label="Category" empty="No managed category"
          disabled={busy} value={content.categoryId??null} onChange={id=>{setContent({...content,categoryId:id||null,category:id?'':content.category});setDirty(true);}}/>
        {!content.categoryId&&<label>Other category text<input maxLength={203} value={content.category} disabled={busy}
          onChange={event=>{setContent({...content,category:event.target.value});setDirty(true);}}/></label>}
        <label>Tags<input placeholder="setup, accounts" value={tags} disabled={busy}
          onChange={event=>{setTags(event.target.value);setDirty(true);}}/></label>
        <p>Separate tags with commas. Use up to 20 tags of 40 characters each.</p>
      </aside>
    </div>}
  </>;
}

function ArticleList({list,filters,paged,categories,selectedCategory}:Categories&{list:List;filters:Filters;paged:boolean}){
  const first=new URLSearchParams({view:'knowledge',status:filters.status,q:filters.q,...(filters.match?{match:filters.match}:{}),...(filters.categoryId?{categoryId:filters.categoryId}:{})});
  const next=list.next?new URLSearchParams({...Object.fromEntries(first),afterAt:String(list.next.afterAt),afterId:list.next.afterId}):null;
  return <>
    <div className="portable-contacts-heading"><h1>Knowledge base</h1><a href={articlePath('new')}>New article</a></div>
    <HelpCenterControls/>
    <form action="/" method="get">
      <input type="hidden" name="view" value="knowledge"/>
      <fieldset>
        <label>Search articles<input name="q" maxLength={200} defaultValue={filters.q}/></label>
        <label>Search matching<select name="match" defaultValue={filters.match??'phrase'}>
          <option value="phrase">Exact phrase</option><option value="words">All words</option>
        </select></label>
        <CategoryPicker initial={categories} selected={selectedCategory} label="Category" name="categoryId" empty="All categories"/>
        <label>Status<select name="status" defaultValue={filters.status}>
          <option value="draft">Drafts</option><option value="archived">Archived</option><option value="all">All articles</option>
        </select></label>
      </fieldset>
      <button type="submit">Find articles</button>
    </form>
    {list.items.length?<div className="article-table-wrap">
      <table><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>{list.items.map(item=><tr key={item.id}>
          <td><a href={articlePath(item.id)}>{item.title}</a>{item.excerpt&&<small>{item.excerpt}</small>}</td>
          <td>{item.category||'—'}</td><td>{item.archivedAt?'Archived':'Draft'}</td><td>{date(item.updatedAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>:<p>No articles match this view.</p>}
    <nav aria-label="Article pages">
      {paged&&<a href={'/?'+first}>First page</a>}{next&&<a href={'/?'+next}>Next page</a>}
    </nav>
    <ManageCategories categories={categories}/>
  </>;
}

// Create, rename and archive categories. Each change reloads the page.
function ManageCategories({categories}:Categories){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [archived,setArchived]=useState(false);
  const pending=useRef<string|undefined>(undefined);
  async function change(body:unknown){
    setBusy(true);setError('');
    try{
      const response=await fetch(api+'/categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json() as {error?:string};
      if(!response.ok){setError(result.error??'Could not change this category.');return;}
      pending.current=undefined;
      window.location.reload();
    }catch{setError('Harbor could not confirm the change. Reload to check.');}
    finally{setBusy(false);}
  }
  return <details>
    <summary>Manage categories</summary>
    {error&&<p role="alert">{error}</p>}
    <form aria-label="New category" onSubmit={event=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      pending.current??=crypto.randomUUID();
      void change({action:'save',id:pending.current,revision:0,name:form.get('name'),description:form.get('description'),parentId:form.get('parentId')||null});
    }}><fieldset disabled={busy}>
      <label>Name<input name="name" required maxLength={100}/></label>
      <label>Description<input name="description" maxLength={400}/></label>
      <CategoryPicker initial={categories} label="Parent" name="parentId" empty="Top level" parentsOnly/>
      <button type="submit">Add category</button>
    </fieldset></form>
    <section aria-label="Active categories"><CategoryBrowser initial={categories}>{items=>items.length?<table><thead><tr><th>Category</th><th>Articles</th><th>Actions</th></tr></thead>
      <tbody>{items.map(category=><tr key={category.id}><td>{categoryName(category)}{category.description&&<small>{category.description}</small>}</td>
        <td>{category.articleCount}</td>
        <td><button type="button" disabled={busy} onClick={()=>{
          const name=window.prompt('Rename category',category.name)?.trim();
          if(name&&name!==category.name)void change({action:'save',id:category.id,revision:category.revision,name,description:category.description,parentId:category.parentId});
        }}>Rename</button>{' '}
        <button type="button" disabled={busy} onClick={()=>void change({action:'archive',id:category.id,revision:category.revision,archived:true})}>Archive</button></td>
      </tr>)}</tbody></table>:<p>No matching active categories.</p>}</CategoryBrowser></section>
    {archived?<section aria-label="Archived category management"><CategoryBrowser status="archived">{items=><ul aria-label="Archived categories">{items.map(category=><li key={category.id}>{categoryName(category)}{' '}
      <button type="button" disabled={busy} onClick={()=>void change({action:'archive',id:category.id,revision:category.revision,archived:false})}>Restore</button></li>)}
      {!items.length&&<li>No matching archived categories.</li>}</ul>}</CategoryBrowser></section>
      :<button type="button" onClick={()=>setArchived(true)}>Show archived categories</button>}
  </details>;
}

export function PortableKnowledge({email,view,categories,selectedCategory}:Categories&{email:string;view:{mode:'editor';initial?:Article;copy?:Copy}|{mode:'list';list:List;filters:Filters;paged:boolean}}){
  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="knowledge" currentHref={portableArticlePath}/>
    <section>{view.mode==='editor'?<EditArticle selectedCategory={selectedCategory} initial={view.initial} copy={view.copy} categories={categories}/>:<ArticleList selectedCategory={selectedCategory} {...view} categories={categories}/>}</section>
  </main>;
}
