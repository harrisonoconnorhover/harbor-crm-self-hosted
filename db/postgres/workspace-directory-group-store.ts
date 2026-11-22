import {and,asc,count,eq,inArray,isNotNull,like,ne,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginIdentities as identities} from './identity-schema';
import {directoryGroups as groups,directoryGroupMembers as assignments,directoryUsers as users} from './workspace-directory-schema';
import {directoryIssuerColumn,DirectoryError,type DirectoryProvider,type DirectoryScope as Scope} from './workspace-directory-store';
import {privateWorkspaces} from './workspace-schema';
import {workspaceTeams as teams} from './workspace-team-schema';
import {workspaceViewers as members} from './workspace-viewer-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Filter={id:string}|{externalId:string}|{displayName:string}|{memberId:string};
type Group={id:string;externalId:string|null;displayName:string;members:string[]};
export type DirectoryGroupChange={op:'rename';displayName:string}|{op:'add'|'remove'|'replace';members:string[]};

const providerScope=(provider:DirectoryProvider)=>provider.issuer!==undefined?eq(directoryIssuerColumn(provider,groups),provider.issuer):eq(groups.tenant,provider.tenant);
const directoryScope=(scope:Scope)=>and(eq(groups.workspaceId,scope.workspaceId),providerScope(scope));
const approvedKey=(scope:DirectoryProvider,key:string)=>scope.issuer!==undefined?
  sql`lower(${groups.samlGroupName})=lower(${key})`:eq(groups.externalId,key);
const externalKey=(scope:DirectoryProvider)=>scope.issuer!==undefined?groups.samlExternalId:groups.externalId;
export function readDirectoryGroupMappings(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,provider:DirectoryProvider){
  const key=provider.issuer!==undefined?groups.samlGroupName:groups.externalId;
  return db.select({teamId:groups.teamId,groupKey:sql<string>`${key}`,
    ...(provider.issuer!==undefined?{directoryId:groups.samlExternalId}:{}),groupId:groups.groupId,displayName:groups.displayName})
    .from(groups).where(and(eq(groups.workspaceId,workspaceId),providerScope(provider))).orderBy(asc(groups.teamId));
}

async function lockOwner(tx:Tx,scope:Scope){
  const [owner]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,scope.workspaceId),eq(privateWorkspaces.ownerId,scope.ownerId))).for('update');
  if(!owner)throw new DirectoryError(403,'Only the workspace owner can manage directory group mappings.');
}

export async function mapDirectoryGroup(tx:Tx,scope:Scope,teamId:string,externalId:string,expectedExternalId?:string){
  await lockOwner(tx,scope);
  const [team]=await tx.select({id:teams.id}).from(teams).where(and(eq(teams.workspaceId,scope.workspaceId),eq(teams.id,teamId)));
  if(!team)throw new DirectoryError(404,'Team not found.');
  const match=and(providerScope(scope),approvedKey(scope,externalId));
  const [prior]=await tx.select({teamId:groups.teamId,id:groups.groupId,
    ...(scope.issuer!==undefined?{directoryId:groups.samlExternalId}:{}),matches:sql<boolean>`${match}`}).from(groups)
    .where(and(eq(groups.workspaceId,scope.workspaceId),or(eq(groups.teamId,teamId),match)));
  if(prior){
    if(prior.teamId!==teamId||!prior.matches)throw new DirectoryError(409,'The team or directory group already has a mapping.','uniqueness');
    if(!expectedExternalId||expectedExternalId===prior.directoryId)return;
    if(prior.id||prior.directoryId)throw new DirectoryError(409,'Unlink the existing group before changing its directory ID.','uniqueness');
  }
  if(expectedExternalId){
    const [used]=await tx.select({id:groups.teamId}).from(groups).where(and(directoryScope(scope),eq(groups.samlExternalId,expectedExternalId)));
    if(used)throw new DirectoryError(409,'This directory group ID is already mapped.','uniqueness');
  }
  // Name-based push clients only gain a team after its owner has approved that name.
  // Name approval cannot take over another provisioned group's current display name.
  if(scope.issuer!==undefined){
    if(!prior){
      await requireAvailableName(tx,scope,externalId);
      await tx.execute(sql`INSERT INTO ${groups} (workspace_id,team_id,${sql.identifier(directoryIssuerColumn(scope,groups).name)},saml_group_name)
        VALUES (${scope.workspaceId},${teamId},${scope.issuer},${externalId})`);
    }
    if(expectedExternalId)await tx.update(groups).set({samlExternalId:expectedExternalId}).where(and(directoryScope(scope),eq(groups.teamId,teamId)));
  }else{
    await tx.execute(sql`INSERT INTO ${groups} (workspace_id,team_id,tenant,external_id)
      VALUES (${scope.workspaceId},${teamId},${scope.tenant},${externalId})`);
  }
}

