'use client';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import type {readWorkspaceInvitation} from '../db/postgres/workspace-invite-store';
import {workspaceInvitationPath,workspaceRole,workspaceSeatLimit,type SharedRecordWriteScope,type WorkspacePermission,type WorkspaceRole} from '../lib/portable-workspace-access';
import {acceptReviewedWorkspaceInvitation,declineReviewedWorkspaceInvitation,readWorkspaceAccess,saveWorkspaceAccess} from './portable-invitation-acceptance';
import {openRoleGuide,optionalAccess,WorkspaceRoleGuide} from './portable-workspace-role-guide';
import './portable-contacts.css';
import './portable-settings.css';
import './portable-workspace-directory.css';

type ManagedDirectory=SharedRecordWriteScope&{ownerEmail:string;permissions:Record<WorkspacePermission,boolean>};
export type WorkspaceSharing={owned:string|null;managed?:ManagedDirectory;inviteSignIn?:boolean;viewers:{id:string;email:string;role:WorkspaceRole;backupAdmin:boolean;contactFiles:boolean;scheduledNotes:boolean;contactOutreach:boolean;recordActivities:boolean}[];
  shared:{id:string;ownerEmail:string;role:WorkspaceRole;grantId:string;backupAdmin:boolean}[];
  sent:{id:string;email:string;role:WorkspaceRole;expiresAt:string}[];incoming:{id:string;ownerEmail:string;role:WorkspaceRole;expiresAt:string}[]};
type Change={action:'grant';email:string}|{action:'invite';email:string;role:WorkspaceRole}|{action:'revoke'|'cancel_invite';id:string}|
  {action:'role'|'invite_role';id:string;role:WorkspaceRole}|{action:'contact_files'|'scheduled_notes'|'contact_outreach'|'record_activities'|'backup_admin';id:string;enabled:boolean};

const roleLabel={viewer:'Viewer',editor:'Editor'} as const;
type Member=WorkspaceSharing['viewers'][number];
type UpdateSharing=(data:Change)=>Promise<boolean>;
const workspaceGuideId='workspace-role-guide';
function InvitationAccessPreview({role,guideId,compact=false}:{role:WorkspaceRole;guideId?:string;compact?:boolean}){
  const editing=role==='editor';
  return <section className="portable-access-preview" aria-label="Invitation access preview">
    <h3 aria-live="polite">{editing?'What an Editor can do':'What a Viewer can do'}</h3>
    <p>Accepting the invitation opens the shared Contacts list. Use the navigation to move between records and tasks.</p>
    <dl>
      <div><dt>Contacts, companies and deals</dt><dd>{editing?'Open, create and edit records. Move deals between stages.':'Open records, follow linked records and view the pipeline.'}</dd></div>
      <div><dt>Search and dashboards</dt><dd>Search records across this workspace and open the dashboards its owner shares.</dd></div>
      <div><dt>Tasks</dt><dd>{editing?'Create, assign and complete shared tasks.':'Read shared tasks and their due dates.'}</dd></div>
      <div><dt>Activity history and files</dt><dd>Contact outreach, company and deal activities, scheduled notes and contact files each need an extra permission.</dd></div>
      <div><dt>Personal connections</dt><dd>The owner’s mail and calendar connections stay private.</dd></div>
    </dl>
    {compact?<Link href={'/?view=workspaces#'+workspaceGuideId+'-'+role}>Compare roles in Workspaces</Link>:guideId?<a href={'#'+guideId} onClick={event=>{
      if(!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)openRoleGuide(guideId,role);
    }}>Compare all four roles</a>:<WorkspaceRoleGuide initialRole={role} guideId="invitation-role-guide"/>}
  </section>;
}

function RemovalControl({invitation=false,email,remove}:{invitation?:boolean;email:string;remove:()=>void}){
  const disclosure=useRef<HTMLDetailsElement>(null);
  return <details className="portable-access-removal" ref={disclosure}>
    <summary>{invitation?'Cancel invitation…':'Revoke access…'}</summary>
    <p>{invitation?<>The invitation link for <strong>{email}</strong> will stop working.</>:
      <><strong>{email}</strong> will lose access to this workspace. Their records and assignments stay in place.</>}</p>
    <div className="portable-access-actions">
      <button type="button" onClick={()=>{if(disclosure.current){
        disclosure.current.open=false;
        disclosure.current.querySelector('summary')?.focus();
      }}}>{invitation?'Keep invitation':'Keep access'}</button>
      <button type="button" className="portable-access-destructive" onClick={remove}>
        {invitation?'Confirm cancellation':'Confirm revocation'}
      </button>
    </div>
  </details>;
}

