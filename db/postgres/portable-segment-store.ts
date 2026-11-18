import {activeContact} from './contact-visibility';
import {and,asc,eq,exists,gt,ilike,inArray,isNotNull,notExists,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {digest} from '../../lib/api-access';
import type {PortableSegment,PortableSegmentList,PortableSegmentMembers,PortableSegmentMembershipReceipt,
  PortableSegmentRead,PortableSegmentWrite} from '../../lib/portable-segments';
import {contacts} from './contact-schema';
import {portableSegmentMembers as members,portableSegmentMembershipReceipts as receipts,portableSegments as segments} from './portable-segment-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordSearchPattern} from './record-search';
import {portableSegmentMatch} from './portable-segment-match';
import {dealWorkflows,segmentWorkflowScans as scans} from './workflow-schema';
import {privateWorkspaces} from './workspace-schema';

const fields={id:segments.id,name:segments.name,description:segments.description,revision:segments.revision,
  mode:segments.mode,criteria:segments.criteria,createdAt:segments.createdAt,updatedAt:segments.updatedAt};
const contactSegment=(row:Omit<PortableSegment,'kind'>):PortableSegment=>({...row,kind:'contacts'});
const contactName=sql<string>`${contacts.data}->>'name'`;
const contactEmail=sql<string>`coalesce(${contacts.data}->>'email','')`;
const memberScope=(workspaceId:string,segmentId:string)=>and(eq(members.workspaceId,workspaceId),eq(members.segmentId,segmentId));

export async function readPortableSegments(db:PostgresJsDatabase,actorId:string,query:PortableSegmentRead):Promise<PortableSegmentList|PortableSegmentMembers|null>{
  const owner=eq(privateWorkspaces.ownerId,actorId);
  const pattern=recordSearchPattern(query.q);
  if('id' in query){
    // Use the same snapshot for the definition, total and cursor page.
    return db.transaction(async tx=>{
      const [saved]=await tx.select({...fields,workspaceId:segments.workspaceId}).from(segments)
        .innerJoin(privateWorkspaces,eq(segments.workspaceId,privateWorkspaces.id))
        .where(and(owner,eq(segments.id,query.id))).limit(1);
      if(!saved)return null;
      const {workspaceId,...row}=saved;
      const segment=contactSegment(row);
      if(query.candidates&&segment.mode!=='static')return null;
      const membership=tx.select({id:members.contactId}).from(members)
        .where(and(memberScope(workspaceId,segment.id),eq(members.contactId,contacts.id)));
      const audience=segment.mode==='active'?portableSegmentMatch(contacts.data,segment.criteria):
        query.candidates?notExists(membership):exists(membership);
      const scope=and(eq(contacts.workspaceId,workspaceId),activeContact,audience,
        pattern?or(ilike(contactName,pattern),ilike(contactEmail,pattern)):undefined);
      const [count]=await tx.select({total:sql<string>`count(*)::text`}).from(contacts).where(scope);
      const rows=await tx.select({id:contacts.id,name:contactName,
        email:contactEmail,lifecycle:sql<string|null>`${contacts.data}->>'lifecycle'`})
        .from(contacts).where(and(scope,query.after?gt(contacts.id,query.after):undefined))
        .orderBy(asc(contacts.id)).limit(query.limit+1);
      const items=rows.slice(0,query.limit);
      return {segment,items,total:count.total,next:rows.length>query.limit?items.at(-1)!.id:null};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
  }
  const rows=await db.select(fields).from(segments).innerJoin(privateWorkspaces,eq(segments.workspaceId,privateWorkspaces.id))
    .where(and(owner,query.activeOnly?eq(segments.mode,'active'):undefined,
      pattern?ilike(segments.name,pattern):undefined,query.after?gt(segments.id,query.after):undefined))
    .orderBy(asc(segments.id)).limit(query.limit+1);
  const page=rows.slice(0,query.limit);
  return {segments:page.map(contactSegment),next:rows.length>query.limit?page.at(-1)!.id:null};
}

type WriteError='missing'|'stale'|'in_use'|'mode'|'not_static'|'invalid_contacts'|'request_conflict';
type WriteResult={segment:PortableSegment}|{ok:true}|{receipt:PortableSegmentMembershipReceipt}|{error:WriteError};
type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Current=Pick<typeof segments.$inferSelect,'revision'|'mode'|'staticGeneration'|'criteria'>;

async function changeMembers(tx:Tx,workspaceId:string,current:Current,input:Extract<PortableSegmentWrite,{action:'members'}>):Promise<WriteResult>{
  const {id,requestId,revision,operation,contactIds}=input;
  const fingerprint=await digest(JSON.stringify([revision,operation,[...contactIds].sort()]));
  const [prior]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
  if(prior){
    if(prior.segmentId!==id||prior.staticGeneration!==current.staticGeneration||prior.fingerprint!==fingerprint)
      return {error:'request_conflict'};
    return {receipt:{id,requestId,revision:prior.revision}};
  }
  const {staticGeneration}=current;
  if(!staticGeneration)return {error:'not_static'};
  if(current.revision!==revision)return {error:'stale'};
  const eligible=await tx.select({id:contacts.id}).from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),activeContact,inArray(contacts.id,contactIds)));
  if(eligible.length!==contactIds.length)return {error:'invalid_contacts'};
  if(operation==='add'){
    await tx.insert(members).values(contactIds.map(contactId=>({workspaceId,segmentId:id,contactId}))).onConflictDoNothing();
  }else{
    await tx.delete(members).where(and(memberScope(workspaceId,id),inArray(members.contactId,contactIds)));
  }
  const next=revision+1;
  await tx.update(segments).set({revision:next,updatedAt:new Date().toISOString()})
    .where(and(eq(segments.workspaceId,workspaceId),eq(segments.id,id)));
  await tx.insert(receipts).values({workspaceId,requestId,segmentId:id,staticGeneration,fingerprint,revision:next});
  return {receipt:{id,requestId,revision:next}};
}

