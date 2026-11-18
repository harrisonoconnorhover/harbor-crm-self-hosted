import {and,asc,desc,eq,gt,ilike,isNull,lt,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {leadStageFor} from '../../lib/lead-pipelines';
import type {LeadHistory,LeadPage,LeadQuery,LeadRecord,LeadSnapshot,LeadWrite} from '../../lib/portable-leads';
import {stages} from '../../lib/crm';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {saveDealInTransaction} from './deal-store';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {portableLeadEvents as events,portableLeads as leads} from './portable-lead-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';
import {resolvePortableRecordOwner} from './workspace-assignee-store';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';

const columns={id:leads.id,revision:leads.revision,data:leads.data,contactId:leads.contactId,companyId:leads.companyId,
  dealId:leads.dealId,assigneeId:leads.assigneeId,assigneeLabel:leads.assigneeLabel,createdAt:leads.createdAt,updatedAt:leads.updatedAt};
const contactName=sql<string|null>`${contacts.data}->>'name'`;
const companyName=sql<string|null>`${companies.data}->>'name'`;
const historySize=20;
type SavedLead=Required<LeadSnapshot> & {id:string;revision:number};
const snapshot=({data,contactId,companyId,dealId,assigneeId,assigneeLabel}:Required<LeadSnapshot>):LeadSnapshot=>
  ({data,contactId,companyId,dealId,assigneeId,assigneeLabel});

function leadOwnerFilter(actorId:string,owner:LeadQuery['owner']){
  if(!owner)return undefined;
  return owner==='unassigned'?isNull(leads.assigneeId):eq(leads.assigneeId,actorId);
}
type LeadTransaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

async function writePortableLeadEvent(tx:LeadTransaction,workspaceId:string,actorId:string,
  current:SavedLead|undefined,saved:SavedLead,occurredAt:string){
  await tx.insert(events).values({workspaceId,leadId:saved.id,revision:saved.revision,actorId,
    previous:current?snapshot(current):null,data:snapshot(saved),occurredAt});
}

export async function movePortableLeadLinks(tx:LeadTransaction,workspaceId:string,actorId:string,
  link:'contactId'|'companyId',from:string,to:string,now:string){
  const scoped=and(eq(leads.workspaceId,workspaceId),eq(leads[link],from));
  const records=await tx.select(columns).from(leads).where(scoped).orderBy(asc(leads.id)).for('update');
  for(const current of records){
    const revision=current.revision+1;
    await tx.update(leads).set({[link]:to,revision,updatedAt:now})
      .where(and(eq(leads.workspaceId,workspaceId),eq(leads.id,current.id)));
    await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,[link]:to,revision},now);
  }
  return records.length;
}

export async function readPortableLeadHistory(db:PostgresJsDatabase,actorId:string,
  {id,workspaceId,before}:{id:string;workspaceId?:string;before?:number}):Promise<LeadHistory|null>{
  const rows=await db.select({revision:events.revision,actorName:loginIdentities.fullName,occurredAt:events.occurredAt,
    previous:events.previous,data:events.data}).from(leads)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,leads.workspaceId))
    .leftJoin(events,and(eq(events.workspaceId,leads.workspaceId),eq(events.leadId,leads.id),
      before?lt(events.revision,before):undefined))
    .leftJoin(loginIdentities,eq(loginIdentities.id,events.actorId))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),eq(leads.id,id)))
    .orderBy(desc(events.revision)).limit(historySize+1);
  if(!rows.length)return null;
  const unassigned={assigneeId:null,assigneeLabel:null};
  const entries=rows.slice(0,historySize).flatMap(row=>row.revision!==null&&row.occurredAt&&row.data?
    [{...row,revision:row.revision,occurredAt:new Date(row.occurredAt).toISOString(),
      previous:row.previous&&{...unassigned,...row.previous},data:{...unassigned,...row.data}}]:[]);
  return {entries,next:rows.length>historySize?entries.at(-1)!.revision:null};
}

