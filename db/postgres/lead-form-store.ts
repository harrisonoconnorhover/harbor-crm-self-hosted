import {and,count,desc,eq,exists,gt,gte,ilike,inArray,not,or,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {recordAccess,type RecordAccessActor} from './record-access-store';
import {ApiError} from '../../lib/api-error';
import {LEAD_FORM_DAILY_LIMIT,LEAD_FORM_HOURLY_LIMIT,unmatchedLeadSubmissionStatuses,SupersededLeadFormError,type leadFormSubmit} from '../../lib/lead-forms';
import {formNoteCapacityIssue,leadFormAutomationNote,type PortableLeadFormPayload,type LeadFormNoteAutomation,type PortableInquiryFilter,type PortableLeadFormDefinition,type portableLeadFormAction} from '../../lib/portable-lead-forms';
import type {ContactFields} from '../../lib/portable-records';
import {contacts,contactEvents,privateWorkspaces} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableJobs as jobs} from './job-schema';
import {formNoteOverdue,inquiryFollowUpOverdue,openFormNoteCapacitySkip,openInquiry} from './lead-form-note-status';
import {jobOverdueAt} from './job-store';
import {lockPortableInquiryToken} from './portable-api-token-store';
import {leadFormActivations as active,leadFormNoteSources as sources,leadForms as forms,leadInquiries as inquiries} from './lead-form-schema';
import {recordSearchPattern} from './record-search';
import {attributeInquiry,attributionWindowMs,type AttributionHint} from './web-attribution-store';
import {formConversions} from './web-attribution-schema';
import {activeWorkspaceAssignee} from './workspace-assignee-store';
import {routeFormContact} from './portable-lead-store';
import {queueMarketingFormDeliveries} from './marketing-form-intake';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Action=z.output<typeof portableLeadFormAction>;
type Submission=Omit<z.output<typeof leadFormSubmit>,'payload'>&{payload:PortableLeadFormPayload};
const unavailable=()=>new ApiError(404,'Form unavailable.');
const changed=()=>new ApiError(409,'This form or request changed. Reload before trying again.');
const formScope=(workspaceId:string,id:string)=>and(eq(forms.workspaceId,workspaceId),eq(forms.id,id));
const formFields={id:forms.id,definition:forms.definition,revision:forms.revision};
const inquiryFollowUp=(handled:boolean)=>handled?and(not(eq(inquiries.status,'removed')),eq(inquiries.handled,true)):openInquiry;
const maxForms=20;
const maxPendingNotes=100;
const pendingNotes=sql`${sources.state} IN ('awaiting_contact','waiting')`;
const settingsChanged='Form settings changed before the internal Note was written.';
const databaseTime=sql<number>`floor(extract(epoch from clock_timestamp())*1000)::float8`;
const noteClock=sql`floor(extract(epoch from statement_timestamp())*1000)::bigint`;
const noteClaimExpired=sql<boolean>`${jobs.status}='running' AND ${jobs.leaseUntil}<=${noteClock}`;
const noteOverdue=or(formNoteOverdue,jobOverdueAt(noteClock),noteClaimExpired)!;
const noteIssues=or(noteOverdue,openFormNoteCapacitySkip,
  sql`${jobs.status} IN ('failed','attention') AND ${jobs.operatorReviewedAt} IS NULL`)!;
const timelineId=(definition:PortableLeadFormDefinition,payload:PortableLeadFormPayload,contactId:string|null)=>
  definition.showMessageOnContact&&payload.message&&contactId?crypto.randomUUID():null;

