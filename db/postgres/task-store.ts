import {and,asc,desc,eq,exists,gt,isNotNull,isNull,ne,notExists,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {isPortableTaskDateView,taskLinkTarget,type PortableTaskDateView,type PortableTaskCompletionPage,type PortableTaskCompletionQuery,type PortableTaskQuery,type PortableTaskRecord,type PortableTaskWrite} from '../../lib/portable-tasks';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {NO_QUEUE} from '../../lib/task-queues';
import {normalizeTaskDeadline} from '../../lib/task-deadline';
import {taskReminderInstant} from '../../lib/portable-task-reminders';
import {ApiError} from '../../lib/api-error';
import {relativeCalendarDay,relativeDateWindow,relativeDayStart} from '../../lib/relative-date-filter';
import {normalizeTaskRepeat,taskRepeatSchema} from '../../lib/task-repeat';
import {portableTaskQueues} from './task-queue-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {activeDeal} from './deal-visibility';
import {resolvePortableDealLink} from './portable-related-deal-link';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {visibleContactScope} from './contact-store';
import {loginIdentities} from './identity-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {activeTask,portableTaskEvents,portableTaskRepeatReceipts,portableTaskSnapshot,portableTasks,taskCompletedTransition,taskEventContact} from './task-schema';
import {advanceTaskOccurrence} from './task-repeat-store';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {activeWorkspaceAssignee,assigneeLabel} from './workspace-assignee-store';

export {portableWorkspaceAssignees as listPortableTaskAssignees} from './workspace-assignee-store';

const columns={
  id:portableTasks.id,revision:portableTasks.revision,data:portableTasks.data,assigneeId:portableTasks.assigneeId,
  assigneeLabel:portableTasks.assigneeLabel,contactId:portableTasks.contactId,companyId:portableTasks.companyId,
  dealId:portableTasks.dealId,queueId:portableTasks.queueId,completedAt:portableTasks.completedAt,
  createdAt:portableTasks.createdAt,updatedAt:portableTasks.updatedAt,
};
const contactName=sql<string|null>`${contacts.data}->>'name'`;
const companyName=sql<string|null>`${companies.data}->>'name'`;
const dealName=sql<string|null>`${deals.data}->>'name'`;
const isoTime=(value:string)=>new Date(value).toISOString();
const taskRecord=(record:PortableTaskRecord,shared?:string):PortableTaskRecord=>({
  ...record,queueId:shared?null:record.queueId,completedAt:record.completedAt&&isoTime(record.completedAt),
  createdAt:isoTime(record.createdAt),updatedAt:isoTime(record.updatedAt),
});
function taskDateFilter(view:PortableTaskDateView,timeZone:string,now=new Date()){
  const date=sql`nullif(${portableTasks.data}->>'dueDate','')`;
  const instant=sql`nullif(${portableTasks.data}->>'dueAt','')`;
  const open=isNull(portableTasks.completedAt);
  // A timed deadline is stored as a canonical UTC ISO instant; a date-only task keeps its calendar date.
  if(view==='overdue')return and(open,sql`${date} IS NOT NULL AND CASE WHEN ${instant} IS NOT NULL
    THEN ${instant}<${now.toISOString()} ELSE ${date}<${relativeCalendarDay(now,timeZone)} END`);
  const {from,until}=relativeDateWindow({period:view==='today'?'today':'laterThan',days:0,timeZone},now);
  const day=and(from?sql`${date}>=${from}`:undefined,until?sql`${date}<${until}`:undefined);
  const timed=and(from?sql`${instant}>=${relativeDayStart(from,timeZone)}`:undefined,
    until?sql`${instant}<${relativeDayStart(until,timeZone)}`:undefined);
  return and(open,sql`CASE WHEN ${instant} IS NOT NULL THEN ${timed} ELSE ${day} END`);
}

export async function readPortableTasks(db:PostgresJsDatabase,actorId:string,query:PortableTaskQuery){
  const scope=recordWorkspaceScope(db,actorId,query.workspaceId);
  const unavailableAssignee=query.taskView==='unavailable-assignee'?and(
    isNull(portableTasks.completedAt),isNotNull(portableTasks.assigneeId),ne(portableTasks.assigneeId,privateWorkspaces.ownerId),
    notExists(db.select({id:workspaceViewers.viewerId}).from(workspaceViewers).where(and(
      eq(workspaceViewers.workspaceId,portableTasks.workspaceId),eq(workspaceViewers.viewerId,portableTasks.assigneeId),
      eq(workspaceViewers.role,'editor'),
    ))),
  ):undefined;
  const source=db.select({...columns,contactId:sql<string|null>`${contacts.id}`,companyId:sql<string|null>`${companies.id}`,dealId:sql<string|null>`${deals.id}`,contactName,companyName,dealName}).from(portableTasks)
    .innerJoin(privateWorkspaces,eq(portableTasks.workspaceId,privateWorkspaces.id))
    .leftJoin(contacts,and(eq(portableTasks.workspaceId,contacts.workspaceId),eq(portableTasks.contactId,contacts.id),activeContact))
    .leftJoin(companies,and(eq(portableTasks.workspaceId,companies.workspaceId),eq(portableTasks.companyId,companies.id),activeCompany))
    .leftJoin(deals,and(eq(portableTasks.workspaceId,deals.workspaceId),eq(portableTasks.dealId,deals.id),activeDeal));
  if(query.id){
    const [record]=await source.where(and(scope,activeTask,unavailableAssignee,eq(portableTasks.id,query.id))).limit(1);
    return record?taskRecord(record,query.workspaceId):null;
  }
  const linked=taskLinkTarget(query);
  const search=query.search?sql`lower(${query.search}::text COLLATE pg_catalog.pg_unicode_fast)`:undefined;
  const rows=await source.where(and(scope,activeTask,unavailableAssignee,query.after?gt(portableTasks.id,query.after):undefined,
    search?or(
      sql`strpos(lower((${portableTasks.data}->>'name') COLLATE pg_catalog.pg_unicode_fast),${search})>0`,
      sql`strpos(lower((${portableTasks.data}->>'notes') COLLATE pg_catalog.pg_unicode_fast),${search})>0`,
    ):undefined,
    query.status?eq(sql`${portableTasks.data}->>'status'`,query.status):undefined,
    query.taskPriority?eq(sql`${portableTasks.data}->>'priority'`,query.taskPriority):undefined,
    query.taskType?eq(sql`${portableTasks.data}->>'taskType'`,query.taskType):undefined,
    query.taskView==='mine'?and(eq(portableTasks.assigneeId,actorId),isNull(portableTasks.completedAt)):undefined,
    query.taskAssignee==='me'?eq(portableTasks.assigneeId,actorId):undefined,
    isPortableTaskDateView(query.taskView)?taskDateFilter(query.taskView,query.taskZone??'UTC'):undefined,
    linked?eq({contacts:contacts.id,companies:companies.id,deals:deals.id}[linked.kind],linked.id):undefined,
    query.queueId===NO_QUEUE?isNull(portableTasks.queueId):query.queueId?eq(portableTasks.queueId,query.queueId):undefined))
    .orderBy(asc(portableTasks.id)).limit(query.limit+1);
  const records=rows.slice(0,query.limit).map(record=>taskRecord(record,query.workspaceId));
  return {records,next:rows.length>query.limit?records.at(-1)!.id:null};
}

export async function readPortableTaskSuccessor(db:PostgresJsDatabase,actorId:string,predecessorId:string,workspaceId?:string){
  const [next]=await db.select({id:portableTasks.id}).from(portableTaskRepeatReceipts)
    .innerJoin(portableTasks,and(
      eq(portableTasks.workspaceId,portableTaskRepeatReceipts.workspaceId),
      eq(portableTasks.id,portableTaskRepeatReceipts.successorId),
    ))
    .innerJoin(privateWorkspaces,eq(portableTasks.workspaceId,privateWorkspaces.id))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),activeTask,
      eq(portableTaskRepeatReceipts.predecessorId,predecessorId)))
    .limit(1);
  return next?.id;
}

