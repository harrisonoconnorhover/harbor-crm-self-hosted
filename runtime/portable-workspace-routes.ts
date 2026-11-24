import {checkMemberRecordAccess} from '../db/postgres/member-property-preview';
import {ApiError} from '../lib/api-error';
import {teammateAccessCsv} from './portable-teammate-access-csv';
import {accessHistoryCsv} from './portable-access-history-csv';
import {teamBookingRoute} from './portable-team-booking';
import {portableWorkspaceSeatLimit} from './portable-config.mjs';
import {mapDirectoryGroup,unmapDirectoryGroup} from '../db/postgres/workspace-directory-group-store';
import {ownedDirectoryEmployees,ownedDirectoryRoster} from '../db/postgres/workspace-directory-access';
import {DirectoryError} from '../db/postgres/workspace-directory-store';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {directoryGroupChange,samlGroupChange,teamChanges} from '../lib/portable-workspace-teams';
import {changeDirectoryTeam} from '../db/postgres/workspace-team-store';
import {z} from 'zod';
import {memberRecordTools,toolPermissionChange} from '../lib/portable-tool-permissions';
import {changeMemberToolPolicies,joinedWorkspacePage,changeWorkspaceGrant,grantWorkspaceView,lockBackupAdministrator,readManagedWorkspaceDirectory,readWorkspaceSharing,revokeWorkspaceView} from '../db/postgres/workspace-viewer-store';
import {cancelWorkspaceInvitation,changeWorkspaceInvitationRole,prepareWorkspaceInvitation,respondToWorkspaceInvitation} from '../db/postgres/workspace-invite-store';
import {lockPortableLoginSession} from '../db/postgres/identity-store';
import {recordScope,validRecordAccess,sharedRecordWriteScope,workspaceInvitationId,workspaceRole} from '../lib/portable-workspace-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableDirectoryOwnerOidcIssuer,portableDirectoryOwnerIssuer,portableDirectoryOwnerTenant,portableLoginConfig as loginConfig} from './portable-login-config';
import {portableApiIdentity} from './portable-api-identity';
import {inviteSignInEnabled,requestSessionHash} from './portable-identity';
import {portableDb} from './portable-db';
import {env} from './portable-env';

const email=z.string().trim().email().max(254).toLowerCase();
const directoryRosterQuery=z.object({directoryRoster:z.enum(['viewer','editor','inactive']),after:z.string().guid().optional(),
  teamId:z.union([z.string().guid(),z.literal('unassigned')]).optional(),includeChildren:z.literal('1').optional()}).strict()
  .refine(q=>!q.teamId||q.directoryRoster!=='inactive')
  .refine(q=>!q.includeChildren||Boolean(q.teamId&&q.teamId!=='unassigned'));
const permission={contact_files:'contactFiles',scheduled_notes:'scheduledNotes',contact_outreach:'contactOutreach',
  record_activities:'recordActivities'} as const;