export async function readPortableLeads(db:PostgresJsDatabase,actorId:string,query:LeadQuery):Promise<LeadPage|LeadRecord|null>{
  const selection=db.select({...columns,contactId:sql<string|null>`${contacts.id}`,companyId:sql<string|null>`${companies.id}`,contactName,companyName,
    dealArchived:sql<boolean>`EXISTS (SELECT 1 FROM ${deals} WHERE ${deals.workspaceId}=${leads.workspaceId} AND ${deals.id}=${leads.dealId} AND ${deals.archivedAt} IS NOT NULL)`}).from(leads)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,leads.workspaceId))
    .leftJoin(companies,and(eq(companies.workspaceId,leads.workspaceId),eq(companies.id,leads.companyId),activeCompany))
    .leftJoin(contacts,and(eq(contacts.workspaceId,leads.workspaceId),eq(contacts.id,leads.contactId),activeContact));
  // Shared viewers and editors read the workspace's Leads under their grant.
  const scope=recordWorkspaceScope(db,actorId,query.workspaceId);
  if(query.id){
    const [record]=await selection.where(and(scope,eq(leads.id,query.id))).limit(1);
    return record??null;
  }
  const pattern=recordSearchPattern(query.search);
  const rows=await selection.where(and(scope,pattern?ilike(sql`${leads.data}->>'name'`,pattern):undefined,
    query.stage?sql`${leads.data}->>'leadStage'=${query.stage}`:undefined,leadOwnerFilter(actorId,query.owner),
    query.after?gt(leads.id,query.after):undefined))
    .orderBy(asc(leads.id)).limit(query.limit+1);
  const records=rows.slice(0,query.limit);
  return {records,next:rows.length>query.limit?records.at(-1)!.id:null};
}

type Result={id:string;created:boolean}|{id:string;dealId:string;created:boolean}|
  {error:'missing'|'stale'|'contact_missing'|'company_missing'|'disqualified'|'access'|'assignee_missing'};

export function writePortableLead(db:PostgresJsDatabase,actorId:string,input:LeadWrite,shared?:SharedRecordWriteScope):Promise<Result>{
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,!shared&&!('id' in input)&&!input.contactId&&!input.companyId,shared,undefined,true);
    if(!workspaceId)return {error:shared?'access':'id' in input?'missing':input.companyId?'company_missing':'contact_missing'};
    const target='id' in input?and(eq(leads.workspaceId,workspaceId),eq(leads.id,input.id)):undefined;
    const current=target?(await tx.select(columns).from(leads).where(target).for('update'))[0]:undefined;
    if('id' in input&&!current)return {error:'missing'};
    // The persisted deal link is the receipt for this lead's one conversion. A
    // retried request after a lost response returns that deal even after edits.
    if(input.action==='convert'&&current?.dealId)return {id:current.id,dealId:current.dealId,created:false};
    if('expectedRevision' in input&&current?.revision!==input.expectedRevision)return {error:'stale'};
    const now=new Date().toISOString();
    if(input.action==='convert'){
      if(!current)return {error:'missing'};
      if(leadStageFor(undefined,current.data)?.outcome==='disqualified')return {error:'disqualified'};
      const result=await saveDealInTransaction(tx,actorId,{action:'save',kind:'deals',
        data:{name:input.dealName,amount:0,closeDate:'',stage:stages[0]},companyId:current.companyId,primaryContactId:current.contactId},shared);
      if('error' in result){
        if(result.error==='contact_missing')return {error:'contact_missing'};
        if(result.error==='company_missing')return {error:'company_missing'};
        throw Error('Lead conversion could not create a deal.');
      }
      const fields={data:{...current.data,leadStage:'Qualified' as const},dealId:result.record.id,
        revision:current.revision+1,updatedAt:now};
      await tx.update(leads).set(fields).where(target);
      await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...fields},now);
      return {id:current.id,dealId:result.record.id,created:true};
    }
    const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.companyId);
    if(!company)return {error:'company_missing'};
    const companyId=company.id;
    const contact=await resolvePortableContactLink(tx,workspaceId,current?.contactId??null,input.contactId);
    if(!contact)return {error:'contact_missing'};
    const contactId=contact.id;
    // Assignment follows the shared record owner rules: the owner or an active editor, kept when omitted.
    const assignee=await resolvePortableRecordOwner(tx,workspaceId,input.assigneeId,current?.assigneeId&&current.assigneeLabel?
      {userId:current.assigneeId,workspaceId,label:current.assigneeLabel}:undefined);
    if(assignee===false)return {error:'assignee_missing'};
    const leadStage=input.data.leadStage??current?.data.leadStage??'New';
    const values={data:{...current?.data,...input.data,leadStage},companyId,contactId,
      assigneeId:assignee?.userId??null,assigneeLabel:assignee?.label??null,updatedAt:now};
    if(current){
      const revision=current.revision+1;
      await tx.update(leads).set({...values,revision}).where(target);
      await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...values,revision},now);
      return {id:current.id,created:false};
    }
    const id=crypto.randomUUID();
    await tx.insert(leads).values({...values,workspaceId,id,revision:1,createdAt:now});
    await writePortableLeadEvent(tx,workspaceId,actorId,undefined,{...values,id,revision:1,dealId:null},now);
    return {id,created:true};
  });
}
