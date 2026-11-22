import {and,asc,eq,gt,ilike,inArray,isNotNull,isNull,ne,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {landingForOrigin,type LandingChange,type LandingDraft,type LandingListFilter} from '../../lib/portable-landing';
import {landingPages as pages,landingPublications as pubs,landingTitle,landingSlug} from './landing-page-schema';
import {leadForms as forms,leadFormActivations as active} from './lead-form-schema';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';
import {privateWorkspaces} from './workspace-schema';

const joinPublication=and(eq(pubs.workspaceId,pages.workspaceId),eq(pubs.pageId,pages.id));
const summary={id:pages.id,workspaceId:pages.workspaceId,revision:pages.revision,draftRevision:pages.draftRevision,
  publishedRevision:pubs.revision,publishedSlug:pubs.slug};
const owners=eq(privateWorkspaces.id,pages.workspaceId);
export async function landingList(db:PostgresJsDatabase,userId:string,{q,status,after}:LandingListFilter){
  const title=landingTitle(pages.draft),slug=landingSlug(pages.draft);
  const pattern=recordSearchPattern(q);
  const draftMatches=pattern?or(ilike(title,pattern),ilike(slug,pattern)):undefined;
  const liveMatches=pattern?or(ilike(landingTitle(pages.lastPublished),pattern),ilike(landingSlug(pages.lastPublished),pattern)):undefined;
  const visibility={
    draft:isNull(pubs.pageId),published:eq(pubs.revision,pages.draftRevision),changed:ne(pubs.revision,pages.draftRevision),
  };
  const rows=await db.select({...summary,title,slug}).from(pages)
    .innerJoin(privateWorkspaces,owners).leftJoin(pubs,joinPublication)
    .where(and(eq(privateWorkspaces.ownerId,userId),after?gt(pages.id,after):undefined,status?visibility[status]:undefined,
      // Both snapshots are on the page, so Postgres can find all candidates before joining.
      // A withdrawn page retains its last snapshot. Only its draft may match after withdrawal.
      pattern?and(or(draftMatches,liveMatches),or(draftMatches,isNotNull(pubs.pageId))):undefined))
    .orderBy(asc(pages.id)).limit(26);
  return {items:rows.slice(0,25),next:rows.length>25?rows[24].id:null};
}
export async function landingLinkChoices(db:PostgresJsDatabase,userId:string,input:{q?:string;after?:string;current?:string;exclude?:string}){
  const title=landingTitle(pages.lastPublished);
  const source=()=>db.select({id:pages.id,title,slug:pubs.slug}).from(pubs)
    .innerJoin(pages,joinPublication).innerJoin(privateWorkspaces,owners);
  const scope=and(eq(privateWorkspaces.ownerId,userId),input.exclude?ne(pages.id,input.exclude):undefined);
  const pattern=recordSearchPattern(input.q);
  const rows=await source().where(and(scope,input.after?gt(pages.id,input.after):undefined,
    pattern?or(ilike(title,pattern),ilike(landingSlug(pages.lastPublished),pattern)):undefined)).orderBy(asc(pages.id)).limit(26);
  const items=rows.slice(0,25);
  const current=input.current?(items.find(item=>item.id===input.current)??
    (await source().where(and(scope,eq(pages.id,input.current))).limit(1))[0]):undefined;
  return {items,current:current??null,next:rows.length>25?items[24].id:null};
}

function linkedPageIds(draft:LandingDraft){
  return [...new Set(draft.blocks.flatMap(b=>b.type==='button'&&'pageId' in b.target?[b.target.pageId]:[]))];
}
export async function ownerLanding(db:PostgresJsDatabase,userId:string,id:string){
  const [row]=await db.select({...summary,draft:pages.draft,lastPublished:pages.lastPublished}).from(pages).innerJoin(privateWorkspaces,owners)
    .leftJoin(pubs,joinPublication).where(and(eq(privateWorkspaces.ownerId,userId),eq(pages.id,id)));
  return row;
}
const missing=()=>new ApiError(404,'Page unavailable.');
const stale=()=>new ApiError(409,'This page changed. Reload it before saving or publishing.');
async function linkedForms(db:PostgresJsDatabase,workspace:string,draft:LandingDraft,enabled:boolean){
  const ids=[...new Set(draft.blocks.flatMap(b=>b.type==='form'?[b.formId]:[]))];
  if(!ids.length)return {ids,available:new Map<string,string|null>()};
  const matches=db.select({id:forms.id,embedOrigin:sql<string|null>`${forms.definition}->>'embedOrigin'`}).from(forms);
  const rows=await (enabled?matches.innerJoin(active,eq(active.formId,forms.id)):matches)
    .where(and(eq(forms.workspaceId,workspace),inArray(forms.id,ids)));
  return {ids,available:new Map(rows.map(row=>[row.id,row.embedOrigin]))};
}
export async function changeLanding(db:PostgresJsDatabase,actor:PostgresSessionActor,input:LandingChange){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to manage landing pages.');
    const ws=await lockRecordWorkspace(tx,actor.userId,input.action==='save',undefined,undefined,true);
    if(!ws)throw missing();
    const page=await ownerLanding(tx,actor.userId,input.id);
    if(!page&&(input.revision!==0||input.action!=='save'))throw missing();
    if((page?.revision??0)!==input.revision)throw stale();
    const revision=input.revision+1;
    const target=and(eq(pages.workspaceId,ws),eq(pages.id,input.id));
    const publication=and(eq(pubs.workspaceId,ws),eq(pubs.pageId,input.id));
    if(input.action==='save'){
      const {available,ids}=await linkedForms(tx,ws,input.draft,false);
      if(ids.length!==available.size)throw new ApiError(400,'Choose forms from this workspace.');
      const links=linkedPageIds(input.draft);
      if(links.length){
        const owned=await tx.select({id:pages.id}).from(pages).where(and(eq(pages.workspaceId,ws),inArray(pages.id,links)));
        if(links.includes(input.id)||owned.length!==links.length)throw new ApiError(400,'Choose another landing page in this workspace.');
      }
      const fields={revision,draftRevision:revision,draft:input.draft};
      if(page)await tx.update(pages).set(fields).where(target);
      else if(!(await tx.insert(pages).values({...fields,id:input.id,workspaceId:ws}).onConflictDoNothing().returning({id:pages.id})).length)throw stale();
    }else if(page){
      if(input.action==='publish'){
        const {available,ids}=await linkedForms(tx,ws,page.draft,true);
        if(ids.length!==available.size)throw new ApiError(409,'Enable each linked form before publishing.');
        const links=linkedPageIds(page.draft);
        if(links.length){
          const live=await tx.select({id:pubs.pageId}).from(pubs).where(and(eq(pubs.workspaceId,ws),inArray(pubs.pageId,links)));
          if(live.length!==links.length)throw new ApiError(409,'Publish each linked landing page or change its button before publishing.');
        }
        // All publication changes hold the workspace lock, including claims on an old address.
        const addresses=[page.draft.slug,...(page.draft.redirectFrom??[])];
        const direct=tx.select({id:pubs.pageId}).from(pubs).where(and(eq(pubs.workspaceId,ws),ne(pubs.pageId,page.id),inArray(pubs.slug,addresses)));
        const redirects=tx.select({id:pubs.pageId}).from(pages).innerJoin(pubs,joinPublication)
          .where(and(eq(pages.workspaceId,ws),ne(pages.id,page.id),
            sql`(${pages.lastPublished}->'redirectFrom') ?| ARRAY[${sql.join(addresses.map(address=>sql`${address}`),sql`, `)}]::text[]`));
        const [collision]=await direct.unionAll(redirects).limit(1);
        if(collision)throw new ApiError(409,'A page address or redirect already belongs to another published page.');
        const snapshot={slug:page.draft.slug,revision:page.draftRevision};
        await tx.insert(pubs).values({...snapshot,pageId:page.id,workspaceId:ws})
          .onConflictDoUpdate({target:[pubs.workspaceId,pubs.pageId],set:snapshot});
      }else await tx.delete(pubs).where(publication);
      await tx.update(pages).set({revision,...(input.action==='publish'?{lastPublished:page.draft}:{})}).where(target);
    }
    return (await ownerLanding(tx,actor.userId,input.id))!;
  });
}
export async function publishedLanding(db:PostgresJsDatabase,workspace:string,slug:string,servedOrigin:string){
  return db.transaction(async tx=>{
    const [page]=await tx.select({content:pages.lastPublished}).from(pubs).innerJoin(pages,joinPublication).where(and(eq(pubs.workspaceId,workspace),eq(pubs.slug,slug)));
    if(!page?.content){
      const [redirect]=await tx.select({redirect:pubs.slug}).from(pages).innerJoin(pubs,joinPublication)
        .where(and(eq(pages.workspaceId,workspace),sql`(${pages.lastPublished}->'redirectFrom') ? ${slug}`)).limit(1);
      return redirect??null;
    }
    const {available}=await linkedForms(tx,workspace,page.content,true);
    const draft=landingForOrigin(page.content,available,servedOrigin);
    const links=linkedPageIds(draft);
    const linkedPages=links.length?await tx.select({id:pubs.pageId,slug:pubs.slug}).from(pubs)
      .where(and(eq(pubs.workspaceId,workspace),inArray(pubs.pageId,links))):[];
    return {draft,linkedPages};
  },{accessMode:'read only',isolationLevel:'repeatable read'});
}
