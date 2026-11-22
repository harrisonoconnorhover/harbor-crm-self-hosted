import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableArticles,readPortableArticle} from '../db/postgres/knowledge-store';
import {listPortableKnowledgeCategories,readOwnedKnowledgeCategory} from '../db/postgres/knowledge-category-store';
import {ApiError} from '../lib/api-error';
import {portableArticleCopy,portableArticleList,portableArticlePath} from '../lib/portable-knowledge';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {workspaceHelpArticles} from '../db/postgres/help-center-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {helpArticleSearch} from '../lib/help-center';
import {portableLoginConfig} from './portable-login-config';
import {env} from './portable-env';
import {PortableCrmHeader} from './portable-crm-header';
import {PublishedTopicFilter} from './portable-published-topic-filter';
import {PortableKnowledge} from './portable-knowledge-ui';

export async function PortableKnowledgePage({article,copyOf,...query}:Record<string,string|undefined>){
  delete query.view;
  if(query.workspaceId!==undefined){
    const parsed=helpArticleSearch.safeParse(query);
    if(article!==undefined||copyOf!==undefined||!parsed.success||!parsed.data.workspaceId)notFound();
    const {workspaceId,q,after,topic}=parsed.data;
    const params=new URLSearchParams({view:'knowledge',workspaceId,...(topic?{topic}:{}),...(q?{q}:{}),...(after?{after}:{})});
    const user=await requireChatGPTUser('/?'+params),db=portableDb();
    if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails))notFound();
    const result=await workspaceHelpArticles(db,user.userId,workspaceId,{q,after,topic}).catch(error=>{
      if(error instanceof ApiError&&error.status===404)notFound();
      throw error;
    });
    if(result.next)params.set('after',result.next);
    return withPortableNavigation(user.email,<main className="portable-contacts">
      <PortableCrmHeader email={user.email} page="knowledge" workspaceId={workspaceId}/>
      <section className="portable-settings-content"><h1>Knowledge base</h1>
        {result.center?<><a href={result.center.path}>Open {result.center.name}</a>
          <form method="get" action="/"><input type="hidden" name="view" value="knowledge"/><input type="hidden" name="workspaceId" value={workspaceId}/>
            <label>Search published articles<input type="search" name="q" defaultValue={q} maxLength={200}/></label><PublishedTopicFilter key={workspaceId+':'+(topic??'')} workspaceId={workspaceId} initialTopic={topic}/><button>Search</button></form>
          {result.suggested&&<h2>Similar articles</h2>}
          {result.items.length?<ul>{result.items.map(item=><li key={item.id}><a href={item.path}>{item.title}</a>{item.topic&&<small> · {item.topic}</small>}{item.subtitle&&<p>{item.subtitle}</p>}</li>)}</ul>:
            <p>{q?'No matching published articles.':'No published articles on this page.'}</p>}
          {result.next&&<a href={'/?'+params}>More articles</a>}</>:<p>This workspace’s public help center is closed.</p>}
      </section></main>,{actorId:user.userId,workspaceId});
  }
  const selection=z.union([z.literal('new'),z.string().guid("Invalid uuid")]).optional().safeParse(article);
  const source=z.string().guid("Invalid uuid").optional().safeParse(copyOf);
  if(query.categoryId==='')delete query.categoryId;
  const filter=portableArticleList.safeParse(query);
  if(!selection.success||!source.success||!filter.success||article&&Object.keys(query).length)notFound();
  // A copy only opens in the new-article editor.
  if(source.data&&selection.data!=='new')notFound();
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries({article,copyOf,...query}))if(value)params.set(key,value);
  const user=await requireChatGPTUser(portableArticlePath+(params.size?'&'+params:''));
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb();
  const categories=await listPortableKnowledgeCategories(db,user.userId,{status:'active',limit:25});
  const currentCategory=async(id?:string|null)=>id?(categories.items.find(item=>item.id===id)??await readOwnedKnowledgeCategory(db,user.userId,id)):undefined;
  if(!selection.data){
    const list=await listPortableArticles(db,user.userId,filter.data);
    return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories} selectedCategory={await currentCategory(filter.data.categoryId)} view={{mode:'list',list,filters:filter.data,paged:!!filter.data.afterId}}/>);
  }
  const read=(id:string)=>readPortableArticle(db,user.userId,id).catch(error=>{
    if(error instanceof ApiError&&error.status===404)notFound();
    throw error;
  });
  if(source.data){
    // Reads only; nothing is written until the owner saves the copy.
    const original=await read(source.data);
    if(original.archivedAt)notFound();
    const selected=await currentCategory(original.content.categoryId);
    const copy=portableArticleCopy(original.content,selected&&selected.archivedAt===null?[selected.id]:[]);
    return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories}
      selectedCategory={copy.categoryCleared?undefined:selected} view={{mode:'editor',copy:{...copy,sourceId:original.id,sourceTitle:original.content.title}}}/>);
  }
  const initial=selection.data==='new'?undefined:await read(selection.data);
  return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories} selectedCategory={await currentCategory(initial?.content.categoryId)} view={{mode:'editor',initial}}/>);
}
