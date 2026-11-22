import {toolLevel} from './member-tool-access';
import {and,asc,desc,eq,exists,gt,ilike,inArray,isNull,lt,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {assessLeadRouting,leadNeedsRouting,recordRoutingTurn,routeNewLead} from './lead-routing-store';
import {ApiError} from '../../lib/api-error';
import {leadStageFor} from '../../lib/lead-pipelines';
import {portableLeadFields} from '../../lib/portable-leads';
import type {LeadEventData,LeadHistory,LeadPage,LeadQuery,LeadRecord,LeadRoutingTarget,LeadSnapshot,LeadWrite} from '../../lib/portable-leads';
import {stages} from '../../lib/crm';
import {companies} from './company-schema';
import {contacts,contactEvents} from './contact-schema';
import type {PortableRecordOwner} from '../../lib/portable-records';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {resolvePortableCompanyLink} from './portable-related-company-link';
import {resolvePortableContactLink} from './portable-related-contact-link';
import {saveDealInTransaction} from './deal-store';
import {ownedRecordScope,sharedCoreRecordScope} from './record-ownership-scope';
import {workspaceViewers} from './workspace-viewer-schema';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {activeLead,leadOwnership,portableLeadEvents as events,portableLeads as leads} from './portable-lead-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';
import {activeWorkspaceAssignee,resolveCoreRecordOwner,resolvePortableRecordOwner} from './workspace-assignee-store';
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
  if(owner==='waiting-routing')return and(sql`${leads.routingRetryAt} IS NOT NULL`,isNull(leads.assigneeId),isNull(leads.dealId),
    sql`${leads.data}->>'leadStage' NOT IN ('Qualified','Disqualified')`);
  if(owner==='needs-routing')return leadNeedsRouting;
  return owner==='unassigned'?isNull(leads.assigneeId):eq(leads.assigneeId,actorId);
}
type LeadTransaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

async function writePortableLeadEvent(tx:LeadTransaction,workspaceId:string,actorId:string|null,
  current:SavedLead,saved:SavedLead,occurredAt:string,routingChange?:LeadEventData['routingChange']){
  await tx.insert(events).values({workspaceId,leadId:saved.id,revision:saved.revision,actorId,automaticRouting:actorId===null,
    previous:snapshot(current),data:{...snapshot(saved),routingChange},occurredAt});
}

async function insertNewLead(tx:LeadTransaction,workspaceId:string,id:string,data:Required<LeadSnapshot>,now:string,
  source:{actorId:string}|{intakeFormId:string;capturedNewContact:boolean},useRouting:boolean,intakeCountry?:string,intakeRegion?:string){
  const routingRetryAt=useRouting&&!data.assigneeId&&process.env.HARBOR_LEAD_ROUTING_RETRY_ENABLED==='true'?now:null;
  await tx.insert(leads).values({...data,intakeCountry,intakeRegion,routingRetryAt,workspaceId,id,revision:1,createdAt:now,updatedAt:now});
  await tx.insert(events).values({...source,workspaceId,leadId:id,revision:1,data:snapshot(data),occurredAt:now});
}

