import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {sharedToolAllowed} from '../db/postgres/shared-tool-permission';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {eq} from 'drizzle-orm';
import {notFound} from 'next/navigation';
import {privateWorkspaces} from '../db/postgres/contact-schema';
import {readTeamInbox} from '../db/postgres/team-inbox-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {ApiError} from '../lib/api-error';
import {inboxQueue,inboxRead} from '../lib/team-inbox';
import {PortableCrmHeader} from './portable-crm-header';
import {portablePageHasBody} from './portable-page-body';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {configuredInbox} from './portable-team-inbox-provider';
import {TeamInbox} from './portable-team-inbox-ui';

export async function TeamInboxPage({input,user}:{input:Record<string,string|undefined>;user:{userId:string;email:string;displayName?:string}}){
  const {view,from,...params}=input;
  // Empty GET form controls mean "all" and do not belong in the normalized queue.
  for(const key of ['claim','tag','ticketTag','mailbox','q','messageText','responseWindow','waiting'])if(typeof params[key]==='string'&&params[key].trim()==='')delete params[key];
  if(from!==undefined&&typeof from!=='string')notFound();
  const prior=from===undefined?undefined:new URLSearchParams(from);
  const queue=prior?inboxQueue.safeParse(Object.fromEntries(prior)):undefined;
  if(prior&&(!params.id||prior.size!==new Set(prior.keys()).size||!queue?.success))notFound();
  const parsed=inboxRead.safeParse(params);
  if(view!=='team-inbox'||!parsed.success)notFound();
  const query=parsed.data,db=portableDb(),workspaceId=query.workspaceId;
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
  const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
  if(workspaceId&&grant?.viewScope!=='all')notFound();
  const result=await readTeamInbox(db,user,query,await portablePageHasBody()).catch(error=>{
    if(error instanceof ApiError&&[403,404].includes(error.status))notFound();
    throw error;
  });
  let canSend=false;
  if('conversation' in result&&result.conversation){
    const ownerWorkspace=workspaceId??(await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
      .where(eq(privateWorkspaces.ownerId,user.userId)).limit(1))[0]?.id;
    canSend=!!ownerWorkspace&&!!configuredInbox(ownerWorkspace,result.conversation.mailbox)?.token;
  }
  const [canEditInbox,canUseSnippets,canUseKnowledge]=await Promise.all([
    sharedToolAllowed(db,user.userId,workspaceId,'team-inbox','edit'),
    sharedToolAllowed(db,user.userId,workspaceId,'snippets'),sharedToolAllowed(db,user.userId,workspaceId,'knowledge'),
  ]);
  const editable=(!workspaceId||grant?.role==='editor'&&grant.editScope==='all')&&canEditInbox;
  const canLogResponse=!workspaceId||!!grant&&effectiveMemberToolPolicy(grant,'tickets').edit!=='none';
  const choices=editable?await portableWorkspaceAssignees(db,user.userId,workspaceId,'inbox'):[];
  const assignees=choices.filter(member=>member.canClaim);
  return <main className="portable-contacts"><PortableCrmHeader email={user.email} page="team-inbox" workspaceId={workspaceId}/>
    <TeamInbox key={JSON.stringify(query)} initial={result} query={query} actorId={user.userId} actorLabel={user.displayName||user.email}
      canUseSnippets={canUseSnippets} canUseKnowledge={canUseKnowledge} assignees={assignees} ticketAssignees={query.id?choices.filter(member=>member.canTakeTicket):[]} returnQueue={queue?.data} editable={editable} canLogResponse={canLogResponse} canSend={canSend} grantId={grant?.id}/>
  </main>;
}