function MemberAccess({member,change,remove,managed,inviteSignIn}:{member:Member;change:UpdateSharing;remove:()=>void;managed?:ManagedDirectory;inviteSignIn:boolean}){
  const extras=optionalAccess.filter(item=>member[item.field]).length;
  const protectedAdmin=Boolean(managed&&member.backupAdmin);
  const restrictedPromotion=Boolean(managed&&member.role==='viewer'&&optionalAccess.some(item=>member[item.field]&&!managed.permissions[item.field]));
  return <details className="portable-access-member">
    <summary>
      <span className="portable-access-person">{member.email}</span>
      <span className="portable-access-role" data-role={member.role}>{roleLabel[member.role]}</span>
      {member.backupAdmin&&<span className="portable-access-role">Backup administrator</span>}
      <span className="portable-access-count">{extras?extras+' extra '+(extras===1?'permission':'permissions'):'Standard access'}</span>
    </summary>
    <div className="portable-access-member-body">
      <label>Workspace role
        <select disabled={protectedAdmin} aria-label={'Access for '+member.email} aria-describedby={'role-help-'+member.id} value={member.role} onChange={event=>void change({
          action:'role',id:member.id,role:workspaceRole.parse(event.target.value),
        })}><option value="viewer">Viewer</option><option value="editor" disabled={restrictedPromotion}>Editor</option></select>
      </label>
      <small id={'role-help-'+member.id}>{member.role==='editor'?'Can create and edit shared records.':'Can view shared records.'}</small>
      {restrictedPromotion&&<small>The owner can promote this teammate. Their extra permissions include access you do not have.</small>}
      <fieldset className="portable-access-grants"><legend>Extra permissions</legend>
        {optionalAccess.map(({field,action,label,accessible,hint})=><label key={field}>
          <input type="checkbox" disabled={protectedAdmin||Boolean(managed&&!managed.permissions[field])}
            aria-label={accessible+' with '+member.email} aria-describedby={field+'-help-'+member.id} checked={member[field]}
            onChange={event=>void change({action,id:member.id,enabled:event.target.checked})}/>
          <span><strong>{label}</strong><small id={field+'-help-'+member.id}>{hint}</small></span>
        </label>)}
      </fieldset>
      {!managed&&<fieldset className="portable-access-grants"><legend>Team administration</legend>
        <label><input type="checkbox" checked={member.backupAdmin} disabled={member.role!=='editor'}
          aria-label={'Backup administrator for '+member.email} onChange={event=>void change({action:'backup_admin',id:member.id,enabled:event.target.checked})}/>
          <span><strong>Backup administrator</strong><small>
            {member.role==='viewer'?'Choose Editor to appoint this teammate.':
              'Can manage ordinary teammates and delegate permissions they hold. '+(inviteSignIn?
                'Their invitations can let eligible new accounts sign in to this host.':'This host requires the invited account to be approved for sign-in first.')+
              ' Switching to Viewer removes this appointment.'}
          </small></span></label>
      </fieldset>}
      {protectedAdmin?<p>Only the owner can change a backup administrator’s access.</p>:<RemovalControl key={member.id} email={member.email} remove={remove}/>}
    </div>
  </details>;
}

