import {sharedToolAllowed} from './shared-tool-permission';
import {and,eq,isNotNull,isNull,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {HelpChange,HelpState} from '../../lib/help-center';
import {foldArticleText,normalizeArticleHtml} from '../../lib/knowledge-base';
import {articlePublications as pubs,helpCenters as centers,knowledgeArticles as articles,knowledgeVersions as versions} from './knowledge-schema';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordCatalogScope} from './workspace-viewer-store';
import {privateWorkspaces} from './workspace-schema';
import {literalSearchPattern} from './search-index';

type Db=PostgresJsDatabase;
const brand={id:centers.id,name:centers.name,accent:centers.accent,enabled:centers.enabled,revision:centers.revision};
const publication={topic:pubs.topic,publishedRevision:pubs.publishedRevision,revision:pubs.revision};
const conflict=()=>new ApiError(409,'The article or publication settings changed. Refresh before publishing.');
const scope=(workspace:string,id:string)=>and(eq(pubs.workspaceId,workspace),eq(pubs.articleId,id));

export async function ownerHelpState(db:Db,user:string,id?:string):Promise<HelpState>{
  const [workspace]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,user));
  if(!workspace)return {center:null,publication:null};
  const [center]=await db.select(brand).from(centers).where(eq(centers.workspaceId,workspace.id));
  const [pub]=id?await db.select(publication).from(pubs).where(scope(workspace.id,id)):[];
  return {center:center??null,publication:pub??null};
}

export async function changeHelpCenter(db:Db,actor:PostgresSessionActor,input:HelpChange){
  await db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to manage publications.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,input.action==='settings',undefined,undefined,true);
    if(!workspace)throw new ApiError(404,'Help center unavailable.');
    const [center]=await tx.select().from(centers).where(eq(centers.workspaceId,workspace));
    if(input.action==='settings'){
      if((center?.revision??0)!==input.revision)throw conflict();
      const values={name:input.name,accent:input.accent,enabled:input.enabled,revision:input.revision+1};
      if(center)await tx.update(centers).set(values).where(eq(centers.workspaceId,workspace));
      else await tx.insert(centers).values({...values,id:crypto.randomUUID(),workspaceId:workspace});
      return;
    }
    const [article]=await tx.select().from(articles).where(and(eq(articles.workspaceId,workspace),eq(articles.id,input.id))).for('update');
    if(!article)throw new ApiError(404,'Article unavailable.');
    const [current]=await tx.select(publication).from(pubs).where(scope(workspace,input.id));
    if((current?.revision??0)!==input.revision||input.articleRevision!==article.revision)throw conflict();
    if(input.action==='publish'&&(!center?.enabled||article.archivedAt!==null))
      throw new ApiError(409,'Open your help center and choose an active article before publishing.');
    const publishedRevision=input.action==='publish'?article.revision:null;
    const topic=input.action==='publish'?(input.topic===undefined?current?.topic??null:input.topic):null;
    if((current?.publishedRevision??null)===publishedRevision&&(current?.topic??null)===topic)return;
    const {title,subtitle,bodyHtml}=article.content;
    const searchText=publishedRevision?foldArticleText([title,subtitle,normalizeArticleHtml(bodyHtml).bodyText].join(' ')):'';
    const values={publishedRevision,topic,searchText,revision:input.revision+1};
    await tx.insert(pubs).values({...values,workspaceId:workspace,articleId:input.id})
      .onConflictDoUpdate({target:[pubs.workspaceId,pubs.articleId],set:values});
  });
  return ownerHelpState(db,actor.userId,input.action==='settings'?undefined:input.id);
}

