import {and,count,eq,inArray,isNotNull,isNull,sql} from 'drizzle-orm';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {
  mergeDefaults,mergeRecordData,mergeStandardFields,
  type PortableMergeCounts,type PortableMergePreview,type PortableMergeReceipt,type PortableRecordMergeAction,
} from '../../lib/portable-record-merge';
import type {SharedRecordWriteScope,WorkspacePermission} from '../../lib/portable-workspace-access';
import {alias} from 'drizzle-orm/pg-core';
import {companies} from './company-schema';
import {contactFileVersions} from './contact-file-schema';
import {contactEvents,contactMergeReceipts as receipts,contacts} from './contact-schema';
import {portableCustomProperties} from './custom-property-schema';
import {dealEvents,deals} from './deal-schema';
import {portableJobs as jobs} from './job-schema';
import {leadFormNoteSources,leadInquiries} from './lead-form-schema';
import {portableActivityRemovals} from './portable-activity-receipt-schema';
import {portableAssociations as links} from './portable-association-schema';
import {pendingContactWork} from './portable-contact-archive-store';
import {portableFileLocations as fileLocations} from './portable-file-folder-schema';
import {portableContactActivities as activities} from './portable-contact-activity-schema';
import {portableGmailLogReceipts as gmailLogs} from './portable-gmail-log-schema';
import {portableLeads} from './portable-lead-schema';
import {movePortableLeadLinks} from './portable-lead-store';
import {portableMeetings as meetings} from './portable-meeting-schema';
import {mergeEndpointOf,mergeLinkLabels,moveMergedAssociations} from './portable-merge-links';
import {recordSegmentMembershipWithoutEnrollment} from './portable-segment-workflow-store';
import {portableSegmentMembers as members} from './portable-segment-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableTaskEvents,portableTaskSnapshot,portableTasks} from './task-schema';
import {portableTicketEvents,portableTickets} from './ticket-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type MergeInput=Extract<PortableRecordMergeAction,{action:'merge'}>;
const notFound='Contact not found in your workspace.';
const stale='One of these Contacts changed. Review the merge again.';
const mergePermissions:WorkspacePermission[]=['contactFiles','scheduledNotes','contactOutreach','recordActivities'];
const accessError='Merging contacts requires editor access with files, scheduled notes, outreach and record activities enabled.';

function scopedCounts(counts:PortableMergeCounts,shared?:SharedRecordWriteScope){
  if(!shared)return counts;
  const visible={...counts};
  delete visible.inquiries;
  delete visible.segments;
  return visible;
}
const isoTime=(time:string)=>new Date(time).toISOString();

async function mergeFields(tx:Pick<Db,'select'>,workspaceId:string){
  const custom=await tx.select({id:portableCustomProperties.id}).from(portableCustomProperties)
    .where(and(eq(portableCustomProperties.workspaceId,workspaceId),eq(portableCustomProperties.kind,'contacts')));
  return [...mergeStandardFields.contacts,...custom.map(({id})=>'custom:'+id)];
}

async function pair(tx:Tx,workspaceId:string,primaryId:string,secondaryId:string,lock:boolean){
  const query=tx.select().from(contacts).where(and(eq(contacts.workspaceId,workspaceId),inArray(contacts.id,[primaryId,secondaryId])));
  const rows=lock?await query.for('update'):await query;
  const primary=rows.find(row=>row.id===primaryId),secondary=rows.find(row=>row.id===secondaryId);
  if(!primary||!secondary||primary.archivedAt||secondary.archivedAt)throw new ApiError(404,notFound);
  return {primary,secondary};
}

// Merge waits for queued or uncertain work on the Contact being merged.
async function guard(tx:Tx,workspaceId:string,primaryId:string,secondaryId:string){
  if(await pendingContactWork(tx,workspaceId,secondaryId)){
    throw new ApiError(409,'Resolve pending jobs and uncertain Calendar actions, or review uncertain Gmail delivery, on the Contact being merged.');
  }
  const keptFile=alias(contactFileVersions,'kept_file');
  const [collision]=await tx.select({id:contactFileVersions.fileId}).from(contactFileVersions)
    .innerJoin(keptFile,and(eq(keptFile.workspaceId,contactFileVersions.workspaceId),
      eq(keptFile.contactId,primaryId),eq(keptFile.fileId,contactFileVersions.fileId)))
    .where(and(eq(contactFileVersions.workspaceId,workspaceId),eq(contactFileVersions.contactId,secondaryId))).limit(1);
  if(collision)throw new ApiError(409,'These Contacts have a file with the same ID. Keep them separate until the file conflict is resolved.');
}

