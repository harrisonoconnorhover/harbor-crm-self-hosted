import {and,asc,desc,eq,gt,gte,ilike,isNull,lt,lte,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableTicketFields,type PortableTicketPage,type PortableTicketQuery,type PortableTicketRecord,type PortableTicketWrite} from '../../lib/portable-tickets';
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
import {recordSearchPattern} from './record-search';
import {ticketCloseSlaFields,ticketCloseSlaResult,writePortableTicketSla} from './portable-ticket-sla-store';
import {portableTicketCloseSlaReceipts as receipts,portableTicketEvents,portableTickets as tickets} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';

const columns={id:tickets.id,revision:tickets.revision,data:tickets.data,contactId:tickets.contactId,
  companyId:tickets.companyId,closedAt:tickets.closedAt,createdAt:tickets.createdAt,updatedAt:tickets.updatedAt};
const contactName=sql<string|null>`${contacts.data}->>'name'`;
const companyName=sql<string|null>`${companies.data}->>'name'`;
const status=sql<string>`${tickets.data}->>'ticketStatus'`;
const priority=sql<string>`${tickets.data}->>'ticketPriority'`;
const ticketSource=sql<string|null>`${tickets.data}->>'ticketSource'`;
const ticketCategory=sql<string|null>`${tickets.data}->>'ticketCategory'`;
const isoTime=(time:string)=>new Date(time).toISOString();
const snapshot=(record:Pick<PortableTicketRecord,'data'|'contactId'|'companyId'|'closedAt'>)=>({
  data:record.data,contactId:record.contactId,companyId:record.companyId,closedAt:record.closedAt&&isoTime(record.closedAt),
});
const resultRecord=(record:PortableTicketRecord,asOf:string,receipt?:CloseSlaReceipt|null):PortableTicketRecord=>({
  ...record,closedAt:record.closedAt&&isoTime(record.closedAt),
  createdAt:isoTime(record.createdAt),updatedAt:isoTime(record.updatedAt),
  ...(receipt?{sla:ticketCloseSlaResult(receipt,asOf)}:{}),
});

export async function readPortableTickets(db:PostgresJsDatabase,actorId:string,query:PortableTicketQuery):Promise<PortableTicketRecord|PortableTicketPage|null>{
  // Workspace members read shared Tickets under their grant.
  const owner=recordWorkspaceScope(db,actorId,query.workspaceId),asOf=new Date().toISOString();
  const source=db.select({...columns,contactId:sql<string|null>`${contacts.id}`,companyId:sql<string|null>`${companies.id}`,contactName,companyName,receipt:ticketCloseSlaFields}).from(tickets)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,tickets.workspaceId))
    .leftJoin(contacts,and(eq(contacts.workspaceId,tickets.workspaceId),eq(contacts.id,tickets.contactId),activeContact))
    .leftJoin(companies,and(eq(companies.workspaceId,tickets.workspaceId),eq(companies.id,tickets.companyId),activeCompany))
    .leftJoin(receipts,and(eq(receipts.workspaceId,tickets.workspaceId),eq(receipts.ticketId,tickets.id)));
  const result=({receipt,...record}:Awaited<typeof source>[number])=>resultRecord(record,asOf,receipt);
  if(query.id){
    const [record]=await source.where(and(owner,eq(tickets.id,query.id))).limit(1);
    return record?result(record):null;
  }
  const pattern=recordSearchPattern(query.search);
  const match=pattern?or(ilike(sql`${tickets.data}->>'name'`,pattern),ilike(sql`${tickets.data}->>'description'`,pattern)):undefined;
  const sla=query.sla&&and(isNull(receipts.completedAt),query.sla==='overdue'?lt(receipts.dueAt,asOf):
    and(gte(receipts.dueAt,asOf),lte(receipts.warningAt,asOf)));
  const byUpdated=query.sort==='updated';
  // Millisecond keys match the ISO cursor exactly even for rows written with microsecond precision.
  const updatedKey=sql`date_trunc('milliseconds',${tickets.updatedAt})`;
  const cursor=!query.after?undefined:byUpdated
    ?sql`(${updatedKey},${tickets.id}) < (${query.afterUpdatedAt}::timestamptz,${query.after}::uuid)`
    :gt(tickets.id,query.after);
  const rows=await source.where(and(owner,match,sla||undefined,cursor,
    query.status?eq(status,query.status):undefined,query.priority?eq(priority,query.priority):undefined,
    query.source?eq(ticketSource,query.source):undefined,query.category?eq(ticketCategory,query.category):undefined,
    query.contactId?eq(contacts.id,query.contactId):undefined,query.companyId?eq(companies.id,query.companyId):undefined
  )).orderBy(...byUpdated?[desc(updatedKey),desc(tickets.id)]:[asc(tickets.id)]).limit(query.limit+1);
  const records=rows.slice(0,query.limit).map(result);
  const last=rows.length>query.limit?records.at(-1)!:undefined;
  return {records,next:last?.id??null,...byUpdated?{nextUpdatedAt:last?.updatedAt??null}:{}};
}

type SaveResult={record:PortableTicketRecord}|{error:'missing'|'stale'|'contact_missing'|'company_missing'|'access'};

export function savePortableTicket(db:PostgresJsDatabase,actorId:string,input:PortableTicketWrite,shared?:SharedRecordWriteScope):Promise<SaveResult>{
  return db.transaction(async tx=>{
    const creating=!('id' in input);
    const workspaceId=await lockRecordWorkspace(tx,actorId,!shared&&creating&&!input.contactId&&!input.companyId,shared);
    if(!workspaceId)return {error:shared?'access':creating?input.contactId?'contact_missing':'company_missing':'missing'};
    const target='id' in input?and(eq(tickets.workspaceId,workspaceId),eq(tickets.id,input.id)):undefined;
    const current=target?(await tx.select(columns).from(tickets).where(target).for('update'))[0]:undefined;
    if('id' in input){
      if(!current)return {error:'missing'};
      if(current.revision!==input.expectedRevision)return {error:'stale'};
    }

    const contact=await resolvePortableContactLink(tx,workspaceId,current?.contactId??null,input.action==='save'?input.contactId:undefined);
    if(!contact)return {error:'contact_missing'};
    const contactId=contact.id;
    const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.action==='save'?input.companyId:undefined);
    if(!company)return {error:'company_missing'};
    const companyId=company.id;

    // Status-only transitions retain the entire ticket and both primary links.
    const data=input.action==='save'?portableTicketFields.parse({...current?.data,...input.data}):{...current!.data,ticketStatus:input.status};
    const now=new Date().toISOString();
    const before=current?{...current.data,closedAt:current.closedAt}:undefined;
    const closedAt=ticketLifecycle(data,before,now).closedAt??null;
    const fields={data,contactId,companyId,closedAt,updatedAt:now};
    const [saved]=current
      ?await tx.update(tickets).set({...fields,revision:current.revision+1}).where(target).returning(columns)
      :await tx.insert(tickets).values({...fields,workspaceId,id:crypto.randomUUID(),revision:1,createdAt:now}).returning(columns);
    await tx.insert(portableTicketEvents).values({
      workspaceId,ticketId:saved.id,revision:saved.revision,actorId,
      previous:current?snapshot(current):null,data:snapshot(saved),occurredAt:now,
    });
    const receipt=await writePortableTicketSla(tx,workspaceId,saved,creating,current?.closedAt!==saved.closedAt);
    return {record:resultRecord({...saved,contactId:contact.visibleId,contactName:contact.name,companyId:company.visibleId,companyName:company.name},now,receipt)};
  });
}