export async function listLeadForms(db:Db,actorId:string){
  const matching=(condition:SQL|undefined)=>db.select({id:inquiries.id}).from(inquiries)
    .where(and(eq(inquiries.workspaceId,forms.workspaceId),eq(inquiries.formId,forms.id),condition));
  const rows=await db.select({...formFields,activation:active.formId,
    hasUnmatchedInquiries:exists(matching(inArray(inquiries.status,unmatchedLeadSubmissionStatuses))).mapWith(Boolean),
    hasOpenInquiries:exists(matching(inquiryFollowUp(false))).mapWith(Boolean),
  }).from(forms)
    .innerJoin(privateWorkspaces,eq(forms.workspaceId,privateWorkspaces.id))
    .leftJoin(active,eq(forms.id,active.formId)).where(eq(privateWorkspaces.ownerId,actorId))
    .orderBy(forms.id).limit(maxForms);
  return rows.map(({activation,...form})=>({...form,enabled:!!activation}));
}

type InquiryPageQuery={formId?:string;cursor?:{at:number;id:string};filter:PortableInquiryFilter;inquirySearch?:string;submissionId?:string};

export function readLeadInquiries(db:Db,actor:RecordAccessActor,query:InquiryPageQuery,includeBody:boolean){
  if(!includeBody)return inquiryPage(db,actor.userId,query);
  return db.transaction(async tx=>{
    const page=await inquiryPage(tx,actor.userId,query);
    const contactIds=new Set(page.results.flatMap(row=>row.contactId?[row.contactId]:[]));
    await recordAccess(tx,actor,'contacts','related',[...contactIds]);
    return page;
  },{isolationLevel:'repeatable read'});
}

async function inquiryPage(db:Db,actorId:string,{formId,cursor,filter,inquirySearch,submissionId}:InquiryPageQuery){
  if(formId){
    const [form]=await db.select({id:forms.id}).from(forms)
      .innerJoin(privateWorkspaces,eq(forms.workspaceId,privateWorkspaces.id))
      .where(and(eq(forms.id,formId),eq(privateWorkspaces.ownerId,actorId)));
    if(!form)throw unavailable();
  }
  const pattern=recordSearchPattern(inquirySearch);
  const match=pattern?and(sql`${inquiries.status} <> 'removed'`,
    or(ilike(sql`${inquiries.payload}->>'name'`,pattern),ilike(sql`${inquiries.payload}->>'email'`,pattern))):undefined;
  const rows=await db.select({
    id:inquiries.id,formId:inquiries.formId,formTitle:sql<string>`${forms.definition}->>'title'`,
    payload:inquiries.payload,contactId:inquiries.contactId,status:inquiries.status,
    receivedAt:inquiries.receivedAt,removedAt:inquiries.removedAt,reviewReason:inquiries.reviewReason,
    handled:inquiries.handled,triageRevision:inquiries.triageRevision,
    contactAvailable:exists(db.select({id:contacts.id}).from(contacts)
      .where(and(eq(contacts.workspaceId,inquiries.workspaceId),eq(contacts.id,inquiries.contactId),activeContact))).mapWith(Boolean),
    journeySite:formConversions.siteId,
    noteState:sources.state,noteIssue:sources.issue,noteOverdue,noteClaimExpired,noteIssues,
    jobId:jobs.id,jobStatus:jobs.status,jobIssue:jobs.issue,
  }).from(inquiries)
    .innerJoin(privateWorkspaces,eq(inquiries.workspaceId,privateWorkspaces.id))
    .innerJoin(forms,and(eq(inquiries.workspaceId,forms.workspaceId),eq(inquiries.formId,forms.id)))
    .leftJoin(formConversions,and(eq(formConversions.workspaceId,inquiries.workspaceId),eq(formConversions.inquiryId,inquiries.id),
      gte(formConversions.convertedAt,Date.now()-attributionWindowMs)))
    .leftJoin(sources,and(eq(sources.workspaceId,inquiries.workspaceId),eq(sources.inquiryId,inquiries.id)))
    .leftJoin(jobs,and(eq(jobs.workspaceId,sources.workspaceId),eq(jobs.id,sources.jobId),eq(sources.state,'queued')))
    .where(and(eq(privateWorkspaces.ownerId,actorId),formId?eq(inquiries.formId,formId):undefined,
    submissionId?eq(inquiries.id,submissionId):undefined,match,
    filter==='unmatched'?inArray(inquiries.status,unmatchedLeadSubmissionStatuses):undefined,
    filter==='needs_review'?eq(inquiries.status,'needs_review'):undefined,
    filter==='open'||filter==='handled'?inquiryFollowUp(filter==='handled'):undefined,
    filter==='overdue'?inquiryFollowUpOverdue:undefined,
    filter==='note_issues'?and(not(eq(inquiries.status,'removed')),noteIssues):undefined,
    cursor?sql`(${inquiries.receivedAt},${inquiries.id}) < (${cursor.at},${cursor.id}::uuid)`:undefined))
    .orderBy(desc(inquiries.receivedAt),desc(inquiries.id)).limit(26);
  const last=rows[24];
  const results=rows.slice(0,25).map(({noteState,noteIssue,noteOverdue,noteClaimExpired,noteIssues,jobId,jobStatus,jobIssue,journeySite,...record})=>{
    const row={...record,...(journeySite?{journeySite}:undefined)};
    if(!noteState||row.status==='removed')return row;
    const noteAutomation:LeadFormNoteAutomation={
      status:noteState!=='queued'?noteState:
        jobStatus==='failed'||jobStatus==='attention'?'failed':
        jobStatus==='succeeded'||jobStatus==='skipped'?jobStatus:'queued',
      issue:jobIssue??noteIssue,...(noteOverdue?{overdue:true}:{}),...(noteClaimExpired?{claimExpired:true}:{}),
      ...(noteIssues&&jobId?{attentionJobId:jobId}:{}),
    };
    return {...row,noteAutomation};
  });
  return {results,next:rows.length>25?{at:last.receivedAt,id:last.id}:null};
}