async function linkCounts(tx:Pick<Db,'select'>,workspaceId:string,id:string):Promise<PortableMergeCounts>{
  const n=(table:Parameters<ReturnType<Db['select']>['from']>[0],where:ReturnType<typeof and>)=>
    tx.select({n:count()}).from(table).where(where).then(([row])=>row!.n);
  return {
    deals:await n(deals,and(eq(deals.workspaceId,workspaceId),eq(deals.primaryContactId,id))),
    leads:await n(portableLeads,and(eq(portableLeads.workspaceId,workspaceId),eq(portableLeads.contactId,id))),
    tickets:await n(portableTickets,and(eq(portableTickets.workspaceId,workspaceId),eq(portableTickets.contactId,id))),
    tasks:await n(portableTasks,and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.contactId,id))),
    activities:await n(activities,and(eq(activities.workspaceId,workspaceId),eq(activities.contactId,id))),
    meetings:await n(meetings,and(eq(meetings.workspaceId,workspaceId),eq(meetings.contactId,id))),
    notes:await n(jobs,and(eq(jobs.workspaceId,workspaceId),eq(jobs.contactId,id),isNull(jobs.segmentEntryRevision))),
    inquiries:await n(leadInquiries,and(eq(leadInquiries.workspaceId,workspaceId),eq(leadInquiries.contactId,id))),
    segments:await n(members,and(eq(members.workspaceId,workspaceId),eq(members.contactId,id))),
    files:await tx.select({n:sql<number>`count(DISTINCT ${contactFileVersions.fileId})::int`}).from(contactFileVersions)
      .where(and(eq(contactFileVersions.workspaceId,workspaceId),eq(contactFileVersions.contactId,id),isNotNull(contactFileVersions.revision))).then(([row])=>row!.n),
    associations:await n(links,and(eq(links.workspaceId,workspaceId),mergeEndpointOf('contacts',id))),
  };
}

const view=(row:typeof contacts.$inferSelect)=>({id:row.id,revision:row.revision,data:row.data,createdAt:isoTime(row.createdAt),primaryCompanyId:row.primaryCompanyId});

export function previewPortableContactMerge(db:Db,actorId:string,input:{primaryId:string;secondaryId:string},shared?:SharedRecordWriteScope):Promise<PortableMergePreview>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,mergePermissions);
    if(!workspaceId)throw shared?new ApiError(403,accessError):new ApiError(404,notFound);
    const {primary,secondary}=await pair(tx,workspaceId,input.primaryId,input.secondaryId,false);
    await guard(tx,workspaceId,primary.id,secondary.id);
    const fields=await mergeFields(tx,workspaceId);
    const companyIds=[primary.primaryCompanyId,secondary.primaryCompanyId].filter((id):id is string=>!!id);
    const names=companyIds.length?await tx.select({id:companies.id,name:sql<string>`${companies.data}->>'name'`}).from(companies)
      .where(and(eq(companies.workspaceId,workspaceId),inArray(companies.id,companyIds),isNull(companies.archivedAt))):[];
    return {kind:'contacts',primary:view(primary),secondary:view(secondary),fields,
      defaults:mergeDefaults(primary,secondary,fields),counts:scopedCounts(await linkCounts(tx,workspaceId,secondary.id),shared),
      companyNames:Object.fromEntries(names.map(({id,name})=>[id,name]))};
  });
}

