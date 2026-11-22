import {ApiError} from '../../lib/api-error';
import {recordUpdatedKey} from './record-updated-key';
import {hiddenStandardFields} from './standard-property-access';
import {listTokenCustomProperties} from './custom-property-store';
import {portableExternalStandardFields} from '../../lib/portable-api-tokens';
import {visibleRecordData} from './record-property-access';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,asc,desc,eq,gt,inArray,isNotNull,sql,type SQL,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {outreachActivityTypes} from '../../lib/activity-date-policy';
import {contacts,privateWorkspaces} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import type {PortableRecordWindow,PortableExternalRecordKind} from '../../lib/portable-api-tokens';
import {portableContactActivities as activities} from './portable-contact-activity-schema';
import {leadInquiries as inquiries} from './lead-form-schema';
import {activeLead,portableLeads as leads} from './portable-lead-schema';
import {activeTask,portableTasks as tasks} from './task-schema';
import {activeTicket,portableTickets as tickets} from './ticket-schema';
import {ownedRecordScope} from './record-ownership-scope';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {recordDeletions} from './portable-api-token-schema';
import {portableJobs as jobs} from './job-schema';
import {scheduledGmail} from './scheduled-gmail-schema';
import {confirmedScheduledGmailReceipt,scheduledGmailReceiptJoin} from './confirmed-scheduled-gmail';

const date=(value:number|null)=>value===null?null:new Date(value).toISOString();

const privateExternalTables={tasks,leads,tickets};
const externalTables={contacts,companies,deals,...privateExternalTables};
const normalize=(row:{id:string;revision:number;data:object;createdAt:string;updatedAt:string})=>({...row,
  createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()});

function externalSelection(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind){
  const table=externalTables[kind];
  // A record scope excludes assignees, queues and other linked records. Ticket owner is stored in the JSON.
  const data=kind==='tickets'?sql<Omit<typeof tickets.$inferSelect.data,'owner'>>`${tickets.data} - 'owner'`:(kind==='deals'||kind==='contacts'||kind==='companies')?visibleRecordData(table.data,workspaceId,kind,null):table.data;
  const source=db.select({id:table.id,revision:table.revision,data,createdAt:table.createdAt,updatedAt:table.updatedAt}).from(table);
  return {source,scope:and(eq(table.workspaceId,workspaceId),kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:kind==='tasks'?activeTask:kind==='leads'?activeLead:activeTicket),recordId:table.id};
}

export async function readExternalProperties(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind){
  const standard=Object.keys(portableExternalStandardFields[kind]);
  if(kind!=='contacts'&&kind!=='companies'&&kind!=='deals')return {object:kind,standardProperties:standard,customProperties:[]};
  const hidden=new Set((await db.execute<{id:string}>(hiddenStandardFields(workspaceId,kind,null))).map(row=>row.id));
  return {object:kind,standardProperties:standard.filter(key=>!hidden.has(key)),customProperties:await listTokenCustomProperties(db,workspaceId,kind)};
}

// Include archived IDs when guarding creation so a retry cannot resurrect a recycled record.
export async function lockExternalRecord(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,id:string){
  const table=externalTables[kind];
  const [row]=await db.select({revision:table.revision}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),eq(table.id,id))).for('update');
  return row;
}

function recordWindowFilter(key:SQL,recordId:SQLWrapper,page:PortableRecordWindow){
  const utc=(value:string)=>sql`(${value}::timestamptz AT TIME ZONE 'UTC')`;
  return and(sql`${key}>=${utc(page.since)} AND ${key}<${utc(page.before)}`,
    page.afterAt?sql`(${key},${recordId})>(${utc(page.afterAt)},${page.after}::uuid)`:undefined);
}

export async function readExternalDeletions(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,page:PortableRecordWindow){
  const {recordId,deletedAt}=recordDeletions;
  const rows=await db.select({id:recordId,deletedAt}).from(recordDeletions)
    .where(and(eq(recordDeletions.workspaceId,workspaceId),eq(recordDeletions.objectKind,kind),
      recordWindowFilter(sql`${deletedAt}`,recordId,page)))
    .orderBy(asc(deletedAt),asc(recordId)).limit(page.limit+1);
  const results=rows.slice(0,page.limit).map(row=>({id:row.id,object:kind,deletedAt:row.deletedAt.toISOString()})),last=results.at(-1);
  return {results,next:rows.length>page.limit&&last?{after:last.id,afterDeletedAt:last.deletedAt}:null};
}

