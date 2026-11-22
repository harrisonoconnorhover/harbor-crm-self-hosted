import {sharedInboxReadable,sharedToolAllowed} from './shared-tool-permission';
import {recordAccess,type RecordAccessActor} from './record-access-store';
import {ownedRecordScope} from './record-ownership-scope';
import {matchesSearchWords,matchesTextFields} from './search-index';
import {activeWorkspaceAssignee} from './workspace-assignee-store';
import {and,asc,desc,eq,inArray,isNotNull,isNull,ne,sql,type SQL} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {supportTags,type InboxRead,type InboxWrite} from '../../lib/team-inbox';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {recordCatalogScope,sharedWorkspaceGrant} from './workspace-viewer-store';
import {portableTicketWrite} from '../../lib/portable-tickets';
import {firstResponseConditions,recordLinkedInboxResponse} from './ticket-first-response-store';
import {savePortableTicket} from './ticket-store';
import {inboxTicketLinks,portableTickets,responseReceipts,activeTicket,ticketOwnership} from './ticket-schema';
import {inboxConversations as threads,inboxMessages as messages,inboxSnippets as snippets,unansweredInboxMessage} from './team-inbox-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Inbound={workspaceId:string;mailbox:string;sender:string;subject:string;body:string;providerId:string;internetId?:string|null;references:string[]};
type Change=Exclude<InboxWrite,{action:'reply'|'save_snippet'|'delete_snippet'}>;
const missing=()=>new ApiError(404,'Conversation unavailable.');
const conflict=(message:string)=>new ApiError(409,message);
const threadKey=(workspaceId:string,id:string)=>and(eq(threads.workspaceId,workspaceId),eq(threads.id,id));
const messageKey=(workspaceId:string,id:string)=>and(eq(messages.workspaceId,workspaceId),eq(messages.id,id));

const replyReceiptFields={id:messages.id,conversationId:messages.conversationId,mailbox:messages.mailbox,
  actorId:messages.actorId,createdAt:messages.createdAt};

function page<T extends {id:string}>(rows:T[]){
  const items=rows.slice(0,25);
  return {items,next:rows.length>25?items[24].id:null};
}

export async function receiveInboxMessage(db:Db,input:Inbound){
  const {workspaceId,providerId,subject,body}=input;
  const mailbox=input.mailbox.trim().toLowerCase(),sender=input.sender.trim().toLowerCase();
  return db.transaction(async tx=>{
    // Keep duplicate recognition, thread selection, and insertion atomic for concurrent deliveries.
    const [space]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,workspaceId)).for('no key update');
    if(!space)throw new ApiError(404,'Inbox destination unavailable.');
    const mailboxMessages=and(eq(messages.workspaceId,workspaceId),eq(messages.mailbox,mailbox));
    const [duplicate]=await tx.select({id:messages.conversationId}).from(messages)
      .where(and(mailboxMessages,eq(messages.direction,'incoming'),eq(messages.providerId,providerId)));
    if(duplicate)return {id:duplicate.id,duplicate:true};
    // Subject alone does not identify a thread. An email header is untrusted, so a reference must also
    // match the original sender and receiving mailbox. Ambiguous references start a separate thread.
    const references=[...new Set(input.references)];
    const matches=references.length?await tx.selectDistinct({id:messages.conversationId}).from(messages)
      .innerJoin(threads,and(eq(threads.workspaceId,messages.workspaceId),eq(threads.id,messages.conversationId)))
      .where(and(mailboxMessages,eq(threads.sender,sender),inArray(messages.internetId,references))).limit(2):[];
    const id=matches.length===1?matches[0].id:crypto.randomUUID();
    if(matches.length===1){
      await tx.update(threads).set({status:'open',revision:sql`${threads.revision}+1`,updatedAt:sql`clock_timestamp()`})
        .where(threadKey(workspaceId,id));
    }else await tx.insert(threads).values({workspaceId,id,mailbox,sender,subject});
    await tx.insert(messages).values({id:crypto.randomUUID(),workspaceId,conversationId:id,direction:'incoming',mailbox,
      createdAt:sql`clock_timestamp()`,state:'received',body,providerId,internetId:input.internetId??null});
    return {id,duplicate:false};
  });
}

const threadColumns={id:threads.id,mailbox:threads.mailbox,sender:threads.sender,subject:threads.subject,status:threads.status,
  claimedBy:threads.claimedBy,claimedByLabel:sql<string|null>`coalesce(nullif(${loginIdentities.fullName},''),${loginIdentities.email})`,
  tags:threads.tags,revision:threads.revision,
  updatedAt:sql<string>`to_char(${threads.updatedAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`};