// The primary keeps its ID and gains the chosen values; a primary Company that
// isn't kept stays as an additional link. The secondary is archived as merged
// and can't be restored. Records that pointed at it point at the primary;
// workflow-run history stays with the secondary because it names that revision.
export function mergePortableContacts(db:Db,actorId:string,input:MergeInput,shared?:SharedRecordWriteScope):Promise<PortableMergeReceipt>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,mergePermissions,true);
    if(!workspaceId)throw shared?new ApiError(403,accessError):new ApiError(404,notFound);
    const {primaryId,secondaryId,requestId}=input;
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.primaryId!==primaryId||previous.secondaryId!==secondaryId)throw new ApiError(409,'That request ID was used for a different merge.');
      return {primaryId,secondaryId,revision:previous.primaryRevision,moved:scopedCounts(previous.moved,shared)};
    }
    const {primary,secondary}=await pair(tx,workspaceId,primaryId,secondaryId,true);
    if(primary.revision!==input.expectedRevisions.primary||secondary.revision!==input.expectedRevisions.secondary)throw new ApiError(409,stale);
    await guard(tx,workspaceId,primaryId,secondaryId);
    const fields=await mergeFields(tx,workspaceId);
    if(Object.keys(input.choices).some(field=>!fields.includes(field)))throw new ApiError(409,'A reviewed property is no longer available. Review the merge again.');
    const {data,primaryCompanyId}=mergeRecordData(primary,secondary,fields,input.choices);
    const now=new Date().toISOString(),revision=primary.revision+1;
    const createdAt=primary.createdAt<secondary.createdAt?primary.createdAt:secondary.createdAt;

    await tx.update(contacts).set({archivedAt:now,mergedIntoId:primaryId,revision:secondary.revision+1,updatedAt:now})
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,secondaryId)));
    await tx.insert(contactEvents).values({workspaceId,contactId:secondaryId,revision:secondary.revision+1,actorId,
      previous:secondary.data,data:secondary.data,previousPrimaryCompanyId:secondary.primaryCompanyId,
      primaryCompanyId:secondary.primaryCompanyId,occurredAt:now});
    await tx.update(contacts).set({data,primaryCompanyId,revision,createdAt,updatedAt:now})
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,primaryId)));
    await recordSegmentMembershipWithoutEnrollment(tx,workspaceId,primaryId,primary.data);
    await tx.insert(contactEvents).values({workspaceId,contactId:primaryId,revision,actorId,previous:primary.data,data,
      previousPrimaryCompanyId:primary.primaryCompanyId,primaryCompanyId,occurredAt:now});

    const moved=await moveContactLinks(tx,workspaceId,actorId,primaryId,secondaryId,now);
    for(const companyId of new Set([primary.primaryCompanyId,secondary.primaryCompanyId])){
      if(companyId&&companyId!==primaryCompanyId)await mergeLinkLabels(tx,workspaceId,{kind:'contacts',id:primaryId},{kind:'companies',id:companyId},[]);
    }
    await tx.insert(receipts).values({workspaceId,requestId,primaryId,secondaryId,primaryRevision:revision,actorId,
      secondaryData:secondary.data,secondaryCompanyId:secondary.primaryCompanyId,moved,mergedAt:now});
    return {primaryId,secondaryId,revision,moved:scopedCounts(moved,shared)};
  });
}