export function writePortableSegment(db:PostgresJsDatabase,actorId:string,input:PortableSegmentWrite):Promise<WriteResult>{
  return db.transaction(async tx=>{
    const creating=input.action==='save'&&input.segment.revision===0;
    const workspaceId=await lockRecordWorkspace(tx,actorId,creating,undefined,undefined,true);
    if(!workspaceId)return {error:'missing'};
    const id=input.action==='save'?input.segment.id:input.id;
    const scope=and(eq(segments.workspaceId,workspaceId),eq(segments.id,id));
    const criteriaUnchanged=input.action==='save'&&input.segment.mode==='active'
      ?sql<boolean>`${segments.criteria} = ${JSON.stringify(input.segment.criteria)}::jsonb`
      :sql<boolean>`false`;
    const [current]=await tx.select({revision:segments.revision,mode:segments.mode,staticGeneration:segments.staticGeneration,
      criteria:segments.criteria,criteriaUnchanged}).from(segments).where(scope).for('update');
    if(input.action==='members')return current?changeMembers(tx,workspaceId,current,input):{error:'missing'};
    if(!current&&!creating)return {error:'missing'};
    const revision=input.action==='save'?input.segment.revision:input.revision;
    if(current&&current.revision!==revision)return {error:'stale'};
    if(input.action==='delete'){
      const [workflow]=await tx.select({id:dealWorkflows.id}).from(dealWorkflows).where(and(
        eq(dealWorkflows.workspaceId,workspaceId),sql`${dealWorkflows.definition}->>'segmentId'=${id}`)).limit(1);
      if(workflow)return {error:'in_use'};
      await tx.delete(segments).where(scope);
      return {ok:true};
    }
    const {name,description,criteria,mode,initialMembers}=input.segment;
    if(current&&current.mode!==mode)return {error:'mode'};
    const values={name,description,criteria:current?.mode==='static'?current.criteria:criteria,updatedAt:new Date().toISOString()};
    const [saved]=current
      ?await tx.update(segments).set({...values,revision:revision+1}).where(scope).returning(fields)
      :await tx.insert(segments).values({...values,workspaceId,id,mode,staticGeneration:mode==='static'?crypto.randomUUID():null,
        revision:1,createdAt:values.updatedAt})
        .onConflictDoNothing({target:[segments.workspaceId,segments.id]}).returning(fields);
    if(!saved)return {error:'stale'};
    if(current?.criteriaUnchanged){
      // Preserve the scan under the same workspace lock. A scan still on an
      // older revision must establish a baseline for its pending criteria change.
      await tx.update(scans).set({segmentRevision:saved.revision}).from(dealWorkflows).where(and(
        eq(scans.workspaceId,workspaceId),eq(scans.segmentRevision,current.revision),isNotNull(scans.nextAt),
        eq(dealWorkflows.workspaceId,scans.workspaceId),eq(dealWorkflows.id,scans.workflowId),
        sql`${dealWorkflows.definition}->>'trigger'='contact_segment'`,
        sql`${dealWorkflows.definition}->>'segmentId'=${id}`));
    }
    if(initialMembers==='snapshot'){
      await tx.execute(sql`INSERT INTO ${members} (workspace_id,segment_id,contact_id)
        SELECT ${contacts.workspaceId},${id}::uuid,${contacts.id} FROM ${contacts}
        WHERE ${and(eq(contacts.workspaceId,workspaceId),activeContact,portableSegmentMatch(contacts.data,criteria))}`);
    }
    return {segment:contactSegment(saved)};
  });
}