const replyAuthor=sql<string|null>`coalesce(nullif(${loginIdentities.fullName},''),${loginIdentities.email})`;
const messageColumns={author:replyAuthor,id:messages.id,direction:messages.direction,body:messages.body,state:messages.state,createdAt:messages.createdAt};
const unsettled=sql`${messages.state} IN ('sending','uncertain')`;
const needsReview=sql`(${messages.state}='uncertain' OR (${messages.state}='sending' AND ${messages.createdAt} < now()-interval '10 minutes'))`;
const pendingInThread=(workspaceId:string,id:string)=>and(eq(messages.workspaceId,workspaceId),eq(messages.conversationId,id),unsettled);

const responseDeadline={
  responseDueAt:sql<string>`to_char(${responseReceipts.dueAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  overdue:sql<boolean>`${responseReceipts.dueAt}<now()`,
};
function conversationTicket(tx:Tx,workspaceId:string,conversationId:string,scope?:SQL){
  return tx.select({id:portableTickets.id,revision:portableTickets.revision,status:sql<string>`coalesce(${portableTickets.data}->>'ticketStatus','New')`,
    assigneeId:portableTickets.assigneeId,assigneeLabel:portableTickets.assigneeLabel,
    tags:sql<string[]>`CASE WHEN ${activeTicket} THEN coalesce(${portableTickets.data}->'tags','[]'::jsonb) ELSE '[]'::jsonb END`,
    archivedAt:portableTickets.archivedAt,firstResponse:{ticketId:responseReceipts.ticketId,...responseDeadline}}).from(inboxTicketLinks)
    .innerJoin(portableTickets,and(eq(portableTickets.workspaceId,inboxTicketLinks.workspaceId),eq(portableTickets.id,inboxTicketLinks.ticketId)))
    .leftJoin(responseReceipts,and(eq(responseReceipts.workspaceId,inboxTicketLinks.workspaceId),eq(responseReceipts.ticketId,inboxTicketLinks.ticketId),isNull(responseReceipts.respondedAt),activeTicket))
    .where(and(eq(inboxTicketLinks.workspaceId,workspaceId),eq(inboxTicketLinks.conversationId,conversationId),scope));
}

export async function readTeamInbox(db:Db,actor:RecordAccessActor,q:InboxRead,includeBody:boolean){
  const actorId=actor.userId;
  return db.transaction(async tx=>{
    const [space]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(and(recordCatalogScope(tx,actorId,q.workspaceId),q.workspaceId?sharedInboxReadable(tx,actorId,q.workspaceId):undefined));
    if(!space){
      if(q.workspaceId||q.id)throw missing();
      return {items:[],next:null};
    }
    const workspaceId=space.id;
    const visibleTicket=q.workspaceId?ownedRecordScope(tx,actorId,workspaceId,ticketOwnership):undefined;
    if(!q.id){
      const status=q.status??'open';
      const [afterId,afterTime]=q.after?.split('~')??[];
      const claimant=q.claim==='mine'?actorId:q.claim;
      const textMatch=q.messageText?matchesSearchWords(messages.body,q.messageText):undefined;
      // Keep one row per conversation, even if several messages contain the same words.
      const matchingThreads=textMatch?tx.select({id:messages.conversationId}).from(messages)
        .where(and(eq(messages.workspaceId,workspaceId),textMatch)):undefined;
      const matchingMessageId=textMatch?sql<string>`(SELECT ${messages.id} FROM ${messages}
        WHERE ${messages.workspaceId}=${threads.workspaceId} AND ${messages.conversationId}=${threads.id} AND ${textMatch}
        ORDER BY ${messages.createdAt} DESC, ${messages.id} DESC LIMIT 1)`:sql<null>`NULL`;
      const filters=and(eq(threads.workspaceId,workspaceId),matchingThreads?inArray(threads.id,matchingThreads):undefined,matchesTextFields([threads.subject,threads.sender],q.q),
        q.mailbox?eq(threads.mailbox,q.mailbox):undefined,
        q.claim==='unclaimed'?isNull(threads.claimedBy):claimant?eq(threads.claimedBy,claimant):undefined,
        q.tag?sql`public.harbor_inbox_tag_keys(${threads.tags}) @> ARRAY[lower(${q.tag}::text)]`:undefined);
      const ticketTagMatch=q.ticketTag?sql`(${portableTickets.data}->'tags') @> ${JSON.stringify([q.ticketTag])}::jsonb`:undefined;
      if(status==='response_due'){
        const due=responseReceipts.dueAt,ticket=responseReceipts.ticketId;
        const deadlines=firstResponseConditions(sql`now()`);
        const rows=await tx.select({...threadColumns,matchingMessageId,firstResponse:{ticketId:ticket,...responseDeadline}}).from(responseReceipts)
          .innerJoin(portableTickets,and(eq(portableTickets.workspaceId,responseReceipts.workspaceId),eq(portableTickets.id,ticket),activeTicket))
          .innerJoin(inboxTicketLinks,and(eq(inboxTicketLinks.workspaceId,responseReceipts.workspaceId),eq(inboxTicketLinks.ticketId,ticket)))
          .innerJoin(threads,and(eq(threads.workspaceId,inboxTicketLinks.workspaceId),eq(threads.id,inboxTicketLinks.conversationId)))
          .leftJoin(loginIdentities,eq(loginIdentities.id,threads.claimedBy))
          .where(and(filters,ticketTagMatch,visibleTicket,deadlines[q.responseWindow??'unanswered'],
            afterTime?sql`(${due},${ticket})>(${afterTime}::timestamptz,${afterId}::uuid)`:undefined))
          .orderBy(asc(due),asc(ticket)).limit(26);
        const items=rows.slice(0,25),last=items.at(-1);
        if(includeBody)await recordAccess(tx,actor,'tickets','related',items.map(item=>item.firstResponse.ticketId),workspaceId);
        return {items,next:rows.length>25&&last?last.firstResponse.ticketId+'~'+last.firstResponse.responseDueAt:null};
      }
      const boundary=afterTime?sql`(${afterTime}::timestamptz,${afterId}::uuid)`:
        sql`(SELECT updated_at,id FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND id=${afterId})`;
      const older=afterId?sql`(${threads.updatedAt},${threads.id}) < ${boundary}`:undefined;
      // The first customer message since the last confirmed outbound reply starts the wait.
      // Equal timestamps remain unanswered, as they do in the queue membership predicate.
      const waitingSince=sql`(SELECT m.created_at FROM ${messages} m
        WHERE m.workspace_id=${threads.workspaceId} AND m.conversation_id=${threads.id} AND m.state='received'
          AND m.created_at >= coalesce(${threads.lastRepliedAt}, '-infinity'::timestamptz)
        ORDER BY m.created_at LIMIT 1)`;
      const waitCutoff=q.waiting?sql`${waitingSince} <= now() - ${q.waiting==='24h'?24:72} * interval '1 hour'`:undefined;
      const queueRows=tx.select({thread:threadColumns,matchingMessageId,
        waitingSince:status==='needs_reply'?sql<string>`to_char(${waitingSince} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:sql<null>`NULL`,
        matchedTicket:q.ticketTag?inboxTicketLinks.ticketId:sql<null>`NULL`}).from(threads).leftJoin(loginIdentities,eq(loginIdentities.id,threads.claimedBy));
      const selection=status==='review'?queueRows.innerJoin(messages,and(eq(messages.workspaceId,threads.workspaceId),
        eq(messages.conversationId,threads.id),unsettled,needsReview)):queueRows;
      const tagged=q.ticketTag?selection
        .innerJoin(inboxTicketLinks,and(eq(inboxTicketLinks.workspaceId,threads.workspaceId),eq(inboxTicketLinks.conversationId,threads.id)))
        .innerJoin(portableTickets,and(eq(portableTickets.workspaceId,inboxTicketLinks.workspaceId),
          eq(portableTickets.id,inboxTicketLinks.ticketId),activeTicket,ticketTagMatch,visibleTicket)):selection;
      const needsReply=status==='needs_reply'?unansweredInboxMessage(threads.lastReceivedAt,threads.lastRepliedAt):undefined;
      const rows=await tagged.where(and(filters,status==='review'?undefined:eq(threads.status,status==='needs_reply'?'open':status),needsReply,waitCutoff,older))
        .orderBy(sql`${threads.updatedAt} DESC NULLS LAST`,sql`${threads.id} DESC NULLS LAST`).limit(26);
      const last=rows[24];
      const items=rows.slice(0,25);
      if(includeBody&&q.ticketTag)await recordAccess(tx,actor,'tickets','related',items.flatMap(item=>item.matchedTicket?[item.matchedTicket]:[]),workspaceId);
      return {items:items.map(({thread,matchingMessageId,waitingSince})=>({...thread,matchingMessageId,waitingSince,firstResponse:null})),
        next:rows.length>25?last.thread.id+'~'+last.thread.updatedAt:null};
    }
    const [detail]=await tx.select({conversation:threadColumns,recentDraftAt:sql<string|null>`CASE
      WHEN ${threads.status}='open' AND ${threads.claimedBy} IS NOT NULL AND ${threads.draftActivityRevision}=${threads.revision}
        AND ${threads.draftActivityAt}>statement_timestamp()-interval '30 seconds'
      THEN to_char(${threads.draftActivityAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`})
      .from(threads).leftJoin(loginIdentities,eq(loginIdentities.id,threads.claimedBy)).where(threadKey(workspaceId,q.id));
    if(!detail)throw missing();
    const older=q.after?sql`(${messages.createdAt},${messages.id}) < (SELECT created_at,id FROM portable_inbox_messages
      WHERE workspace_id=${workspaceId} AND conversation_id=${q.id} AND id=${q.after})`:undefined;
    const [pending]=await tx.select(messageColumns).from(messages).leftJoin(loginIdentities,eq(loginIdentities.id,messages.actorId)).where(pendingInThread(workspaceId,q.id)).limit(1);
    const responseTicketId=sql<string|null>`(SELECT ${responseReceipts.ticketId} FROM ${responseReceipts}
      JOIN ${portableTickets} ON ${portableTickets.workspaceId}=${responseReceipts.workspaceId} AND ${portableTickets.id}=${responseReceipts.ticketId}
      WHERE ${responseReceipts.workspaceId}=${messages.workspaceId} AND ${responseReceipts.inboxReplyId}=${messages.id} AND ${activeTicket} AND ${visibleTicket??sql`true`})`;
    const recipient=alias(loginIdentities,'handoff_recipient');
    const rows=await tx.select({...messageColumns,responseTicketId,handoffToLabel:sql<string|null>`coalesce(nullif(${recipient.fullName},''),${recipient.email})`})
      .from(messages).leftJoin(loginIdentities,eq(loginIdentities.id,messages.actorId)).leftJoin(recipient,eq(recipient.id,messages.handoffToId))
      .where(and(eq(messages.workspaceId,workspaceId),eq(messages.conversationId,q.id),older,
        q.history?eq(messages.direction,'internal'):undefined,
        q.history==='notes'?eq(messages.state,'note'):q.history==='handoffs'?eq(messages.state,'handoff'):undefined,
        q.messageId?eq(messages.id,q.messageId):undefined))
      .orderBy(sql`${messages.createdAt} DESC NULLS LAST`,sql`${messages.id} DESC NULLS LAST`).limit(26);
    if(q.messageId&&!rows.length)throw missing();
    const {items,next}=page(rows);
    const [ticket]=await conversationTicket(tx,workspaceId,q.id,visibleTicket);
    if(includeBody){
      const ids=new Set(items.flatMap(message=>message.responseTicketId?[message.responseTicketId]:[]));
      if(ticket)ids.add(ticket.id);
      await recordAccess(tx,actor,'tickets','related',[...ids],workspaceId);
    }
    return {...detail,ticket:ticket??null,messages:items,pendingReply:pending??null,next};
  },{isolationLevel:'repeatable read',accessMode:includeBody&&(q.id||q.ticketTag||q.status==='response_due')?'read write':'read only'});
}