async function moveContactLinks(tx:Tx,workspaceId:string,actorId:string,primaryId:string,secondaryId:string,now:string){
  const moved:PortableMergeCounts={};
  const own=(table:{workspaceId:AnyPgColumn})=>eq(table.workspaceId,workspaceId);

  const dealRows=await tx.select().from(deals).where(and(own(deals),eq(deals.primaryContactId,secondaryId))).for('update');
  for(const row of dealRows){
    const scope=and(own(deals),eq(deals.id,row.id));
    if(row.archivedAt){await tx.update(deals).set({primaryContactId:primaryId}).where(scope);continue;}
    const revision=row.revision+1;
    await tx.update(deals).set({primaryContactId:primaryId,revision,updatedAt:now}).where(scope);
    await tx.insert(dealEvents).values({workspaceId,dealId:row.id,revision,actorId,previous:row.data,data:row.data,
      previousPipelineId:row.pipelineId,pipelineId:row.pipelineId,previousStageId:row.stageId,stageId:row.stageId,
      previousCompanyId:row.companyId,companyId:row.companyId,
      previousPrimaryContactId:secondaryId,primaryContactId:primaryId,occurredAt:now});
  }
  moved.deals=dealRows.length;

  moved.leads=await movePortableLeadLinks(tx,workspaceId,actorId,'contactId',secondaryId,primaryId,now);

  const ticketRows=await tx.select().from(portableTickets).where(and(own(portableTickets),eq(portableTickets.contactId,secondaryId))).for('update');
  for(const row of ticketRows){
    const revision=row.revision+1;
    const snapshot=(contactId:string)=>({data:row.data,contactId,companyId:row.companyId,closedAt:row.closedAt&&isoTime(row.closedAt)});
    await tx.update(portableTickets).set({contactId:primaryId,revision,updatedAt:now}).where(and(own(portableTickets),eq(portableTickets.id,row.id)));
    await tx.insert(portableTicketEvents).values({workspaceId,ticketId:row.id,revision,actorId,
      previous:snapshot(secondaryId),data:snapshot(primaryId),occurredAt:now});
  }
  moved.tickets=ticketRows.length;

  const taskRows=await tx.select().from(portableTasks).where(and(own(portableTasks),eq(portableTasks.contactId,secondaryId))).for('update');
  for(const row of taskRows){
    const scope=and(own(portableTasks),eq(portableTasks.id,row.id));
    if(row.archivedAt){await tx.update(portableTasks).set({contactId:primaryId}).where(scope);continue;}
    const revision=row.revision+1;
    await tx.update(portableTasks).set({contactId:primaryId,revision,updatedAt:now}).where(scope);
    await tx.insert(portableTaskEvents).values({workspaceId,taskId:row.id,revision,actorId,
      previous:portableTaskSnapshot(row),data:portableTaskSnapshot({...row,contactId:primaryId}),occurredAt:now});
  }
  moved.tasks=taskRows.length;

  moved.activities=(await tx.update(activities).set({contactId:primaryId})
    .where(and(own(activities),eq(activities.contactId,secondaryId))).returning({id:activities.id})).length;
  await tx.update(gmailLogs).set({contactId:primaryId}).where(and(own(gmailLogs),eq(gmailLogs.contactId,secondaryId)));
  await tx.update(portableActivityRemovals).set({recordId:primaryId}).where(and(own(portableActivityRemovals),
    eq(portableActivityRemovals.recordKind,'contacts'),eq(portableActivityRemovals.recordId,secondaryId)));
  moved.meetings=(await tx.update(meetings).set({contactId:primaryId})
    .where(and(own(meetings),eq(meetings.contactId,secondaryId))).returning({id:meetings.id})).length;
  // Segment-entry jobs name a secondary revision and stay with its history.
  moved.notes=(await tx.update(jobs).set({contactId:primaryId})
    .where(and(own(jobs),eq(jobs.contactId,secondaryId),isNull(jobs.segmentEntryRevision))).returning({id:jobs.id})).length;
  moved.inquiries=(await tx.update(leadInquiries).set({contactId:primaryId})
    .where(and(own(leadInquiries),eq(leadInquiries.contactId,secondaryId))).returning({id:leadInquiries.id})).length;
  await tx.update(leadFormNoteSources).set({contactId:primaryId}).where(and(own(leadFormNoteSources),eq(leadFormNoteSources.contactId,secondaryId)));

  const memberships=await tx.delete(members).where(and(own(members),eq(members.contactId,secondaryId))).returning({segmentId:members.segmentId});
  if(memberships.length){
    await tx.insert(members).values(memberships.map(({segmentId})=>({workspaceId,segmentId,contactId:primaryId}))).onConflictDoNothing();
  }
  moved.segments=memberships.length;

  // Stored objects stay where they are; each version remembers the Contact ID in its key.
  const files=await tx.update(contactFileVersions).set({storageContactId:sql`coalesce(${contactFileVersions.storageContactId},${contactFileVersions.contactId})`,
    contactId:primaryId}).where(and(own(contactFileVersions),eq(contactFileVersions.contactId,secondaryId)))
    .returning({fileId:contactFileVersions.fileId,revision:contactFileVersions.revision});
  moved.files=new Set(files.filter(row=>row.revision!==null).map(row=>row.fileId)).size;
  await tx.update(fileLocations).set({contactId:primaryId}).where(and(own(fileLocations),eq(fileLocations.contactId,secondaryId)));

  moved.associations=await moveMergedAssociations(tx,workspaceId,'contacts',primaryId,secondaryId);
  return moved;
}
