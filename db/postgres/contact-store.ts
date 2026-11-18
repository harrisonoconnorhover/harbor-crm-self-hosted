import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {mergePortableCustomValues} from './custom-property-store';
import {and,asc,desc,eq,gt,ilike,isNull,lt,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {ContactRecord,ContactTextWrite,ContactWrite,PortableRecordQuery} from '../../lib/portable-records';
import {readContactOutreachCursor} from '../../lib/portable-records';
import {contactEvents,contacts,privateWorkspaces} from './contact-schema';
import {companies} from './company-schema';
import type {SharedRecordWriteScope,WorkspacePermission} from '../../lib/portable-workspace-access';
import {lockRecordWorkspace} from './private-workspace-store';
import {resolvePortableRecordOwner} from './workspace-assignee-store';
import {captureWorkflowEntry} from './workflow-store';
import {recordWorkspaceScope} from './workspace-viewer-store';
import {recordOwnerFilter,recordSearchPattern} from './record-search';
import {latestContactOutreach} from './portable-external-record-store';

export async function visibleContactScope(db:PostgresJsDatabase,actorId:string,contactId:string,workspaceId?:string,permission?:WorkspacePermission){
  const [scope]=await db.select({workspaceId:contacts.workspaceId,contactId:contacts.id}).from(contacts)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,contacts.workspaceId))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId,permission),activeContact,eq(contacts.id,contactId))).limit(1);
  return scope??null;
}

const columns={id:contacts.id,revision:contacts.revision,data:contacts.data,createdAt:contacts.createdAt,
  updatedAt:contacts.updatedAt,primaryCompanyId:contacts.primaryCompanyId};
const companyName=sql<string|null>`${companies.data}->>'name'`;

export async function readContacts(db:PostgresJsDatabase,actorId:string,query:Pick<PortableRecordQuery,'id'|'after'|'limit'|'search'|'owner'|'workspaceId'|'companyId'|'sort'>){
  const scope=and(recordWorkspaceScope(db,actorId,query.workspaceId),activeContact);
  // An archived primary Company stays stored but reads as no Company until restore.
  const fields={...columns,primaryCompanyId:sql<string|null>`${companies.id}`,primaryCompanyName:companyName};
  const owned=db.select(fields).from(contacts)
    .innerJoin(privateWorkspaces,eq(contacts.workspaceId,privateWorkspaces.id))
    .leftJoin(companies,and(eq(companies.workspaceId,contacts.workspaceId),eq(companies.id,contacts.primaryCompanyId),activeCompany));
  if(query.id){
    const [record]=await owned.where(and(scope,eq(contacts.id,query.id))).limit(1);
    return record??null;
  }
  const pattern=recordSearchPattern(query.search);
  const match=pattern?or(ilike(sql`${contacts.data}->>'name'`,pattern),ilike(sql`${contacts.data}->>'email'`,pattern)):undefined;
  const filters=and(scope,match,recordOwnerFilter(db,contacts.data,actorId,query.owner),query.companyId?eq(companies.id,query.companyId):undefined);
  if(query.sort){
    // Without outreach access the lateral join returns no dates, including for ordering and cursors.
    const latest=latestContactOutreach(db,{permission:recordWorkspaceScope(db,actorId,query.workspaceId,'contactOutreach'),
      includeScheduledGmail:query.workspaceId===undefined});
    const outreachAt=sql`${latest.at}`;
    const cursor=query.after?readContactOutreachCursor(query.after):undefined;
    const newest=query.sort==='outreach-newest';
    const after=cursor?(cursor.at===null?and(isNull(outreachAt),gt(contacts.id,cursor.id)):
      or(isNull(outreachAt),(newest?lt:gt)(outreachAt,cursor.at),and(eq(outreachAt,cursor.at),gt(contacts.id,cursor.id)))):undefined;
    const rows=await db.select({record:fields,outreachAt:latest.at}).from(contacts)
      .innerJoin(privateWorkspaces,eq(contacts.workspaceId,privateWorkspaces.id))
      .leftJoin(companies,and(eq(companies.workspaceId,contacts.workspaceId),eq(companies.id,contacts.primaryCompanyId),activeCompany))
      .leftJoinLateral(latest,sql`true`).where(and(filters,after))
      .orderBy(sql`${(newest?desc:asc)(outreachAt)} NULLS LAST`,asc(contacts.id)).limit(query.limit+1);
    const page=rows.slice(0,query.limit),last=page.at(-1);
    return {records:page.map(row=>row.record),next:rows.length>query.limit&&last?`${last.record.id}:${last.outreachAt??'none'}`:null};
  }
  const rows=await owned.where(and(filters,query.after?gt(contacts.id,query.after):undefined))
    .orderBy(asc(contacts.id)).limit(query.limit+1);
  const records=rows.slice(0,query.limit);
  return {records,next:rows.length>query.limit?records.at(-1)!.id:null};
}

