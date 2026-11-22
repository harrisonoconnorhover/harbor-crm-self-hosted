import {and,asc,eq,exists,gt,ilike,isNull,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {randomSecret,sha256} from '../../lib/email/crypto';
import type {CasePortalChange,CasePortalState} from '../../lib/portable-case-portal';
import {recordSearchPattern} from './record-search';
import type {ticketStatuses} from '../../lib/crm';
import {recordPreviewAccess,type RecordAccessActor} from './record-access-store';
import {contacts} from './contact-schema';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {knowledgeArticles,knowledgeVersions,articlePublications,helpCenters as centers} from './knowledge-schema';
import {lockRecordWorkspace,readOwnedWorkspaceId} from './private-workspace-store';
import {customerCaseAccess as access,customerCasePublications as publications,portableTickets as tickets} from './ticket-schema';

type Db=PostgresJsDatabase;
const day=24*60*60*1000;
const pageSize=25;
const secretFormat=/^[A-Za-z0-9_-]{43}$/;
const unavailable=()=>new ApiError(404,'Case unavailable.');
const conflict=()=>new ApiError(409,'The ticket or portal settings changed. Refresh before trying again.');
const brand={name:centers.name,accent:centers.accent};
const contactJoin=and(eq(contacts.workspaceId,tickets.workspaceId),eq(contacts.id,tickets.contactId),isNull(contacts.archivedAt));

// A case refers to the article, never to a draft or a copied title.
async function publishedArticle(db:Db,workspace:string,id:string){
  const [row]=await db.select({id:articlePublications.articleId,title:sql<string>`${knowledgeVersions.content}->>'title'`})
    .from(articlePublications).innerJoin(knowledgeVersions,and(eq(knowledgeVersions.workspaceId,articlePublications.workspaceId),
      eq(knowledgeVersions.articleId,articlePublications.articleId),eq(knowledgeVersions.revision,articlePublications.publishedRevision)))
    .innerJoin(knowledgeArticles,and(eq(knowledgeArticles.workspaceId,articlePublications.workspaceId),eq(knowledgeArticles.id,articlePublications.articleId)))
    .where(and(eq(articlePublications.workspaceId,workspace),eq(articlePublications.articleId,id),isNull(knowledgeArticles.archivedAt)));
  return row??null;
}

async function caseState(db:Db,workspace:string,ticketId:string):Promise<CasePortalState>{
  const [row]=await db.select({
    ticketRevision:tickets.revision,id:contacts.id,name:sql<string|null>`${contacts.data}->>'name'`,
    articleId:publications.articleId,pc:publications.contactId,revision:publications.revision,subject:publications.subject,update:publications.update,
    accessRevision:access.revision,kind:access.kind,expiresAt:access.expiresAt,
    centerId:centers.id,centerName:centers.name,enabled:centers.enabled,
  }).from(tickets).leftJoin(contacts,contactJoin)
    .leftJoin(publications,and(eq(publications.workspaceId,tickets.workspaceId),eq(publications.ticketId,tickets.id)))
    .leftJoin(access,and(eq(access.workspaceId,tickets.workspaceId),eq(access.contactId,contacts.id)))
    .leftJoin(centers,eq(centers.workspaceId,tickets.workspaceId))
    .where(and(eq(tickets.workspaceId,workspace),eq(tickets.id,ticketId),isNull(tickets.archivedAt)));
  if(!row)throw unavailable();
  return {ticketId,ticketRevision:row.ticketRevision,contact:row.id?{id:row.id,name:row.name??''}:null,
    center:row.centerId?{id:row.centerId,name:row.centerName!,enabled:row.enabled!}:null,
    publicationRevision:row.revision??0,
    publication:row.pc&&row.pc===row.id?{revision:row.revision!,subject:row.subject!,update:row.update!,
      article:row.articleId?(await publishedArticle(db,workspace,row.articleId)??{id:row.articleId,title:null}):null}:null,
    access:row.kind?{revision:row.accessRevision!,state:row.expiresAt!==null&&row.expiresAt<=Date.now()?'expired':row.kind,expiresAt:row.expiresAt}:null};
}

async function recordCasePreview(db:Db,actor:RecordAccessActor,workspace:string,state:CasePortalState){
  const records=[{kind:'tickets',id:state.ticketId}];
  if(state.contact)records.push({kind:'contacts',id:state.contact.id});
  await recordPreviewAccess(db,actor,'related',records,workspace);
  return state;
}

export async function ownerCaseState(db:Db,actor:RecordAccessActor,ticketId:string,includeBody:boolean){
  return db.transaction(async tx=>{
    const workspace=await readOwnedWorkspaceId(tx,actor.userId);
    if(!workspace)throw unavailable();
    const state=await caseState(tx,workspace,ticketId);
    return includeBody?recordCasePreview(tx,actor,workspace,state):state;
  },{isolationLevel:'repeatable read',accessMode:includeBody?'read write':'read only'});
}

export async function changeCasePortal(db:Db,actor:PostgresSessionActor,input:CasePortalChange):Promise<CasePortalState>{
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to manage this case.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,false,undefined,undefined,true);
    if(!workspace)throw unavailable();
    // Customer sign-out also updates this row, independently of the workspace management lock.
    if(input.action==='invite'||input.action==='revoke')await tx.select({revision:access.revision}).from(access)
      .where(and(eq(access.workspaceId,workspace),eq(access.contactId,input.contactId))).for('update');
    const current=await caseState(tx,workspace,input.ticketId);
    if(input.contactId!==current.contact?.id||input.ticketRevision!==current.ticketRevision)throw conflict();
    if((input.action==='publish'||input.action==='invite')&&!current.center?.enabled)
      throw new ApiError(409,'Open the help center before sharing cases.');
    const {ticketId,contactId}=input;
    const preview=(state:CasePortalState)=>recordCasePreview(tx,actor,workspace,state);
    let inviteToken:string|undefined;
    if(input.action==='publish'||input.action==='withdraw'){
      if(current.publicationRevision!==input.expectedRevision)throw conflict();
      if(input.action==='withdraw'&&!current.publication)return preview(current);
      const previousArticle=current.publication?.article?.id??null;
      const articleId=input.action==='publish'&&input.articleId!==undefined?input.articleId:previousArticle;
      if(articleId&&articleId!==previousArticle&&!await publishedArticle(tx,workspace,articleId))
        throw new ApiError(409,'Choose a currently published article from this help center.');
      const next=input.action==='publish'?{contactId,subject:input.subject,update:input.update,articleId}:
        {contactId:null,subject:null,update:null,articleId:null};
      if(current.publication&&next.subject===current.publication.subject&&next.update===current.publication.update&&articleId===previousArticle)return preview(current);
      const values={...next,revision:input.expectedRevision+1};
      await tx.insert(publications).values({...values,workspaceId:workspace,ticketId})
        .onConflictDoUpdate({target:[publications.workspaceId,publications.ticketId],set:values});
    }else{
      if((current.access?.revision??0)!==input.expectedRevision)throw conflict();
      if(input.action==='revoke'&&(!current.access||current.access.state==='revoked'))return preview(current);
      inviteToken=input.action==='invite'?randomSecret():undefined;
      const values={kind:inviteToken?'invited' as const:'revoked' as const,tokenHash:inviteToken?await sha256(inviteToken):null,
        expiresAt:inviteToken?Date.now()+day:null,revision:input.expectedRevision+1};
      await tx.insert(access).values({...values,workspaceId:workspace,contactId})
        .onConflictDoUpdate({target:[access.workspaceId,access.contactId],set:values});
    }
    return {...await preview(await caseState(tx,workspace,ticketId)),...(inviteToken?{inviteToken}:{})};
  });
}