async function clearAssignments(tx:Tx,workspaceId:string,groupId:string,teamId:string,userIds?:string[]){
  if(userIds?.length===0)return;
  const managed=and(eq(assignments.workspaceId,workspaceId),eq(assignments.groupId,groupId),
    userIds?inArray(assignments.userId,userIds):undefined);
  await tx.update(members).set({teamId:null}).where(and(eq(members.workspaceId,workspaceId),eq(members.teamId,teamId),
    inArray(members.viewerId,tx.select({id:assignments.userId}).from(assignments).where(managed))));
  await tx.delete(assignments).where(managed);
}

export async function unmapDirectoryGroup(tx:Tx,scope:Scope,teamId:string,externalId:string){
  await lockOwner(tx,scope);
  const where=and(directoryScope(scope),eq(groups.teamId,teamId),approvedKey(scope,externalId));
  const [group]=await tx.select({id:groups.groupId}).from(groups).where(where);
  if(!group)throw new DirectoryError(404,'Directory group mapping not found.');
  if(group.id)await clearAssignments(tx,scope.workspaceId,group.id,teamId);
  await tx.delete(groups).where(where);
}

// SCIM callers hold lockDirectory for their transaction. Map/unmap, team edits,
// deactivation and SCIM membership updates serialize on the same workspace row.
export async function directoryGroupPage(tx:Tx,scope:Scope,filters:Filter[],start:number,size:number,includeMembers=true){
  const predicates=filters.map(filter=>{
    if('memberId' in filter){
      const memberGroups=tx.select({id:assignments.groupId}).from(users)
        .innerJoin(assignments,and(eq(assignments.workspaceId,users.workspaceId),eq(assignments.userId,users.userId)))
        .where(and(eq(users.workspaceId,scope.workspaceId),eq(users.id,filter.memberId)));
      return inArray(groups.groupId,memberGroups);
    }
    if('id' in filter)return eq(groups.groupId,filter.id);
    if('externalId' in filter)return eq(externalKey(scope),filter.externalId);
    return sql`lower(${groups.displayName})=lower(${filter.displayName})`;
  });
  const where=and(directoryScope(scope),isNotNull(groups.groupId),...predicates);
  const [total]=await tx.select({value:count()}).from(groups).where(where);
  const result=size?await tx.select({id:groups.groupId,displayName:groups.displayName,externalId:externalKey(scope)})
    .from(groups).where(where).orderBy(asc(groups.groupId)).limit(size).offset(start-1):[];
  const rows:Group[]=result.map(row=>({id:row.id!,displayName:row.displayName!,externalId:row.externalId,members:[]}));
  if(includeMembers&&rows.length){
    const byGroup=new Map(rows.map(group=>[group.id,group]));
    const roster=await tx.select({groupId:assignments.groupId,id:users.id}).from(assignments)
      .innerJoin(users,and(eq(users.workspaceId,assignments.workspaceId),eq(users.userId,assignments.userId)))
      .where(and(eq(assignments.workspaceId,scope.workspaceId),inArray(assignments.groupId,rows.map(row=>row.id)))).orderBy(asc(users.id));
    for(const member of roster)byGroup.get(member.groupId)!.members.push(member.id);
  }
  return {total:total.value,rows};
}

export async function directoryGroup(tx:Tx,scope:Scope,id:string,includeMembers=true){
  const [group]=(await directoryGroupPage(tx,scope,[{id}],1,1,includeMembers)).rows;
  if(!group)throw new DirectoryError(404,'Directory group not found.');
  return group;
}

async function changeMembers(tx:Tx,scope:Scope,id:string,teamId:string,change:Exclude<DirectoryGroupChange,{op:'rename'}>){
  const wanted=[...new Set(change.members)];
  const found=wanted.length?await tx.select({userId:users.userId,grantId:members.id,teamId:members.teamId,groupId:assignments.groupId})
    .from(users).innerJoin(identities,eq(identities.id,users.userId))
    .leftJoin(members,and(eq(members.workspaceId,users.workspaceId),eq(members.viewerId,users.userId)))
    .leftJoin(assignments,and(eq(assignments.workspaceId,users.workspaceId),eq(assignments.userId,users.userId)))
    .where(and(eq(users.workspaceId,scope.workspaceId),scope.issuer!==undefined?
      eq(directoryIssuerColumn(scope,users),scope.issuer):like(identities.microsoftSubject,scope.tenant+':%'),inArray(users.id,wanted))):[];
  if(found.length!==wanted.length)throw new DirectoryError(400,'Group members must be directory Users in this workspace.','invalidValue');
  if(change.op==='remove'){
    await clearAssignments(tx,scope.workspaceId,id,teamId,found.map(row=>row.userId));
    return;
  }
  if(found.some(row=>!row.grantId))throw new DirectoryError(400,'Only active directory Users can be assigned to a group.','invalidValue');
  if(found.some(row=>row.groupId===id?row.teamId!==teamId:row.groupId!==null||row.teamId!==null)){
    throw new DirectoryError(409,'A requested member already has a separately managed primary team.','uniqueness');
  }
  if(change.op==='replace'){
    const present=await tx.select({userId:assignments.userId}).from(assignments)
      .where(and(eq(assignments.workspaceId,scope.workspaceId),eq(assignments.groupId,id)));
    const keep=new Set(found.map(row=>row.userId));
    await clearAssignments(tx,scope.workspaceId,id,teamId,present.map(row=>row.userId).filter(userId=>!keep.has(userId)));
  }
  const added=found.filter(row=>row.groupId!==id);
  if(added.length){
    await tx.insert(assignments).values(added.map(({userId})=>({workspaceId:scope.workspaceId,userId,groupId:id})));
    await tx.update(members).set({teamId}).where(and(eq(members.workspaceId,scope.workspaceId),inArray(members.viewerId,added.map(row=>row.userId))));
  }
}

