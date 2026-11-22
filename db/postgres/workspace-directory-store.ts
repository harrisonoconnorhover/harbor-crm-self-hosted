import {oidcDirectoryScope,oidcSubjectKey} from '../../runtime/portable-company-oidc-config';
import {entraDirectoryScope} from '../../lib/portable-api-tokens';
import {and,asc,count,eq,isNotNull,isNull,like,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {samlDirectoryScope,samlSubject} from '../../runtime/portable-saml-config';
import {loginIdentities as identities} from './identity-schema';
import {workspaceHasRoom} from './workspace-invite-store';
import {workspaceInvites as invites} from './workspace-invite-schema';
import {workspaceViewers as members} from './workspace-viewer-schema';
import {directoryGroupMembers as assignments,directoryGroups as groups,directoryUsers as users} from './workspace-directory-schema';
import {privateWorkspaces} from './workspace-schema';
import {portableApiTokens} from './portable-api-token-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
export type DirectoryProvider={tenant:string;issuer?:undefined;protocol?:undefined}|{issuer:string;protocol:'saml'|'oidc';tenant?:undefined};
export type DirectoryScope={workspaceId:string;ownerId:string}&DirectoryProvider;
export function directoryIssuerColumn<S,O>(provider:DirectoryProvider,table:{samlIssuer:S;oidcIssuer:O}){
  return provider.protocol==='oidc'?table.oidcIssuer:table.samlIssuer;
}
export class DirectoryError extends Error{
  constructor(readonly status:number,message:string,readonly scimType?:string){super(message);}
}

export async function lockDirectory(tx:Tx,scope:DirectoryScope,tokenId:string){
  const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,scope.workspaceId),eq(privateWorkspaces.ownerId,scope.ownerId))).for('update');
  if(!workspace)throw new DirectoryError(403,'Directory access ended.');
  const credentialScope=scope.issuer===undefined?entraDirectoryScope(scope.tenant):(scope.protocol==='oidc'?oidcDirectoryScope:samlDirectoryScope)(scope.issuer);
  const [token]=await tx.select({id:portableApiTokens.id}).from(portableApiTokens)
    .where(and(eq(portableApiTokens.id,tokenId),eq(portableApiTokens.workspaceId,scope.workspaceId),eq(portableApiTokens.issuerId,scope.ownerId),
      isNull(portableApiTokens.revokedAt),sql`${portableApiTokens.expiresAt} > extract(epoch from clock_timestamp())*1000`,
      eq(portableApiTokens.scopes,[credentialScope]))).for('share');
  if(!token)throw new DirectoryError(401,'Directory token expired or revoked.');
}

type Filter={id?:string;groupId?:string;email?:string;externalId?:string;active?:boolean;role?:'editor'|'viewer'};
function userScope(scope:DirectoryScope,filter:Filter){
  const provider=scope.issuer===undefined?
    and(isNull(users.samlIssuer),like(identities.microsoftSubject,scope.tenant+':%'),
      filter.externalId?eq(identities.microsoftSubject,scope.tenant+':'+filter.externalId):undefined):
    and(eq(directoryIssuerColumn(scope,users),scope.issuer),filter.externalId?eq(users.samlExternalId,filter.externalId):undefined);
  return and(eq(users.workspaceId,scope.workspaceId),provider,
    filter.active===undefined?undefined:filter.active?isNotNull(members.id):isNull(members.id),
    filter.role?eq(members.role,filter.role):undefined,
    filter.id?eq(users.id,filter.id):undefined,filter.email?eq(identities.email,filter.email):undefined);
}
const fields={id:users.id,userId:users.userId,email:identities.email,displayName:users.displayName,subject:identities.microsoftSubject,
  externalId:sql<string>`coalesce(${users.samlExternalId}, split_part(${identities.microsoftSubject}, ':', 2))`.as('external_id'),
  groupId:groups.groupId,groupName:sql<string|null>`${groups.displayName}`.as('group_name'),role:members.role,active:sql<boolean>`${isNotNull(members.id)}`.as('active')};
export async function directoryPage(tx:Tx,scope:DirectoryScope,filter:Filter,start:number,size:number){
  const where=and(userScope(scope,filter),filter.groupId?eq(groups.groupId,filter.groupId):undefined);
  const identity=eq(identities.id,users.userId);
  const membership=and(eq(members.workspaceId,users.workspaceId),eq(members.viewerId,users.userId));
  const roster=tx.select(fields).from(users).innerJoin(identities,identity)
    .leftJoin(members,membership)
    .leftJoin(assignments,and(eq(assignments.workspaceId,users.workspaceId),eq(assignments.userId,users.userId)))
    .leftJoin(groups,and(eq(groups.workspaceId,assignments.workspaceId),eq(groups.groupId,assignments.groupId),
      eq(groups.teamId,members.teamId),scope.issuer===undefined?eq(groups.tenant,scope.tenant):eq(directoryIssuerColumn(scope,groups),scope.issuer)))
    .where(where).as('directory_roster');
  const [total]=await tx.select({value:count()}).from(roster);
  const rows=size===0?[]:await tx.select().from(roster).orderBy(asc(roster.id)).offset(start-1).limit(size);
  return {total:total.value,rows};
}
export async function directoryUser(tx:Tx,scope:DirectoryScope,id:string){
  const [row]=(await directoryPage(tx,scope,{id},1,1)).rows;
  if(!row)throw new DirectoryError(404,'Employee not found.');
  return row;
}