const input=z.discriminatedUnion('action',[
  z.object({action:z.literal('check_member_record'),memberId:z.string().guid(),recordId:z.string().guid(),kind:z.enum(memberRecordTools),objectId:z.string().guid().optional()}).strict()
    .refine(input=>(input.kind==='custom-objects')===Boolean(input.objectId)),
  toolPermissionChange,...teamChanges,directoryGroupChange,samlGroupChange,
  z.object({action:z.literal('lookup_directory_employee'),email}).strict(),
  z.object({action:z.literal('grant'),email}).strict(),
  z.object({action:z.literal('invite'),email,teamId:z.string().guid().toLowerCase().nullish(),role:workspaceRole.default('viewer'),viewScope:recordScope.default('all'),editScope:recordScope.default('all')}).strict(),
  z.object({action:z.literal('record_scope'),id:workspaceInvitationId,viewScope:recordScope,editScope:recordScope}).strict(),
  z.object({action:z.literal('accept_invite'),id:workspaceInvitationId}).strict(),
  z.object({action:z.literal('decline_invite'),id:workspaceInvitationId}).strict(),
  z.object({action:z.literal('cancel_invite'),id:z.string().guid("Invalid uuid")}).strict(),
  z.object({action:z.literal('invite_role'),id:z.string().guid("Invalid uuid"),role:workspaceRole}).strict(),
  z.object({action:z.literal('revoke'),id:z.string().guid("Invalid uuid")}).strict(),
  z.object({action:z.literal('role'),id:z.string().guid("Invalid uuid"),role:workspaceRole}).strict(),
  z.object({action:z.enum(['contact_files','scheduled_notes','contact_outreach','record_activities','backup_admin']),
    id:z.string().guid("Invalid uuid"),enabled:z.boolean()}).strict(),
]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function workspaceRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const db=portableDb(),allowedEmails=loginConfig(env).allowedEmails;
    const guestOwners=user.guest?allowedEmails:undefined;
    const query=new URL(request.url).searchParams;
    if(query.has('joined')){
      const options=z.object({joined:z.literal('1'),q:z.string().trim().max(254).optional(),
        after:z.string().guid().optional(),current:z.string().guid().optional()}).strict().safeParse(Object.fromEntries(query));
      if(request.method!=='GET'||!options.success||query.size!==new Set(query.keys()).size)return json({error:'Invalid workspace search.'},400);
      const page=await joinedWorkspacePage(db,user.userId,guestOwners,options.data);
      return page?json(page):json({error:'Workspace access changed. Reopen Workspaces.'},404);
    }
    if(query.get('view')==='teammate-access'){
      const options=z.object({view:z.literal('teammate-access'),export:z.literal('csv'),workspaceId:z.string().guid()}).strict().safeParse(Object.fromEntries(query));
      if(!['GET','HEAD'].includes(request.method)||!options.success||query.size!==new Set(query.keys()).size)return json({error:'Invalid teammate export.'},400);
      if(user.guest)return json({error:'Open your own workspace to export teammate access.'},403);
      return await teammateAccessCsv(db,user.userId,options.data.workspaceId,request.method);
    }
    if(query.get('view')==='record-access'){
      if(user.guest)return json({error:'Open your own workspace to export record access history.'},403);
      return await accessHistoryCsv(db,user.userId,query,request);
    }
    if(query.has('directoryRoster')){
      const options=directoryRosterQuery.safeParse(Object.fromEntries(query));
      if(request.method!=='GET'||!options.success||query.size!==new Set(query.keys()).size)return json({error:'Invalid directory roster request.'},400);
      if(user.guest||!(portableDirectoryOwnerTenant(user.email)||portableDirectoryOwnerIssuer(user.email)||portableDirectoryOwnerOidcIssuer(user.email)))return json({error:'Open your own workspace with a configured company directory.'},403);
      return json(await ownedDirectoryRoster(db,user.userId,options.data.directoryRoster,options.data.after,options.data.teamId,!!options.data.includeChildren));
    }
    if(query.has('team'))return await teamBookingRoute(request,user);
    const scope=query.size?sharedRecordWriteScope.safeParse(Object.fromEntries(query)):undefined;
    if(scope&&!scope.success)return json({error:'Choose the workspace you manage from Workspaces.'},400);
    const managed=scope?.data;
    const directoryTenant=user.guest||managed?undefined:portableDirectoryOwnerTenant(user.email);
    const oidcIssuer=user.guest||managed?undefined:portableDirectoryOwnerOidcIssuer(user.email);
    const directoryIssuer=user.guest||managed?undefined:portableDirectoryOwnerIssuer(user.email);
    const unavailable=()=>json({error:'Team administration changed. Reopen Workspaces to check your current access.'},403);
    const inviteSignIn=(!user.guest||!!managed)&&inviteSignInEnabled();
    if(request.method==='POST'){
      const body=await readBoundedRequestText(request,8192);
      if(body===null)return json({error:'Workspace request is too large.'},413);
      const parsed=input.safeParse(JSON.parse(body));
      if(!parsed.success)return json({error:'Check the workspace request.'},400);
      const change=parsed.data;
      if(change.action==='check_member_record'){
        if(user.guest||managed)return unavailable();
        const access=await checkMemberRecordAccess(db,user.userId,change.memberId,change.kind,change.recordId,change.objectId);
        return access?json(access):json({error:'This teammate or record is no longer available.'},404);
      }
      if(change.action==='lookup_directory_employee'){
        if(!directoryTenant&&!directoryIssuer&&!oidcIssuer)return json({error:'Open your own workspace with a configured company directory.'},403);
        return json({employees:await ownedDirectoryEmployees(db,user.userId,change.email)});
      }
      if((change.action==='invite'||change.action==='record_scope')&&!validRecordAccess(change))return json({error:'Editing must stay within the viewing scope.'},400);
      if(user.guest&&!managed&&change.action!=='accept_invite'&&change.action!=='decline_invite')
        return json({error:'Only workspace owners can change sharing.'},403);
      if(managed&&['accept_invite','decline_invite','backup_admin','record_scope','grant','tool_permissions'].includes(change.action))return unavailable();
      const sessionHash=await requestSessionHash(request.headers);
      const sessionEnded=()=>json({error:'Sign in again to manage workspace access.'},403);
      if(!sessionHash)return sessionEnded();
      const reply=await db.transaction(async tx=>{
        // Sign-out and workspace access changes must have a defined order.
        if(!await lockPortableLoginSession(tx,{...user,sessionHash}))return sessionEnded();
        const admin=managed?await lockBackupAdministrator(tx,user.userId,managed,guestOwners):undefined;
        if(managed&&!admin)return unavailable();
        const ownerId=admin?.ownerId??user.userId;
        if('externalId' in change||'groupName' in change){
          const protocol=change.action.startsWith('oidc_')?'oidc':'saml';
          const issuer=protocol==='oidc'?oidcIssuer:directoryIssuer;
          const provider='groupName' in change?(issuer&&{protocol,issuer} as const):(directoryTenant&&{tenant:directoryTenant});
          if(!provider)return json({error:'Only the workspace owner can manage groups for its configured directory.'},403);
          const key='groupName' in change?change.groupName:change.externalId;
          const workspaceId=await readOwnedWorkspaceId(tx,user.userId);
          if(!workspaceId)return json({error:'Create a workspace team before mapping a group.'},409);
          const scope={workspaceId,ownerId:user.userId,...provider};
          if(change.action==='directory_group_map'||change.action==='saml_group_map'||change.action==='oidc_group_map')await mapDirectoryGroup(tx,scope,change.teamId,key,'expectedExternalId' in change?change.expectedExternalId:undefined);
          else await unmapDirectoryGroup(tx,scope,change.teamId,key);
        }else if(change.action==='grant'||change.action==='invite'){
          const allowed=allowedEmails.includes(change.email);
          if(change.email===user.email||change.email===admin?.ownerEmail)return json({error:'Enter your teammate’s email address.'},404);
          if(!allowed&&change.action==='invite'&&!inviteSignIn)
            return json({error:'Ask your Harbor administrator to approve this account for sign-in, then prepare its invitation.'},404);
          if(!allowed&&change.action==='grant')
            return json({error:inviteSignIn?'Prepare an invitation so this teammate can sign in and accept access.':
              'Ask your Harbor administrator to approve this account for sign-in first.'},404);
          const result=change.action==='invite'?await prepareWorkspaceInvitation(tx,ownerId,change.email,change.role,{viewScope:change.viewScope,editScope:change.editScope},change.teamId,!!admin):
            await grantWorkspaceView(tx,ownerId,change.email);
          if(result==='no_workspace')return json({error:'Add your first record before sharing this workspace.'},409);
          if(result==='directory_managed')return json({error:'This employee’s access is managed by the company directory.'},409);
          if(result==='no_account')return json({error:'That account has not signed in or cannot be identified. You can prepare an invitation.'},404);
          if(result==='role_conflict')return json({error:'An invitation with different access is pending. Review or cancel it before inviting again.'},409);
          if(result==='full')return json({error:'This workspace has reached its configured limit of '+portableWorkspaceSeatLimit(process.env)+' active teammates and pending invitations.'},409);
          if(result==='pending')return json({error:'An invitation is already pending for this account.'},409);
          if(result==='already_shared')return json({error:'This account already has access.'},409);
        }else if(change.action==='tool_permissions'){
          if(!await changeMemberToolPolicies(tx,ownerId,change.ids,change.tool,change.policy))
            return json({error:'A selected membership changed. Refresh the directory and select again.'},409);
        }else if(change.action==='team_create'||change.action==='team_edit'||change.action==='team_remove'||change.action==='team_assign'){
          const problem=await changeDirectoryTeam(tx,ownerId,change,!!admin);
          if(problem)return json({error:problem},409);
        }else if(change.action==='invite_role'){
          if(!await changeWorkspaceInvitationRole(tx,ownerId,change.id,change.role,!!admin))
            return json({error:'Invitation unavailable. Refresh the sharing list.'},404);
        }else if(change.action==='accept_invite'||change.action==='decline_invite'||change.action==='cancel_invite'){
          const updated=change.action==='cancel_invite'?await cancelWorkspaceInvitation(tx,ownerId,change.id):
            await respondToWorkspaceInvitation(tx,user.userId,user.email,change.id,change.action,guestOwners);
          if(!updated)return json({error:'Invitation unavailable. Refresh the sharing list.'},404);
        }else{
          const updated=change.action==='revoke'?await revokeWorkspaceView(tx,ownerId,change.id,admin):
            await changeWorkspaceGrant(tx,ownerId,change.id,change.action==='role'?{role:change.role}:change.action==='record_scope'?{viewScope:change.viewScope,editScope:change.editScope}:
              change.action==='backup_admin'?{backupAdmin:change.enabled}:{[permission[change.action]]:change.enabled},admin);
          if(!updated)return json({error:'Workspace access changed. Refresh the sharing list.'},404);
        }
        if(admin)return json({...await readManagedWorkspaceDirectory(tx,admin),inviteSignIn});
      });
      if(reply)return reply;
    }
    if(managed)return await db.transaction(async tx=>{
      const admin=await lockBackupAdministrator(tx,user.userId,managed,guestOwners);
      return admin?json({...await readManagedWorkspaceDirectory(tx,admin),inviteSignIn}):unavailable();
    });
    const sharing=await readWorkspaceSharing(db,user.userId,user.email,guestOwners,directoryTenant,directoryIssuer,oidcIssuer);
    return json(user.guest?sharing:{...sharing,inviteSignIn});
  }catch(error){
    if(error instanceof DirectoryError||error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError)return json({error:'Check the workspace request.'},400);
    console.error('Portable workspace request failed.');
    return json({error:'Could not finish the workspace request.'},500);
  }
}
export {workspaceRoute as GET,workspaceRoute as POST};
