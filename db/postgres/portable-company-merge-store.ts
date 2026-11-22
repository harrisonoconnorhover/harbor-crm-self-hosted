import {sharedToolAllowed} from './shared-tool-permission';
import {requireMergeFieldAccess} from './record-property-access';
import {and,count,eq,inArray} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {
  mergeDefaults,mergeRecordData,mergeStandardFields,
  type PortableMergeCounts,type PortableMergePreview,type PortableMergeReceipt,type PortableRecordMergeAction,
} from '../../lib/portable-record-merge';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {portableActivityRemovals} from './portable-activity-receipt-schema';
import {portableAssociations as links} from './portable-association-schema';
import {companyEvents,companyMergeReceipts as receipts,companies} from './company-schema';
import {contactEvents,contacts} from './contact-schema';
import {portableCustomProperties} from './custom-property-schema';
import {dealEvents,deals} from './deal-schema';
import {portableLeads} from './portable-lead-schema';
import {movePortableLeadLinks} from './portable-lead-store';
import {portableRecordActivities} from './portable-record-activity-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {mergeEndpointOf,moveMergedAssociations} from './portable-merge-links';
import {portableTaskEvents,portableTaskSnapshot,portableTasks} from './task-schema';
import {portableTicketEvents,portableTickets} from './ticket-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type MergeInput=Extract<PortableRecordMergeAction,{action:'merge'}>;
const notFound='Company not found in your workspace.';
const stale='One of these Companies changed. Review the merge again.';
const isoTime=(time:string)=>new Date(time).toISOString();

async function mergeFields(tx:Pick<Db,'select'>,workspaceId:string){
  const custom=await tx.select({id:portableCustomProperties.id}).from(portableCustomProperties)
    .where(and(eq(portableCustomProperties.workspaceId,workspaceId),eq(portableCustomProperties.kind,'companies')));
  return [...mergeStandardFields.companies,...custom.map(({id})=>'custom:'+id)];
}

async function pair(tx:Tx,workspaceId:string,primaryId:string,secondaryId:string,lock:boolean){
  const query=tx.select().from(companies).where(and(eq(companies.workspaceId,workspaceId),inArray(companies.id,[primaryId,secondaryId])));
  const rows=lock?await query.for('update'):await query;
  const primary=rows.find(row=>row.id===primaryId),secondary=rows.find(row=>row.id===secondaryId);
  if(!primary||!secondary||primary.archivedAt||secondary.archivedAt)throw new ApiError(404,notFound);
  return {primary,secondary};
}

async function linkCounts(tx:Pick<Db,'select'>,workspaceId:string,id:string):Promise<PortableMergeCounts>{
  const n=(table:Parameters<ReturnType<Db['select']>['from']>[0],where:ReturnType<typeof and>)=>
    tx.select({n:count()}).from(table).where(where).then(([row])=>row!.n);
  return {
    contacts:await n(contacts,and(eq(contacts.workspaceId,workspaceId),eq(contacts.primaryCompanyId,id))),
    deals:await n(deals,and(eq(deals.workspaceId,workspaceId),eq(deals.companyId,id))),
    leads:await n(portableLeads,and(eq(portableLeads.workspaceId,workspaceId),eq(portableLeads.companyId,id))),
    tickets:await n(portableTickets,and(eq(portableTickets.workspaceId,workspaceId),eq(portableTickets.companyId,id))),
    tasks:await n(portableTasks,and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.companyId,id))),
    activities:await n(portableRecordActivities,and(eq(portableRecordActivities.workspaceId,workspaceId),eq(portableRecordActivities.companyId,id))),
    associations:await n(links,and(eq(links.workspaceId,workspaceId),endpointOf(id))),
  };
}
const endpointOf=(id:string)=>mergeEndpointOf('companies',id);

