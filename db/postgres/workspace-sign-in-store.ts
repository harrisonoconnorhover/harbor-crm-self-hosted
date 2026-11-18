import {and,eq,exists,gt,inArray,ne,notExists,sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginIdentities} from './identity-schema';
import {workspaceInvites} from './workspace-invite-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {privateWorkspaces} from './workspace-schema';

type Account={subject:string;provider?:'google'|'microsoft'}|{userId:string};

export async function workspaceSignInAllowed(db:PostgresJsDatabase,email:string,account:Account,ownerEmails:string[]){
  const owner=alias(loginIdentities,'invite_owner');
  const invitedBy=and(eq(privateWorkspaces.ownerId,owner.id),inArray(owner.email,ownerEmails));
  const subject='subject' in account&&account.provider==='microsoft'?loginIdentities.microsoftSubject:loginIdentities.googleSubject;
  const accountMatch='subject' in account?eq(subject,account.subject):eq(loginIdentities.id,account.userId);
  const otherAccount='subject' in account?sql`${subject} IS DISTINCT FROM ${account.subject}`:ne(loginIdentities.id,account.userId);
  const conflictingIdentity=db.select({id:loginIdentities.id}).from(loginIdentities)
    .where(and(eq(loginIdentities.email,email),otherAccount));
  const invitation=db.select({id:workspaceInvites.id}).from(workspaceInvites)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceInvites.workspaceId))
    .innerJoin(owner,invitedBy)
    .where(and(eq(workspaceInvites.email,email),gt(workspaceInvites.expiresAt,sql`clock_timestamp()`),notExists(conflictingIdentity)));
  const membership=db.select({id:workspaceViewers.id}).from(workspaceViewers)
    .innerJoin(loginIdentities,eq(workspaceViewers.viewerId,loginIdentities.id))
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceViewers.workspaceId))
    .innerJoin(owner,invitedBy).where(accountMatch);
  const [row]=await db.select({allowed:sql<boolean>`${exists(invitation)} OR ${exists(membership)}`}).from(sql`(SELECT 1) AS admission`);
  return row.allowed===true;
}

export async function guestWorkspaceAllowed(db:PostgresJsDatabase,actorId:string,workspaceId:string,ownerEmails:string[]){
  const [grant]=await db.select({id:workspaceViewers.id}).from(workspaceViewers)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,workspaceViewers.workspaceId))
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(workspaceViewers.workspaceId,workspaceId),eq(workspaceViewers.viewerId,actorId),
      inArray(loginIdentities.email,ownerEmails))).limit(1);
  return !!grant;
}
