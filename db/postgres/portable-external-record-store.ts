import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,asc,desc,eq,gt,inArray,isNotNull,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {outreachActivityTypes} from '../../lib/activity-date-policy';
import {contacts,privateWorkspaces} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import type {PortableExternalRecordKind} from '../../lib/portable-api-tokens';
import {portableContactActivities as activities} from './portable-contact-activity-schema';
import {leadInquiries as inquiries} from './lead-form-schema';
import {portableLeads as leads} from './portable-lead-schema';
import {activeTask,portableTasks as tasks} from './task-schema';
import {portableTickets as tickets} from './ticket-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {portableJobs as jobs} from './job-schema';
import {scheduledGmail} from './scheduled-gmail-schema';
import {confirmedScheduledGmailReceipt,scheduledGmailReceiptJoin} from './confirmed-scheduled-gmail';

const date=(value:number|null)=>value===null?null:new Date(value).toISOString();

const privateExternalTables={tasks,leads,tickets};
const externalTables={contacts,companies,deals,...privateExternalTables};
const normalize=(row:{id:string;data:object;createdAt:string;updatedAt:string})=>({...row,
  createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()});

function externalSelection(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind){
  const table=externalTables[kind];
  // A record scope excludes assignees, queues and other linked records. Ticket owner is stored in the JSON.
  const data=kind==='tickets'?sql<Omit<typeof tickets.$inferSelect.data,'owner'>>`${tickets.data} - 'owner'`:table.data;
  const source=db.select({id:table.id,data,createdAt:table.createdAt,updatedAt:table.updatedAt}).from(table);
  return {source,scope:and(eq(table.workspaceId,workspaceId),kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:kind==='tasks'?activeTask:undefined),recordId:table.id};
}

export async function readExternalRecordBatch(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,ids:string[]){
  const {source,scope,recordId}=externalSelection(db,workspaceId,kind);
  const rows=await source.where(and(scope,inArray(recordId,ids)));
  return Object.hasOwn(privateExternalTables,kind)?rows.map(normalize):rows;
}

export async function readExternalPrivateRecords(db:PostgresJsDatabase,workspaceId:string,
  kind:keyof typeof privateExternalTables,{id,after,limit}:{id?:string;after?:string;limit:number},
){
  const {source,scope,recordId}=externalSelection(db,workspaceId,kind);
  if(id){
    const [record]=await source.where(and(scope,eq(recordId,id))).limit(1);
    return record?normalize(record):null;
  }
  const rows=await source.where(and(scope,after?gt(recordId,after):undefined)).orderBy(asc(recordId)).limit(limit+1);
  const records=rows.slice(0,limit).map(normalize);
  return {records,next:rows.length>limit?records.at(-1)!.id:null};
}

const contactActivityScope=and(eq(activities.workspaceId,contacts.workspaceId),eq(activities.contactId,contacts.id));
export function latestContactOutreach(db:PostgresJsDatabase,{permission,includeScheduledGmail=false}:
  {permission?:SQL;includeScheduledGmail?:boolean}={}){
  const logged=db.select({at:activities.occurredAt}).from(activities)
    .where(and(contactActivityScope,inArray(activities.kind,outreachActivityTypes),permission))
    .orderBy(desc(activities.occurredAt)).limit(1);
  if(!includeScheduledGmail)return logged.as('latest_outreach');

  const sent=db.select({at:scheduledGmail.dispatchStartedAt}).from(jobs).innerJoin(scheduledGmail,scheduledGmailReceiptJoin)
    .where(and(eq(jobs.workspaceId,contacts.workspaceId),eq(jobs.contactId,contacts.id),confirmedScheduledGmailReceipt,permission))
    .orderBy(desc(scheduledGmail.dispatchStartedAt)).limit(1);
  const at=sql`greatest((${logged}),(${sent}))`.mapWith(activities.occurredAt).as('outreach_at');
  return db.select({at}).from(sql`(values (1)) as outreach_projection`).as('latest_outreach');
}

export async function readPortableLastContacted(db:PostgresJsDatabase,actorId:string,ids:string[],workspaceId?:string):Promise<Record<string,string|null>>{
  if(!ids.length)return {};
  const contacted=latestContactOutreach(db,{includeScheduledGmail:workspaceId===undefined});
  const rows=await db.select({id:contacts.id,at:contacted.at}).from(contacts)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,contacts.workspaceId))
    .leftJoinLateral(contacted,sql`true`)
    .where(and(recordWorkspaceScope(db,actorId,workspaceId,'contactOutreach'),inArray(contacts.id,ids),activeContact));
  return Object.fromEntries(rows.map(row=>[row.id,date(row.at)]));
}

export async function readExternalContactDates(db:PostgresJsDatabase,workspaceId:string,ids:string[]){
  if(!ids.length)return new Map<string,{lastContacted:string|null;lastActivity:string|null}>();
  const latest=db.select({at:activities.occurredAt}).from(activities)
    .where(contactActivityScope).orderBy(desc(activities.occurredAt)).limit(1).as('latest_activity');
  const contacted=latestContactOutreach(db);
  const latestInquiry=db.select({at:inquiries.receivedAt}).from(inquiries)
    .where(and(eq(inquiries.workspaceId,contacts.workspaceId),eq(inquiries.contactId,contacts.id),
      isNotNull(inquiries.timelineNoteId))).orderBy(desc(inquiries.receivedAt)).limit(1).as('latest_inquiry');
  const rows=await db.select({id:contacts.id,lastContacted:contacted.at,
    lastActivity:sql`greatest(${latest.at},${latestInquiry.at})`.mapWith(activities.occurredAt)}).from(contacts)
    .leftJoinLateral(latest,sql`true`).leftJoinLateral(contacted,sql`true`)
    .leftJoinLateral(latestInquiry,sql`true`)
    .where(and(eq(contacts.workspaceId,workspaceId),inArray(contacts.id,ids),activeContact));
  return new Map(rows.map(row=>[row.id,{lastContacted:date(row.lastContacted),lastActivity:date(row.lastActivity)}]));
}
