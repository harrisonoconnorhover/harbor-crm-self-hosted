import {and,desc,eq,gte,inArray,isNotNull,lt,lte,sql,type SQL} from 'drizzle-orm';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableActivityFilters,PortableActivityHistoryQuery,PortableActivityMutation,PortableLoggedActivityQuery,PortableOutreach,PortableOutreachQuery,PortableRecordActivityQuery} from '../../lib/portable-contact-activities';
import {activityDateBounds,hasActivityFilters,portableOutreachSummaryLimit} from '../../lib/portable-contact-activities';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {deals} from './deal-schema';
import {visibleContactScope} from './contact-store';
import {jobClock} from './job-store';
import type {AircallAsset} from '../../lib/aircall-activity';
import {portableContactActivities as activities,reportedAircallAssets} from './portable-contact-activity-schema';
import {portableRecordActivities as recordActivities} from './portable-record-activity-schema';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {ownedRecordScope} from './record-ownership-scope';
import {lockRecordWorkspace} from './private-workspace-store';
import {outreachActivityTypes} from '../../lib/activity-date-policy';
import {digest} from '../../lib/api-access';
import {portableActivityCreationReceipts as receipts,portableActivityRemovals as removals} from './portable-activity-receipt-schema';
import {leadInquiries as inquiries} from './lead-form-schema';
import {portableActivityHistory as history} from './portable-activity-history-schema';
import {portableGmailLogReceipts as gmailReceipts} from './portable-gmail-log-schema';
import {portableJobs as jobs} from './job-schema';
import {scheduledGmail as mail} from './scheduled-gmail-schema';
import {confirmedScheduledGmailReceipt,scheduledGmailReceiptJoin} from './confirmed-scheduled-gmail';

type Db=PostgresJsDatabase;
const pageSize=25;
const gmailSource=sql<boolean>`EXISTS (SELECT 1 FROM ${gmailReceipts} WHERE ${gmailReceipts.workspaceId}=${activities.workspaceId}
  AND ${gmailReceipts.activityId}=${activities.id} AND ${gmailReceipts.contactId}=${activities.contactId})`;
const manualContactActivity=sql`NOT (${gmailSource})`;
function occurredWithin(column:AnyPgColumn,filters:PortableActivityFilters){
  const {start,end}=activityDateBounds(filters);
  return and(start===undefined?undefined:gte(column,start),end===undefined?undefined:lte(column,end));
}

// Filters narrow listed items only; Last contacted and Last logged activity stay record-wide.
async function readActivityPage(db:Db,table:typeof activities|typeof recordActivities,scope:SQL|undefined,
  {afterAt,afterId}:Pick<PortableOutreachQuery,'afterAt'|'afterId'>,filters:PortableActivityFilters={}){
  const fields={id:table.id,revision:table.revision,kind:table.kind,occurredAt:table.occurredAt,summary:table.summary,
    media:table===activities?sql<AircallAsset[]|null>`CASE WHEN ${activities.kind}='Call' THEN ${reportedAircallAssets(activities.workspaceId,activities.id)} END`:sql<null>`NULL`,
    gmail:table===activities?gmailSource:sql<false>`false`};
  const rows=await db.select(fields).from(table).where(and(scope,
    filters.channel?eq(table.kind,filters.channel):undefined,occurredWithin(table.occurredAt,filters),
    afterAt===undefined?undefined:sql`(${table.occurredAt},${table.id}) < (${afterAt},${afterId}::uuid)`))
    .orderBy(desc(table.occurredAt),desc(table.id)).limit(pageSize+1);
  const items=rows.slice(0,pageSize).map(({gmail,media,...row})=>({...row,...(media?{aircallAssets:media}:{}),...(gmail?{fromGmail:true as const}:{})})),last=items.at(-1);
  const latest=()=>db.select({occurredAt:table.occurredAt}).from(table);
  const lastActivity=afterAt===undefined&&!hasActivityFilters(filters)?items[0]:
    (await latest().where(scope).orderBy(desc(table.occurredAt)).limit(1))[0];
  const [lastContacted]=await latest().where(and(scope,inArray(table.kind,outreachActivityTypes)))
    .orderBy(desc(table.occurredAt)).limit(1);
  return {items,lastContacted:lastContacted?.occurredAt??null,lastActivity:lastActivity?.occurredAt??null,
    next:rows.length>pageSize&&last?{at:last.occurredAt,id:last.id}:null};
}