async function lockedConversation(tx:Tx,actor:PostgresSessionActor,id:string,shared?:SharedRecordWriteScope,assignment?:Extract<InboxWrite,{action:'assign'|'assign_ticket'}>){
  if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
  const workspaceId=await lockRecordWorkspace(tx,actor.userId,false,shared,undefined,true,true);
  if(!workspaceId||shared&&((await sharedWorkspaceGrant(tx,actor.userId,shared.workspaceId,true))?.editScope!=='all'||!await sharedToolAllowed(tx,actor.userId,shared.workspaceId,'team-inbox','edit')))throw new ApiError(403,'Inbox edit access unavailable.');
  // Deprovisioning locks the membership before releasing its inbox claims. Match that order on handoff.
  const assignee=assignment?await activeWorkspaceAssignee(tx,workspaceId,assignment.assigneeId,{
    conversation:assignment.action==='assign',tool:assignment.action==='assign_ticket'||assignment.linkedTicket?'tickets':undefined,
  }):undefined;
  const [conversation]=await tx.select().from(threads).where(threadKey(workspaceId,id)).for('update');
  if(!conversation)throw missing();
  return {...conversation,assignee};
}

function checkRevision(current:number,expected:number){
  if(current!==expected)throw conflict('This conversation changed. Refresh before continuing.');
}
function requireClaim(claimedBy:string|null,actor:string){
  if(claimedBy!==actor)throw conflict('Claim the conversation before changing it.');
}
async function changeThread(tx:Tx,workspace:string,id:string,changes:Partial<Pick<typeof threads.$inferInsert,'tags'|'status'|'claimedBy'>>={}){
  const [result]=await tx.update(threads).set({...changes,updatedAt:sql`clock_timestamp()`,revision:sql`${threads.revision}+1`})
    .where(threadKey(workspace,id)).returning({id:threads.id,revision:threads.revision});
  return result;
}

