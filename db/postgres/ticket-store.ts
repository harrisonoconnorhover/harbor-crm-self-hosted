import {sharedInboxReadable} from './shared-tool-permission';
import {recordUpdatedKey} from './record-updated-key';
import {firstResponseConditions,responseFields,responseResult,ticketResponseReceipt} from './ticket-first-response-store';
import {ownedRecordScope,sharedCoreRecordScope} from './record-ownership-scope';
import {activeWorkspaceAssignee,canTakeTicket,resolveCoreRecordOwner} from './workspace-assignee-store';
import {inboxTicketLinks,responseReceipts,ticketOwnership} from './ticket-schema';
import {and,asc,desc,eq,gt,gte,ilike,isNull,lt,lte,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableTicketFields,type PortableTicketPage,type PortableTicketQuery,type PortableTicketRecord,type PortableTicketWrite} from '../../lib/portable-tickets';
import {captureWorkflowEntry} from './workflow-store';
import {ticketLifecycle} from '../../lib/ticket-lifecycle';
import type {CloseSlaReceipt} from '../../lib/ticket-sla';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {recordSearchPattern,unavailableWorkspaceAssignee} from './record-search';
import {ticketCloseSlaFields,ticketCloseSlaResult,writePortableTicketSla} from './portable-ticket-sla-store';
import {activeTicket,portableTicketCloseSlaReceipts as receipts,portableTicketEvents,portableTickets as tickets} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';

const columns={id:tickets.id,revision:tickets.revision,data:tickets.data,contactId:tickets.contactId,
  companyId:tickets.companyId,assigneeId:tickets.assigneeId,assigneeLabel:tickets.assigneeLabel,closedAt:tickets.closedAt,createdAt:tickets.createdAt,updatedAt:tickets.updatedAt};
const contactName=sql<string|null>`${contacts.data}->>'name'`;
const companyName=sql<string|null>`${companies.data}->>'name'`;
const status=sql<string>`${tickets.data}->>'ticketStatus'`;
const priority=sql<string>`${tickets.data}->>'ticketPriority'`;
const ticketSource=sql<string|null>`${tickets.data}->>'ticketSource'`;
const ticketCategory=sql<string|null>`${tickets.data}->>'ticketCategory'`;
const isoTime=(time:string)=>new Date(time).toISOString();
const snapshot=(record:Pick<PortableTicketRecord,'data'|'contactId'|'companyId'|'closedAt'|'assigneeId'|'assigneeLabel'>)=>({
  assigneeId:record.assigneeId,assigneeLabel:record.assigneeLabel,data:record.data,contactId:record.contactId,companyId:record.companyId,closedAt:record.closedAt&&isoTime(record.closedAt),
});
const resultRecord=(record:PortableTicketRecord,asOf:string,receipt?:CloseSlaReceipt|null):PortableTicketRecord=>({
  ...record,closedAt:record.closedAt&&isoTime(record.closedAt),
  createdAt:isoTime(record.createdAt),updatedAt:isoTime(record.updatedAt),
  ...(receipt?{sla:ticketCloseSlaResult(receipt,asOf)}:{}),
});

