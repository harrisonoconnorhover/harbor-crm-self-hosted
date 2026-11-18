import {z} from 'zod';
import {changeWorkspaceGrant,grantWorkspaceView,lockBackupAdministrator,readManagedWorkspaceDirectory,readWorkspaceSharing,revokeWorkspaceView} from '../db/postgres/workspace-viewer-store';
import {cancelWorkspaceInvitation,changeWorkspaceInvitationRole,prepareWorkspaceInvitation,respondToWorkspaceInvitation,workspaceSeatLimit} from '../db/postgres/workspace-invite-store';
import {lockPortableLoginSession} from '../db/postgres/identity-store';
import {sharedRecordWriteScope,workspaceInvitationId,workspaceRole} from '../lib/portable-workspace-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableLoginConfig as loginConfig} from './portable-login-config';
import {portableApiIdentity} from './portable-api-identity';
import {inviteSignInEnabled,requestSessionHash} from './portable-identity';
import {portableDb} from './portable-db';
import {env} from './portable-env';

const email=z.string().trim().email().max(254).toLowerCase();
const permission={contact_files:'contactFiles',scheduled_notes:'scheduledNotes',contact_outreach:'contactOutreach',
  record_activities:'recordActivities'} as const;
const input=z.discriminatedUnion('action',[
  z.object({action:z.literal('grant'),email}).strict(),
  z.object({action:z.literal('invite'),email,role:workspaceRole.default('viewer')}).strict(),
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
    const scope=query.size?sharedRecordWriteScope.safeParse(Object.fromEntries(query)):undefined;
    if(scope&&!scope.success)return json({error:'Choose the workspace you manage from Workspaces.'},400);
    const managed=scope?.data;
    const unavailable=()=>json({error:'Team administration changed. Reopen Workspaces to check your current access.'},403);
    const inviteSignIn=(!user.guest||!!managed)&&inviteSignInEnabled();
    if(request.method==='POST'){
      const body=await readBoundedRequestText(request,4096);
      if(body===null)return json({error:'Workspace request is too large.'},413);
      const parsed=input.safeParse(JSON.parse(body));
      if(!parsed.success)return json({error:'Check the workspace request.'},400);
      const change=parsed.data;
      if(user.guest&&!managed&&change.action!=='accept_invite'&&change.action!=='decline_invite')
        return json({error:'Only workspace owners can change sharing.'},403);
      if(managed&&['accept_invite','decline_invite','backup_admin','grant'].includes(change.action))return unavailable();
      const sessionHash=await requestSessionHash(request.headers);
      const sessionEnded=()=>json({error:'Sign in again to manage workspace access.'},403);
      if(!sessionHash)return sessionEnded();
      const reply=await db.transaction(async tx=>{
        // Sign-out and workspace access changes must have a defined order.
        if(!await lockPortableLoginSession(tx,{...user,sessionHash}))return sessionEnded();
        const admin=managed?await lockBackupAdministrator(tx,user.userId,managed,guestOwners):undefined;
        if(managed&&!admin)return unavailable();
        const ownerId=admin?.ownerId??user.userId;
        if(change.action==='grant'||change.action==='invite'){
          const allowed=allowedEmails.includes(change.email);
          if(change.email===user.email||change.email===admin?.ownerEmail)return json({error:'Enter your teammate’s email address.'},404);
          if(!allowed&&change.action==='invite'&&!inviteSignIn)
            return json({error:'Ask your Harbor administrator to approve this account for sign-in, then prepare its invitation.'},404);
          if(!allowed&&change.action==='grant')
            return json({error:inviteSignIn?'Prepare an invitation so this teammate can sign in and accept access.':
              'Ask your Harbor administrator to approve this account for sign-in first.'},404);
          const result=change.action==='invite'?await prepareWorkspaceInvitation(tx,ownerId,change.email,change.role):
            await grantWorkspaceView(tx,ownerId,change.email);
          if(result==='no_workspace')return json({error:'Add your first record before sharing this workspace.'},409);
          if(result==='no_account')return json({error:'That account has not signed in or cannot be identified. You can prepare an invitation.'},404);
          if(result==='role_conflict')return json({error:'An invitation with a different role is pending. Change its role in Pending invitations.'},409);
          if(result==='full')return json({error:'This workspace already has '+workspaceSeatLimit+' teammates and pending invitations.'},409);
          if(result==='pending')return json({error:'An invitation is already pending for this account.'},409);
          if(result==='already_shared')return json({error:'This account already has access.'},409);
        }else if(change.action==='invite_role'){
          if(!await changeWorkspaceInvitationRole(tx,ownerId,change.id,change.role))
            return json({error:'Invitation unavailable. Refresh the sharing list.'},404);
        }else if(change.action==='accept_invite'||change.action==='decline_invite'||change.action==='cancel_invite'){
          const updated=change.action==='cancel_invite'?await cancelWorkspaceInvitation(tx,ownerId,change.id):
            await respondToWorkspaceInvitation(tx,user.userId,user.email,change.id,change.action,guestOwners);
          if(!updated)return json({error:'Invitation unavailable. Refresh the sharing list.'},404);
        }else{
          const updated=change.action==='revoke'?await revokeWorkspaceView(tx,ownerId,change.id,admin):
            await changeWorkspaceGrant(tx,ownerId,change.id,change.action==='role'?{role:change.role}:
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
    const sharing=await readWorkspaceSharing(db,user.userId,user.email,guestOwners);
    return json(user.guest?sharing:{...sharing,inviteSignIn});
  }catch(error){
    if(error instanceof SyntaxError)return json({error:'Check the workspace request.'},400);
    console.error('Portable workspace request failed.');
    return json({error:'Could not finish the workspace request.'},500);
  }
}
export {workspaceRoute as GET,workspaceRoute as POST};
