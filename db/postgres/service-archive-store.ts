import {and,asc,eq,gt,isNotNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ownedRecordScope} from './record-ownership-scope';
import {ApiError} from '../../lib/api-error';
import type {PortableArchiveInput,PortableArchiveReceipt} from '../../lib/portable-contact-archive';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {loginIdentities} from './identity-schema';
import {archiveWorkspaceScope} from './portable-archive-scope';
import {leadOwnership,portableLeads} from './portable-lead-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {serviceArchiveReceipts as receipts} from './service-archive-schema';
import {ticketOwnership,portableTickets} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';

type Kind='leads'|'tickets';
export async function readServiceArchive(db:PostgresJsDatabase,ownerId:string,kind:Kind,after?:string,shared?:SharedRecordWriteScope){
  const table=kind==='leads'?portableLeads:portableTickets,column=kind==='leads'?receipts.leadId:receipts.ticketId;
  const rows=await db.select({id:table.id,name:sql<string>`${table.data}->>'name'`,revision:table.revision,archivedAt:table.archivedAt,
    archivedBy:sql<string|null>`(SELECT coalesce(nullif(${loginIdentities.fullName},''),${loginIdentities.email})
      FROM ${receipts} JOIN ${loginIdentities} ON ${loginIdentities.id}=${receipts.actorId}
      WHERE ${receipts.workspaceId}=${table.workspaceId} AND ${column}=${table.id} AND ${receipts.action}='archive'
      ORDER BY ${receipts.revision} DESC LIMIT 1)`}).from(table)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,table.workspaceId))
    .where(and(archiveWorkspaceScope(db,ownerId,shared,kind==='leads'?leadOwnership:ticketOwnership),isNotNull(table.archivedAt),after?gt(table.id,after):undefined))
    .orderBy(asc(table.id)).limit(26);
  return {records:rows.slice(0,25).map(r=>({...r,archivedAt:new Date(r.archivedAt!).toISOString()})),next:rows.length>25?rows[24].id:null};
}

export function changeServiceArchive(db:PostgresJsDatabase,ownerId:string,kind:Kind,input:PortableArchiveInput,shared?:SharedRecordWriteScope):Promise<PortableArchiveReceipt>{
  const table=kind==='leads'?portableLeads:portableTickets;
  const {id,expectedRevision,requestId,action}=input;
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,shared,undefined,true,true,[kind,'delete']);
    if(!workspaceId)throw new ApiError(shared?403:404,'Archive unavailable.');
    const scope=and(eq(table.workspaceId,workspaceId),eq(table.id,id),
      shared?ownedRecordScope(tx,ownerId,workspaceId,kind==='leads'?leadOwnership:ticketOwnership,'edit'):undefined);
    const [record]=await tx.select({revision:table.revision,archivedAt:table.archivedAt}).from(table).where(scope).for('update');
    if(!record)throw new ApiError(404,'Record unavailable.');
    const [existing]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    const revision=expectedRevision+1;
    if(existing){
      if(existing[kind==='leads'?'leadId':'ticketId']!==id||existing.action!==action||existing.revision!==revision)
        throw new ApiError(409,'That request ID already identifies another archive change.');
      return {id,action,revision,archivedAt:action==='archive'?new Date(existing.occurredAt).toISOString():null};
    }
    if(record.revision!==expectedRevision||Boolean(record.archivedAt)!==(action==='restore'))
      throw new ApiError(409,'This record changed. Reload before trying again.');
    const now=new Date().toISOString(),archivedAt=action==='archive'?now:null;
    if(kind==='leads')await tx.update(portableLeads).set({revision,archivedAt,updatedAt:now,routingRetryAt:null,routingMiss:null}).where(scope);
    else await tx.update(portableTickets).set({revision,archivedAt,updatedAt:now}).where(scope);
    await tx.insert(receipts).values({workspaceId,requestId,leadId:kind==='leads'?id:null,ticketId:kind==='tickets'?id:null,
      actorId:ownerId,action,revision,occurredAt:now});
    return {id,action,revision,archivedAt};
  });
}