export async function readPortableTickets(db:PostgresJsDatabase,actorId:string,query:PortableTicketQuery):Promise<PortableTicketRecord|PortableTicketPage|null>{
  const workspace=db.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(recordWorkspaceScope(db,actorId));
  const sharedId=query.workspaceId;
  const visibleWorkspace=sharedId?and(eq(tickets.workspaceId,sharedId),ownedRecordScope(db,actorId,sharedId,ticketOwnership,query.editableOnly?'edit':'view')):
    eq(tickets.workspaceId,workspace);
  const inboxVisible=sharedId?sharedInboxReadable(db,actorId,sharedId):sql<boolean>`true`;
  const asOf=new Date().toISOString();
  const byDue=query.sort==='response_due',due=responseReceipts.dueAt;
  // Keep Postgres precision in the page token even though displayed times use JavaScript dates.
  const response=byDue?{...responseFields,dueAt:sql<string>`to_char(${due} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`}:responseFields;
  const originalConversation=sql<string|null>`(SELECT ${inboxTicketLinks.conversationId} FROM ${inboxTicketLinks}
    WHERE ${inboxTicketLinks.workspaceId}=${tickets.workspaceId} AND ${inboxTicketLinks.ticketId}=${tickets.id})`;
  const editable=sharedId&&(query.id||query.assignee==='unavailable')?sql<boolean>`${ownedRecordScope(db,actorId,sharedId,ticketOwnership,'edit')}`:undefined;
  const source=db.select({...columns,inboxVisible,...(editable?{editable}:{}),
    ...(query.id?{inboxConversationId:originalConversation}:{}),
    contactId:sql<string|null>`${contacts.id}`,companyId:sql<string|null>`${companies.id}`,
    contactName,companyName,response,receipt:ticketCloseSlaFields}).from(tickets)
    .leftJoin(contacts,and(eq(contacts.workspaceId,tickets.workspaceId),eq(contacts.id,tickets.contactId),activeContact,sharedCoreRecordScope(db,actorId,sharedId,contacts)))
    .leftJoin(companies,and(eq(companies.workspaceId,tickets.workspaceId),eq(companies.id,tickets.companyId),activeCompany,sharedCoreRecordScope(db,actorId,sharedId,companies)))
    .leftJoin(responseReceipts,and(eq(responseReceipts.workspaceId,tickets.workspaceId),eq(responseReceipts.ticketId,tickets.id)))
    .leftJoin(receipts,and(eq(receipts.workspaceId,tickets.workspaceId),eq(receipts.ticketId,tickets.id)));
  const result=({receipt,response,inboxVisible,...record}:Awaited<typeof source>[number])=>resultRecord({
    ...record,...(!inboxVisible?{inboxConversationId:null}:{}),
    ...(response?{firstResponse:responseResult(!inboxVisible&&response.inboxReplyId
      ?{...response,summary:'Reply from team inbox',inboxConversationId:null,inboxReplyId:null}
      :response,asOf)}:{}),
  },asOf,receipt);
  if(query.id){
    const [record]=await source.where(and(activeTicket,visibleWorkspace,eq(tickets.id,query.id))).limit(1);
    return record?result(record):null;
  }
  const pattern=recordSearchPattern(query.search);
  const match=pattern?or(ilike(sql`${tickets.data}->>'name'`,pattern),ilike(sql`${tickets.data}->>'description'`,pattern)):undefined;
  const sla=query.sla&&and(isNull(receipts.completedAt),query.sla==='overdue'?lt(receipts.dueAt,asOf):
    and(gte(receipts.dueAt,asOf),lte(receipts.warningAt,asOf)));
  const responseFilters=firstResponseConditions(asOf);
  const responseMatch=query.response?responseFilters[query.response]:undefined;
  const assigneeMatch=query.assignee==='me'?eq(tickets.assigneeId,actorId):
    query.assignee==='unassigned'?isNull(tickets.assigneeId):
    query.assignee==='unavailable'?and(isNull(tickets.closedAt),unavailableWorkspaceAssignee(db,tickets.workspaceId,tickets.assigneeId,
      db.select({id:privateWorkspaces.ownerId}).from(privateWorkspaces).where(eq(privateWorkspaces.id,tickets.workspaceId)),canTakeTicket)):
    query.assignee?eq(tickets.assigneeId,query.assignee):undefined;
  const byUpdated=query.sort==='updated';
  // Millisecond keys match the ISO cursor exactly even for rows written with microsecond precision.
  const updatedKey=recordUpdatedKey(tickets.updatedAt);
  // With a response filter every result has a receipt. Its existing deadline/ID index can serve deep pages directly.
  const dueId=query.response?responseReceipts.ticketId:tickets.id;
  let cursor;
  if(query.after){
    if(byUpdated)cursor=sql`(${updatedKey},${tickets.id}) < ((${query.afterUpdatedAt}::timestamptz AT TIME ZONE 'UTC'),${query.after}::uuid)`;
    else if(byDue){
      if(query.afterDueAt==='none')cursor=and(isNull(due),gt(tickets.id,query.after));
      else{
        const later=sql`(${due},${dueId}) > (${query.afterDueAt}::text::timestamptz,${query.after}::uuid)`;
        cursor=query.response?later:or(later,isNull(due));
      }
    }else cursor=gt(tickets.id,query.after);
  }
  const order=byUpdated?[desc(updatedKey),desc(tickets.id)]:byDue?[asc(due),asc(dueId)]:[asc(tickets.id)];
  const rows=await source.where(and(activeTicket,visibleWorkspace,match,sla||undefined,responseMatch,assigneeMatch,cursor,
    query.status?eq(status,query.status):undefined,query.priority?eq(priority,query.priority):undefined,
    query.source?eq(ticketSource,query.source):undefined,query.category?eq(ticketCategory,query.category):undefined,
    query.tag?sql`(${tickets.data}->'tags') @> ${JSON.stringify([query.tag])}::jsonb`:undefined,
    query.contactId?eq(contacts.id,query.contactId):undefined,query.companyId?eq(companies.id,query.companyId):undefined
  )).orderBy(...order).limit(query.limit+1);
  const records=rows.slice(0,query.limit).map(result);
  const last=rows.length>query.limit?records.at(-1)!:undefined;
  return {records,next:last?.id??null,...(byUpdated?{nextUpdatedAt:last?.updatedAt??null}:{}),
    ...(byDue?{nextDueAt:last?(rows[query.limit-1].response?.dueAt??'none'):null}:{})};
}

type SaveResult={record:PortableTicketRecord}|{error:'missing'|'stale'|'contact_missing'|'company_missing'|'access'|'assignee_missing'|'unavailable_changed'|'not_waiting_unassigned'};