export function previewPortableCompanyMerge(db:Db,actorId:string,input:{primaryId:string;secondaryId:string},shared?:SharedRecordWriteScope):Promise<PortableMergePreview>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,'recordActivities',!!shared);
    if(!workspaceId||!await sharedToolAllowed(tx,actorId,shared?.workspaceId,'duplicates','edit'))throw shared?new ApiError(403,'Merging companies requires editor access with record activities enabled.'):new ApiError(404,notFound);
    if(shared)await requireMergeFieldAccess(tx,workspaceId,'companies',actorId);
    const {primary,secondary}=await pair(tx,workspaceId,input.primaryId,input.secondaryId,false);
    const fields=await mergeFields(tx,workspaceId);
    const view=(row:typeof primary)=>({id:row.id,revision:row.revision,data:row.data,createdAt:isoTime(row.createdAt)});
    return {kind:'companies',primary:view(primary),secondary:view(secondary),fields,
      defaults:mergeDefaults(primary,secondary,fields),counts:await linkCounts(tx,workspaceId,secondary.id)};
  });
}

// The primary keeps its ID and gains the chosen values. The secondary is
// archived as merged and can't be restored. Every record that pointed at the
// secondary points at the primary; active records gain an attributed revision,
// archived ones keep their archive revision and show the primary after restore.
export function mergePortableCompanies(db:Db,actorId:string,input:MergeInput,shared?:SharedRecordWriteScope):Promise<PortableMergeReceipt>{
  return db.transaction(async tx=>{
    // Serializes with every record writer, so no new link to the secondary can commit.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,'recordActivities',true);
    if(!workspaceId||!await sharedToolAllowed(tx,actorId,shared?.workspaceId,'duplicates','edit'))throw shared?new ApiError(403,'Merging companies requires editor access with record activities enabled.'):new ApiError(404,notFound);
    if(shared)await requireMergeFieldAccess(tx,workspaceId,'companies',actorId);
    const {primaryId,secondaryId,requestId}=input;
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.primaryId!==primaryId||previous.secondaryId!==secondaryId)throw new ApiError(409,'That request ID was used for a different merge.');
      return {primaryId,secondaryId,revision:previous.primaryRevision,moved:previous.moved};
    }
    const {primary,secondary}=await pair(tx,workspaceId,primaryId,secondaryId,true);
    if(primary.revision!==input.expectedRevisions.primary||secondary.revision!==input.expectedRevisions.secondary)throw new ApiError(409,stale);
    const fields=await mergeFields(tx,workspaceId);
    if(Object.keys(input.choices).some(field=>!fields.includes(field)))throw new ApiError(409,'A reviewed property is no longer available. Review the merge again.');
    const {data}=mergeRecordData(primary,secondary,fields,input.choices);
    const now=new Date().toISOString(),revision=primary.revision+1;
    const createdAt=primary.createdAt<secondary.createdAt?primary.createdAt:secondary.createdAt;

    await tx.update(companies).set({archivedAt:now,mergedIntoId:primaryId,revision:secondary.revision+1,updatedAt:now})
      .where(and(eq(companies.workspaceId,workspaceId),eq(companies.id,secondaryId)));
    await tx.insert(companyEvents).values({workspaceId,companyId:secondaryId,revision:secondary.revision+1,actorId,
      previous:secondary.data,data:secondary.data,occurredAt:now});
    await tx.update(companies).set({data,revision,createdAt,updatedAt:now})
      .where(and(eq(companies.workspaceId,workspaceId),eq(companies.id,primaryId)));
    await tx.insert(companyEvents).values({workspaceId,companyId:primaryId,revision,actorId,previous:primary.data,data,occurredAt:now});

    const moved=await moveCompanyLinks(tx,workspaceId,actorId,primaryId,secondaryId,now);
    await tx.insert(receipts).values({workspaceId,requestId,primaryId,secondaryId,primaryRevision:revision,actorId,
      secondaryData:secondary.data,moved,mergedAt:now});
    return {primaryId,secondaryId,revision,moved};
  });
}