type TimelineItem=Awaited<ReturnType<typeof readActivityPage>>['items'][number]&{
  fromInquiry?:true;fromScheduledGmail?:true;scheduledJobId?:string;
};

const scheduledActivityId=sql<string>`md5('portable-scheduled-gmail:' || ${jobs.id}::text)::uuid`;
function readScheduledGmailTimeline(db:Db,workspaceId:string,contactId:string,query?:PortableOutreachQuery&PortableActivityFilters){
  return db.select({id:scheduledActivityId,scheduledJobId:jobs.id,
    occurredAt:sql<number>`${mail.dispatchStartedAt}`.mapWith(Number)})
    .from(jobs).innerJoin(mail,scheduledGmailReceiptJoin)
    .where(and(eq(jobs.workspaceId,workspaceId),eq(jobs.contactId,contactId),confirmedScheduledGmailReceipt,
      query?occurredWithin(mail.dispatchStartedAt,query):undefined,
      query?.afterAt===undefined?undefined:sql`(${mail.dispatchStartedAt},${scheduledActivityId}) < (${query.afterAt},${query.afterId}::uuid)`))
    .orderBy(desc(mail.dispatchStartedAt),desc(scheduledActivityId));
}

export async function readPortableOutreach(db:Db,actorId:string,query:PortableOutreachQuery&PortableActivityFilters){
  return db.transaction(async tx=>{
    const {contactId,workspaceId}=query;
    const contact=await visibleContactScope(tx,actorId,contactId,workspaceId,'contactOutreach');
    if(!contact)return null;
    const scope=and(eq(activities.workspaceId,contact.workspaceId),eq(activities.contactId,contactId));
    const inquiryScope=and(eq(inquiries.workspaceId,contact.workspaceId),eq(inquiries.contactId,contactId),
      isNotNull(inquiries.timelineNoteId));
    const {afterAt,afterId}=query,filtered=hasActivityFilters(query);
    // Form inquiries appear as Notes, so another channel filter excludes them.
    const formChannel=!query.channel||query.channel==='Note';
    const gmailChannel=!workspaceId&&(!query.channel||query.channel==='Email');
    const [manual,formNotes,sent]=await Promise.all([
      readActivityPage(tx,activities,scope,query,query),
      formChannel?tx.select({id:sql<string>`${inquiries.timelineNoteId}`,occurredAt:inquiries.receivedAt,
        summary:sql<string>`${inquiries.payload}->>'message'`}).from(inquiries).where(and(inquiryScope,
        occurredWithin(inquiries.receivedAt,query),
        afterAt===undefined?undefined:sql`(${inquiries.receivedAt},${inquiries.timelineNoteId}) < (${afterAt},${afterId}::uuid)`))
        .orderBy(desc(inquiries.receivedAt),desc(inquiries.timelineNoteId)).limit(pageSize+1):[],
      gmailChannel?readScheduledGmailTimeline(tx,contact.workspaceId,contactId,query).limit(pageSize+1):[],
    ]);
    const newest=afterAt===undefined&&!filtered;
    if(!formNotes.length&&!sent.length&&newest)return {...manual,items:manual.items as TimelineItem[]};
    const [latestForm,latestSent]=newest?[formNotes[0],sent[0]]:await Promise.all([
      tx.select({occurredAt:inquiries.receivedAt}).from(inquiries).where(inquiryScope)
        .orderBy(desc(inquiries.receivedAt),desc(inquiries.timelineNoteId)).limit(1).then(rows=>rows[0]),
      workspaceId?undefined:readScheduledGmailTimeline(tx,contact.workspaceId,contactId).limit(1).then(rows=>rows[0]),
    ]);
    const combined:TimelineItem[]=[
      ...manual.items,...formNotes.map(note=>({...note,kind:'Note' as const,revision:1,fromInquiry:true as const})),
      ...sent.map(email=>({...email,kind:'Email' as const,revision:1,fromScheduledGmail:true as const,summary:'Gmail accepted this scheduled email.'})),
    ];
    // UUID text order matches Postgres UUID order for canonical UUIDs.
    combined.sort((a,b)=>b.occurredAt-a.occurredAt||(a.id<b.id?1:a.id>b.id?-1:0));
    const items=combined.slice(0,pageSize),last=items.at(-1);
    const more=combined.length>pageSize||manual.next!==null;
    const lastContacted=Math.max(manual.lastContacted??0,latestSent?.occurredAt??0)||null;
    const lastActivity=Math.max(manual.lastActivity??0,latestForm?.occurredAt??0,latestSent?.occurredAt??0)||null;
    return {items,lastContacted,lastActivity,next:more&&last?{at:last.occurredAt,id:last.id}:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

const homes={companies,deals};
// Archived Companies and Deals keep their timeline, hidden until restore.
const activeHome=(kind:'companies'|'deals')=>kind==='companies'?activeCompany:activeDeal;
function activityHome(kind:PortableRecordActivityQuery['kind']){
  return kind==='companies'?recordActivities.companyId:recordActivities.dealId;
}

async function visibleRecordActivityScope(db:Db,actorId:string,query:PortableRecordActivityQuery){
  const home=homes[query.kind];
  const [record]=await db.select({workspaceId:home.workspaceId}).from(home)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,home.workspaceId))
    .where(and(query.workspaceId?ownedRecordScope(db,actorId,query.workspaceId,home,'view','recordActivities'):recordWorkspaceScope(db,actorId),eq(home.id,query.recordId),activeHome(query.kind))).limit(1);
  return record;
}

export async function readPortableRecordActivity(db:Db,actorId:string,query:PortableRecordActivityQuery&PortableActivityFilters){
  return db.transaction(async tx=>{
    const record=await visibleRecordActivityScope(tx,actorId,query);
    if(!record)return null;
    const scope=and(eq(recordActivities.workspaceId,record.workspaceId),eq(activityHome(query.kind),query.recordId));
    return readActivityPage(tx,recordActivities,scope,query,query);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function readPortableActivityRemovals(db:Db,actorId:string,query:PortableLoggedActivityQuery){
  return db.transaction(async tx=>{
    const contact='contactId' in query;
    const record=contact?await visibleContactScope(tx,actorId,query.contactId,query.workspaceId,'contactOutreach'):
      await visibleRecordActivityScope(tx,actorId,query);
    if(!record)return null;
    const {afterAt,afterId}=query;
    const rows=await tx.select({id:removals.id,kind:removals.kind,removedAt:removals.removedAt,removedBy:removals.removedBy})
      .from(removals).where(and(eq(removals.workspaceId,record.workspaceId),eq(removals.recordKind,contact?'contacts':query.kind),
        eq(removals.recordId,contact?query.contactId:query.recordId),
        afterAt===undefined?undefined:sql`(${removals.removedAt},${removals.id}) < (${afterAt},${afterId}::uuid)`))
      .orderBy(desc(removals.removedAt),desc(removals.id)).limit(pageSize+1);
    const items=rows.slice(0,pageSize),last=items.at(-1);
    return {items,next:rows.length>pageSize&&last?{at:last.removedAt,id:last.id}:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

function sameActivity(a:PortableOutreach,b:PortableOutreach){
  return a.kind===b.kind&&a.occurredAt===b.occurredAt&&a.summary===b.summary;
}

type ActivityHome={kind:'contacts'|'companies'|'deals';recordId:string};
function activitySource(query:Pick<PortableOutreachQuery,'contactId'>|Pick<PortableRecordActivityQuery,'kind'|'recordId'>){
  if('contactId' in query)return {
    home:{kind:'contacts',recordId:query.contactId} as const,table:activities,homeId:activities.contactId,
    historyId:history.contactActivityId,
  };
  return {home:{kind:query.kind,recordId:query.recordId},table:recordActivities,homeId:activityHome(query.kind),
    historyId:history.recordActivityId};
}

export function readPortableActivityHistory(db:Db,actorId:string,query:PortableActivityHistoryQuery){
  return db.transaction(async tx=>{
    const {home,table,homeId,historyId}=activitySource(query);
    const contact=home.kind==='contacts';
    const record=home.kind==='contacts'?await visibleContactScope(tx,actorId,home.recordId,query.workspaceId,'contactOutreach'):
      await visibleRecordActivityScope(tx,actorId,{...query,kind:home.kind,recordId:home.recordId});
    if(!record)return null;
    // Shared history covers manual logs. Previous Gmail excerpts stay with the owner.
    const manualOnly=query.workspaceId&&contact?manualContactActivity:undefined;
    const [activity]=await tx.select({workspaceId:table.workspaceId}).from(table)
      .where(and(eq(table.workspaceId,record.workspaceId),eq(table.id,query.history),eq(homeId,home.recordId),manualOnly)).limit(1);
    if(!activity)return null;
    const rows=await tx.select({revision:history.revision,editorName:history.editorName,editedAt:history.editedAt,
      previousAt:history.previousAt,previousSummary:history.previousSummary,occurredAt:history.occurredAt,summary:history.summary})
      .from(history).where(and(eq(history.workspaceId,activity.workspaceId),eq(historyId,query.history),
        query.before===undefined?undefined:lt(history.revision,query.before)))
      .orderBy(desc(history.revision)).limit(pageSize+1);
    const items=rows.slice(0,pageSize);
    return {items,next:rows.length>pageSize?items.at(-1)!.revision:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

const namespace=(home:ActivityHome)=>home.kind==='contacts'?'contact':'record';
const creationFingerprint=(author:string,home:ActivityHome,input:PortableOutreach)=>
  digest(JSON.stringify([author,home.kind,home.recordId,input.kind,input.occurredAt,input.summary]));

async function originalCreate(db:Db,workspaceId:string,actorId:string,home:ActivityHome,input:PortableOutreach,present:boolean){
  const [receipt]=await db.select({fingerprint:receipts.fingerprint}).from(receipts)
    .where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.namespace,namespace(home)),eq(receipts.id,input.id))).limit(1);
  if(!receipt)return present?'conflict':undefined;
  if(receipt.fingerprint!==await creationFingerprint(actorId,home,input))return 'conflict';
  return present?'replayed':'gone';
}

export function logPortableOutreach(db:Db,actorId:string,contactId:string,input:PortableOutreach,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,'contactOutreach',true,true);
    if(!workspaceId)return shared?'access':'missing';
    const [contact]=await tx.select({id:contacts.id,formNote:sql<boolean>`EXISTS (
      SELECT 1 FROM ${inquiries} WHERE ${inquiries.workspaceId}=${workspaceId}
      AND ${inquiries.contactId}=${contactId} AND ${inquiries.timelineNoteId}=${input.id}
    )`}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contactId),activeContact,
        shared?ownedRecordScope(tx,actorId,workspaceId,contacts,'edit'):undefined));
    if(!contact)return 'missing';
    if(contact.formNote)return 'conflict';
    const [existing]=await tx.select().from(activities)
      .where(and(eq(activities.workspaceId,workspaceId),eq(activities.id,input.id)));
    if(existing?.revision===1){
      return existing.actorId===actorId&&existing.contactId===contactId&&sameActivity(existing,input)?'replayed':'conflict';
    }
    const original=await originalCreate(tx,workspaceId,actorId,{kind:'contacts',recordId:contactId},input,!!existing);
    if(original)return original;
    const recordedAt=await jobClock(tx);
    if(input.occurredAt>recordedAt)return 'future';
    await tx.insert(activities).values({...input,workspaceId,contactId,actorId,recordedAt});
    return 'created';
  });
}

export function logPortableRecordActivity(db:Db,actorId:string,{kind,recordId}:PortableRecordActivityQuery,input:PortableOutreach,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,'recordActivities',true,true);
    if(!workspaceId)return shared?'access':'missing';
    const home=homes[kind];
    const [record]=await tx.select({id:home.id}).from(home).where(and(eq(home.workspaceId,workspaceId),eq(home.id,recordId),activeHome(kind),
      shared?ownedRecordScope(tx,actorId,workspaceId,home,'edit'):undefined)).limit(1);
    if(!record)return 'missing';
    const [existing]=await tx.select().from(recordActivities)
      .where(and(eq(recordActivities.workspaceId,workspaceId),eq(recordActivities.id,input.id)));
    const homeLink=kind==='companies'?{companyId:recordId,dealId:null}:{companyId:null,dealId:recordId};
    if(existing?.revision===1){
      return existing.actorId===actorId&&existing.companyId===homeLink.companyId&&existing.dealId===homeLink.dealId&&
        sameActivity(existing,input)?'replayed':'conflict';
    }
    const original=await originalCreate(tx,workspaceId,actorId,{kind,recordId},input,!!existing);
    if(original)return original;
    const recordedAt=await jobClock(tx);
    if(input.occurredAt>recordedAt)return 'future';
    await tx.insert(recordActivities).values({...input,workspaceId,...homeLink,actorId,recordedAt});
    return 'created';
  });
}

export function mutatePortableActivity(db:Db,actor:{userId:string;displayName:string},query:PortableLoggedActivityQuery,
  input:PortableActivityMutation,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const {home,table,homeId}=activitySource(query),contactActivity=home.kind==='contacts';
    const workspaceId=await lockRecordWorkspace(tx,actor.userId,false,shared,contactActivity?'contactOutreach':'recordActivities',true,true);
    if(!workspaceId)return shared?'access':'missing';
    const records=home.kind==='contacts'?contacts:homes[home.kind];
    const [record]=await tx.select({id:records.id}).from(records)
      .where(and(eq(records.workspaceId,workspaceId),eq(records.id,home.recordId),contactActivity?activeContact:activeHome(home.kind),
        shared?ownedRecordScope(tx,actor.userId,workspaceId,records,'edit'):undefined));
    if(!record)return 'missing';
    const scope=and(eq(table.workspaceId,workspaceId),eq(homeId,home.recordId),eq(table.id,input.id),
      shared&&contactActivity?manualContactActivity:undefined);
    const [existing]=await tx.select({id:table.id,revision:table.revision,actorId:table.actorId,
      kind:table.kind,occurredAt:table.occurredAt,summary:table.summary}).from(table).where(scope).limit(1);
    if(!existing)return 'missing';
    if(existing.revision!==input.expectedRevision)return 'stale';
    const editedAt=input.action==='update'?await jobClock(tx):0;
    if(input.action==='update'){
      if(input.occurredAt>editedAt)return 'future';
      if(input.summary.length>portableOutreachSummaryLimit){
        const [source]=home.kind==='contacts'?await tx.select({gmail:gmailSource}).from(activities).where(scope).limit(1):[];
        if(!source?.gmail)return 'too_long';
      }
      if(existing.occurredAt===input.occurredAt&&existing.summary===input.summary)return 'unchanged';
    }

    // Manual logs need a receipt before their first change. A provider log
    // may already have a source-specific receipt that must survive edits and removal.
    if(existing.revision===1){
      await tx.insert(receipts).values({workspaceId,namespace:namespace(home),id:existing.id,
        fingerprint:await creationFingerprint(existing.actorId,home,existing)}).onConflictDoNothing();
    }
    if(input.action==='remove'){
      if(shared)await tx.insert(removals).values({workspaceId,recordKind:home.kind,recordId:home.recordId,id:input.id,
        kind:existing.kind,removedAt:await jobClock(tx),removedById:actor.userId,removedBy:actor.displayName});
      await tx.delete(table).where(scope);
      return 'removed';
    }
    const revision=existing.revision+1;
    await tx.update(table).set({summary:input.summary,occurredAt:input.occurredAt,revision}).where(scope);
    const link=home.kind==='contacts'?{contactActivityId:input.id}:{recordActivityId:input.id};
    await tx.insert(history).values({workspaceId,...link,revision,editorId:actor.userId,editorName:actor.displayName,
      editedAt,previousAt:existing.occurredAt,previousSummary:existing.summary,occurredAt:input.occurredAt,summary:input.summary});
    return 'updated';
  });
}