export async function publicHelp(db:Db,portal:string,input:{article?:string;q?:string;after?:string;topic?:string},requireExistingTopic=true){
  return db.transaction(async tx=>{
    const [center]=await tx.select({workspace:centers.workspaceId,name:centers.name,accent:centers.accent})
      .from(centers).where(and(eq(centers.id,portal),eq(centers.enabled,true)));
    if(!center)return null;
    const fields={id:pubs.articleId,topic:pubs.topic,title:sql<string>`${versions.content}->>'title'`,subtitle:sql<string>`${versions.content}->>'subtitle'`};
    const query=foldArticleText(input.q??'');
    const terms=query?[...new Set(query.split(' '))]:[];
    const text=sql`(${pubs.searchText} COLLATE "C")`;
    const phrase=literalSearchPattern(query);
    const ranked=!!query&&(!input.after||input.after.includes(':'));
    // Published search text starts with the title. Keep the rank in the cursor so
    // withdrawing the last article on a page cannot strand the next page.
    const rank=ranked?sql<number>`CASE WHEN ${text} LIKE ${phrase.slice(1)} THEN 0
      WHEN ${text} LIKE ${phrase} THEN 1 ELSE 2 END`:sql<number>`0::int`;
    const cursor=input.after?.split(':');
    const after=ranked&&cursor?.length===2?sql`(${rank},${pubs.articleId})>(${Number(cursor[0])}::int,${cursor[1]}::uuid)`:
      cursor?sql`${pubs.articleId}>${cursor.at(-1)}::uuid`:undefined;
    const editions=(includeBody=false)=>tx.select({...fields,rank,body:includeBody?sql<string>`${versions.content}->>'bodyHtml'`:sql<string>`''`})
      .from(pubs).innerJoin(versions,and(eq(versions.workspaceId,pubs.workspaceId),eq(versions.articleId,pubs.articleId),eq(versions.revision,pubs.publishedRevision)))
      .innerJoin(articles,and(eq(articles.workspaceId,pubs.workspaceId),eq(articles.id,pubs.articleId)));
    const visible=and(eq(pubs.workspaceId,center.workspace),input.topic?eq(pubs.topic,input.topic):undefined,isNull(articles.archivedAt),isNotNull(pubs.publishedRevision));
    const rows=await editions(Boolean(input.article)).where(and(visible,
        input.article?eq(pubs.articleId,input.article):undefined,after,
        ...terms.map(term=>sql`${text} LIKE ${literalSearchPattern(term)}`)))
      .orderBy(...(ranked?[rank,pubs.articleId]:[pubs.articleId])).limit(input.article?1:26);
    if(input.article&&!rows.length)return null;
    if(requireExistingTopic&&input.topic&&!rows.length){
      const [existing]=await tx.select({id:pubs.articleId}).from(pubs)
        .innerJoin(articles,and(eq(articles.workspaceId,pubs.workspaceId),eq(articles.id,pubs.articleId))).where(visible).limit(1);
      if(!existing)return null;
    }
    // Keep literal punctuation, record codes and saved pagination cursors exact.
    const longTerms=terms.filter(term=>term.length>=5);
    if(!rows.length&&!input.article&&!input.after&&longTerms.length&&terms.length<=4&&terms.every(term=>/^\p{L}{1,64}$/u.test(term))){
      const candidates=terms.map(term=>term.length<5?sql`${text} LIKE ${literalSearchPattern(term)}`:
        sql`(${text} LIKE ${literalSearchPattern(term)} OR ${text} OPERATOR(public.%>>) ${term})`);
      const score=sql.join(longTerms.map(term=>sql`public.strict_word_similarity(${term},${text})`),sql` + `);
      const items=await editions().where(and(visible,...candidates)).orderBy(sql`(${score}) DESC`,pubs.articleId).limit(5);
      return {name:center.name,accent:center.accent,items,next:null,related:[],suggested:items.length>0};
    }
    const items=rows.slice(0,25),last=items.at(-1);
    const article=input.article?items[0]:undefined;
    const related=article?.topic?await editions().where(and(visible,eq(pubs.topic,article.topic),ne(pubs.articleId,article.id)))
      .orderBy(pubs.articleId).limit(5):[];
    return {name:center.name,accent:center.accent,items,related,suggested:false,next:rows.length>25&&last?(ranked?last.rank+':'+last.id:last.id):null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}


export function publicHelpTopics(db:Db,portal:string,after?:string){
  return db.transaction(async tx=>{
    const [center]=await tx.select({workspace:centers.workspaceId,name:centers.name,accent:centers.accent}).from(centers)
      .where(and(eq(centers.id,portal),eq(centers.enabled,true)));
    if(!center)return null;
    const rows=await tx.selectDistinct({topic:pubs.topic}).from(pubs)
      .innerJoin(articles,and(eq(articles.workspaceId,pubs.workspaceId),eq(articles.id,pubs.articleId)))
      .where(and(eq(pubs.workspaceId,center.workspace),isNotNull(pubs.publishedRevision),isNotNull(pubs.topic),
        isNull(articles.archivedAt),after?sql`${pubs.topic} > ${after}`:undefined))
      .orderBy(pubs.topic).limit(26);
    const topics=rows.slice(0,25).map(row=>row.topic!);
    return {name:center.name,accent:center.accent,topics,next:rows.length>25?topics[24]:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

// Resolve the center through the signed-in workspace, even when this person also owns one.
async function workspaceHelpCenter(db:Db,userId:string,workspaceId:string|undefined){
  if(!await sharedToolAllowed(db,userId,workspaceId,'knowledge'))throw new ApiError(404,'Knowledge base unavailable.');
  const [workspace]=await db.select({center:centers.id}).from(privateWorkspaces)
    .leftJoin(centers,and(eq(centers.workspaceId,privateWorkspaces.id),eq(centers.enabled,true)))
    .where(recordCatalogScope(db,userId,workspaceId)).limit(1);
  if(workspaceId&&!workspace)throw new ApiError(404,'Workspace unavailable.');
  return workspace?.center;
}

export async function workspaceHelpTopics(db:Db,userId:string,workspaceId:string|undefined,after?:string){
  const center=await workspaceHelpCenter(db,userId,workspaceId);
  const directory=center?await publicHelpTopics(db,center,after):null;
  return {topics:directory?.topics??[],next:directory?.next??null};
}

export async function workspaceHelpArticles(db:Db,userId:string,workspaceId:string|undefined,input:{q?:string;after?:string;topic?:string}){
  const center=await workspaceHelpCenter(db,userId,workspaceId);
  const published=center?await publicHelp(db,center,input,false):null;
  if(!published||!center)return {center:null,items:[],next:null,suggested:false};
  const path='/help/'+center;
  const items=published.items.map(({id,title,subtitle,topic})=>({id,title,subtitle,topic,path:path+'/'+id}));
  return {center:{name:published.name,path},items,next:published.next,suggested:published.suggested};
}