// Intake and ordinary lead edits both serialize on the workspace row. A second
// submission for the same contact keeps any existing open lead and assignment.
export async function routeFormContact(tx:LeadTransaction,workspaceId:string,formId:string,contactId:string,submittedName:string,formTitle:string,intake:{newContact:boolean;country?:string;region?:string}){
  const [existing]=await tx.select({id:leads.id}).from(leads).where(and(eq(leads.workspaceId,workspaceId),
    eq(leads.contactId,contactId),activeLead,isNull(leads.dealId),sql`${leads.data}->>'leadStage' NOT IN ('Qualified','Disqualified')`)).limit(1);
  if(existing)return;
  const [contact]=await tx.select({companyId:companies.id}).from(contacts)
    .leftJoin(companies,and(eq(companies.workspaceId,contacts.workspaceId),eq(companies.id,contacts.primaryCompanyId),activeCompany))
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contactId),activeContact));
  if(!contact)throw Error('The captured contact is unavailable.');
  const chosen=await routeNewLead(tx,workspaceId,contact.companyId,contactId,intake.country,intake.region);
  const assignee=await resolvePortableRecordOwner(tx,workspaceId,chosen,undefined,{tool:'leads'});
  if(assignee===false)throw Error('The selected lead assignee is unavailable.');
  const now=new Date().toISOString(),id=crypto.randomUUID();
  // The contact retains its full name when it exceeds the lead title limit.
  const title=portableLeadFields.shape.name.safeParse(submittedName);
  const data=portableLeadFields.parse({name:title.success?title.data:formTitle,leadStage:'New'});
  const saved={data,contactId,companyId:contact.companyId,dealId:null,
    assigneeId:assignee?.userId??null,assigneeLabel:assignee?.label??null};
  await insertNewLead(tx,workspaceId,id,saved,now,{intakeFormId:formId,capturedNewContact:intake.newContact&&!assignee},true,intake.country,intake.region);
  return assignee;
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
  const eventData=(column:typeof events.data|typeof events.previous)=>{
    if(!workspaceId)return column;
    const link=(field:string,table:typeof contacts|typeof companies|typeof deals)=>sql`(SELECT ${table.id} FROM ${table}
      WHERE ${table.workspaceId}=${workspaceId} AND ${table.id}=(${column}->>${field}::text)::uuid
        AND ${ownedRecordScope(db,actorId,workspaceId,table)})`;
    return sql<LeadSnapshot|null>`CASE WHEN ${column} IS NULL THEN NULL ELSE ${column} || jsonb_build_object(
      'contactId',${link('contactId',contacts)},'companyId',${link('companyId',companies)},'dealId',${link('dealId',deals)}) END`;
  };
  const rows=await db.select({revision:events.revision,actorName:sql<string|null>`CASE WHEN ${events.automaticRouting} THEN 'Automatic lead routing' WHEN ${events.intakeFormId} IS NOT NULL THEN 'Website form' ELSE ${loginIdentities.fullName} END`,occurredAt:events.occurredAt,
    previous:eventData(events.previous),data:eventData(events.data)}).from(leads)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,leads.workspaceId))
    .leftJoin(events,and(eq(events.workspaceId,leads.workspaceId),eq(events.leadId,leads.id),
      before?lt(events.revision,before):undefined))
    .leftJoin(loginIdentities,eq(loginIdentities.id,events.actorId))
    .where(and(activeLead,sharedCoreRecordScope(db,actorId,workspaceId,leadOwnership)??recordWorkspaceScope(db,actorId),eq(leads.id,id)))
    .orderBy(desc(events.revision)).limit(historySize+1);
  if(!rows.length)return null;
  const unassigned={assigneeId:null,assigneeLabel:null};
  const entries=rows.slice(0,historySize).flatMap(row=>row.revision!==null&&row.occurredAt&&row.data?
    [{...row,revision:row.revision,occurredAt:new Date(row.occurredAt).toISOString(),
      previous:row.previous&&{...unassigned,...row.previous},data:{...unassigned,...row.data}}]:[]);
  return {entries,next:rows.length>historySize?entries.at(-1)!.revision:null};
}