async function moveCompanyLinks(tx:Tx,workspaceId:string,actorId:string,primaryId:string,secondaryId:string,now:string){
  const moved:PortableMergeCounts={};

  const contactRows=await tx.select().from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.primaryCompanyId,secondaryId))).for('update');
  for(const row of contactRows){
    const scope=and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,row.id));
    if(row.archivedAt){await tx.update(contacts).set({primaryCompanyId:primaryId}).where(scope);continue;}
    const revision=row.revision+1;
    await tx.update(contacts).set({primaryCompanyId:primaryId,revision,updatedAt:now}).where(scope);
    await tx.insert(contactEvents).values({workspaceId,contactId:row.id,revision,actorId,previous:row.data,data:row.data,
      previousPrimaryCompanyId:secondaryId,primaryCompanyId:primaryId,occurredAt:now});
  }
  moved.contacts=contactRows.length;

  const dealRows=await tx.select().from(deals)
    .where(and(eq(deals.workspaceId,workspaceId),eq(deals.companyId,secondaryId))).for('update');
  for(const row of dealRows){
    const scope=and(eq(deals.workspaceId,workspaceId),eq(deals.id,row.id));
    if(row.archivedAt){await tx.update(deals).set({companyId:primaryId}).where(scope);continue;}
    const revision=row.revision+1;
    await tx.update(deals).set({companyId:primaryId,revision,updatedAt:now}).where(scope);
    await tx.insert(dealEvents).values({workspaceId,dealId:row.id,revision,actorId,previous:row.data,data:row.data,
      previousPipelineId:row.pipelineId,pipelineId:row.pipelineId,previousStageId:row.stageId,stageId:row.stageId,
      previousCompanyId:secondaryId,companyId:primaryId,
      previousPrimaryContactId:row.primaryContactId,primaryContactId:row.primaryContactId,occurredAt:now});
  }
  moved.deals=dealRows.length;

  moved.leads=await movePortableLeadLinks(tx,workspaceId,actorId,'companyId',secondaryId,primaryId,now);

  const ticketRows=await tx.select().from(portableTickets)
    .where(and(eq(portableTickets.workspaceId,workspaceId),eq(portableTickets.companyId,secondaryId))).for('update');
  for(const row of ticketRows){
    const revision=row.revision+1;
    const snapshot=(companyId:string)=>({assigneeId:row.assigneeId,assigneeLabel:row.assigneeLabel,data:row.data,contactId:row.contactId,companyId,closedAt:row.closedAt&&isoTime(row.closedAt)});
    await tx.update(portableTickets).set({companyId:primaryId,revision,updatedAt:now})
      .where(and(eq(portableTickets.workspaceId,workspaceId),eq(portableTickets.id,row.id)));
    await tx.insert(portableTicketEvents).values({workspaceId,ticketId:row.id,revision,actorId,
      previous:snapshot(secondaryId),data:snapshot(primaryId),occurredAt:now});
  }
  moved.tickets=ticketRows.length;

  const taskRows=await tx.select().from(portableTasks)
    .where(and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.companyId,secondaryId))).for('update');
  for(const row of taskRows){
    const scope=and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.id,row.id));
    if(row.archivedAt){await tx.update(portableTasks).set({companyId:primaryId}).where(scope);continue;}
    const revision=row.revision+1;
    await tx.update(portableTasks).set({companyId:primaryId,revision,updatedAt:now}).where(scope);
    await tx.insert(portableTaskEvents).values({workspaceId,taskId:row.id,revision,actorId,
      previous:portableTaskSnapshot(row),data:portableTaskSnapshot({...row,companyId:primaryId}),occurredAt:now});
  }
  moved.tasks=taskRows.length;

  moved.activities=(await tx.update(portableRecordActivities).set({companyId:primaryId})
    .where(and(eq(portableRecordActivities.workspaceId,workspaceId),eq(portableRecordActivities.companyId,secondaryId)))
    .returning({id:portableRecordActivities.id})).length;
  await tx.update(portableActivityRemovals).set({recordId:primaryId}).where(and(eq(portableActivityRemovals.workspaceId,workspaceId),
    eq(portableActivityRemovals.recordKind,'companies'),eq(portableActivityRemovals.recordId,secondaryId)));

  moved.associations=await moveMergedAssociations(tx,workspaceId,'companies',primaryId,secondaryId);
  return moved;
}
