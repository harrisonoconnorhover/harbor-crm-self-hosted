import {z} from 'zod';
import {listPortableKnowledgeCategories,mutatePortableKnowledgeCategory} from '../db/postgres/knowledge-category-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableKnowledgeCategoryMutation,portableKnowledgeCategoryQuery} from '../lib/portable-knowledge';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

// Knowledge base categories are owner-private, like the articles.
async function categories(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Invalid category settings query.'},400);
      const text=await readBoundedRequestText(request,4096);
      if(text===null)return json({error:'Category settings are too large.'},413);
      return json({item:await mutatePortableKnowledgeCategory(db,user.userId,portableKnowledgeCategoryMutation.parse(JSON.parse(text)))});
    }
    const query=portableKnowledgeCategoryQuery.parse(Object.fromEntries(params));
    return json({items:await listPortableKnowledgeCategories(db,user.userId,query.status)});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the category fields.'},400);
    if(error instanceof SyntaxError)return json({error:'Send valid category settings.'},400);
    return json({error:'Could not confirm the category change. Reload to check.'},503);
  }
}

export {categories as GET,categories as POST};