async function assignLinkedTicket(tx:Tx,actorId:string,workspaceId:string,conversationId:string,expected:{id:string;revision:number},assigneeId:string,shared?:SharedRecordWriteScope){
  const [ticket]=await conversationTicket(tx,workspaceId,conversationId,shared?ownedRecordScope(tx,actorId,workspaceId,ticketOwnership,'edit'):undefined);
  if(!ticket||ticket.archivedAt||ticket.id!==expected.id||ticket.revision!==expected.revision)
    throw conflict('The linked ticket changed. Review its assignment and try again.');
  if(ticket.assigneeId===assigneeId)return;
  const saved=await savePortableTicket(tx,actorId,{action:'assign_from_inbox',id:ticket.id,
    expectedRevision:ticket.revision,assigneeId},shared);
  if('error' in saved)throw conflict(saved.error==='assignee_missing'?'Choose a current ticket assignee.':'Could not assign the linked ticket. Review its assignment and try again.');
}

async function changeLinkedTicketStatus(tx:Tx,actorId:string,workspaceId:string,conversationId:string,
  reviewed:{id:string;revision:number},status:'Closed'|'Waiting on us',shared?:SharedRecordWriteScope){
  const [ticket]=await conversationTicket(tx,workspaceId,conversationId,shared?ownedRecordScope(tx,actorId,workspaceId,ticketOwnership,'edit'):undefined);
  if(!ticket||ticket.archivedAt||ticket.id!==reviewed.id||ticket.revision!==reviewed.revision)
    throw conflict('The linked ticket changed. Review its current status before continuing.');
  if(status==='Waiting on us'&&ticket.status!=='Closed')throw conflict('Only a closed ticket can be reopened.');
  if(ticket.status===status)throw conflict('The ticket is already closed. Resolve the conversation separately.');
  const saved=await savePortableTicket(tx,actorId,{action:'status',id:ticket.id,expectedRevision:ticket.revision,status},shared);
  if('error' in saved)throw conflict('Could not change the linked ticket. Refresh and review its current status.');
}

