import {sharedInboxReadable} from './shared-tool-permission';
import {and,desc,eq,gt,gte,isNotNull,isNull,lt,lte,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {firstResponseStatus,defaultResponsePolicy,responseDeadline,responseWorkingMs,type FirstResponse,type ResponsePolicy,type logFirstResponse,type logInboxResponse} from '../../lib/first-response';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import type {PortableTicketFields} from '../../lib/portable-tickets';
import {inboxMessages} from './team-inbox-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {ownedRecordScope} from './record-ownership-scope';
import {activeTicket,ticketOwnership,inboxTicketLinks,portableTickets,responsePolicies as policies,responseReceipts as receipts} from './ticket-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';

export function firstResponseConditions(asOf:string|SQL){
  const waiting=and(isNull(receipts.respondedAt),gte(receipts.dueAt,asOf));
  return {
    unanswered:and(isNotNull(receipts.ticketId),isNull(receipts.respondedAt)),
    waiting,
    due_next_hour:and(waiting,lte(receipts.dueAt,sql`${asOf}::timestamptz + interval '1 hour'`)),
    overdue:and(isNull(receipts.respondedAt),lt(receipts.dueAt,asOf)),
    met:lte(receipts.respondedAt,receipts.dueAt),
    late:gt(receipts.respondedAt,receipts.dueAt),
    no_target:isNull(receipts.ticketId),
  };
}

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const policyFields={enabled:policies.enabled,targets:policies.targets,calendar:policies.calendar,revision:policies.revision};
export const responseFields={policyRevision:receipts.policyRevision,targetMinutes:receipts.targetMinutes,dueAt:receipts.dueAt,
  respondedAt:receipts.respondedAt,workingMs:receipts.workingMs,actorId:receipts.actorId,channel:receipts.channel,summary:receipts.summary,
  inboxReplyId:receipts.inboxReplyId,
  inboxConversationId:sql<string|null>`(SELECT ${inboxMessages.conversationId} FROM ${inboxMessages}
    WHERE ${inboxMessages.workspaceId}=${receipts.workspaceId} AND ${inboxMessages.id}=${receipts.inboxReplyId})`.as('inbox_conversation_id'),
  recordedBy:sql<string|null>`(SELECT coalesce(nullif(${loginIdentities.fullName},''),${loginIdentities.email}) FROM ${loginIdentities}
    WHERE ${loginIdentities.id}=${receipts.actorId})`.as('response_author')};
export function responseResult(row:FirstResponse,asOf:string):FirstResponse&{status:ReturnType<typeof firstResponseStatus>}{
  return {...row,status:firstResponseStatus(row,Date.parse(asOf)),dueAt:new Date(row.dueAt).toISOString(),respondedAt:row.respondedAt&&new Date(row.respondedAt).toISOString()};
}
export async function getResponsePolicy(db:Db,user:string){
  const [policy]=await db.select(policyFields).from(policies).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,policies.workspaceId))
    .where(eq(privateWorkspaces.ownerId,user)).orderBy(desc(policies.revision)).limit(1);
  return policy??defaultResponsePolicy;
}
export async function saveResponsePolicy(db:Db,actor:PostgresSessionActor,input:ResponsePolicy){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to change support hours.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,true,undefined,undefined,true);
    if(!workspace)throw new ApiError(404,'Workspace unavailable.');
    const [current]=await tx.select({revision:policies.revision}).from(policies).where(eq(policies.workspaceId,workspace)).orderBy(desc(policies.revision)).limit(1);
    if((current?.revision??0)!==input.revision)throw new ApiError(409,'Response targets have changed. Reload the settings.');
    const [policy]=await tx.insert(policies).values({...input,workspaceId:workspace,revision:input.revision+1}).returning(policyFields);
    return policy;
  });
}

export async function ticketResponseReceipt(tx:Tx,workspace:string,ticket:{id:string;createdAt:string;data:PortableTicketFields},creating:boolean){
  if(!creating)return (await tx.select(responseFields).from(receipts).where(and(eq(receipts.workspaceId,workspace),eq(receipts.ticketId,ticket.id))))[0];
  const [policy]=await tx.select(policyFields).from(policies).where(eq(policies.workspaceId,workspace)).orderBy(desc(policies.revision)).limit(1);
  const minutes=ticket.data.ticketPriority&&policy?.targets[ticket.data.ticketPriority];
  if(!policy?.enabled||!minutes)return;
  return (await tx.insert(receipts).values({workspaceId:workspace,ticketId:ticket.id,policyRevision:policy.revision,targetMinutes:minutes,
    startedAt:ticket.createdAt,dueAt:responseDeadline(policy.calendar,Date.parse(ticket.createdAt),minutes)}).returning(responseFields))[0];
}