export async function enabledLeadForm(db:Db,id:string){
  const [form]=await db.select({...formFields,workspaceId:forms.workspaceId}).from(forms)
    .innerJoin(active,eq(active.formId,forms.id)).where(eq(forms.id,id));
  return form;
}

async function matchContact(tx:Tx,workspaceId:string,formId:string,payload:PortableLeadFormPayload,routingFormTitle?:string){
  const emailMatch=and(eq(contacts.workspaceId,workspaceId),sql`lower(${contacts.data}->>'email')=${payload.email}`);
  const matches=await tx.select({id:contacts.id}).from(contacts)
    .where(and(emailMatch,activeContact)).limit(2).for('share');
  if(matches.length>1)return {status:'needs_review' as const,contactId:null,reviewReason:'duplicate_email' as const};
  if(matches[0]){
    if(routingFormTitle)await routeFormContact(tx,workspaceId,formId,matches[0].id,payload.name,routingFormTitle,{newContact:false,country:payload.country,region:payload.region});
    return {status:'linked' as const,contactId:matches[0].id,reviewReason:null};
  }
  // Archive changes take the same workspace lock as submissions and retries.
  // Leave an archived-only match for review without exposing or recreating it.
  const [archived]=await tx.select({id:contacts.id}).from(contacts)
    .where(and(emailMatch,not(activeContact))).limit(1);
  if(archived)return {status:'needs_review' as const,contactId:null,reviewReason:'archived_contact' as const};
  const contactId=crypto.randomUUID(),now=new Date().toISOString();
  const data:ContactFields={name:payload.name,email:payload.email,phone:payload.phone,title:'',lifecycle:'Lead',...(payload.country?{country:payload.country}:{}),...(payload.region?{state:payload.region}:{})};
  await tx.insert(contacts).values({workspaceId,id:contactId,revision:1,data,createdAt:now,updatedAt:now});
  if(routingFormTitle){
    const owner=await routeFormContact(tx,workspaceId,formId,contactId,payload.name,routingFormTitle,{newContact:true,country:payload.country,region:payload.region});
    if(owner&&await activeWorkspaceAssignee(tx,workspaceId,owner.userId,{tool:'contacts'})){
      data.recordOwner=owner;
      await tx.update(contacts).set({data}).where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,contactId)));
    }
  }
  await tx.insert(contactEvents).values({workspaceId,contactId,revision:1,intakeFormId:formId,data,occurredAt:now});
  return {status:'created' as const,contactId,reviewReason:null};
}