export function changeInboxConversation(db:Db,actor:PostgresSessionActor,input:Change,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const current=await lockedConversation(tx,actor,input.id,shared,input.action==='assign'||input.action==='assign_ticket'?input:undefined);
    const {id,workspaceId}=current;
    if(input.action==='draft_activity'){
      requireClaim(current.claimedBy,actor.userId);
      checkRevision(current.revision,input.revision);
      if(current.status!=='open')throw conflict('Reopen the conversation before drafting a reply.');
      // Presence must not invalidate a draft, reorder the queue or add a history entry.
      await tx.update(threads).set({draftActivityAt:sql`statement_timestamp()`,draftActivityRevision:current.revision})
        .where(and(threadKey(workspaceId,id),sql`(${threads.draftActivityRevision} IS DISTINCT FROM ${current.revision}
          OR ${threads.draftActivityAt} IS NULL OR ${threads.draftActivityAt}<=statement_timestamp()-interval '8 seconds')`));
      return {id,revision:current.revision};
    }
    const editableTicket=shared?ownedRecordScope(tx,actor.userId,workspaceId,ticketOwnership,'edit'):undefined;
    if(input.action==='note'){
      // A retry can arrive after a handoff or resolution. Only acknowledge the original author's exact note.
      const [saved]=await tx.select({conversationId:messages.conversationId,actorId:messages.actorId,state:messages.state,body:messages.body})
        .from(messages).where(messageKey(workspaceId,input.noteId));
      if(saved){
        if(saved.conversationId!==id||saved.actorId!==actor.userId||saved.state!=='note'||saved.body!==input.body)
          throw conflict('That note ID is already in use.');
        return {id,revision:current.revision};
      }
      checkRevision(current.revision,input.revision);
      if(current.status!=='open')throw conflict('Reopen this conversation before adding a team note.');
      await tx.insert(messages).values({workspaceId,id:input.noteId,conversationId:id,mailbox:current.mailbox,
        direction:'internal',state:'note',actorId:actor.userId,body:input.body,createdAt:sql`clock_timestamp()`});
      return changeThread(tx,workspaceId,id);
    }
    if(input.action==='create_ticket'||input.action==='link_ticket'){
      requireClaim(current.claimedBy,actor.userId);
      const [existing]=await conversationTicket(tx,workspaceId,id,editableTicket);
      if(existing){
        if(input.action==='link_ticket'&&input.ticketId!==existing.id)throw conflict('This conversation already has a linked ticket.');
        return {id,revision:current.revision,ticketId:existing.id};
      }
      if(shared){
        const [linked]=await tx.select({id:inboxTicketLinks.conversationId}).from(inboxTicketLinks)
          .where(and(eq(inboxTicketLinks.workspaceId,workspaceId),eq(inboxTicketLinks.conversationId,id)));
        if(linked)throw conflict('A linked ticket is unavailable for editing.');
      }
      checkRevision(current.revision,input.revision);
      if(current.status!=='open')throw conflict('Reopen this conversation to add a ticket.');
      if(input.action==='link_ticket'){
        const [ticket]=await tx.select({revision:portableTickets.revision}).from(portableTickets)
          .where(and(eq(portableTickets.workspaceId,workspaceId),eq(portableTickets.id,input.ticketId),activeTicket,editableTicket)).for('share');
        if(!ticket)throw new ApiError(404,'Ticket unavailable.');
        if(ticket.revision!==input.ticketRevision)throw conflict('The ticket changed. Choose it again to link the current version.');
        const linked=await tx.insert(inboxTicketLinks).values({workspaceId,conversationId:id,ticketId:input.ticketId})
          .onConflictDoNothing().returning({ticketId:inboxTicketLinks.ticketId});
        if(!linked.length)throw conflict('That ticket is already linked to another conversation.');
        return {...await changeThread(tx,workspaceId,id),ticketId:input.ticketId};
      }
      const tags=supportTags.safeParse(current.tags.map(tag=>tag.toLowerCase()));
      if(!tags.success)throw conflict('Edit the conversation tags before creating a ticket. Use up to ten distinct tags of 40 characters each.');
      const name=current.subject.trim().replace(/\s+/gu,' ').slice(0,160).replace(/[\uD800-\uDBFF]$/u,'')||'Inbox inquiry';
      const ticket=portableTicketWrite.parse({action:'save',data:{name,ticketSource:'Email',ticketPriority:input.priority,tags:tags.data}});
      const result=await savePortableTicket(tx,actor.userId,ticket,shared);
      if('error' in result)throw conflict('Could not create the ticket. Refresh the conversation and try again.');
      await tx.insert(inboxTicketLinks).values({workspaceId,conversationId:id,ticketId:result.record.id});
      return {...await changeThread(tx,workspaceId,id),ticketId:result.record.id};
    }
    checkRevision(current.revision,input.revision);
    if(input.action==='claim'){
      if(current.claimedBy===actor.userId)return {id,revision:current.revision};
      if(current.claimedBy)throw conflict('Another teammate has claimed this conversation.');
      return changeThread(tx,workspaceId,id,{claimedBy:actor.userId});
    }
    if(input.action==='assign_ticket'){
      if(shared)requireClaim(current.claimedBy,actor.userId);
      if(current.status!=='open')throw conflict('Reopen this conversation before assigning its ticket.');
      if(!current.assignee)throw conflict('Choose a current ticket assignee.');
      await assignLinkedTicket(tx,actor.userId,workspaceId,id,{id:input.ticketId,revision:input.ticketRevision},current.assignee.id,shared);
      return {id,revision:current.revision,ticketId:input.ticketId};
    }
    if(input.action==='assign'){
      if(shared)requireClaim(current.claimedBy,actor.userId);
      if(current.status!=='open')throw conflict('Reopen this conversation before assigning it.');
      const recipient=current.assignee;
      if(!recipient)throw conflict(input.linkedTicket?'Choose a teammate who can edit the inbox and the linked ticket.':'Choose a current teammate with workspace-wide inbox edit access.');
      if(current.claimedBy===recipient.id){
        if(input.note||input.linkedTicket)throw conflict('Choose a different teammate to hand off this conversation.');
        return {id,revision:current.revision};
      }
      if(input.linkedTicket)await assignLinkedTicket(tx,actor.userId,workspaceId,id,input.linkedTicket,recipient.id,shared);
      await tx.insert(messages).values({workspaceId,id:crypto.randomUUID(),conversationId:id,mailbox:current.mailbox,
        direction:'internal',state:'handoff',actorId:actor.userId,handoffToId:recipient.id,body:input.note??'',createdAt:sql`clock_timestamp()`});
      return changeThread(tx,workspaceId,id,{claimedBy:recipient.id});
    }
    if(input.action==='release'){
      if(shared)requireClaim(current.claimedBy,actor.userId);
      return changeThread(tx,workspaceId,id,{claimedBy:null});
    }
    if(input.action==='confirm_sent'||input.action==='confirm_failed'){
      if(shared)throw new ApiError(403,'The workspace owner verifies unresolved replies.');
      if(!input.replyId)throw new ApiError(400,'Choose a reply to reconcile.');
      const [settled]=await tx.update(messages).set({state:input.action==='confirm_sent'?'sent':'failed'})
        .where(and(messageKey(workspaceId,input.replyId),eq(messages.conversationId,id),
          needsReview))
        .returning(replyReceiptFields);
      if(!settled)throw conflict('This reply is settled or still being submitted.');
      if(input.action==='confirm_sent')await recordLinkedInboxResponse(tx,workspaceId,settled);
      return changeThread(tx,workspaceId,id);
    }
    requireClaim(current.claimedBy,actor.userId);
    if(input.action==='tag')return changeThread(tx,workspaceId,id,{tags:[...new Set(input.tags??[])]});
    if(input.action==='tag_ticket'){
      if(current.status!=='open')throw conflict('Reopen the conversation before editing ticket tags.');
      const [ticket]=await conversationTicket(tx,workspaceId,id,editableTicket);
      if(!ticket||ticket.archivedAt||ticket.id!==input.linkedTicket.id||ticket.revision!==input.linkedTicket.revision)
        throw conflict('The linked ticket changed. Review its latest tags before saving.');
      if(input.tags.length!==ticket.tags.length||input.tags.some(tag=>!ticket.tags.includes(tag))){
        const result=await savePortableTicket(tx,actor.userId,{action:'tag_from_inbox',id:ticket.id,expectedRevision:ticket.revision,tags:input.tags},shared);
        if('error' in result)throw conflict('Could not update ticket tags. Review the linked ticket and try again.');
      }
      return {id,revision:current.revision,ticketId:ticket.id};
    }
    if(input.action==='reopen_ticket'){
      if(current.status!=='open')throw conflict('Reopen the conversation before reopening its ticket.');
      await changeLinkedTicketStatus(tx,actor.userId,workspaceId,id,input.linkedTicket,'Waiting on us',shared);
      return {id,revision:current.revision,ticketId:input.linkedTicket.id};
    }
    if(input.action==='resolve'){
      if(input.linkedTicket&&current.status!=='open')throw conflict('This conversation is already resolved.');
      const [pending]=await tx.select({id:messages.id}).from(messages).where(pendingInThread(workspaceId,id)).limit(1);
      if(pending)throw conflict('Confirm the pending reply’s delivery before resolving this conversation.');
      if(input.linkedTicket)await changeLinkedTicketStatus(tx,actor.userId,workspaceId,id,input.linkedTicket,'Closed',shared);
      return changeThread(tx,workspaceId,id,{status:'resolved',claimedBy:null});
    }
    return changeThread(tx,workspaceId,id,{status:'open'});
  });
}