export async function readExternalArchives(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,
  {id,after,limit,ids,window}:{id?:string;after?:string;limit:number;ids?:string[];window?:PortableRecordWindow}){
  const table=externalTables[kind];
  const key=recordUpdatedKey(table.archivedAt);
  const rows=await db.select({id:table.id,archivedAt:table.archivedAt}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),isNotNull(table.archivedAt),
      id?eq(table.id,id):undefined,ids?inArray(table.id,ids):undefined,window?recordWindowFilter(key,table.id,window):after?gt(table.id,after):undefined))
    .orderBy(...(window?[asc(key),asc(table.id)]:[asc(table.id)])).limit(id?1:limit+1);
  const results=rows.slice(0,limit).map(row=>({id:row.id,object:kind,archivedAt:new Date(row.archivedAt!).toISOString()}));
  const last=results.at(-1);
  return {results,next:rows.length>limit&&last?{after:last.id,...window&&{afterArchivedAt:last.archivedAt}}:null};
}

export async function matchExternalIdentifiers(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,
  property:'email'|'domain'|`custom:${string}`,values:string[]){
  const table=externalTables[kind];
  let matchesValue:SQL;
  if(property==='email'||property==='domain'){
    const key=property==='email'?sql`lower(r.data->>'email')`:sql`lower(r.data->>'domain')`;
    matchesValue=sql`${key}=lower(v.identifier)`;
  }else{
    const fieldId=property.slice(7);
    const fields=kind==='contacts'||kind==='companies'||kind==='deals'?await listTokenCustomProperties(db,workspaceId,kind):[];
    if(!fields.some(field=>field.id===fieldId&&field.type==='text'))
      throw new ApiError(400,'Choose a readable single-line text property for identifier lookup.');
    matchesValue=sql`(r.data->'custom') IS NOT NULL AND (r.data->'custom') @> jsonb_build_object(${fieldId}::text,v.identifier)`;
  }
  // Two hits are enough to distinguish an ambiguous key, even on a heavily duplicated import.
  const rows=await db.execute<{identifier:string;id:string}>(sql`
    SELECT v.identifier, hit.id FROM (VALUES ${sql.join(values.map(value=>sql`(${value}::text)`),sql`,`)}) v(identifier)
    CROSS JOIN LATERAL (SELECT r.id FROM ${table} r WHERE r.workspace_id=${workspaceId} AND r.archived_at IS NULL
      AND ${matchesValue} LIMIT 2) hit`);
  const matches=new Map<string,string|null>();
  for(const row of rows)matches.set(row.identifier,matches.has(row.identifier)?null:row.id);
  return matches;
}

export async function readExternalRecordBatch(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,ids:string[]){
  const {source,scope,recordId}=externalSelection(db,workspaceId,kind);
  const rows=await source.where(and(scope,inArray(recordId,ids)));
  return Object.hasOwn(privateExternalTables,kind)?rows.map(normalize):rows;
}

export async function readExternalUpdatedRecords(db:PostgresJsDatabase,workspaceId:string,kind:PortableExternalRecordKind,page:PortableRecordWindow){
  const {source,scope,recordId}=externalSelection(db,workspaceId,kind);
  const key=recordUpdatedKey(externalTables[kind].updatedAt);
  const rows=await source.where(and(scope,recordWindowFilter(key,recordId,page)))
    .orderBy(asc(key),asc(recordId)).limit(page.limit+1);
  const items=rows.slice(0,page.limit),last=items.at(-1);
  return {records:Object.hasOwn(privateExternalTables,kind)?items.map(normalize):items,
    next:rows.length>page.limit&&last?{after:last.id,afterUpdatedAt:new Date(last.updatedAt).toISOString()}:null};
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
    .where(and(workspaceId?ownedRecordScope(db,actorId,workspaceId,contacts,'view','contactOutreach'):recordWorkspaceScope(db,actorId),inArray(contacts.id,ids),activeContact));
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
