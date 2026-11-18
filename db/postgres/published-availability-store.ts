import {and,desc,eq,gt,inArray,isNotNull,lt,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {availabilityPageChanged,availabilityPageFromInput,validatePublishedSlots,
  availabilityState,sameAvailabilityPage,type AvailabilityPageInput,type VerifiedBookingCursor} from '../../lib/calendar/published-availability';
import {attachGuestInvitationStatuses} from '../../lib/calendar/guest-invitation';
import {ApiError} from '../../lib/api-error';
import {portableGuestBookingRequests as requests,portableMeetings,portablePublishedAvailability as pages} from './portable-meeting-schema';
import {portableOpenCalendarSlots} from './portable-meeting-store';
import {privateWorkspaces} from './workspace-schema';
import {loginIdentities,loginSessions} from './identity-schema';
import {lockRecordWorkspace} from './private-workspace-store';

type Db=PostgresJsDatabase;
const projection={id:pages.id,title:pages.title,timeZone:pages.timeZone,slots:pages.slots,allowGuestProof:pages.allowGuestProof};
const verifiedRequestsPageSize=25;
export async function portableOwnerAvailability(db:Db,ownerId:string,includeRequests=false,cursor?:VerifiedBookingCursor){
  const [page]=await db.select({...projection,workspaceId:pages.workspaceId}).from(pages).innerJoin(privateWorkspaces,eq(pages.workspaceId,privateWorkspaces.id))
    .where(eq(privateWorkspaces.ownerId,ownerId));
  if(!page){
    if(cursor)throw availabilityPageChanged();
    return includeRequests?{...availabilityState(null),verifiedRequests:[]}:availabilityState(null);
  }
  const {workspaceId,...published}=page;
  const state=availabilityState(published);
  if(cursor&&(!includeRequests||!state.page?.allowGuestProof||state.page.id!==cursor.pageId))throw availabilityPageChanged();
  if(!includeRequests)return state;
  if(!state.page?.allowGuestProof)return {...state,verifiedRequests:[]};
  const r=requests;
  const scope=and(eq(r.workspaceId,workspaceId),eq(r.pageId,state.page.id),isNotNull(r.verifiedAt));
  let beforeAnchor;
  if(cursor){
    const [anchor]=await db.select({verifiedAt:r.verifiedAt}).from(r)
      .where(and(scope,eq(r.id,cursor.afterId))).limit(1);
    // The anchor can fall out of the upcoming list while its row still exists.
    if(!anchor||anchor.verifiedAt===null)throw availabilityPageChanged();
    beforeAnchor=or(lt(r.verifiedAt,anchor.verifiedAt),and(eq(r.verifiedAt,anchor.verifiedAt),lt(r.id,cursor.afterId)));
  }
  const pending=await db.select({id:r.id,email:r.email,start:r.start,end:r.end,verifiedAt:r.verifiedAt}).from(r)
    .innerJoin(pages,and(eq(r.workspaceId,pages.workspaceId),eq(r.pageId,pages.id)))
    .innerJoin(privateWorkspaces,eq(pages.workspaceId,privateWorkspaces.id))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),scope,gt(r.start,new Date().toISOString()),beforeAnchor))
    .orderBy(desc(r.verifiedAt),desc(r.id)).limit(verifiedRequestsPageSize+1);
  const visible=pending.slice(0,verifiedRequestsPageSize);
  const verifiedRequests=await attachGuestInvitationStatuses(workspaceId,visible,async ids=>
    db.select({id:portableMeetings.id,status:portableMeetings.status,eventUrl:portableMeetings.eventUrl}).from(portableMeetings)
      .where(and(eq(portableMeetings.workspaceId,workspaceId),eq(portableMeetings.ownerId,ownerId),inArray(portableMeetings.id,ids))));
  const nextVerifiedRequests=pending.length>verifiedRequestsPageSize
    ?{pageId:state.page.id,afterId:visible[verifiedRequestsPageSize-1].id}:null;
  return {...state,verifiedRequests,nextVerifiedRequests};
}

export function savePortableAvailability(db:Db,owner:{userId:string;email:string},input:AvailabilityPageInput,sessionHash:string){
  return db.transaction(async tx=>{
    const [session]=await tx.select({userId:loginSessions.userId}).from(loginSessions)
      .innerJoin(loginIdentities,eq(loginSessions.userId,loginIdentities.id))
      .where(and(eq(loginSessions.tokenHash,sessionHash),eq(loginIdentities.id,owner.userId),
        eq(loginIdentities.email,owner.email),gt(loginSessions.expiresAt,sql`extract(epoch from clock_timestamp())*1000`)))
      .for('share');
    if(!session)throw new ApiError(403,'Sign in again to manage availability.');
    const ownerId=owner.userId;
    const workspaceId=await lockRecordWorkspace(tx,ownerId,input.action==='publish',undefined,undefined,true);
    if(!workspaceId)return availabilityState(null);
    const [current]=await tx.select(projection).from(pages).where(eq(pages.workspaceId,workspaceId));
    if(input.action==='unpublish'){
      const state=availabilityState(current);
      if(!state.page)return state;
      if(state.page.id!==input.id)throw availabilityPageChanged();
      const [revoked]=await tx.update(pages).set({id:crypto.randomUUID(),title:'',slots:[],allowGuestProof:false})
        .where(and(eq(pages.workspaceId,workspaceId),eq(pages.id,input.id))).returning(projection);
      return availabilityState(revoked);
    }
    const page=availabilityPageFromInput(input);
    if(sameAvailabilityPage(current,page))return availabilityState(current);
    if((current?.id??null)!==input.previousId||page.id===current?.id)throw availabilityPageChanged();
    validatePublishedSlots(page.slots);
    const open=await portableOpenCalendarSlots(tx,ownerId,page.slots);
    if(open.length!==page.slots.length)throw new ApiError(409,'Some times are already held in Harbor. Check the window again.');
    await tx.insert(pages).values({workspaceId,...page}).onConflictDoUpdate({target:pages.workspaceId,set:page});
    return availabilityState(page);
  });
}

export async function findPortablePublishedAvailability(db:Db,id:string){
  const [row]=await db.select({...projection,workspaceId:pages.workspaceId,ownerId:privateWorkspaces.ownerId,email:loginIdentities.email})
    .from(pages).innerJoin(privateWorkspaces,eq(pages.workspaceId,privateWorkspaces.id))
    .innerJoin(loginIdentities,eq(privateWorkspaces.ownerId,loginIdentities.id)).where(eq(pages.id,id));
  return row;
}
