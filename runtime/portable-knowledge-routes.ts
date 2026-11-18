import {z} from 'zod';
import {listPortableArticles,mutatePortableArticle,readPortableArticle,readPortableArticleHistory,readPortableArticleVersion} from '../db/postgres/knowledge-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {ArticleContentError,articleMutation} from '../lib/knowledge-base';
import {portableArticleDetail,portableArticleList} from '../lib/portable-knowledge';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function articles(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Invalid article settings query.'},400);
      // The JSON representation can escape each character as a six-byte Unicode escape.
      const text=await readBoundedRequestText(request,800_000);
      if(text===null)return json({error:'Article settings are too large.'},413);
      return json(await mutatePortableArticle(db,user.userId,articleMutation.parse(JSON.parse(text))));
    }
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid article query.'},400);
    const query=Object.fromEntries(params);
    if(!params.has('id'))return json(await listPortableArticles(db,user.userId,portableArticleList.parse(query)));
    const {id,history,version,before}=portableArticleDetail.parse(query);
    if(history)return json(await readPortableArticleHistory(db,user.userId,id,before));
    if(version)return json({item:await readPortableArticleVersion(db,user.userId,id,version)});
    return json({item:await readPortableArticle(db,user.userId,id)});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the article fields.'},400);
    if(error instanceof ArticleContentError)return json({error:error.message},400);
    if(error instanceof SyntaxError)return json({error:'Send valid article settings.'},400);
    console.error('Portable article request failed.');
    return json({error:'Could not confirm the article request. Your draft is kept.'},503);
  }
}

export {articles as GET,articles as POST};
