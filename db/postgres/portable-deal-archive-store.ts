import {and,asc,eq,gt,inArray,isNotNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableArchivedRecord,PortableArchiveInput,PortableArchiveReceipt} from '../../lib/portable-contact-archive';
import {dealArchiveReceipts as receipts,dealEvents,deals} from './deal-schema';
import {portableJobs as jobs} from './job-schema';
import {uncertainGmailIssues} from './job-store';
import {lockRecordWorkspace} from './private-workspace-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {ownedRecordScope} from './record-ownership-scope';
import {archiveAccessError,archivedByLabel,archiveWorkspaceScope} from './portable-archive-scope';
import {dealWorkflowRuns as runs} from './workflow-schema';
import {privateWorkspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const pageSize=25;
const at=(value:string|null)=>value===null?null:new Date(value).toISOString();

export async function readPortableDealArchive(db:Db,actorId:string,after?:string,shared?:SharedRecordWriteScope){
  const rows=await db.select({id:deals.id,name:sql<string>`${deals.data}->>'name'`,revision:deals.revision,archivedAt:deals.archivedAt,
    archivedBy:archivedByLabel(dealEvents,dealEvents.dealId,deals.id,deals.workspaceId,deals.revision)})
    .from(deals).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,deals.workspaceId))
    .where(and(archiveWorkspaceScope(db,actorId,shared,deals),isNotNull(deals.archivedAt),after?gt(deals.id,after):undefined))
    .orderBy(asc(deals.id)).limit(pageSize+1);
  const records:PortableArchivedRecord[]=rows.slice(0,pageSize).map(row=>({...row,archivedAt:at(row.archivedAt)!}));
  return {records,next:rows.length>pageSize?records.at(-1)!.id:null};
}

export async function isPortableDealArchived(db:Db,actorId:string,id:string){
  const [record]=await db.select({id:deals.id}).from(deals)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,deals.workspaceId))
    .where(and(eq(privateWorkspaces.ownerId,actorId),eq(deals.id,id),isNotNull(deals.archivedAt))).limit(1);
  return Boolean(record);
}

// A stage workflow run for this Deal may still hold a Note job for its Contact.
async function pendingDealWork(tx:Tx,workspaceId:string,dealId:string){
  const [row]=await tx.execute<{pending:boolean}>(sql`
    SELECT EXISTS (SELECT 1 FROM ${runs} JOIN ${jobs} ON ${jobs.workspaceId}=${runs.workspaceId} AND ${jobs.id}=${runs.jobId}
      WHERE ${runs.workspaceId}=${workspaceId} AND ${runs.dealId}=${dealId}
      AND ${inArray(jobs.status,['queued','running','dispatching','attention'])}
      AND (${jobs.status}='attention' AND ${jobs.kind}='gmail' AND ${inArray(jobs.issue,uncertainGmailIssues)}
        AND ${jobs.operatorReviewedAt} IS NOT NULL) IS NOT TRUE) AS pending
  `);
  return row.pending;
}

// Archive hides the Deal and keeps its line items, quotes, invoices, timeline
// and stored links. Tasks and Leads show no Deal while it is archived and the
// same link again after restore. Existing quotes and invoices stay available.
export function changePortableDealArchive(db:Db,actorId:string,input:PortableArchiveInput,shared?:SharedRecordWriteScope):Promise<PortableArchiveReceipt>{
  return db.transaction(async tx=>{
    // Link writers, line items and quote/invoice drafts take this lock before checking that a Deal is active.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true,true,['deals','delete']);
    if(!workspaceId)throw shared?new ApiError(403,archiveAccessError):new ApiError(404,'Deal not found in your workspace.');
    const {id,requestId,expectedRevision,action}=input;
    const scope=and(eq(deals.workspaceId,workspaceId),eq(deals.id,id),shared?ownedRecordScope(tx,actorId,workspaceId,deals,'edit'):undefined);
    const [deal]=await tx.select().from(deals).where(scope).for('update');
    if(!deal)throw new ApiError(404,'Deal not found in your workspace.');
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.dealId!==id||previous.action!==action||previous.revision!==expectedRevision+1){
        throw new ApiError(409,'That request ID was used for a different Deal change.');
      }
      return {id,action,revision:previous.revision,archivedAt:at(previous.archivedAt)};
    }
    if(deal.revision!==expectedRevision||Boolean(deal.archivedAt)!==(action==='restore')){
      throw new ApiError(409,'This Deal changed. Refresh before trying again.');
    }
    if(action==='archive'&&await pendingDealWork(tx,workspaceId,id)){
      throw new ApiError(409,'Resolve pending workflow jobs for this Deal, or review uncertain Gmail delivery, before archiving it.');
    }
    const now=new Date().toISOString(),archivedAt=action==='archive'?now:null,revision=expectedRevision+1;
    await tx.update(deals).set({archivedAt,revision,updatedAt:now}).where(scope);
    // Keep each record revision addressable by workflow and history readers.
    await tx.insert(dealEvents).values({workspaceId,dealId:id,revision,actorId,previous:deal.data,data:deal.data,
      previousPipelineId:deal.pipelineId,pipelineId:deal.pipelineId,previousStageId:deal.stageId,stageId:deal.stageId,
      previousCompanyId:deal.companyId,companyId:deal.companyId,
      previousPrimaryContactId:deal.primaryContactId,primaryContactId:deal.primaryContactId,occurredAt:now});
    await tx.insert(receipts).values({workspaceId,requestId,dealId:id,action,revision,archivedAt});
    return {id,action,revision,archivedAt};
  });
}
