import {and,desc,eq,isNotNull,isNull,lt,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {foldArticleText,normalizeArticleHtml,sameArticleContent,type ArticleContent,type ArticleVersionAction,type articleMutation} from '../../lib/knowledge-base';
import type {portableArticleList} from '../../lib/portable-knowledge';
import {knowledgeArticles as articles,knowledgeCategories,knowledgeVersions as versions} from './knowledge-schema';
import {requireActiveKnowledgeCategory} from './knowledge-category-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

const pageSize=25;
const articleFields={
  id:articles.id,content:articles.content,revision:articles.revision,
  createdAt:articles.createdAt,updatedAt:articles.updatedAt,archivedAt:articles.archivedAt,
};
const historyFields={
  title:sql<string>`${versions.content}->>'title'`,revision:versions.revision,
  action:versions.action,sourceRevision:versions.sourceRevision,
  savedAt:versions.savedAt,archivedAt:versions.archivedAt,changedById:versions.changedById,
};
const unavailable=()=>new ApiError(404,'Article is unavailable.');
const conflict=()=>new ApiError(409,'This article changed or was archived. Reload the saved article before trying again.');

export async function listPortableArticles(db:PostgresJsDatabase,actorId:string,input:z.infer<typeof portableArticleList>){
  const q=foldArticleText(input.q);
  const rows=await db.select({
    id:articles.id,title:sql<string>`${articles.content}->>'title'`,
    category:sql<string>`coalesce((SELECT c.name FROM ${knowledgeCategories} c WHERE c.workspace_id=${articles.workspaceId}
      AND c.id::text=${articles.content}->>'categoryId'),${articles.content}->>'category')`,
    categoryId:sql<string|null>`${articles.content}->>'categoryId'`,excerpt:articles.excerpt,
    updatedAt:articles.updatedAt,archivedAt:articles.archivedAt,
  }).from(articles).innerJoin(workspaces,eq(articles.workspaceId,workspaces.id))
    .where(and(eq(workspaces.ownerId,actorId),
      input.status==='draft'?isNull(articles.archivedAt):input.status==='archived'?isNotNull(articles.archivedAt):undefined,
      // A managed category matches by its current name, so a rename is searchable at once.
      q?sql`(strpos(${articles.searchText},${q}) > 0 OR EXISTS(SELECT 1 FROM ${knowledgeCategories} c WHERE c.workspace_id=${articles.workspaceId}
        AND c.id::text=${articles.content}->>'categoryId' AND strpos(c.name_key,${q}) > 0))`:undefined,
      input.categoryId?sql`${articles.content}->>'categoryId'=${input.categoryId}::text`:undefined,
      input.afterAt!==undefined?sql`(${articles.updatedAt}, ${articles.id}) < (${input.afterAt}, ${input.afterId})`:undefined))
    .orderBy(desc(articles.updatedAt),desc(articles.id)).limit(pageSize+1);
  const items=rows.slice(0,pageSize),last=items.at(-1);
  return {items,next:rows.length>pageSize&&last?{afterAt:last.updatedAt,afterId:last.id}:null};
}

export async function readPortableArticle(db:PostgresJsDatabase,actorId:string,id:string){
  const [item]=await db.select(articleFields).from(articles).innerJoin(workspaces,eq(articles.workspaceId,workspaces.id))
    .where(and(eq(workspaces.ownerId,actorId),eq(articles.id,id)));
  if(!item)throw unavailable();
  return item;
}

export async function readPortableArticleHistory(db:PostgresJsDatabase,actorId:string,id:string,before?:number){
  const rows=await db.select({...historyFields,current:sql<boolean>`${versions.revision} = ${articles.revision}`})
    .from(versions).innerJoin(articles,and(eq(versions.workspaceId,articles.workspaceId),eq(versions.articleId,articles.id)))
    .innerJoin(workspaces,eq(versions.workspaceId,workspaces.id))
    .where(and(eq(workspaces.ownerId,actorId),eq(versions.articleId,id),before===undefined?undefined:lt(versions.revision,before)))
    .orderBy(desc(versions.revision)).limit(pageSize+1);
  if(!rows.length)await readPortableArticle(db,actorId,id);
  const items=rows.slice(0,pageSize);
  return {items,next:rows.length>pageSize?items.at(-1)?.revision??null:null};
}

export async function readPortableArticleVersion(db:PostgresJsDatabase,actorId:string,id:string,revision:number){
  const [item]=await db.select({...historyFields,content:versions.content}).from(versions)
    .innerJoin(workspaces,eq(versions.workspaceId,workspaces.id))
    .where(and(eq(workspaces.ownerId,actorId),eq(versions.articleId,id),eq(versions.revision,revision)));
  if(!item)throw new ApiError(404,'Article version is unavailable.');
  return item;
}

// A managed category replaces the free-text one; its current name is searchable.
function articleValues(raw:ArticleContent){
  const {bodyHtml,bodyText}=normalizeArticleHtml(raw.bodyHtml);
  const content=raw.categoryId?{...raw,category:'',bodyHtml}:{...raw,bodyHtml};
  return {
    content,
    excerpt:bodyText.slice(0,180),
    searchText:foldArticleText([raw.title,raw.subtitle,content.category,...raw.tags,bodyText].join('\n')),
  };
}

export async function mutatePortableArticle(db:PostgresJsDatabase,actorId:string,input:z.infer<typeof articleMutation>){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.revision===0);
    if(!workspaceId)throw unavailable();
    const values=async(content:ArticleContent)=>{
      if(content.categoryId)await requireActiveKnowledgeCategory(tx,workspaceId,content.categoryId);
      return articleValues(content);
    };
    const savedValues=input.action==='save'?await values(input.content):undefined;
    const scope=and(eq(articles.workspaceId,workspaceId),eq(articles.id,input.id));
    const versionScope=and(eq(versions.workspaceId,workspaceId),eq(versions.articleId,input.id));
    const current=async()=>(
      await tx.select(articleFields).from(articles).where(scope).for('update')
    )[0];
    const action:ArticleVersionAction=input.action==='save'?(input.revision===0?'created':'saved'):
      input.action==='restore'?'restored':input.archived?'archived':'unarchived';
    const sourceRevision=input.action==='restore'?input.sourceRevision:null;
    const now=Date.now();
    let item:typeof articles.$inferSelect|undefined;
    if(input.revision===0&&savedValues){
      [item]=await tx.insert(articles).values({
        ...savedValues,workspaceId,id:input.id,revision:1,createdAt:now,updatedAt:now,
      }).onConflictDoNothing().returning();
    }
    if(!item){
      const existing=await current();
      if(!existing)throw unavailable();
      let next=savedValues;
      if(input.action==='restore'){
        if(input.sourceRevision>=input.revision)throw new ApiError(400,'Choose an earlier article version.');
        const [source]=await tx.select({content:versions.content}).from(versions)
          .where(and(versionScope,eq(versions.revision,input.sourceRevision)));
        if(!source)throw new ApiError(404,'Article version is unavailable.');
        next=await values(source.content);
      }
      if(existing.revision===input.revision+1){
        const [receipt]=await tx.select({action:versions.action,sourceRevision:versions.sourceRevision}).from(versions)
          .where(and(versionScope,eq(versions.revision,existing.revision)));
        if(receipt?.action===action&&receipt.sourceRevision===sourceRevision&&
          (next?sameArticleContent(existing.content,next.content):input.action==='archive'&&Boolean(existing.archivedAt)===input.archived)){
          return {item:existing};
        }
      }
      if(existing.revision!==input.revision||input.revision===0||input.action!=='archive'&&existing.archivedAt!==null)throw conflict();
      if(input.action==='archive'){
        if(Boolean(existing.archivedAt)===input.archived)return {item:existing};
        if(!input.archived&&existing.content.categoryId)await requireActiveKnowledgeCategory(tx,workspaceId,existing.content.categoryId);
      }
      [item]=await tx.update(articles).set({
        ...next,revision:existing.revision+1,updatedAt:Math.max(now,existing.updatedAt+1),
        archivedAt:input.action==='archive'&&input.archived?now:null,
      }).where(and(scope,eq(articles.revision,input.revision))).returning();
    }
    if(!item)throw conflict();
    await tx.insert(versions).values({
      workspaceId,articleId:item.id,revision:item.revision,content:item.content,
      action,sourceRevision,savedAt:item.updatedAt,archivedAt:item.archivedAt,changedById:actorId,
    });
    return {item:{
      id:item.id,content:item.content,revision:item.revision,
      createdAt:item.createdAt,updatedAt:item.updatedAt,archivedAt:item.archivedAt,
    }};
  });
}