export function reserveInboxReply(db:Db,actor:PostgresSessionActor,input:{id:string;revision:number;replyId:string;body:string},
  shared?:SharedRecordWriteScope,checkDelivery?:(workspaceId:string,mailbox:string)=>void){
  return db.transaction(async tx=>{
    const thread=await lockedConversation(tx,actor,input.id,shared);
    const {workspaceId,mailbox,sender,subject}=thread;
    const replyId=input.replyId;
    const [prior]=await tx.select().from(messages).where(messageKey(workspaceId,replyId));
    const destination={workspaceId,mailbox,sender,subject,replyId};
    if(prior){
      if(prior.conversationId!==thread.id||prior.direction!=='outgoing'||prior.actorId!==actor.userId||prior.body!==input.body)
        throw conflict('This reply ID has already been used.');
      return {...destination,dispatch:false,internetId:prior.internetId!,inReplyTo:prior.inReplyTo,state:prior.state};
    }
    checkRevision(thread.revision,input.revision);
    requireClaim(thread.claimedBy,actor.userId);
    if(thread.status!=='open')throw conflict('Reopen the conversation to reply.');
    const conversation=and(eq(messages.workspaceId,workspaceId),eq(messages.conversationId,thread.id));
    const [pending]=await tx.select({id:messages.id}).from(messages)
      .where(pendingInThread(workspaceId,thread.id)).limit(1);
    if(pending)throw conflict('An earlier reply needs delivery confirmation.');
    checkDelivery?.(workspaceId,mailbox);
    const [source]=await tx.select({id:messages.internetId}).from(messages)
      .where(and(conversation,eq(messages.direction,'incoming'),isNotNull(messages.internetId)))
      .orderBy(desc(messages.createdAt),desc(messages.id)).limit(1);
    const inReplyTo=source?.id??null,internetId='<'+replyId+'@'+mailbox.slice(mailbox.lastIndexOf('@')+1)+'>';
    await tx.insert(messages).values({workspaceId,conversationId:thread.id,mailbox,id:replyId,
      createdAt:sql`clock_timestamp()`,direction:'outgoing',state:'sending',actorId:actor.userId,body:input.body,inReplyTo,internetId});
    await changeThread(tx,workspaceId,thread.id);
    return {...destination,dispatch:true,internetId,inReplyTo,state:'sending' as const};
  });
}

