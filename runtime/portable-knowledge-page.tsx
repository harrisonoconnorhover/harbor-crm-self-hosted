import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableArticles,readPortableArticle} from '../db/postgres/knowledge-store';
import {listPortableKnowledgeCategories} from '../db/postgres/knowledge-category-store';
import {ApiError} from '../lib/api-error';
import {portableArticleCopy,portableArticleList,portableArticlePath} from '../lib/portable-knowledge';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableKnowledge} from './portable-knowledge-ui';

export async function PortableKnowledgePage({article,copyOf,...query}:Record<string,string|undefined>){
  delete query.view;
  const selection=z.union([z.literal('new'),z.string().guid("Invalid uuid")]).optional().safeParse(article);
  const source=z.string().guid("Invalid uuid").optional().safeParse(copyOf);
  const filter=portableArticleList.safeParse(query);
  if(!selection.success||!source.success||!filter.success||article&&Object.keys(query).length)notFound();
  // A copy only opens in the new-article editor.
  if(source.data&&selection.data!=='new')notFound();
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries({article,copyOf,...query}))if(value)params.set(key,value);
  const user=await requireChatGPTUser(portableArticlePath+(params.size?'&'+params:''));
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb();
  const categories=await listPortableKnowledgeCategories(db,user.userId,'active');
  if(!selection.data){
    const list=await listPortableArticles(db,user.userId,filter.data);
    return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories} view={{mode:'list',list,filters:filter.data,paged:!!filter.data.afterId}}/>);
  }
  const read=(id:string)=>readPortableArticle(db,user.userId,id).catch(error=>{
    if(error instanceof ApiError&&error.status===404)notFound();
    throw error;
  });
  if(source.data){
    // Reads only; nothing is written until the owner saves the copy.
    const original=await read(source.data);
    if(original.archivedAt)notFound();
    const copy=portableArticleCopy(original.content,categories.map(category=>category.id));
    return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories}
      view={{mode:'editor',copy:{...copy,sourceId:original.id,sourceTitle:original.content.title}}}/>);
  }
  const initial=selection.data==='new'?undefined:await read(selection.data);
  return withPortableNavigation(user.email,<PortableKnowledge email={user.email} categories={categories} view={{mode:'editor',initial}}/>);
}
