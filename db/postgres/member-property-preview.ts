import {and,eq,isNull,sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {memberRecordTools} from '../../lib/portable-tool-permissions';
import {portableTasks,taskOwnership} from './task-schema';
import {portableTickets,ticketOwnership} from './ticket-schema';
import {portableLeads,leadOwnership} from './portable-lead-schema';
import {objectRecords} from './custom-object-schema';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {ownedRecordScope} from './record-ownership-scope';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {privateWorkspaces} from './workspace-schema';
import {memberTeamPaths} from './workspace-team-store';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {loginIdentities} from './identity-schema';
import {portableCustomProperties as custom,portableStandardPropertyAccess as standard} from './custom-property-schema';
import {propertyVisibleTo} from './record-property-access';
import {standardPropertyVisibleTo} from './standard-property-access';

// The grant and both property catalogs must describe the same membership snapshot.
export function memberPropertyPreview(db:PostgresJsDatabase,ownerId:string,grantId:string){
  return db.transaction(async tx=>{
    const [member]=await tx.select({workspaceId:workspaceViewers.workspaceId,userId:workspaceViewers.viewerId,
      toolPolicies:workspaceViewers.toolPolicies,role:workspaceViewers.role,backupAdmin:workspaceViewers.backupAdmin,team:workspaceTeams.name,teamPaths:memberTeamPaths,
      viewScope:workspaceViewers.viewScope,editScope:workspaceViewers.editScope,email:loginIdentities.email}).from(workspaceViewers)
      .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceViewers.workspaceId))
      .innerJoin(loginIdentities,eq(loginIdentities.id,workspaceViewers.viewerId))
      .leftJoin(workspaceTeams,and(eq(workspaceTeams.workspaceId,workspaceViewers.workspaceId),eq(workspaceTeams.id,workspaceViewers.teamId)))
      .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(workspaceViewers.id,grantId)));
    if(!member)return null;
    const fields=await tx.select({kind:custom.kind,id:custom.id,label:custom.label,visible:sql<boolean>`${propertyVisibleTo(member.userId)}`})
      .from(custom).where(and(eq(custom.workspaceId,member.workspaceId),eq(custom.restricted,true)));
    const rules=await tx.select({kind:standard.kind,id:standard.id,visible:sql<boolean>`${standardPropertyVisibleTo(member.userId)}`})
      .from(standard).where(and(eq(standard.workspaceId,member.workspaceId),eq(standard.restricted,true)));
    return {grantId,toolPolicies:member.toolPolicies,email:member.email,role:member.role,backupAdmin:member.backupAdmin,team:member.team,teamPaths:member.teamPaths,viewScope:member.viewScope,editScope:member.editScope,fields,rules};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export async function checkMemberRecordAccess(db:PostgresJsDatabase,ownerId:string,memberId:string,kind:typeof memberRecordTools[number],recordId:string,objectId?:string){
  const member=alias(workspaceViewers,'preview_member');
  if(kind==='custom-objects'&&!objectId)return undefined;
  const record={contacts,companies,deals,tasks:portableTasks,tickets:portableTickets,leads:portableLeads,'custom-objects':objectRecords}[kind];
  const ownership={contacts,companies,deals,tasks:taskOwnership,tickets:ticketOwnership,leads:leadOwnership,'custom-objects':objectRecords}[kind];
  const [access]=await db.select({
    canView:ownedRecordScope(db,member.viewerId,record.workspaceId,ownership),
    canEdit:ownedRecordScope(db,member.viewerId,record.workspaceId,ownership,'edit'),
  }).from(record).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,record.workspaceId))
    .innerJoin(member,eq(member.workspaceId,record.workspaceId))
    .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(member.id,memberId),eq(record.id,recordId),isNull(record.archivedAt),
      kind==='custom-objects'?eq(objectRecords.objectId,objectId!):undefined)).limit(1);
  return access;
}