type SaveResult={record:ContactRecord}|{error:'missing'|'stale'|'access'|'company_missing'|'assignee_missing'};

export function saveContact(db:PostgresJsDatabase,actorId:string,input:ContactWrite|ContactTextWrite,shared?:SharedRecordWriteScope,
  {gmailSender,captureWorkflows=true}:{gmailSender?:string;captureWorkflows?:boolean}={}):Promise<SaveResult>{
  return db.transaction(async tx=>{
    const creating=!('id' in input);
    // Contact admission and future archive/restore checks serialize on the same workspace row.
    const workspaceId=await lockRecordWorkspace(tx,actorId,creating&&!input.primaryCompanyId,shared,undefined,true);
    if(!workspaceId)return {error:shared?'access':creating?'company_missing':'missing'};
    const target='id' in input?and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,input.id),activeContact):undefined;
    const current=target?(await tx.select(columns).from(contacts).where(target).for('update'))[0]:undefined;
    if('id' in input){
      if(!current)return {error:'missing'};
      if(current.revision!==input.expectedRevision)return {error:'stale'};
    }
    const before='id' in input?current?.data:input.data;
    if(!before)return {error:'missing'};
    const company=await resolvePortableCompanyLink(tx,workspaceId,current?.primaryCompanyId??null,input.primaryCompanyId);
    if(!company)return {error:'company_missing'};
    const primaryCompanyId=company.id,primaryCompanyName=company.name;
    const recordOwner=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId,current?.data.recordOwner);
    if(recordOwner===false)return {error:'assignee_missing'};
    const now=new Date().toISOString();
    const {custom,...patch}=input.data;
    const data={...before,...patch,recordOwner,custom:await mergePortableCustomValues(tx,workspaceId,'contacts',custom,current?.data.custom)};
    const [saved]=current
      ?await tx.update(contacts).set({data,primaryCompanyId,revision:current.revision+1,updatedAt:now}).where(target).returning(columns)
      :await tx.insert(contacts).values({workspaceId,id:crypto.randomUUID(),revision:1,data,primaryCompanyId,createdAt:now,updatedAt:now}).returning(columns);
    await tx.insert(contactEvents).values({
      workspaceId,contactId:saved.id,revision:saved.revision,actorId,previous:current?.data??null,data:saved.data,
      previousPrimaryCompanyId:current?.primaryCompanyId??null,primaryCompanyId,occurredAt:saved.updatedAt,
    });
    if(captureWorkflows){
      if(!current){
        await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'contact_created',id:saved.id,revision:saved.revision,lifecycle:saved.data.lifecycle});
      }else if(current.data.lifecycle!==saved.data.lifecycle){
        await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'contact_lifecycle',id:saved.id,revision:saved.revision,lifecycle:saved.data.lifecycle,email:saved.data.email},gmailSender);
      }
      if(current&&recordOwner&&current.data.recordOwner?.userId!==recordOwner.userId){
        await captureWorkflowEntry(tx,workspaceId,actorId,{kind:'contact_owner_assigned',id:saved.id,revision:saved.revision,
          lifecycle:saved.data.lifecycle});
      }
    }
    return {record:{...saved,primaryCompanyId:company.visibleId,primaryCompanyName}};
  });
}