function InvitationExpiry({expiresAt}:{expiresAt:string}){
  // Normalize Postgres timestamps before parsing in the browser.
  const instant=new Date(expiresAt.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00')).toISOString();
  return <time dateTime={instant}>{instant.slice(0,19).replace('T',' ')} UTC</time>;
}

const savedMessages:Partial<Record<Change['action'],string>>={
  grant:'Viewer access granted.',
  revoke:'Workspace access revoked.',
  cancel_invite:'Invitation cancelled.',
  invite_role:'Invitation list updated.',
  role:'Workspace role updated.',
  backup_admin:'Backup administrator access updated.',
};

export function PortableWorkspaceSharing({guest=false,expanded=false,initial,scope}:{guest?:boolean;expanded?:boolean;initial?:WorkspaceSharing;scope?:SharedRecordWriteScope}={}){
  const instanceId=useId();
  const guideId=expanded&&!scope?workspaceGuideId:instanceId;
  const [refreshedSharing,setSharing]=useState<WorkspaceSharing>();
  const sharing=refreshedSharing??initial;
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [mustRefresh,setMustRefresh]=useState(false);
  const inFlight=useRef(false);
  const [manualLink,setManualLink]=useState<{id:string;url:string}>();
  const [query,setQuery]=useState('');
  const [inviteRole,setInviteRole]=useState<WorkspaceRole>('viewer');
  const [selectedTeam,setSelectedTeam]=useState<(SharedRecordWriteScope&{ownerEmail:string})>();
  const directory=useRef<HTMLHeadingElement>(null);
  const inviteForm=useRef<HTMLDetailsElement>(null);
  const canInvite=expanded&&!guest&&!!sharing;
  useEffect(()=>{
    if(!canInvite)return;
    const hash=window.location.hash;
    for(const role of ['editor','viewer'] as const){
      if(hash==='#'+guideId+'-'+role)openRoleGuide(guideId,role);
    }
    if(hash==='#invite-teammate'&&inviteForm.current){
      inviteForm.current.open=true;
      inviteForm.current.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
    }
  },[canInvite,guideId]);
  useEffect(()=>{
    if(initial)return;
    const controller=new AbortController();
    readWorkspaceAccess<WorkspaceSharing>(fetch,controller.signal,scope).then(result=>{
      if(!controller.signal.aborted)setSharing(result);
    }).catch(()=>{if(!controller.signal.aborted)setError(scope?'Could not open this team directory. Go back to Workspaces to check your access.':'Could not load workspace sharing.');});
    return ()=>controller.abort();
  },[initial,scope]);

  async function refresh(){
    if(inFlight.current)return;
    inFlight.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    setManualLink(undefined);
    try{
      setSharing(await readWorkspaceAccess<WorkspaceSharing>(fetch,undefined,scope));
      setMustRefresh(false);
      setNotice('Workspace access refreshed.');
    }catch{if(scope)setSharing(undefined);setError('Could not load workspace sharing.');}
    finally{inFlight.current=false;setBusy(false);}
  }

  async function change(data:Change){
    if(inFlight.current||mustRefresh)return false;
    inFlight.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    const recipient=data.action==='invite'?data.email.trim().toLowerCase():
      data.action==='invite_role'?sharing?.sent.find(invite=>invite.id===data.id)?.email:undefined;
    if(data.action==='invite_role')setManualLink(undefined);
    try{
      const result=await saveWorkspaceAccess<WorkspaceSharing>(fetch,data,scope);
      if(result.status==='saved'||result.status==='refreshed'){
        setSharing(result.sharing);
        const invite=data.action==='invite'||data.action==='invite_role'
          ?result.sharing.sent.find(item=>item.email===recipient&&item.role===data.role):undefined;
        setManualLink(invite?{id:invite.id,url:invitationUrl(invite.id)}:undefined);
        setNotice(invite?(data.action==='invite_role'?'Share the current invitation link with '+invite.email+'.':
          'Invitation ready for '+invite.email+'. Share the link below.'):
          result.status==='saved'?(savedMessages[data.action]??'Workspace permissions updated.'):
            'The reply was interrupted. The list is up to date. Check it before trying again.');
        if(invite){setQuery('');return true;}
      }else if(result.status==='denied'){
        if(result.scopeLost){setSharing(undefined);setMustRefresh(true);}
        if(data.action==='invite_role')setMustRefresh(true);
        setError(result.message);
      }else{
        setMustRefresh(true);
        setError('Could not confirm the change. Refresh sharing to check current access.');
      }
      return result.status==='saved';
    }finally{inFlight.current=false;setBusy(false);}
  }

  function invitationUrl(id:string){
    return new URL(workspaceInvitationPath(id),window.location.origin).href;
  }

  async function copyInvitation(id:string,email:string){
    const url=invitationUrl(id);
    setNotice('');
    try{
      await navigator.clipboard.writeText(url);
      setNotice('Invitation link copied for '+email+'.');
    }catch{
      setManualLink({id,url});
      setNotice('Select and copy the invitation link below.');
    }
  }

  async function grant(event:FormEvent<HTMLFormElement>,action:'invite'|'grant'){
    event.preventDefault();
    const form=event.currentTarget,email=String(new FormData(form).get('email')||'');
    const data:Change=action==='grant'?{action,email}:{action,email,role:workspaceRole.parse(new FormData(form).get('inviteRole'))};
    if(await change(data)){form.reset();setInviteRole('viewer');setQuery('');}
  }

  async function remove(data:Extract<Change,{action:'revoke'|'cancel_invite'}>){
    if(await change(data))directory.current?.focus();
  }

  const needle=query.trim().toLowerCase();
  const members=sharing?.viewers.filter(member=>member.email.toLowerCase().includes(needle))??[];
  // A role or permission change rotates the grant ID. Keep the editor open for
  // the same person; fall back to the grant if identities share an email.
  const uniqueEmails=new Set<string>(),repeatedEmails=new Set<string>();
  for(const member of sharing?.viewers??[]){
    if(uniqueEmails.has(member.email))repeatedEmails.add(member.email);
    else uniqueEmails.add(member.email);
  }
  const invitations=sharing?.sent.filter(invite=>invite.email.toLowerCase().includes(needle))??[];
  const noMatches=!!needle&&!members.length&&!invitations.length;

  if(selectedTeam)return <div className="portable-workspace-settings">
    <button type="button" onClick={()=>{setSelectedTeam(undefined);void refresh();}}>Back to my workspaces</button>
    <h2>Team from {selectedTeam.ownerEmail}</h2>
    <p>You’re managing this team as a backup administrator. You can share the extra permissions you already have.</p>
    <PortableWorkspaceSharing expanded scope={selectedTeam}/>
  </div>;
  const disclosure=<details id="portable-workspace-sharing" open={guest||expanded||undefined}>
    <summary>Workspace sharing{sharing?.incoming.length?' · '+sharing.incoming.length+' pending':
      sharing?.shared.length?' · '+sharing.shared.length+' shared with you':''}</summary>
    {error&&<p role="alert">{error}</p>}
    {(sharing||error)&&<p className="portable-sharing-refresh"><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh sharing</button></p>}
    {!sharing&&!error&&<p role="status">Loading workspace access…</p>}
    {(notice||busy)&&<p role="status">{notice||'Updating workspace access…'}</p>}
    {sharing&&<>
      {(expanded||guest)&&<WorkspaceRoleGuide initialRole={sharing.managed?'backup':guest?'viewer':'owner'} guideId={guideId}/>}
      {(guest||!expanded||sharing.shared.length>0)&&<><h2>Shared with you</h2>
      {sharing.shared.length?<ul>{sharing.shared.map(workspace=><li key={workspace.id}>
        <a href={'/?workspaceId='+workspace.id}>Workspace from {workspace.ownerEmail}</a>
        {' · '}{workspace.role==='editor'?'Editor':'Viewer'}
        {workspace.backupAdmin&&<> · Backup administrator{' '}<button type="button" aria-label={'Manage team from '+workspace.ownerEmail}
          onClick={()=>setSelectedTeam({workspaceId:workspace.id,grantId:workspace.grantId,ownerEmail:workspace.ownerEmail})}>Manage team</button></>}
      </li>)}</ul>:<p className={expanded?'portable-settings-empty':undefined}>No workspaces shared with you.</p>}</>}
      {sharing.incoming.length>0&&<>
        <h2>Invitations for you</h2>
        <ul>{sharing.incoming.map(invite=><li key={invite.id}>
          Workspace from {invite.ownerEmail} · {roleLabel[invite.role]}{' '}
          <a href={workspaceInvitationPath(invite.id)}>Review invitation</a>
        </li>)}</ul>
      </>}
      {!guest&&<>
      <fieldset disabled={busy||mustRefresh} className="portable-sharing-controls portable-access-controls">
      <details id="invite-teammate" ref={inviteForm} className="portable-access-add" open={!sharing.sent.length&&!sharing.viewers.length||undefined}>
      <summary>Invite a teammate</summary>
      <form onSubmit={event=>void grant(event,'invite')} className="portable-access-invite">
        <label>Teammate email<input name="email" type="email" required maxLength={254} placeholder="teammate@example.com"/></label>
        <label>Invitation role
          <select name="inviteRole" value={inviteRole} onChange={event=>setInviteRole(workspaceRole.parse(event.target.value))}><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
        </label>
        <InvitationAccessPreview role={inviteRole} guideId={guideId} compact={!expanded}/>
        <button type="submit">Prepare invitation</button>
        <p>{sharing.inviteSignIn?'Share the link with your teammate. They must sign in with this account.':
          'Share the link yourself. This account must already be approved for Harbor sign-in.'}</p>
      </form>
      <p><strong>Handing off a deal?</strong> After the teammate joins, open their name in the Team directory and turn on <b>Company and deal activities</b> to share logged calls, meetings and notes. Contact outreach and files are separate choices.</p>
      {sharing.owned&&<details className="portable-access-direct"><summary>Grant access without an invitation</summary>
        <p>For an approved account that has already signed in, you can grant Viewer access immediately.</p>
        <form onSubmit={event=>void grant(event,'grant')}>
          <label>Existing teammate email<input name="email" type="email" required maxLength={254}/></label>
          <button type="submit">Grant view access</button>
        </form>
      </details>}</details>
      <h2 tabIndex={-1} ref={directory}>Team directory</h2>
      <p className="portable-access-count">{sharing.viewers.length+sharing.sent.length} of {workspaceSeatLimit} teammate places used, including pending invitations.</p>
      {sharing.viewers.length+sharing.sent.length>0&&<div className="portable-access-search">
        <label>Find a teammate<input type="search" placeholder="Search by email" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {query&&<button type="button" onClick={()=>setQuery('')}>Clear search</button>}
        {needle&&!noMatches&&<span className="portable-access-count" role="status">
          {members.length+invitations.length} {members.length+invitations.length===1?'match':'matches'}
        </span>}
      </div>}
      {noMatches&&<p className="portable-settings-empty" role="status">No matches. Try another email.</p>}
      {invitations.length>0&&<>
        <h3>Pending invitations <span className="portable-access-tally">{invitations.length}</span></h3>
        <ul className="portable-access-list">{invitations.map(invite=><li key={invite.id}>
          <div className="portable-access-invitation">
            <div><strong className="portable-access-person">{invite.email}</strong> <span className="portable-access-role" data-role={invite.role}>{roleLabel[invite.role]}</span>
              <small>Expires <InvitationExpiry expiresAt={invite.expiresAt}/></small></div>
            <button type="button" onClick={()=>void copyInvitation(invite.id,invite.email)}>Copy invitation link</button>
          </div>
          {manualLink?.id===invite.id&&<label>Invitation link<input readOnly value={manualLink.url}
            onFocus={event=>event.currentTarget.select()}/></label>}
          <details className="portable-access-invite-tools"><summary>Manage invitation</summary>
            <p>Changing the role replaces this link. Share the new link with your teammate.</p>
            <button type="button" onClick={()=>void change({
              action:'invite_role',id:invite.id,role:invite.role==='viewer'?'editor':'viewer',
            })}>Change to {invite.role==='viewer'?'Editor':'Viewer'}</button>
            <RemovalControl invitation email={invite.email} remove={()=>void remove({action:'cancel_invite',id:invite.id})}/>
          </details>
        </li>)}</ul>
      </>}
      {(members.length>0||(!needle&&expanded))&&<h3>People with access <span className="portable-access-tally">{members.length}</span></h3>}
      {members.length>0?<ul className="portable-access-list">{members.map(member=><li key={repeatedEmails.has(member.email)?member.id:member.email}>
        <MemberAccess member={member} managed={sharing.managed} inviteSignIn={!!sharing.inviteSignIn}
          change={change} remove={()=>void remove({action:'revoke',id:member.id})}/>
      </li>)}</ul>:!needle&&expanded&&<p className="portable-settings-empty">No teammates have access yet.</p>}
      </fieldset>
      {sharing.owned&&<details className="portable-access-review"><summary>Review assignments after access changes</summary>
        <p>Find records whose owner or assignee no longer has access.</p>
        <nav aria-label="Review assignments after access changes">
          <Link href="/?kind=tasks&taskView=unavailable-assignee">Tasks with unavailable assignees</Link>
          <Link href="/?owner=unavailable">Contacts</Link>
          <Link href="/?kind=companies&owner=unavailable">Companies</Link>
          <Link href="/?kind=deals&owner=unavailable">Deals</Link>
        </nav>
      </details>}</>}
    </>}
  </details>;
  return expanded?<div className="portable-workspace-settings">{disclosure}</div>:disclosure;
}

export function PortableGuestHome({email,initial}:{email:string;initial?:WorkspaceSharing}){
  return <main className="portable-contacts">
    <header><span>⚓ Harbor</span><span>{email} · <a href="/auth/sign-out">Sign out</a></span></header>
    <section><h1>Your shared workspaces</h1><p>Review a pending invitation or open a workspace you’ve joined.</p>
      <PortableWorkspaceSharing guest initial={initial}/></section>
  </main>;
}

export function PortableInvitationPage({id,email,review}:{id:string;email:string;review:Awaited<ReturnType<typeof readWorkspaceInvitation>>}){
  const submitting=useRef(false);
  const [busy,setBusy]=useState<'accept'|'decline'>();
  const [checking,setChecking]=useState(false);
  const [declineState,setDeclineState]=useState<'declined'|'unconfirmed'>();
  const [error,setError]=useState('');
  async function accept(){
    if(!review||submitting.current)return;
    submitting.current=true;
    setBusy('accept');
    setError('');
    const result=await acceptReviewedWorkspaceInvitation(fetch,id,review.workspaceId,checking);
    if(result.status==='accepted'){
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Reload workspace access after acceptance.
      window.location.assign('/?workspaceId='+review.workspaceId);
      return;
    }
    setError(result.message);
    setChecking(result.status==='unconfirmed');
    submitting.current=false;
    setBusy(undefined);
  }
  async function decline(){
    if(!review||submitting.current||checking)return;
    submitting.current=true;
    setBusy('decline');
    setError('');
    try{
      const result=await declineReviewedWorkspaceInvitation(fetch,id);
      if(result.status==='declined')setDeclineState('declined');
      else{
        setError(result.message);
        if(result.status==='unconfirmed')setDeclineState('unconfirmed');
      }
    }finally{
      submitting.current=false;
      setBusy(undefined);
    }
  }
  const signIn='/auth/sign-in?'+new URLSearchParams({return_to:workspaceInvitationPath(id)});
  return <main className="portable-contacts">
    <header><span>⚓ Harbor</span>{/* The portable renderer uses full document navigation. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/?view=workspaces">Workspaces</a></header>
    <section><h1>Workspace invitation</h1>
      <p>Signed in as {email}</p>
      {declineState==='declined'?<p role="status">Invitation declined.</p>:declineState==='unconfirmed'?
        <button type="button" onClick={()=>window.location.reload()}>Reload invitation</button>:review?<>
        <p>Join the workspace from <strong>{review.ownerEmail}</strong> as {review.role==='editor'?'an':'a'} {roleLabel[review.role]}.</p>
        <InvitationAccessPreview role={review.role}/>
        <p>Expires <InvitationExpiry expiresAt={review.expiresAt}/>.</p>
        <button type="button" disabled={!!busy} onClick={()=>void accept()}>{checking?(busy?'Checking…':'Check workspace access'):(busy==='accept'?'Joining…':'Accept invitation')}</button>{' '}
        {!checking&&<button type="button" disabled={!!busy} onClick={()=>void decline()}>{busy==='decline'?'Declining…':'Decline invitation'}</button>}
      </>:<>
        <p>Invitation unavailable. In Workspaces, check for a replacement invitation or open a workspace you’ve joined.</p>
        <p><Link href="/?view=workspaces">Open my workspaces</Link></p>
        <p>Use the account approved for the invited address, or ask the workspace owner for a current one.</p>
        <a href={signIn}>Use another account</a>
      </>}
      {error&&<p role="alert">{error}</p>}
    </section>
  </main>;
}
