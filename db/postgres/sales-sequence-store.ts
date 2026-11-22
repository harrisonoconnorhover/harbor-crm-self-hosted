import {toolLevel} from './member-tool-access';
import {recordAccess,recordPreviewAccess,type RecordAccessActor} from './record-access-store';
import {teamBookings} from './portable-meeting-schema';
import {sequenceRepCanEditContact,sequenceRepCanWorkTasks,unavailableSequenceAssignee} from './sales-sequence-access';
import {isDeepStrictEqual} from 'node:util';
import {and,asc,desc,eq,gt,inArray,isNotNull,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {suppressedAddress} from '../../lib/email/suppression';
import type {SalesSequenceCommand,SalesSequenceQuery} from '../../lib/portable-sales-sequences';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {workspaceEmailBlocked} from './email-suppression-store';
import {loginIdentities} from './identity-schema';
import {jobClock} from './job-store';
import {portableJobs} from './job-schema';
import {scheduledGmail} from './scheduled-gmail-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {salesEnrollments as enrollments,salesSequenceActivations as activations,salesSequenceSteps as steps,salesSequences as sequences} from './sales-sequence-schema';
import {activeWorkspaceAssignee,assigneeLabel} from './workspace-assignee-store';
import {workspaceViewers} from './workspace-viewer-schema';
import {privateWorkspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const limit=25;
const notFound=()=>new ApiError(404,'Sequence, enrollment or workspace unavailable.');
const definitionScope=(ws:string,id:string)=>and(eq(sequences.workspaceId,ws),eq(sequences.id,id));
const enrollmentScope=(ws:string,id:string)=>and(eq(enrollments.workspaceId,ws),eq(enrollments.id,id));
const stepScope=(ws:string,id:string)=>and(eq(steps.workspaceId,ws),eq(steps.enrollmentId,id));
const summary={id:sequences.id,name:sequences.name,revision:sequences.revision,stepCount:sql<number>`jsonb_array_length(${sequences.steps})`,
  createdAt:sequences.createdAt,updatedAt:sequences.updatedAt};
const enrollmentFields={id:enrollments.id,sequenceId:enrollments.sequenceId,sequenceRevision:enrollments.sequenceRevision,
  sequenceName:enrollments.sequenceName,contactId:enrollments.contactId,contactName:enrollments.contactName,
  contactAvailable:sql<boolean>`EXISTS (SELECT 1 FROM ${contacts} WHERE ${contacts.workspaceId}=${enrollments.workspaceId}
    AND ${contacts.id}=${enrollments.contactId} AND ${activeContact})`,
  recipient:enrollments.recipient,actorId:enrollments.actorId,sender:enrollments.sender,assigneeId:enrollments.assigneeId,
  assigneeLabel:enrollments.assigneeLabel,state:enrollments.state,issue:enrollments.issue,createdAt:enrollments.createdAt,
  finishedAt:enrollments.finishedAt,activeActivation:isNotNull(activations.enrollmentId),bookingStopPending:isNotNull(activations.teamBookingId)};
function selectEnrollments(tx:Tx){
  return tx.select(enrollmentFields).from(enrollments).leftJoin(activations,and(
    eq(activations.workspaceId,enrollments.workspaceId),eq(activations.enrollmentId,enrollments.id)));
}
const listPage=<T extends {id:string}>(rows:T[])=>({items:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null});

async function enrollmentPage<T extends {id:string;contactId:string}>(tx:Tx,ws:string,rows:T[],actor?:RecordAccessActor){
  const page=listPage(rows);
  if(actor)await recordAccess(tx,actor,'contacts','related',[...new Set(page.items.map(row=>row.contactId))],ws);
  return page;
}

async function enrollmentDetail(tx:Tx,ws:string,id:string,actor?:RecordAccessActor){
  const [enrollment]=await selectEnrollments(tx).where(enrollmentScope(ws,id));
  if(!enrollment)throw notFound();
  const history=await tx.select({id:steps.id,position:steps.position,definition:steps.definition,state:steps.state,dueAt:steps.dueAt,
    finishedAt:steps.finishedAt,jobId:steps.jobId,taskId:steps.taskId,issue:steps.issue,jobState:portableJobs.status,dispatchStartedAt:scheduledGmail.dispatchStartedAt})
    .from(steps).leftJoin(portableJobs,and(eq(portableJobs.workspaceId,steps.workspaceId),eq(portableJobs.id,steps.jobId)))
    .leftJoin(scheduledGmail,and(eq(scheduledGmail.workspaceId,steps.workspaceId),eq(scheduledGmail.jobId,steps.jobId)))
    .where(stepScope(ws,id)).orderBy(asc(steps.position)).limit(20);
  if(actor)await recordPreviewAccess(tx,actor,'related',[
    {kind:'contacts',id:enrollment.contactId},
    ...history.flatMap(step=>step.taskId?[{kind:'tasks',id:step.taskId}]:[]),
  ],ws);
  return {enrollment,steps:history};
}

export async function readSalesSequences(db:Db,actor:RecordAccessActor,query:SalesSequenceQuery,includeBody=true){
  const actorId=actor.userId;
  const reader=includeBody?actor:undefined;
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actorId));
    if(query.view==='assignees'){
      const page=query.page??0;
      let eligible;
      if(query.contactId){
        if(!workspace)throw notFound();
        const [target]=await tx.select({id:contacts.id}).from(contacts)
          .where(and(eq(contacts.workspaceId,workspace.id),eq(contacts.id,query.contactId),activeContact));
        if(!target)throw notFound();
        eligible=and(sequenceRepCanEditContact(tx,loginIdentities.id,workspace.id,target.id),
          query.emailOnly?undefined:sequenceRepCanWorkTasks(tx,loginIdentities.id,workspace.id));
      }else if(workspace){
        eligible=sql`EXISTS(SELECT 1 FROM ${workspaceViewers} WHERE ${workspaceViewers.workspaceId}=${workspace.id}
          AND ${workspaceViewers.viewerId}=${loginIdentities.id} AND ${workspaceViewers.role}='editor'
          AND ${toolLevel('contacts','edit')}='all' AND ${toolLevel('tasks','edit')}='all')`;
      }
      const rows=await tx.select({id:loginIdentities.id,name:loginIdentities.fullName,email:loginIdentities.email}).from(loginIdentities)
        .where(or(eq(loginIdentities.id,actorId),eligible))
        .orderBy(sql`CASE WHEN ${loginIdentities.id}=${actorId} THEN 0 ELSE 1 END`,asc(loginIdentities.id)).offset(page*limit).limit(limit+1);
      return {items:rows.slice(0,limit).map(row=>({id:row.id,label:assigneeLabel(row)})),next:rows.length>limit?page+1:null};
    }
    if(!workspace){
      if(query.sequenceId||query.enrollmentId||query.contactId||query.bookingId)throw notFound();
      return {items:[],next:null};
    }
    const ws=workspace.id;
    if(query.sequenceId){
      const [sequence]=await tx.select({...summary,steps:sequences.steps}).from(sequences).where(definitionScope(ws,query.sequenceId));
      if(!sequence)throw notFound();
      return {sequence};
    }
    if(query.enrollmentId)return enrollmentDetail(tx,ws,query.enrollmentId,reader);
    if(query.contactId||query.view==='enrollments'){
      if(query.contactId){
        const [contact]=await tx.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,ws),eq(contacts.id,query.contactId),activeContact));
        if(!contact)throw notFound();
      }
      if(query.state){
        const [booking]=query.bookingId?await tx.select({email:teamBookings.email,title:teamBookings.title,cancelled:teamBookings.cancelled})
          .from(teamBookings).where(and(eq(teamBookings.workspaceId,ws),eq(teamBookings.id,query.bookingId))):[];
        if(query.bookingId&&!booking)throw notFound();
        const guestContacts=booking?tx.select({id:contacts.id}).from(contacts).where(and(eq(contacts.workspaceId,ws),activeContact,
          sql`lower(${contacts.data}->>'email')=${booking.email}`)):undefined;
        const [cursor]=query.after?await tx.select({at:enrollments.createdAt}).from(enrollments).where(enrollmentScope(ws,query.after)):[];
        if(query.after&&!cursor)throw notFound();
        const page=await enrollmentPage(tx,ws,await selectEnrollments(tx).where(and(eq(enrollments.workspaceId,ws),
          query.assignee?unavailableSequenceAssignee(tx,actorId):undefined,
          guestContacts?inArray(enrollments.contactId,guestContacts):undefined,
          eq(enrollments.state,query.state),cursor?sql`(${enrollments.createdAt},${enrollments.id}) < (${cursor.at},${query.after})`:undefined))
          .orderBy(desc(enrollments.createdAt),desc(enrollments.id)).limit(limit+1),reader);
        return booking?{...page,booking}:page;
      }
      return enrollmentPage(tx,ws,await selectEnrollments(tx).where(and(eq(enrollments.workspaceId,ws),
        query.contactId?eq(enrollments.contactId,query.contactId):undefined,query.after?gt(enrollments.id,query.after):undefined))
        .orderBy(asc(enrollments.id)).limit(limit+1),reader);
    }
    return listPage(await tx.select(summary).from(sequences).where(and(eq(sequences.workspaceId,ws),query.after?gt(sequences.id,query.after):undefined))
      .orderBy(asc(sequences.id)).limit(limit+1));
  },{isolationLevel:'repeatable read',accessMode:includeBody?'read write':'read only'});
}