type InboxTicketTags={action:'tag_from_inbox';id:string;expectedRevision:number;tags:string[]};
type InboxTicketAssignment={action:'assign_from_inbox';id:string;expectedRevision:number;assigneeId:string};

export function savePortableTicket(db:PostgresJsDatabase,actorId:string,input:PortableTicketWrite|InboxTicketAssignment|InboxTicketTags,shared?:SharedRecordWriteScope,createId?:string):Promise<SaveResult>{
  return db.transaction(async tx=>{
    const creating=!('id' in input);
    const workspaceId=await lockRecordWorkspace(tx,actorId,!shared&&creating&&!input.contactId&&!input.companyId,shared,undefined,true,true,['tickets','id' in input?'edit':'create']);
    if(!workspaceId)return {error:shared?'access':creating?input.contactId?'contact_missing':'company_missing':'missing'};
    const target='id' in input?and(activeTicket,eq(tickets.workspaceId,workspaceId),eq(tickets.id,input.id),
      shared?ownedRecordScope(tx,actorId,workspaceId,ticketOwnership,'edit'):undefined):undefined;
    const current=target?(await tx.select(columns).from(tickets).where(target).for('update'))[0]:undefined;
    if('id' in input){
      if(!current)return {error:'missing'};
      if(input.action==='take_unavailable'&&(current.closedAt||current.assigneeId!==input.previousAssigneeId||
        await activeWorkspaceAssignee(tx,workspaceId,input.previousAssigneeId,{tool:'tickets'})))return {error:'unavailable_changed'};
      if(input.action==='take_first_response'){
        if(current.assigneeId||current.closedAt)return {error:'not_waiting_unassigned'};
        const [waiting]=await tx.select({id:responseReceipts.ticketId}).from(responseReceipts)
          .where(and(eq(responseReceipts.workspaceId,workspaceId),eq(responseReceipts.ticketId,current.id),isNull(responseReceipts.respondedAt)));
        if(!waiting)return {error:'not_waiting_unassigned'};
      }
      if(current.revision!==input.expectedRevision)return {error:'stale'};
    }

    const contact=await resolvePortableContactLink(tx,workspaceId,current?.contactId??null,input.action==='save'?input.contactId:undefined,shared?actorId:undefined);
    if(!contact)return {error:'contact_missing'};
    const contactId=contact.id;
    const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.action==='save'?input.companyId:undefined,shared?actorId:undefined);
    if(!company)return {error:'company_missing'};
    const companyId=company.id;

    const data=input.action==='save'?portableTicketFields.parse({...current?.data,...input.data}):
      input.action==='status'?{...current!.data,ticketStatus:input.status}:
      input.action==='tag_from_inbox'?{...current!.data,tags:input.tags}:current!.data;
    const now=new Date().toISOString();
    const before=current?{...current.data,closedAt:current.closedAt}:undefined;
    const closedAt=ticketLifecycle(data,before,now).closedAt??null;
    const prior=current?.assigneeId&&current.assigneeLabel?{workspaceId,userId:current.assigneeId,label:current.assigneeLabel}:undefined;
    const requestedAssignee=input.action==='take_first_response'||input.action==='take_unavailable'?actorId:input.action==='save'||input.action==='assign_from_inbox'?input.assigneeId:undefined;
    const assignee=await resolveCoreRecordOwner(tx,workspaceId,actorId,!!shared,'tickets',requestedAssignee,prior,creating);
    if(assignee===false)return {error:'assignee_missing'};
    const fields={data,contactId,companyId,assigneeId:assignee?.userId??null,assigneeLabel:assignee?.label??null,closedAt,updatedAt:now};
    const [saved]=current
      ?await tx.update(tickets).set({...fields,revision:current.revision+1}).where(target).returning(columns)
      :await tx.insert(tickets).values({...fields,workspaceId,id:createId??crypto.randomUUID(),revision:1,createdAt:now}).returning(columns);
    await tx.insert(portableTicketEvents).values({
      workspaceId,ticketId:saved.id,revision:saved.revision,actorId,
      previous:current?snapshot(current):null,data:snapshot(saved),occurredAt:now,
    });
    if(current?.data.ticketStatus!==saved.data.ticketStatus){
      await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'ticket_status',id:saved.id,revision:saved.revision,
        ticketStatus:saved.data.ticketStatus,properties:saved.data,primaryContactId:contact.visibleId,lifecycle:null});
    }
    const receipt=await writePortableTicketSla(tx,workspaceId,saved,creating,current?.closedAt!==saved.closedAt);
    const response=await ticketResponseReceipt(tx,workspaceId,saved,creating);
    if(shared){
      const visible=await readPortableTickets(tx,actorId,{id:saved.id,workspaceId,limit:1});
      if(!visible||!('data' in visible))throw Error('Saved ticket is outside the editor’s scope.');
      return {record:visible};
    }
    return {record:resultRecord({...saved,...response?{firstResponse:responseResult(response,now)}:{},contactId:contact.visibleId,contactName:contact.name,companyId:company.visibleId,companyName:company.name},now,receipt)};
  });
}