export async function readCaseBrand(db:Db,centerId:string){
  const [row]=await db.select(brand).from(centers).where(and(eq(centers.id,centerId),eq(centers.enabled,true)));
  return row??null;
}

const activeContact=and(eq(contacts.workspaceId,access.workspaceId),eq(contacts.id,access.contactId),isNull(contacts.archivedAt));
function centerScope(db:Db,centerId:string){
  return exists(db.select({id:centers.id}).from(centers).where(and(eq(centers.workspaceId,access.workspaceId),
    eq(centers.id,centerId),eq(centers.enabled,true))));
}

export async function redeemCaseInvite(db:Db,centerId:string,inviteToken:string){
  if(!secretFormat.test(inviteToken))return null;
  const token=randomSecret(),expiresAt=Date.now()+7*day;
  // The conditional UPDATE both consumes the invitation and installs the session.
  const [claimed]=await db.update(access).set({kind:'active',tokenHash:await sha256(token),expiresAt})
    .where(and(eq(access.tokenHash,await sha256(inviteToken)),eq(access.kind,'invited'),gt(access.expiresAt,Date.now()),
      centerScope(db,centerId),exists(db.select({id:contacts.id}).from(contacts).where(activeContact))))
    .returning({expiresAt:access.expiresAt});
  return claimed?{token,expiresAt}:null;
}