export function manageLeadForm(db:Db,actorId:string,input:Action){
  return db.transaction(async tx=>{
    const creating=input.action==='save'&&input.revision===0;
    if(creating)await tx.insert(privateWorkspaces).values({id:crypto.randomUUID(),ownerId:actorId})
      .onConflictDoNothing({target:privateWorkspaces.ownerId});
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.ownerId,actorId)).for('no key update');
    if(!workspace)throw unavailable();
    const workspaceId=workspace.id;
    if(input.action==='removeInquiry'||input.action==='retry'||input.action==='setInquiryHandled'){
      const target=and(eq(inquiries.workspaceId,workspaceId),eq(inquiries.formId,input.formId),eq(inquiries.id,input.submissionId));
      const source=and(eq(sources.workspaceId,workspaceId),eq(sources.inquiryId,input.submissionId));
      const [receipt]=await tx.select({status:inquiries.status,payload:inquiries.payload,contactId:inquiries.contactId,
        handled:inquiries.handled,triageRevision:inquiries.triageRevision,routeLeadRevision:inquiries.routeLeadRevision}).from(inquiries).where(target);
      if(!receipt)throw unavailable();
      if(input.action==='setInquiryHandled'){
        if(receipt.status==='removed')throw unavailable();
        const nextRevision=input.triageRevision+1;
        if(receipt.triageRevision===input.triageRevision){
          await tx.update(inquiries).set({handled:input.handled,triageRevision:nextRevision}).where(target);
        }else if(receipt.triageRevision!==nextRevision||receipt.handled!==input.handled){
          throw new ApiError(409,'Inquiry follow-up status changed. Reload before trying again.');
        }
        return {ok:true};
      }
      if(input.action==='removeInquiry'&&receipt.status!=='removed'){
        await tx.delete(formConversions).where(and(eq(formConversions.workspaceId,workspaceId),eq(formConversions.inquiryId,input.submissionId)));
        await tx.update(inquiries).set({status:'removed',payload:null,fingerprint:null,contactId:null,reviewReason:null,
          timelineNoteId:null,handled:false,removedAt:Date.now()}).where(target);
        await tx.update(sources).set({state:'skipped',nextAt:null,retryAt:null,contactId:null,issue:'Inquiry was removed.'})
          .where(and(source,sql`NOT EXISTS (SELECT 1 FROM ${jobs}
            WHERE ${jobs.workspaceId}=${sources.workspaceId} AND ${jobs.id}=${sources.jobId} AND ${jobs.status}='succeeded')`));
      }
      if(input.action==='retry'&&(receipt.status==='needs_review'||receipt.status==='inbox_only')&&receipt.payload){
        const [form]=await tx.select(formFields).from(forms).where(formScope(workspaceId,input.formId));
        if(!form)throw unavailable();
        const [enabled]=await tx.select({id:active.formId}).from(active).where(eq(active.formId,form.id));
        const route=enabled&&form.definition.routeSalesLead&&receipt.routeLeadRevision===form.revision;
        const match=await matchContact(tx,workspaceId,input.formId,receipt.payload,route?form.definition.title:undefined);
        await tx.update(inquiries).set({...match,timelineNoteId:timelineId(form.definition,receipt.payload,match.contactId)}).where(target);
        if(match.contactId){
          const awaiting=and(source,eq(sources.state,'awaiting_contact'));
          if(enabled&&leadFormAutomationNote(form.definition)){
            await tx.update(sources).set({state:'waiting',contactId:match.contactId,nextAt:databaseTime,retryAt:null})
              .where(and(awaiting,eq(sources.formRevision,form.revision)));
          }
          await tx.update(sources).set({state:'skipped',retryAt:null,issue:settingsChanged}).where(awaiting);
          return {ok:true,capturedContact:{id:match.contactId,status:match.status}};
        }
      }
      if(input.action==='retry'&&receipt.contactId&&(receipt.status==='created'||receipt.status==='linked')){
        const [contact]=await tx.select({id:contacts.id}).from(contacts)
          .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,receipt.contactId),activeContact));
        if(contact)return {ok:true,capturedContact:{id:contact.id,status:receipt.status}};
      }
      return {ok:true};
    }
    const [form]=await tx.select(formFields).from(forms).where(formScope(workspaceId,input.id));
    if(input.action==='save'&&input.definition.collectRegion===true&&(input.definition.collectCountry??form?.definition.collectCountry)!==true)
      throw new ApiError(400,'Enable country collection to ask for a state or province.');
    if(creating){
      if(form){
        if(Object.entries(input.definition).some(([key,value])=>form.definition[key as keyof PortableLeadFormDefinition]!==value))throw changed();
        return {ok:true};
      }
      const [total]=await tx.select({count:count()}).from(forms).where(eq(forms.workspaceId,workspaceId));
      if(total.count>=maxForms)throw new ApiError(409,'This workspace already has 20 forms.');
      const [saved]=await tx.insert(forms).values({workspaceId,id:input.id,revision:1,definition:{...input.definition,captureContacts:input.definition.captureContacts??false}})
        .onConflictDoNothing().returning({id:forms.id});
      if(!saved)throw changed();
      return {ok:true};
    }
    if(!form)throw unavailable();
    if(form.revision!==input.revision||form.revision>=2147483647)throw changed();
    await tx.update(forms).set({revision:form.revision+1,...(input.action==='save'?{definition:{...input.definition,
      captureContacts:input.definition.captureContacts??form.definition.captureContacts??true,
      collectCountry:input.definition.collectCountry??form.definition.collectCountry,
      collectRegion:input.definition.collectCountry===false?false:input.definition.collectRegion??form.definition.collectRegion,
      routeSalesLead:input.definition.captureContacts===false?false:input.definition.routeSalesLead??form.definition.routeSalesLead,
      showMessageOnContact:input.definition.showMessageOnContact??form.definition.showMessageOnContact}}:{})})
      .where(formScope(workspaceId,input.id));
    await tx.update(sources).set({state:'skipped',nextAt:null,retryAt:null,issue:settingsChanged})
      .where(and(eq(sources.workspaceId,workspaceId),eq(sources.formId,input.id),pendingNotes));
    if(input.action==='setEnabled'){
      if(input.enabled)await tx.insert(active).values({formId:form.id}).onConflictDoNothing();
      else await tx.delete(active).where(eq(active.formId,form.id));
    }
    return {ok:true};
  });
}