type DirectoryRole='viewer'|'editor';
export async function setDirectoryAccess(tx:Tx,scope:DirectoryScope,userId:string,active:boolean,role?:DirectoryRole){
  if(userId===scope.ownerId)throw new DirectoryError(409,'The workspace owner is managed separately.');
  const match=and(eq(members.workspaceId,scope.workspaceId),eq(members.viewerId,userId));
  if(!active){await tx.delete(members).where(match);return;}
  const [member]=await tx.select({id:members.id,role:members.role}).from(members).where(match).for('update');
  if(member){
    if(role&&role!==member.role)await tx.update(members).set({role,id:crypto.randomUUID(),...(role==='viewer'?{backupAdmin:false}:{editScope:'owned' as const})}).where(match);
    return;
  }
  if(!await workspaceHasRoom(tx,scope.workspaceId))throw new DirectoryError(409,'No seats available.');
  await tx.insert(members).values({id:crypto.randomUUID(),workspaceId:scope.workspaceId,viewerId:userId,
    role:role??'viewer',viewScope:'owned',editScope:'owned'});
}

export async function createDirectoryUser(tx:Tx,scope:DirectoryScope,input:{userName:string;externalId:string;active:boolean;role?:DirectoryRole;displayName?:string|null;directoryAuthority:string|null}){
  const now=Date.now();
  const subject=scope.protocol==='oidc'?oidcSubjectKey(scope.issuer,input.externalId):
    scope.protocol==='saml'?samlSubject(scope.issuer,input.externalId):scope.tenant+':'+input.externalId;
  const subjectKey=scope.protocol==='oidc'?'oidcSubject':scope.protocol==='saml'?'samlSubject':'microsoftSubject';
  const issuerKey=scope.protocol==='oidc'?'oidcDirectoryIssuer':'samlDirectoryIssuer';
  const subjectColumn=identities[subjectKey];
  // Share the sign-in store's address lock so a concurrent callback cannot adopt this email.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userName},0))`);
  const conflicts=await tx.select({id:identities.id,email:identities.email,subject:subjectColumn,
    authority:identities.directoryAuthority,issuer:identities[issuerKey]}).from(identities)
    .where(or(eq(identities.email,input.userName),eq(subjectColumn,subject))).limit(2);
  if(conflicts.length>1||conflicts.some(row=>row.email!==input.userName||row.subject!==subject))
    throw new DirectoryError(409,'This identity is already in use.','uniqueness');
  if(input.directoryAuthority&&(input.directoryAuthority!==scope.workspaceId||conflicts.some(row=>
    row.authority!==scope.workspaceId||(scope.issuer!==undefined&&row.issuer!==scope.issuer))))
    throw new DirectoryError(409,'This sign-in identity is managed separately.','uniqueness');
  const userId=conflicts[0]?.id??crypto.randomUUID();
  if(userId===scope.ownerId)throw new DirectoryError(409,'The workspace owner is managed separately.');
  if(!conflicts.length){
    const [identity]=await tx.insert(identities).values({id:userId,
      [subjectKey]:subject,...(input.directoryAuthority&&scope.issuer?{[issuerKey]:scope.issuer}:{}),
      directoryAuthority:input.directoryAuthority,email:input.userName,createdAt:now,updatedAt:now,
    }).onConflictDoNothing().returning({id:identities.id});
    if(!identity)throw new DirectoryError(409,'This identity is already in use.','uniqueness');
  }
  const existing=await tx.select({id:users.id}).from(users).where(and(eq(users.workspaceId,scope.workspaceId),eq(users.userId,userId)));
  if(existing.length)throw new DirectoryError(409,'This directory employee already exists.','uniqueness');
  const manual=await tx.select({id:members.id}).from(members).where(and(eq(members.workspaceId,scope.workspaceId),eq(members.viewerId,userId)));
  if(manual.length)throw new DirectoryError(409,'Remove the existing manual membership before assigning directory access.');
  // This reservation converts to the directory seat. A stale invite link can no longer grant access.
  await tx.delete(invites).where(and(eq(invites.workspaceId,scope.workspaceId),eq(invites.email,input.userName)));
  const id=crypto.randomUUID();
  await tx.insert(users).values({id,workspaceId:scope.workspaceId,userId,displayName:input.displayName,
     ...(scope.issuer?{[scope.protocol==='oidc'?'oidcIssuer':'samlIssuer']:scope.issuer,samlExternalId:input.externalId}:{})});
  await setDirectoryAccess(tx,scope,userId,input.active,input.role);
  return directoryUser(tx,scope,id);
}
export async function setDirectoryDisplayName(tx:Tx,scope:DirectoryScope,id:string,displayName:string|null){
  await tx.update(users).set({displayName}).where(and(eq(users.workspaceId,scope.workspaceId),eq(users.id,id)));
}
export async function deleteDirectoryUser(tx:Tx,scope:DirectoryScope,id:string,userId:string){
  await setDirectoryAccess(tx,scope,userId,false);
  await tx.delete(users).where(and(eq(users.workspaceId,scope.workspaceId),eq(users.id,id)));
}
