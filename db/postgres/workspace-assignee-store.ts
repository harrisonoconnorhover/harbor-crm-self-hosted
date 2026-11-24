import type {MemberTool} from '../../lib/portable-tool-permissions';
import {canEditAssignedRecord,toolLevel} from './member-tool-access';
import {and,asc,eq,exists,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordOwner} from '../../lib/portable-records';
import {ownedRecordScope} from './record-ownership-scope';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import {workspaceViewers} from './workspace-viewer-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const identityColumns={id:loginIdentities.id,email:loginIdentities.email,name:loginIdentities.fullName};
export const assigneeLabel=(member:{name:string|null;email:string})=> (member.name?.trim()||member.email).slice(0,100);

const canClaimInbox=sql<boolean>`${toolLevel('team-inbox','edit')}='all'`;
export const canWorkTask=canEditAssignedRecord('tasks');
export const canTakeTicket=canEditAssignedRecord('tickets');
export const canWorkLead=canEditAssignedRecord('leads');
type AssignmentRequirements={conversation?:boolean;tool?:MemberTool};

export async function activeWorkspaceAssignee(tx:Transaction,workspaceId:string,id:string,needed?:AssignmentRequirements){
  const [owner]=await tx.select(identityColumns).from(loginIdentities)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.ownerId,loginIdentities.id))
    .where(and(eq(privateWorkspaces.id,workspaceId),eq(loginIdentities.id,id)));
  if(owner)return owner;
  const [member]=await tx.select(identityColumns).from(loginIdentities)
    .innerJoin(workspaceViewers,eq(workspaceViewers.viewerId,loginIdentities.id))
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,id),
      eq(workspaceViewers.role,'editor'),needed?.conversation?canClaimInbox:undefined,
      needed?.tool?canEditAssignedRecord(needed.tool):undefined)).for('share');
  return member;
}

export async function resolvePortableRecordOwner(tx:Transaction,workspaceId:string,
  assigneeId:string|null|undefined,current?:PortableRecordOwner,needed?:AssignmentRequirements):Promise<PortableRecordOwner|undefined|false>{
  if(assigneeId===undefined)return current;
  if(assigneeId===null)return undefined;
  const member=await activeWorkspaceAssignee(tx,workspaceId,assigneeId,needed);
  return member?{userId:member.id,workspaceId,label:assigneeLabel(member)}:false;
}

// Called under the workspace and current editor-grant locks held by the record writer.
export async function resolveCoreRecordOwner(tx:Transaction,workspaceId:string,actorId:string,shared:boolean,tool:MemberTool,
  assigneeId:string|null|undefined,current:PortableRecordOwner|undefined,creating:boolean){
  // A scoped creator may be credited automatically for intake even when they cannot edit.
  // Check explicit assignments, including a handoff to the current assignee.
  const needed=assigneeId!==undefined?{tool}:undefined;
  const resolve=(id:string|null|undefined)=>resolvePortableRecordOwner(tx,workspaceId,id,current,needed);
  if(!shared||(!creating&&assigneeId===undefined))return resolve(assigneeId);
  const mode=creating?'view':'edit';
  const [grant]=await tx.select({scope:toolLevel(tool,mode),base:workspaceViewers.editScope}).from(workspaceViewers)
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId)));
  if(!grant)return false;
  if(grant.scope==='none')return false;
  if(grant.scope==='all'&&(!creating||grant.base==='all'))return resolve(assigneeId);
  const target=assigneeId===undefined&&creating?actorId:assigneeId;
  if(!target)return false;
  const targetOwner={workspaceId:sql`${workspaceId}::uuid`,
    data:sql`${JSON.stringify({recordOwner:{workspaceId,userId:target}})}::jsonb`};
  const permitted=and(ownedRecordScope(tx,actorId,workspaceId,targetOwner,mode,undefined,undefined,tool),
    creating?ownedRecordScope(tx,actorId,workspaceId,targetOwner,'edit'):undefined);
  const [allowed]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,workspaceId),permitted));
  return allowed?resolve(target):false;
}

export async function portableWorkspaceAssignees(db:PostgresJsDatabase,actorId:string,workspaceId?:string,eligibility?:'inbox',tool?:MemberTool):Promise<{id:string;label:string;canClaim?:boolean;canTakeTicket?:boolean;canReceive?:boolean}[]>{
  const recipient=tool?canEditAssignedRecord(tool):undefined;
  return db.transaction(async tx=>{
    if(workspaceId){
      const [actor]=await tx.select({scope:toolLevel(tool,'edit')}).from(workspaceViewers)
        .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.role,'editor')));
      if(!actor)return [];
      if(actor.scope!=='all'){
        if(eligibility)return [];
        const eligible=ownedRecordScope(tx,actorId,workspaceId,{workspaceId:sql`${workspaceId}::uuid`,
          data:sql`jsonb_build_object('recordOwner',jsonb_build_object('workspaceId',${workspaceId}::text,'userId',${loginIdentities.id}))`},'edit',undefined,undefined,tool);
        // Core CRM screens also use this roster to tell whether a manager can repair a
        // record in their team. Retain those editors and flag which can receive new work.
        const forRecordList=tool==='contacts'||tool==='companies'||tool==='deals';
        const members=await tx.select({...identityColumns,...(forRecordList&&recipient?{canReceive:recipient}:{})}).from(loginIdentities).innerJoin(workspaceViewers,eq(workspaceViewers.viewerId,loginIdentities.id))
          .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.role,'editor'),forRecordList?undefined:recipient,eligible))
          .orderBy(asc(loginIdentities.fullName),asc(loginIdentities.email),asc(loginIdentities.id));
        return members.map(member=>({id:member.id,label:assigneeLabel(member),canReceive:member.canReceive}));
      }
    }
    const requester=tx.select({id:workspaceViewers.id}).from(workspaceViewers).where(and(
      eq(workspaceViewers.workspaceId,privateWorkspaces.id),eq(workspaceViewers.viewerId,actorId),eq(workspaceViewers.viewScope,'all'),eq(workspaceViewers.role,'editor')));
    const [owner]=await tx.select({...identityColumns,workspaceId:privateWorkspaces.id}).from(privateWorkspaces)
      .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
      .where(workspaceId?and(eq(privateWorkspaces.id,workspaceId),exists(requester)):eq(privateWorkspaces.ownerId,actorId)).limit(1);
    if(!owner){
      if(workspaceId)return [];
      // The owner can assign their first record to themselves before the workspace exists.
      const [identity]=await tx.select(identityColumns).from(loginIdentities).where(eq(loginIdentities.id,actorId)).limit(1);
      return identity?[{id:identity.id,label:assigneeLabel(identity),...(eligibility==='inbox'?{canClaim:true,canTakeTicket:true}:{})}]:[];
    }
    const editors=await tx.select({...identityColumns,...(eligibility?{canClaim:canClaimInbox,canTakeTicket}:{})}).from(workspaceViewers)
      .innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
      .where(and(eq(workspaceViewers.workspaceId,owner.workspaceId),eq(workspaceViewers.role,'editor'),
        recipient))
      .orderBy(asc(loginIdentities.fullName),asc(loginIdentities.email),asc(loginIdentities.id));
    return [{...owner,canClaim:true,canTakeTicket:true},...editors].map(member=>({id:member.id,
      ...(eligibility==='inbox'?{canClaim:member.canClaim,canTakeTicket:member.canTakeTicket}:{}),
      label:eligibility&&member.name?.trim()?member.name.trim()+' ('+member.email+')':assigneeLabel(member)}));
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