export async function readPortableTaskCompletions(db:PostgresJsDatabase,actorId:string,query:PortableTaskCompletionQuery):Promise<PortableTaskCompletionPage|null>{
  const {completionHistoryFor,workspaceId,limit,afterAt,afterId,afterRevision}=query;
  return db.transaction(async tx=>{
    const contact=await visibleContactScope(tx,actorId,completionHistoryFor,workspaceId);
    if(!contact)return null;
    const events=portableTaskEvents;
    const actorMembership=tx.select({id:workspaceViewers.viewerId}).from(workspaceViewers)
      .where(and(eq(workspaceViewers.workspaceId,events.workspaceId),eq(workspaceViewers.viewerId,events.actorId)));
    const rows=await tx.select({id:events.taskId,revision:events.revision,occurredAt:events.occurredAt,
      name:sql<string>`${events.data}->'fields'->>'name'`,actorName:loginIdentities.fullName})
      .from(events).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,events.workspaceId))
      .innerJoin(portableTasks,and(eq(portableTasks.workspaceId,events.workspaceId),eq(portableTasks.id,events.taskId),activeTask))
      .leftJoin(loginIdentities,and(eq(loginIdentities.id,events.actorId),
        or(eq(privateWorkspaces.ownerId,events.actorId),exists(actorMembership))))
      .where(and(eq(events.workspaceId,contact.workspaceId),eq(taskEventContact(events.data),completionHistoryFor),
        taskCompletedTransition(events.data,events.previous),afterAt===undefined?undefined:
          sql`(${events.occurredAt},${events.taskId},${events.revision}) < (${afterAt}::timestamptz,${afterId}::uuid,${afterRevision}::integer)`))
      .orderBy(desc(events.occurredAt),desc(events.taskId),desc(events.revision)).limit(limit+1);
    const items=rows.slice(0,limit).map(row=>({...row,occurredAt:isoTime(row.occurredAt)}));
    const last=items.at(-1);
    return {items,next:rows.length>limit&&last?{at:last.occurredAt,id:last.id,revision:last.revision}:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

type SaveTaskResult={record:PortableTaskRecord;nextTaskId?:string}|{error:'access'|'missing'|'stale'|'assignee_missing'|'queue_missing'|'queue_scope'|'contact_missing'|'related_missing'};

export function savePortableTask(db:PostgresJsDatabase,actorId:string,input:PortableTaskWrite,shared?:SharedRecordWriteScope):Promise<SaveTaskResult>{
  return db.transaction(async tx=>{
    // Assignment may lock another member's grant. Serialize task writes per workspace before locking grants.
    const workspaceId=await lockRecordWorkspace(tx,actorId,!('id' in input)&&!input.contactId&&!input.related,shared,undefined,true);
    const missingLink=input.contactId||input.related?.kind==='contacts'?'contact_missing':'related_missing';
    if(!workspaceId)return {error:shared?'access':'id' in input?'missing':missingLink};
    const target='id' in input?and(eq(portableTasks.workspaceId,workspaceId),eq(portableTasks.id,input.id),activeTask):undefined;
    const current=target?(await tx.select(columns).from(portableTasks).where(target).for('update'))[0]:undefined;
    if('id' in input){
      if(!current)return {error:'missing'};
      if(current.revision!==input.expectedRevision)return {error:'stale'};
    }

    const assigneeId=input.assigneeId===undefined?current?.assigneeId??null:input.assigneeId;
    let label=input.assigneeId===undefined?current?.assigneeLabel??null:null;
    if(input.assigneeId){
      const member=await activeWorkspaceAssignee(tx,workspaceId,input.assigneeId);
      if(!member)return {error:'assignee_missing'};
      label=assigneeLabel(member);
    }

    if(shared&&input.queueId!==undefined)return {error:'queue_scope'};
    const queueId=input.queueId===undefined?current?.queueId??null:input.queueId;
    if(input.queueId){
      const [queue]=await tx.select({id:portableTaskQueues.id}).from(portableTaskQueues)
        .where(and(eq(portableTaskQueues.workspaceId,workspaceId),eq(portableTaskQueues.id,input.queueId)));
      if(!queue)return {error:'queue_missing'};
    }

    const currentLink=taskLinkTarget(current??{});
    // The legacy null clears a contact without removing a newer company or deal link.
    const related=input.related!==undefined?input.related:
      input.contactId?{kind:'contacts' as const,id:input.contactId}:
      input.contactId===null&&currentLink?.kind==='contacts'?null:currentLink;
    let linkedName:string|null=null,visibleContactId:string|null=null,visibleCompanyId:string|null=null,visibleDealId:string|null=null;
    // Only `related` names a Company or Deal. A legacy contactId (including null) never re-requests a retained link.
    const requestedRecord=input.related!==undefined;
    if(related?.kind==='contacts'){
      const requested=input.related!==undefined||input.contactId!==undefined?related.id:undefined;
      const contact=await resolvePortableContactLink(tx,workspaceId,current?.contactId??null,requested);
      if(!contact)return {error:'contact_missing'};
      linkedName=contact.name;
      visibleContactId=contact.visibleId;
    }else if(related?.kind==='companies'){
      const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,requestedRecord?related.id:undefined);
      if(!company)return {error:'related_missing'};
      linkedName=company.name;
      visibleCompanyId=company.visibleId;
    }else if(related){
      const deal=await resolvePortableDealLink(tx,workspaceId,current?.dealId??null,requestedRecord?related.id:undefined);
      if(!deal)return {error:'related_missing'};
      linkedName=deal.name;
      visibleDealId=deal.visibleId;
    }
    const links={
      contactId:related?.kind==='contacts'?related.id:null,
      companyId:related?.kind==='companies'?related.id:null,
      dealId:related?.kind==='deals'?related.id:null,
    };

    const now=new Date().toISOString();
    const fields={dueDate:'',...current?.data,...input.data};
    const previous=current?.data;
    // A legacy date-clear request clears any saved time, too. An omitted date leaves it alone.
    if(input.data.dueDate===''&&input.data.dueTime===undefined)delete fields.dueTime;
    if(input.data.dueTimeOccurrence===undefined&&
      (fields.dueDate!==previous?.dueDate||fields.dueTime!==previous?.dueTime||fields.dueTimeZone!==previous?.dueTimeZone)){
      delete fields.dueTimeOccurrence;
    }
    // Canonicalize JSONB key order to preserve valid repeat anchors. A repair
    // can replace or clear a malformed legacy repeat; the new fields are still validated.
    const savedRepeat=previous?.repeat?taskRepeatSchema.safeParse(previous.repeat):undefined;
    const priorRepeat=savedRepeat?.success?{...previous,repeat:savedRepeat.data}:undefined;
    const data=normalizeTaskRepeat(normalizeTaskDeadline(fields),priorRepeat);
    if(!data.dueAt&&input.data.reminderMinutes!=null)throw new ApiError(400,'Choose a due date and time for the reminder.');
    if(!data.dueAt||data.reminderMinutes==null)delete data.reminderMinutes;
    const completedAt=data.status==='Completed'?current?.completedAt??now:null;
    const reminderAt=taskReminderInstant(data);
    const newReminder=current&&(previous?.dueAt!==data.dueAt||previous?.reminderMinutes!==data.reminderMinutes||
      current.assigneeId!==assigneeId||Boolean(current.completedAt)!==Boolean(completedAt));
    const values={data,assigneeId,assigneeLabel:label,queueId,...links,completedAt,reminderAt,
      ...(newReminder?{reminderDismissedBy:null}:{}),revision:(current?.revision??0)+1,updatedAt:now};
    const [record]=current
      ?await tx.update(portableTasks).set(values).where(target).returning(columns)
      :await tx.insert(portableTasks).values({...values,workspaceId,id:crypto.randomUUID(),createdAt:now}).returning(columns);
    await tx.insert(portableTaskEvents).values({
      workspaceId,taskId:record.id,revision:record.revision,actorId,
      previous:current?portableTaskSnapshot(current):null,data:portableTaskSnapshot(record),occurredAt:record.updatedAt,
    });
    const nextTaskId=data.repeat&&data.status==='Completed'&&previous?.status!=='Completed'
      ?await advanceTaskOccurrence(tx,workspaceId,actorId,{...record,contactId:visibleContactId,companyId:visibleCompanyId,dealId:visibleDealId},now):undefined;
    return {nextTaskId,record:taskRecord({...record,contactId:visibleContactId,companyId:visibleCompanyId,dealId:visibleDealId,
      contactName:visibleContactId?linkedName:null,companyName:visibleCompanyId?linkedName:null,dealName:visibleDealId?linkedName:null,
    },shared?.workspaceId)};
  });
}