export async function finishInboxReply(db:Db,input:{workspaceId:string;replyId:string;state:'sent'|'failed'|'uncertain';providerId?:string}){
  await db.transaction(async tx=>{
    // Same lock order as reservation/agent edits. A late provider result cannot overwrite a settled receipt.
    await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.id,input.workspaceId)).for('no key update');
    const [updated]=await tx.update(messages).set({state:input.state,providerId:input.providerId??null})
      .where(and(messageKey(input.workspaceId,input.replyId),eq(messages.state,'sending')))
      .returning(replyReceiptFields);
    if(!updated)return;
    if(input.state==='sent')await recordLinkedInboxResponse(tx,input.workspaceId,updated);
    await changeThread(tx,input.workspaceId,updated.conversationId);
  });
}

type SnippetWrite={action:'save_snippet'|'delete_snippet';id:string;revision:number;name?:string;body?:string};
const snippetColumns={id:snippets.id,name:snippets.name,body:snippets.body,revision:snippets.revision};
async function snippetWorkspace(tx:Tx,actorId:string,workspaceId?:string){
  if(workspaceId&&((await sharedWorkspaceGrant(tx,actorId,workspaceId,true))?.viewScope!=='all'||!await sharedToolAllowed(tx,actorId,workspaceId,'snippets')))throw new ApiError(404,'Snippets unavailable.');
  const [space]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(recordCatalogScope(tx,actorId,workspaceId));
  if(!space&&workspaceId)throw new ApiError(404,'Inbox unavailable.');
  return space?.id;
}
export async function readInboxSnippets(db:Db,actorId:string,workspaceId?:string,id?:string){
  return db.transaction(async tx=>{
    const workspace=await snippetWorkspace(tx,actorId,workspaceId);
    if(!workspace)return {items:[]};
    const items=await tx.select(snippetColumns).from(snippets).where(and(eq(snippets.workspaceId,workspace),id?eq(snippets.id,id):undefined))
      .orderBy(asc(sql`lower(${snippets.name})`),asc(snippets.id)).limit(id?1:40);
    return {items};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export async function findInboxSnippetNames(db:Db,actorId:string,workspaceId?:string,q?:string){
  return db.transaction(async tx=>{
    const workspace=await snippetWorkspace(tx,actorId,workspaceId);
    if(!workspace)return {items:[]};
    const items=await tx.select({id:snippets.id,name:snippets.name}).from(snippets)
      .where(and(eq(snippets.workspaceId,workspace),matchesTextFields([snippets.name,snippets.body],q)))
      .orderBy(asc(sql`lower(${snippets.name})`),asc(snippets.id)).limit(40);
    return {items};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export async function writeInboxSnippet(db:Db,actor:PostgresSessionActor,input:SnippetWrite){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,input.action==='save_snippet',undefined,undefined,true);
    if(!workspace)throw new ApiError(404,'Quick reply unavailable.');
    const owned=eq(snippets.workspaceId,workspace);
    const key=and(owned,eq(snippets.id,input.id));
    const [existing]=await tx.select({revision:snippets.revision}).from(snippets).where(key);
    if(input.action==='delete_snippet'&&!existing)throw new ApiError(404,'Quick reply unavailable.');
    if((existing?.revision??0)!==input.revision)throw conflict('This quick reply changed. Refresh before editing.');
    const revision=input.revision+1;
    if(input.action==='delete_snippet'){
      await tx.delete(snippets).where(key);
    }else{
      const name=input.name?.trim(),body=input.body;
      if(!name||name.length>100||!body?.trim()||body.length>16000)throw new ApiError(400,'Enter a name and a plain-text reply.');
      const [duplicate]=await tx.select({id:snippets.id}).from(snippets)
        .where(and(owned,ne(snippets.id,input.id),sql`lower(${snippets.name})=lower(${name})`));
      if(duplicate)throw conflict('Another quick reply already uses that name.');
      if(existing)await tx.update(snippets).set({name,body,revision}).where(key);
      else{
        const used=new Set((await tx.select({slot:snippets.slot}).from(snippets).where(owned)).map(row=>row.slot));
        let slot=1;
        while(used.has(slot))slot++;
        if(slot>40)throw conflict('The workspace already has 40 quick replies.');
        await tx.insert(snippets).values({id:input.id,workspaceId:workspace,name,body,revision,slot});
      }
    }
    return {id:input.id,revision};
  });
}