// All SCIM mutations hold the workspace lock. Use the same comparison as the unique index.
async function requireAvailableName(tx:Tx,scope:Scope,name:string,exceptTeam?:string){
  const currentName=sql`lower(${groups.displayName})=lower(${name})`;
  const conflict=scope.issuer!==undefined?or(approvedKey(scope,name),currentName):currentName;
  const [taken]=await tx.select({id:groups.groupId}).from(groups).where(and(directoryScope(scope),conflict,
    exceptTeam?ne(groups.teamId,exceptTeam):undefined)).limit(1);
  if(taken)throw new DirectoryError(409,'A directory group with this display name already exists.','uniqueness');
}

export async function createDirectoryGroup(tx:Tx,scope:Scope,input:{externalId?:string;displayName:string;members?:string[]},includeMembers:boolean){
  const key=scope.issuer!==undefined?input.displayName:input.externalId;
  if(!key)throw new DirectoryError(400,'A directory group object ID is required.','invalidValue');
  const where=and(directoryScope(scope),approvedKey(scope,key));
  const [mapping]=await tx.select({teamId:groups.teamId,id:groups.groupId,
    ...(scope.issuer!==undefined?{directoryId:groups.samlExternalId}:{})}).from(groups).where(where);
  if(!mapping)throw new DirectoryError(403,'The workspace owner must map this directory group to a team first.');
  if(mapping.id)throw new DirectoryError(409,'This directory group is already provisioned.','uniqueness');
  if(mapping.directoryId&&mapping.directoryId!==input.externalId)throw new DirectoryError(403,'The directory group ID must match the ID approved by the workspace owner.');
  await requireAvailableName(tx,scope,input.displayName,mapping.teamId);
  if(scope.issuer!==undefined&&input.externalId){
    const [used]=await tx.select({id:groups.groupId}).from(groups).where(and(directoryScope(scope),eq(groups.samlExternalId,input.externalId),ne(groups.teamId,mapping.teamId))).limit(1);
    if(used)throw new DirectoryError(409,'This directory group identity is already in use.','uniqueness');
  }
  const id=crypto.randomUUID();
  await tx.update(groups).set({groupId:id,displayName:input.displayName,...(scope.issuer!==undefined?{samlExternalId:input.externalId}: {})}).where(where);
  if(input.members?.length)await changeMembers(tx,scope,id,mapping.teamId,{op:'add',members:input.members});
  return directoryGroup(tx,scope,id,includeMembers);
}

export async function patchDirectoryGroup(tx:Tx,scope:Scope,id:string,changes:DirectoryGroupChange[],includeMembers:boolean){
  const where=and(directoryScope(scope),eq(groups.groupId,id));
  const [mapping]=await tx.select({teamId:groups.teamId}).from(groups).where(where);
  if(!mapping)throw new DirectoryError(404,'Directory group not found.');
  for(const change of changes){
    if(change.op==='rename'){
      await requireAvailableName(tx,scope,change.displayName,mapping.teamId);
      await tx.update(groups).set({displayName:change.displayName}).where(where);
    }else await changeMembers(tx,scope,id,mapping.teamId,change);
  }
  return directoryGroup(tx,scope,id,includeMembers);
}

export async function deleteDirectoryGroup(tx:Tx,scope:Scope,id:string){
  const where=and(directoryScope(scope),eq(groups.groupId,id));
  const [mapping]=await tx.select({teamId:groups.teamId}).from(groups).where(where);
  if(!mapping)throw new DirectoryError(404,'Directory group not found.');
  await clearAssignments(tx,scope.workspaceId,id,mapping.teamId);
  if(scope.issuer!==undefined)await tx.delete(groups).where(where);
  else await tx.update(groups).set({groupId:null,displayName:null}).where(where);
}