export async function signOutCustomerCases(db:Db,centerId:string,sessionToken:string){
  if(!secretFormat.test(sessionToken))return;
  await db.update(access).set({kind:'revoked',tokenHash:null,expiresAt:null,revision:sql`${access.revision}+1`})
    .where(and(eq(access.kind,'active'),eq(access.tokenHash,await sha256(sessionToken)),centerScope(db,centerId)));
}

export async function readCustomerCases(db:Db,centerId:string,sessionToken:string,input:{id?:string;after?:string;q?:string;includeUpdates?:boolean;status?:(typeof ticketStatuses)[number]}={}){
  if(!secretFormat.test(sessionToken))return null;
  const hash=await sha256(sessionToken);
  return db.transaction(async tx=>{
    const [scope]=await tx.select({...brand,workspace:access.workspaceId,contact:access.contactId}).from(access)
      .innerJoin(contacts,activeContact).innerJoin(centers,eq(centers.workspaceId,access.workspaceId))
      .where(and(eq(centers.id,centerId),eq(centers.enabled,true),eq(access.tokenHash,hash),eq(access.kind,'active'),gt(access.expiresAt,Date.now())));
    if(!scope)return null;
    const status=sql<string>`${tickets.data}->>'ticketStatus'`;
    const pattern=recordSearchPattern(input.q);
    const rows=await tx.select({id:tickets.id,articleId:publications.articleId,subject:publications.subject,
      update:input.id?publications.update:sql<null>`NULL`,status}).from(publications)
      .innerJoin(tickets,and(eq(tickets.workspaceId,publications.workspaceId),eq(tickets.id,publications.ticketId),
        eq(tickets.contactId,publications.contactId),isNull(tickets.archivedAt)))
      .where(and(eq(publications.workspaceId,scope.workspace),eq(publications.contactId,scope.contact),
        pattern?or(ilike(publications.subject,pattern),input.includeUpdates?ilike(publications.update,pattern):undefined):undefined,input.status?eq(status,input.status):undefined,
        input.id?eq(publications.ticketId,input.id):undefined,input.after?gt(publications.ticketId,input.after):undefined))
      .orderBy(asc(publications.ticketId)).limit(input.id?1:pageSize+1);
    if(input.id&&!rows.length)return null;
    const items=rows.slice(0,pageSize).map(row=>({...row,subject:row.subject!}));
    const article=input.id&&items[0]?.articleId?await publishedArticle(tx,scope.workspace,items[0].articleId):null;
    return {name:scope.name,accent:scope.accent,article,items,next:rows.length>pageSize?items[pageSize-1].id:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