export async function writeSalesSequences(db:Db,actor:RecordAccessActor,command:SalesSequenceCommand,sender:string|null=null){
  const actorId=actor.userId;
  return db.transaction(async tx=>{
    const ws=await lockRecordWorkspace(tx,actorId,command.action==='save',undefined,undefined,true);
    if(!ws)throw notFound();
    const now=await jobClock(tx);
    if(command.action==='save'){
      const scope=definitionScope(ws,command.id);
      const [old]=await tx.select({...summary,steps:sequences.steps}).from(sequences).where(scope);
      if(old&&old.revision===command.expectedRevision+1&&old.name===command.name&&isDeepStrictEqual(old.steps,command.steps))return {sequence:old};
      if((old?.revision??0)!==command.expectedRevision)throw new ApiError(409,'The sequence changed. Reload before saving.');
      const values={name:command.name,revision:command.expectedRevision+1,steps:command.steps,updatedAt:now};
      const [sequence]=old?await tx.update(sequences).set(values).where(scope).returning({...summary,steps:sequences.steps}):
        await tx.insert(sequences).values({...values,workspaceId:ws,id:command.id,createdAt:now}).returning({...summary,steps:sequences.steps});
      return {sequence};
    }
    if(command.action==='stop'){
      const [previous]=await tx.select({state:enrollments.state}).from(enrollments).where(enrollmentScope(ws,command.id)).for('update');
      if(!previous)throw notFound();
      if(previous.state==='active'||previous.state==='attention'){
        await tx.delete(activations).where(and(eq(activations.workspaceId,ws),eq(activations.enrollmentId,command.id)));
        await tx.update(enrollments).set({state:'stopped',finishedAt:now}).where(enrollmentScope(ws,command.id));
        await tx.update(steps).set({state:'stopped',finishedAt:now}).where(and(stepScope(ws,command.id),inArray(steps.state,['ready','waiting','queued'])));
      }
      return enrollmentDetail(tx,ws,command.id,actor);
    }
    const [existing]=await selectEnrollments(tx).where(enrollmentScope(ws,command.id));
    if(existing){
      if(existing.sequenceId!==command.sequenceId||existing.sequenceRevision!==command.expectedRevision||existing.contactId!==command.contactId||
         existing.assigneeId!==command.assigneeId||existing.actorId!==actorId||existing.recipient!==command.recipient)
        throw new ApiError(409,'That enrollment ID already belongs to a different enrollment.');
      const receipt=await enrollmentDetail(tx,ws,command.id,actor);
      const first=receipt.steps[0];
      if(command.startStepId?first?.definition.id!==command.startStepId:first?.position!==0)
        throw new ApiError(409,'That enrollment ID already uses a different starting step.');
      return receipt;
    }
    const [sequence]=await tx.select().from(sequences).where(definitionScope(ws,command.sequenceId));
    if(!sequence)throw notFound();
    if(sequence.revision!==command.expectedRevision)throw new ApiError(409,'The sequence changed. Review the latest steps before enrolling.');
    const [prior]=await tx.select({id:enrollments.id}).from(enrollments).where(and(eq(enrollments.workspaceId,ws),eq(enrollments.sequenceId,sequence.id),
      eq(enrollments.contactId,command.contactId),inArray(enrollments.state,['active','attention']))).limit(1);
    if(prior)throw new ApiError(409,'This contact already has an open enrollment in this sequence.');
    const [contact]=await tx.select({data:contacts.data}).from(contacts).where(and(eq(contacts.workspaceId,ws),eq(contacts.id,command.contactId),activeContact)).for('share');
    if(!contact)throw notFound();
    const start=command.startStepId?sequence.steps.findIndex(step=>step.id===command.startStepId):0;
    if(start<0)throw new ApiError(409,'Choose a starting step in the reviewed sequence.');
    const remaining=sequence.steps.slice(start);
    const owner=await activeWorkspaceAssignee(tx,ws,actorId);
    const assignee=command.assigneeId===actorId?owner:await activeWorkspaceAssignee(tx,ws,command.assigneeId,
      remaining.some(step=>step.type==='task')?{tool:'tasks'}:undefined);
    if(!owner||!assignee)throw new ApiError(409,'Choose a teammate who can complete shared tasks.');
    if(command.assigneeId!==actorId){
      const [eligible]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(and(eq(privateWorkspaces.id,ws),
        sequenceRepCanEditContact(tx,command.assigneeId,ws,command.contactId)));
      if(!eligible)throw new ApiError(409,'Choose a teammate who can edit this contact.');
    }
    const needsMail=remaining.some(step=>step.type==='email');
    if(needsMail&&(!sender||sender.toLowerCase()!==owner.email.toLowerCase()))throw new ApiError(409,'Scheduled Gmail is unavailable for this owner.');
    const recipient=suppressedAddress.safeParse(contact.data.email).data;
    if((needsMail&&!command.recipient)||(command.recipient&&recipient!==command.recipient))
      throw new ApiError(409,'Review the current contact email before enrolling.');
    if(needsMail&&await workspaceEmailBlocked(tx,ws,command.recipient!))throw new ApiError(409,'This contact is on the Do not email list.');
    await tx.insert(enrollments).values({workspaceId:ws,id:command.id,sequenceId:sequence.id,sequenceRevision:sequence.revision,sequenceName:sequence.name,
      contactId:command.contactId,contactName:contact.data.name,recipient:command.recipient,sender:owner.email.toLowerCase(),actorId,
      assigneeId:assignee.id,assigneeLabel:assigneeLabel(assignee),state:'active',createdAt:now});
    await tx.insert(steps).values(remaining.map((definition,offset)=>({workspaceId:ws,enrollmentId:command.id,id:crypto.randomUUID(),position:start+offset,definition,
      state:offset===0?'ready' as const:'waiting' as const,dueAt:offset===0?now+definition.delayDays*86400000:null})));
    await tx.insert(activations).values({workspaceId:ws,enrollmentId:command.id});
    return enrollmentDetail(tx,ws,command.id,actor);
  });
}