export function submitLeadInquiry(db:Db,formId:string,workspaceId:string,input:Submission,fingerprint:string,tokenId?:string,attribution?:AttributionHint){
  async function readAdmission(tx:Tx){
    // The same workspace lock serializes settings, submission IDs, quota and public email matching.
    const [workspace]=await tx.select({ownerId:privateWorkspaces.ownerId}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.id,workspaceId)).for('no key update');
    if(!workspace)throw unavailable();
    const form=await enabledLeadForm(tx,formId);
    if(!form||form.workspaceId!==workspaceId||(tokenId&&form.definition.captureContacts!==false))throw unavailable();
    if(tokenId&&!await lockPortableInquiryToken(tx,workspaceId,workspace.ownerId,tokenId))
      throw new ApiError(403,'Token or workspace access changed. Refresh access before retrying.');
    const [receipt]=await tx.select({formId:inquiries.formId,fingerprint:inquiries.fingerprint,status:inquiries.status}).from(inquiries)
      .where(and(eq(inquiries.workspaceId,workspaceId),eq(inquiries.id,input.id)));
    if(receipt&&(receipt.formId!==formId||receipt.status!=='removed'&&receipt.fingerprint!==fingerprint))throw changed();
    return {form,receipt,ownerId:workspace.ownerId};
  }
  return db.transaction(async tx=>{
    const {form,receipt,ownerId}=await readAdmission(tx);
    if(receipt)return;
    if(form.revision>input.revision&&!tokenId)throw new SupersededLeadFormError();
    if(form.revision!==input.revision)throw changed();
    if(input.payload.region!==undefined&&!form.definition.collectRegion)
      throw new ApiError(400,'This form does not collect state or province.');
    if(input.payload.country!==undefined&&!form.definition.collectCountry)
      throw new ApiError(400,'This form does not collect country or region.');
    const [{at}]=await tx.select({at:databaseTime}).from(sql`(select 1) as clock`);
    const day=Math.floor(at/86_400_000)*86_400_000;
    const scope=eq(inquiries.workspaceId,workspaceId);
    const [daily]=await tx.select({count:count()}).from(inquiries).where(and(scope,gte(inquiries.receivedAt,day)));
    const [hourly]=await tx.select({count:count()}).from(inquiries)
      .where(and(scope,eq(inquiries.formId,formId),gt(inquiries.receivedAt,at-3_600_000)));
    if(daily.count>=LEAD_FORM_DAILY_LIMIT||hourly.count>=LEAD_FORM_HOURLY_LIMIT)
      throw new ApiError(429,'This form is receiving too many inquiries. Try again later.');
    // Old definitions omitted this setting and captured contacts automatically.
    const match=form.definition.captureContacts===false?{status:'inbox_only' as const,contactId:null}:
      await matchContact(tx,workspaceId,formId,input.payload,form.definition.routeSalesLead?form.definition.title:undefined);
    await tx.insert(inquiries).values({workspaceId,id:input.id,formId,receivedAt:at,payload:input.payload,fingerprint,
      routeLeadRevision:form.definition.routeSalesLead?form.revision:null,...match,timelineNoteId:timelineId(form.definition,input.payload,match.contactId)});
    if(attribution&&!tokenId)await attributeInquiry(tx,workspaceId,input.id,at,attribution);
    if(process.env.HARBOR_MARKETING_WORKSPACE_ID?.toLowerCase()===workspaceId){
      await queueMarketingFormDeliveries(tx,workspaceId,formId,input.id,at);
    }
    if(leadFormAutomationNote(form.definition)){
      const [pending]=await tx.select({count:count()}).from(sources).where(and(eq(sources.workspaceId,workspaceId),pendingNotes));
      const full=pending.count>=maxPendingNotes;
      await tx.insert(sources).values({workspaceId,inquiryId:input.id,formId,formRevision:form.revision,
        ownerId,jobId:crypto.randomUUID(),contactId:match.contactId,
        state:full?'skipped':match.contactId?'waiting':'awaiting_contact',
        nextAt:!full&&match.contactId?at:null,issue:full?formNoteCapacityIssue:null});
    }
  }).catch(async error=>{
    if(error instanceof ApiError)throw error;
    if(tokenId){
      // Confirm a lost acknowledgment through fresh admission. Never repeat the write here.
      const confirmed=await db.transaction(async tx=>!!(await readAdmission(tx)).receipt).catch(recheck=>{
        if(recheck instanceof ApiError)throw recheck;
        return false;
      });
      if(!confirmed)throw error;
      return;
    }
    // A lost COMMIT reply can leave the inquiry and its effects saved.
    const [confirmed]=await db.select({id:inquiries.id}).from(inquiries)
      .innerJoin(active,eq(active.formId,inquiries.formId))
      .where(and(eq(inquiries.workspaceId,workspaceId),eq(inquiries.formId,formId),eq(inquiries.id,input.id),
        eq(inquiries.fingerprint,fingerprint),not(eq(inquiries.status,'removed')))).limit(1).catch(()=>[]);
    if(!confirmed)throw error;
  });
}