// The caller holds the workspace write lock and has just confirmed this outgoing reply.
export async function recordLinkedInboxResponse(tx:Tx,workspace:string,reply:{
  id:string;conversationId:string;mailbox:string;actorId:string|null;createdAt:string;
}){
  if(!reply.actorId)return;
  const [target]=await tx.select({id:receipts.ticketId,start:receipts.startedAt,calendar:policies.calendar})
    .from(inboxTicketLinks)
    .innerJoin(portableTickets,and(eq(portableTickets.workspaceId,inboxTicketLinks.workspaceId),eq(portableTickets.id,inboxTicketLinks.ticketId)))
    .innerJoin(receipts,and(eq(receipts.workspaceId,portableTickets.workspaceId),eq(receipts.ticketId,portableTickets.id)))
    .innerJoin(policies,and(eq(policies.workspaceId,receipts.workspaceId),eq(policies.revision,receipts.policyRevision)))
    .where(and(eq(inboxTicketLinks.workspaceId,workspace),eq(inboxTicketLinks.conversationId,reply.conversationId),
      activeTicket,isNull(receipts.respondedAt),lte(receipts.startedAt,reply.createdAt)))
    .for('update',{of:portableTickets});
  if(!target)return;
  await tx.update(receipts).set({respondedAt:reply.createdAt,actorId:reply.actorId,channel:'Email',
    summary:'Reply from '+reply.mailbox,inboxReplyId:reply.id,
    workingMs:responseWorkingMs(target.calendar,Date.parse(target.start),Date.parse(reply.createdAt))})
    .where(and(eq(receipts.workspaceId,workspace),eq(receipts.ticketId,target.id),isNull(receipts.respondedAt)));
}

export async function logTicketResponse(db:Db,actor:PostgresSessionActor,input:z.infer<typeof logFirstResponse|typeof logInboxResponse>,shared?:SharedRecordWriteScope){
  await db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again to log a response.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,false,shared,undefined,true,true,['tickets','edit']);
    if(!workspace)throw new ApiError(403,'Ticket editing access is required.');
    const inboxReadable=shared&&input.action==='inbox_first_response'?sharedInboxReadable(tx,actor.userId,workspace):sql<boolean>`true`;
    const [ticket]=await tx.select({revision:portableTickets.revision,inboxReadable}).from(portableTickets)
      .where(and(activeTicket,eq(portableTickets.workspaceId,workspace),eq(portableTickets.id,input.id),
        shared?ownedRecordScope(tx,actor.userId,workspace,ticketOwnership,'edit'):undefined)).for('update');
    if(!ticket)throw new ApiError(404,'Ticket unavailable.');
    const key=and(eq(receipts.workspaceId,workspace),eq(receipts.ticketId,input.id));
    const [row]=await tx.select().from(receipts).where(key);
    if(!row)throw new ApiError(409,'This ticket has no first-response target.');
    let channel:string,summary:string,at:number,replyId:string|null=null;
    if(input.action==='inbox_first_response'){
      if(!ticket.inboxReadable)throw new ApiError(403,'Inbox unavailable.');
      if(row.inboxReplyId===input.replyId)return;
      if(row.respondedAt)throw new ApiError(409,'A first response is already logged. Reload the ticket.');
      const [reply]=await tx.select({id:inboxMessages.id,mailbox:inboxMessages.mailbox,createdAt:inboxMessages.createdAt}).from(inboxMessages).where(and(eq(inboxMessages.workspaceId,workspace),
        eq(inboxMessages.id,input.replyId),eq(inboxMessages.direction,'outgoing'),eq(inboxMessages.state,'sent'))).for('update');
      if(!reply)throw new ApiError(409,'Choose a confirmed reply from this workspace.');
      const [used]=await tx.select({id:receipts.ticketId}).from(receipts).where(and(eq(receipts.workspaceId,workspace),eq(receipts.inboxReplyId,reply.id)));
      if(used)throw new ApiError(409,'This reply is already recorded on another ticket.');
      channel='Email';summary='Reply from '+reply.mailbox;at=Date.parse(reply.createdAt);replyId=reply.id;
    }else{
      if(row.respondedAt){
        if(!row.inboxReplyId&&row.actorId===actor.userId&&row.channel===input.channel&&row.summary===input.summary&&(!input.at||Date.parse(input.at)===Date.parse(row.respondedAt)))return;
        throw new ApiError(409,'A first response is already logged. Reload the ticket.');
      }
      channel=input.channel;summary=input.summary;at=input.at?Date.parse(input.at):Date.now();
    }
    if(ticket.revision!==input.expectedRevision)throw new ApiError(409,'The ticket changed. Reload it before logging the response.');
    const start=Date.parse(row.startedAt);
    if(at<start||at>Date.now())throw new ApiError(400,'Use a response time between ticket creation and now.');
    const [policy]=await tx.select({calendar:policies.calendar}).from(policies).where(and(eq(policies.workspaceId,workspace),eq(policies.revision,row.policyRevision)));
    await tx.update(receipts).set({respondedAt:new Date(at).toISOString(),channel,summary,inboxReplyId:replyId,
      actorId:actor.userId,workingMs:responseWorkingMs(policy.calendar,start,at)}).where(key);
  });
}
