import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import type {portableCloseSlaInput,PortableCloseSlaPolicy,PortableTicketFields} from '../../lib/portable-tickets';
import {closeSlaStatus,defaultCloseSla,slaPriorities,type CloseSlaReceipt} from '../../lib/ticket-sla';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableTicketCloseSlaPolicies as policies,portableTicketCloseSlaReceipts as receipts} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const {enabled,targets,warningMinutes}=defaultCloseSla;
const defaults={enabled,targets,warningMinutes,revision:0,updatedAt:null};
const policyFields={enabled:policies.enabled,targets:policies.targets,warningMinutes:policies.warningMinutes,
  revision:policies.revision,updatedAt:policies.updatedAt};
export const ticketCloseSlaFields={recordId:receipts.ticketId,policyRevision:receipts.policyRevision,priority:receipts.priority,
  targetMinutes:receipts.targetMinutes,warningMinutes:receipts.warningMinutes,startedAt:receipts.startedAt,dueAt:receipts.dueAt,
  warningAt:receipts.warningAt,completedAt:receipts.completedAt,appliedAt:receipts.appliedAt};
const iso=(date:string)=>new Date(date).toISOString();
const offset=(date:string,minutes:number)=>new Date(Date.parse(date)+minutes*60_000).toISOString();
const policyResult=(row:typeof policies.$inferSelect|PortableCloseSlaPolicy):PortableCloseSlaPolicy=>({
  enabled:row.enabled,targets:row.targets,warningMinutes:row.warningMinutes,
  revision:row.revision,updatedAt:row.updatedAt&&iso(row.updatedAt),
});

export async function readPortableCloseSlaPolicy(db:Db,actorId:string){
  const [policy]=await db.select(policyFields).from(policies).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,policies.workspaceId))
    .where(eq(privateWorkspaces.ownerId,actorId)).limit(1);
  return policy?policyResult(policy):defaults;
}

export async function savePortableCloseSlaPolicy(db:Db,actorId:string,input:z.output<typeof portableCloseSlaInput>){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.revision===0,undefined,undefined,true);
    if(!workspaceId)return null;
    const where=eq(policies.workspaceId,workspaceId);
    const [current]=await tx.select(policyFields).from(policies).where(where).limit(1);
    const prior=current?policyResult(current):defaults;
    if(input.revision!==prior.revision)return null;
    if(input.enabled===prior.enabled&&input.warningMinutes===prior.warningMinutes&&
      slaPriorities.every(priority=>input.targets[priority]===prior.targets[priority]))return prior;
    const values={enabled:input.enabled,targets:input.targets,warningMinutes:input.warningMinutes,
      revision:input.revision+1,updatedAt:new Date().toISOString()};
    const [saved]=current?await tx.update(policies).set(values).where(where).returning(policyFields):
      await tx.insert(policies).values({workspaceId,...values}).returning(policyFields);
    return policyResult(saved);
  });
}

export function ticketCloseSlaResult(saved:CloseSlaReceipt,asOf:string){
  const receipt={...saved,startedAt:iso(saved.startedAt),dueAt:iso(saved.dueAt),appliedAt:iso(saved.appliedAt),
    warningAt:saved.warningAt&&iso(saved.warningAt),completedAt:saved.completedAt&&iso(saved.completedAt)};
  return {asOf,receipt,status:closeSlaStatus(receipt,asOf)};
}

// Ticket saves hold a shared workspace lock. Policy changes take the conflicting workspace lock.
export async function writePortableTicketSla(tx:Tx,workspaceId:string,ticket:{
  id:string;data:PortableTicketFields;createdAt:string;closedAt:string|null;
},creating:boolean,closureChanged:boolean){
  const where=and(eq(receipts.workspaceId,workspaceId),eq(receipts.ticketId,ticket.id));
  if(!creating){
    const [receipt]=closureChanged?await tx.update(receipts).set({completedAt:ticket.closedAt}).where(where).returning(ticketCloseSlaFields):
      await tx.select(ticketCloseSlaFields).from(receipts).where(where).limit(1);
    return receipt;
  }
  const priority=ticket.data.ticketPriority;
  if(!priority)return undefined;
  const [policy]=await tx.select(policyFields).from(policies).where(eq(policies.workspaceId,workspaceId)).limit(1);
  if(!policy?.enabled)return undefined;
  const targetMinutes=policy.targets[priority];
  if(!targetMinutes)return undefined;
  const {createdAt:startedAt,closedAt:completedAt}=ticket;
  const dueAt=offset(startedAt,targetMinutes),warningMinutes=policy.warningMinutes;
  const [receipt]=await tx.insert(receipts).values({workspaceId,ticketId:ticket.id,policyRevision:policy.revision,
    priority,targetMinutes,warningMinutes,startedAt,dueAt,warningAt:warningMinutes?offset(dueAt,-warningMinutes):null,
    completedAt,appliedAt:startedAt}).returning(ticketCloseSlaFields);
  return receipt;
}