export async function readPortableLeads(db:PostgresJsDatabase,actorId:string,query:LeadQuery):Promise<LeadPage|LeadRecord|null>{
  const shared=query.workspaceId;
  const [afterId,afterTime]=query.after?.split('~')??[];
  // Existing ID-only page links continue through their original ordering.
  const routingQueue=query.owner==='needs-routing'||query.owner==='waiting-routing';
  const oldestFirst=routingQueue&&(!afterId||Boolean(afterTime));
  const createdAt=routingQueue?sql<string>`to_char(${leads.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:leads.createdAt;
  const selection=db.select({...columns,createdAt,routingRetryAt:leads.routingRetryAt,routingPending:sql<boolean>`${leads.routingRetryAt} IS NOT NULL`,...(shared?{editable:sql<boolean>`${ownedRecordScope(db,actorId,shared,leadOwnership,'edit')}`,
    convertedDealUnavailable:sql<boolean>`${leads.dealId} IS NOT NULL AND ${deals.id} IS NULL`}:{}),
    dealId:sql<string|null>`${deals.id}`,contactId:sql<string|null>`${contacts.id}`,companyId:sql<string|null>`${companies.id}`,contactName,companyName,
    dealArchived:sql<boolean>`${deals.archivedAt} IS NOT NULL`}).from(leads)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,leads.workspaceId))
    .leftJoin(companies,and(eq(companies.workspaceId,leads.workspaceId),eq(companies.id,leads.companyId),activeCompany,sharedCoreRecordScope(db,actorId,shared,companies)))
    .leftJoin(contacts,and(eq(contacts.workspaceId,leads.workspaceId),eq(contacts.id,leads.contactId),activeContact,sharedCoreRecordScope(db,actorId,shared,contacts)))
    .leftJoin(deals,and(eq(deals.workspaceId,leads.workspaceId),eq(deals.id,leads.dealId),sharedCoreRecordScope(db,actorId,shared,deals)));
  // Shared viewers and editors read the workspace's Leads under their grant.
  const scope=sharedCoreRecordScope(db,actorId,shared,leadOwnership)??recordWorkspaceScope(db,actorId);
  if(query.id){
    const [record]=await selection.where(and(activeLead,scope,eq(leads.id,query.id))).limit(1);
    return record??null;
  }
  const pattern=recordSearchPattern(query.search);
  const rows=await selection.where(and(activeLead,scope,pattern?ilike(sql`${leads.data}->>'name'`,pattern):undefined,
    query.stage?sql`${leads.data}->>'leadStage'=${query.stage}`:undefined,leadOwnerFilter(actorId,query.owner),
    afterTime?sql`(${leads.createdAt},${leads.id})>(${afterTime}::timestamptz,${afterId}::uuid)`:afterId?gt(leads.id,afterId):undefined))
    .orderBy(...(oldestFirst?[asc(leads.createdAt),asc(leads.id)]:[asc(leads.id)])).limit(query.limit+1);
  const records=rows.slice(0,query.limit);
  const last=records.at(-1);
  const next=last&&rows.length>query.limit?(oldestFirst?last.id+'~'+last.createdAt:last.id):null;
  return {records,next};
}

type Result={id:string;created:boolean;routing?:'assigned'|'unavailable'|'queued'}|{id:string;dealId:string;created:boolean}|
  {error:'missing'|'stale'|'contact_missing'|'company_missing'|'disqualified'|'not_routable'|'access'|'assignee_missing'};

// Carry the form's original assignment intent through a delayed handoff. A linked
// existing contact, an edited contact, or a replacement link keeps its own ownership.
async function assignCapturedContact(tx:LeadTransaction,workspaceId:string,actorId:string|null,
  lead:SavedLead,owner:PortableRecordOwner,now:string,shared?:SharedRecordWriteScope){
  if(!lead.contactId||lead.assigneeId)return;
  const [capture]=await tx.select({form:events.intakeFormId,contact:contacts}).from(events)
    .innerJoin(contacts,and(eq(contacts.workspaceId,events.workspaceId),eq(contacts.id,lead.contactId),
      sql`${events.data}->>'contactId'=${contacts.id}::text`))
    .where(and(eq(events.workspaceId,workspaceId),eq(events.leadId,lead.id),eq(events.revision,1),
      eq(events.capturedNewContact,true),activeContact,eq(contacts.revision,1),
      shared&&actorId?ownedRecordScope(tx,actorId,workspaceId,contacts,'edit',undefined,shared.grantId):undefined,
      sql`${contacts.data}->>'recordOwner' IS NULL`)).for('update',{of:contacts});
  if(!capture?.form||!await activeWorkspaceAssignee(tx,workspaceId,owner.userId,{tool:'contacts'}))return;
  const {contact}=capture,data={...contact.data,recordOwner:owner};
  const revision=contact.revision+1;
  await tx.update(contacts).set({revision,data,updatedAt:now})
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contact.id)));
  await tx.insert(contactEvents).values({workspaceId,contactId:contact.id,revision,actorId,
    intakeFormId:actorId?null:capture.form,previous:contact.data,data,occurredAt:now,
    previousPrimaryCompanyId:contact.primaryCompanyId,primaryCompanyId:contact.primaryCompanyId});
}

async function assignWaitingLead(tx:LeadTransaction,workspaceId:string,actorId:string|null,current:SavedLead&{intakeCountry:string|null;intakeRegion:string|null},now:string,shared?:SharedRecordWriteScope){
  const {counts,winner}=await assessLeadRouting(tx,workspaceId,current.companyId,current.contactId,current.intakeCountry??undefined,current.intakeRegion??undefined);
  if(!winner){
    if(actorId===null){
      await tx.update(leads).set({routingRetryAt:sql`statement_timestamp()+interval '5 minutes'`,routingMiss:{checkedAt:now,counts}})
        .where(and(eq(leads.workspaceId,workspaceId),eq(leads.id,current.id)));
    }
    return 'unavailable' as const;
  }
  const chosen=winner.user_id;
  await recordRoutingTurn(tx,workspaceId,chosen);
  const assignee=await resolvePortableRecordOwner(tx,workspaceId,chosen,undefined,{tool:'leads'});
  if(!assignee)throw new ApiError(409,'The routing pool changed. Refresh the leads and try again.');
  const fields={routingRetryAt:null,routingMiss:null,assigneeId:assignee.userId,assigneeLabel:assignee.label,revision:current.revision+1,updatedAt:now};
  await tx.update(leads).set(fields).where(and(eq(leads.workspaceId,workspaceId),eq(leads.id,current.id)));
  await assignCapturedContact(tx,workspaceId,actorId,current,assignee,now,shared);
  await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...fields},now);
  return 'assigned' as const;
}

// Take the workspace lock before the lead, as interactive edits and form captures do.
export async function retryWaitingLead(db:PostgresJsDatabase){
  const due=and(activeLead,isNull(leads.assigneeId),isNull(leads.dealId),sql`${leads.routingRetryAt}<=statement_timestamp()`);
  return db.transaction(async tx=>{
    const waiting=tx.select({id:leads.id}).from(leads);
    // The uncorrelated check uses the global due index when the worker is idle.
    const [next]=await tx.select({workspace:privateWorkspaces.id}).from(privateWorkspaces)
      .where(and(exists(waiting.where(due)),exists(tx.select({id:leads.id}).from(leads)
        .where(and(eq(leads.workspaceId,privateWorkspaces.id),due)))))
      .orderBy(sql`${privateWorkspaces.lastLeadRoutingAt} ASC NULLS FIRST`,asc(privateWorkspaces.id))
      .limit(1).for('no key update',{skipLocked:true});
    if(!next)return false;
    const [current]=await tx.select({...columns,intakeCountry:leads.intakeCountry,intakeRegion:leads.intakeRegion}).from(leads)
      .where(and(eq(leads.workspaceId,next.workspace),due)).orderBy(asc(leads.routingRetryAt),asc(leads.id))
      .limit(1).for('update');
    if(!current)return false;
    if(current.data.leadStage==='Qualified'||current.data.leadStage==='Disqualified'){
      await tx.update(leads).set({routingRetryAt:null,routingMiss:null}).where(and(eq(leads.workspaceId,next.workspace),eq(leads.id,current.id)));
    }else{
      await assignWaitingLead(tx,next.workspace,null,current,new Date().toISOString());
    }
    // A full or off-shift pool also consumes its turn. Commit the turn with the outcome.
    await tx.update(privateWorkspaces).set({lastLeadRoutingAt:sql`clock_timestamp()`}).where(eq(privateWorkspaces.id,next.workspace));
    return true;
  });
}

function requireRoutingRetries(){
  if(process.env.HARBOR_LEAD_ROUTING_RETRY_ENABLED!=='true')throw new ApiError(409,'Automatic lead routing retries are off.');
}

// Callers hold the workspace and lead locks and have checked the current assignee’s eligibility.
async function queueWaitingLead(tx:LeadTransaction,workspaceId:string,actorId:string,current:SavedLead&{routingRetryAt:string|null}){
  if(current.routingRetryAt)return;
  const now=new Date().toISOString();
  const fields={routingRetryAt:now,revision:current.revision+1,updatedAt:now,assigneeId:null,assigneeLabel:null};
  await tx.update(leads).set(fields).where(and(eq(leads.workspaceId,workspaceId),eq(leads.id,current.id)));
  await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...fields},now,'queued');
}

export function routeWaitingLeadPage(db:PostgresJsDatabase,actorId:string,targets:LeadRoutingTarget[],shared?:SharedRecordWriteScope,queueIfUnavailable=false){
  return db.transaction(async tx=>{
    const workspace=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true,true,['leads','edit-all']);
    if(!workspace)throw new ApiError(shared?403:404,'Workspace unavailable for lead routing.');
    if(queueIfUnavailable)requireRoutingRetries();
    const rows=await tx.select({...columns,intakeCountry:leads.intakeCountry,intakeRegion:leads.intakeRegion,routingRetryAt:leads.routingRetryAt}).from(leads).where(and(
      eq(leads.workspaceId,workspace),activeLead,leadNeedsRouting,inArray(leads.id,targets.map(row=>row.id))
    )).for('update');
    const current=new Map(rows.map(row=>[row.id,row]));
    const counts={assigned:0,unavailable:0,skipped:0};
    let queued=0;
    // Use the displayed order. Each assignment consumes capacity before considering the next lead.
    for(const target of targets){
      const row=current.get(target.id);
      if(!row||row.revision!==target.expectedRevision){counts.skipped++;continue;}
      const outcome=await assignWaitingLead(tx,workspace,actorId,row,new Date().toISOString(),shared);
      if(outcome==='unavailable'&&queueIfUnavailable){
        await queueWaitingLead(tx,workspace,actorId,row);
        queued++;
      }else counts[outcome]++;
    }
    return queueIfUnavailable?{...counts,queued}:counts;
  });
}

export function writePortableLead(db:PostgresJsDatabase,actorId:string,input:LeadWrite,shared?:SharedRecordWriteScope,createId?:string):Promise<Result>{
  return db.transaction(async tx=>{
    const routing=input.action==='route'||input.action==='queue_routing';
    const operation=routing?'edit-all':'id' in input?'edit':'create';
    const workspaceId=await lockRecordWorkspace(tx,actorId,!shared&&!('id' in input)&&!input.contactId&&!input.companyId,
      shared,undefined,true,true,['leads',operation]);
    if(!workspaceId)return {error:shared?'access':'id' in input?'missing':input.companyId?'company_missing':'contact_missing'};
    const target='id' in input?and(activeLead,eq(leads.workspaceId,workspaceId),eq(leads.id,input.id),shared?ownedRecordScope(tx,actorId,workspaceId,leadOwnership,'edit'):undefined):undefined;
    const current=target?(await tx.select({...columns,intakeCountry:leads.intakeCountry,intakeRegion:leads.intakeRegion,routingRetryAt:leads.routingRetryAt,...(input.action==='route'||input.action==='queue_routing'?{needsRouting:leadNeedsRouting}:{})}).from(leads).where(target).for('update'))[0]:undefined;
    if('id' in input&&!current)return {error:'missing'};
    // The persisted deal link is the receipt for this lead's one conversion. A
    // retried request after a lost response returns that deal even after edits.
    if(input.action==='convert'&&current?.dealId){
      if(shared){
        const [visible]=await tx.select({id:deals.id}).from(deals).where(and(eq(deals.workspaceId,workspaceId),
          eq(deals.id,current.dealId),ownedRecordScope(tx,actorId,workspaceId,deals)));
        if(!visible)return {error:'access'};
      }
      return {id:current.id,dealId:current.dealId,created:false};
    }
    if(input.action==='queue_routing'){
      if(!current)return {error:'missing'};
      requireRoutingRetries();
      if(!current.needsRouting)return {error:'not_routable'};
      if(current.routingRetryAt)return {id:current.id,created:false,routing:'queued'};
      if(input.expectedRevision!==current.revision)return {error:'stale'};
      if(current.assigneeId!==(input.releaseAssigneeId??null))
        throw new ApiError(409,'Review the current assignee before queuing this lead.');
      await queueWaitingLead(tx,workspaceId,actorId,current);
      return {id:current.id,created:false,routing:'queued'};
    }
    if('expectedRevision' in input&&current?.revision!==input.expectedRevision)return {error:'stale'};
    const now=new Date().toISOString();
    if(input.action==='route'){
      if(!current)return {error:'missing'};
      if(!current.needsRouting)return {error:'not_routable'};
      return {id:current.id,created:false,routing:await assignWaitingLead(tx,workspaceId,actorId,current,now,shared)};
    }
    if(input.action==='convert'){
      if(!current)return {error:'missing'};
      if(leadStageFor(undefined,current.data)?.outcome==='disqualified')return {error:'disqualified'};
      const result=await saveDealInTransaction(tx,actorId,{action:'save',kind:'deals',assigneeId:current.assigneeId,
        data:{name:input.dealName,stage:stages[0]},companyId:current.companyId,primaryContactId:current.contactId},shared);
      if('error' in result){
        if(result.error==='access')return {error:'access'};
        if(result.error==='assignee_missing')throw new ApiError(409,'Reassign this lead to an eligible workspace member before converting it to a deal.');
        if(result.error==='contact_missing')return {error:'contact_missing'};
        if(result.error==='company_missing')return {error:'company_missing'};
        throw Error('Lead conversion could not create a deal.');
      }
      const fields={routingRetryAt:null,routingMiss:null,data:{...current.data,leadStage:'Qualified' as const},dealId:result.record.id,
        revision:current.revision+1,updatedAt:now};
      await tx.update(leads).set(fields).where(target);
      await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...fields},now);
      return {id:current.id,dealId:result.record.id,created:true};
    }
    const company=await resolvePortableCompanyLink(tx,workspaceId,current?.companyId??null,input.companyId,shared?actorId:undefined);
    if(!company)return {error:'company_missing'};
    const companyId=company.id;
    const contact=await resolvePortableContactLink(tx,workspaceId,current?.contactId??null,input.contactId,shared?actorId:undefined);
    if(!contact)return {error:'contact_missing'};
    const contactId=contact.id;
    // Assignment follows the shared record owner rules: the owner or an active editor, kept when omitted.
    const leadStage=input.data.leadStage??current?.data.leadStage??'New';
    const [grant]=shared?await tx.select({scope:toolLevel('leads','edit')}).from(workspaceViewers)
      .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId))):[];
    const automatic=(!shared||grant?.scope==='all')&&!current&&input.assigneeId===undefined&&leadStage!=='Qualified'&&leadStage!=='Disqualified';
    const assigneeId=automatic?await routeNewLead(tx,workspaceId,companyId,contactId):input.assigneeId;
    const assignee=await resolveCoreRecordOwner(tx,workspaceId,actorId,!!shared,'leads',assigneeId,current?.assigneeId&&current.assigneeLabel?
      {userId:current.assigneeId,workspaceId,label:current.assigneeLabel}:undefined,!current);
    if(assignee===false)return {error:'assignee_missing'};
    const values={data:{...current?.data,...input.data,leadStage},companyId,contactId,
      assigneeId:assignee?.userId??null,assigneeLabel:assignee?.label??null,updatedAt:now};
    if(current){
      const revision=current.revision+1;
      const stopRouting=input.assigneeId!==undefined||leadStage==='Qualified'||leadStage==='Disqualified';
      await tx.update(leads).set({...values,revision,...(stopRouting?{routingRetryAt:null,routingMiss:null}:{})}).where(target);
      const cancelled=current.routingRetryAt&&input.assigneeId===null&&leadStage===current.data.leadStage;
      await writePortableLeadEvent(tx,workspaceId,actorId,current,{...current,...values,revision},now,cancelled?'cancelled':undefined);
      return {id:current.id,created:false};
    }
    const id=createId??crypto.randomUUID();
    await insertNewLead(tx,workspaceId,id,{...values,dealId:null},now,{actorId},automatic);
    return {id,created:true};
  });
}
