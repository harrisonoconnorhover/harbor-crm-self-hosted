'use client';

import {enrollmentUrl} from '../lib/portable-sales-sequences';
import {JoinedWorkspaceList} from './portable-joined-workspaces';
import {MemberToolEditor,type ToolChange} from './portable-member-tool-editor';
import type {ToolPolicies} from '../lib/portable-tool-permissions';
import {DirectoryEmployeeLookup} from './portable-directory-employee-ui';
import {PortableTeamScheduling} from './portable-team-scheduling-ui';
import {useEffect,useId,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {RecordScopeControls} from './portable-record-scope-controls';
import {fullRecordAccess,scopeLabels,type MemberRecordAccess} from '../lib/portable-workspace-access';
import {DirectoryTeams,teamOptions} from './portable-workspace-teams-ui';
import type {DirectoryGroupMapping,DirectoryGroupChange,DirectoryTeam,TeamChange} from '../lib/portable-workspace-teams';
import Link from 'next/link';
import type {readWorkspaceInvitation} from '../db/postgres/workspace-invite-store';
import {workspaceInvitationPath,workspaceRole,type SharedRecordWriteScope,type WorkspacePermission,type WorkspaceRole} from '../lib/portable-workspace-access';
import {acceptReviewedWorkspaceInvitation,declineReviewedWorkspaceInvitation,readWorkspaceAccess,saveWorkspaceAccess} from './portable-invitation-acceptance';
import {guideRoles,openRoleGuide,optionalAccess,WorkspaceRoleGuide} from './portable-workspace-role-guide';
import './portable-contacts.css';
import './portable-settings.css';
import './portable-workspace-directory.css';

type ManagedDirectory=SharedRecordWriteScope&{ownerEmail:string;permissions:Record<WorkspacePermission,boolean>};
export type WorkspaceSharing={owned:string|null;managed?:ManagedDirectory;inviteSignIn?:boolean;seatLimit:number|null;teams:DirectoryTeam[];directoryGroupMappings?:DirectoryGroupMapping[];oidcGroupMappings?:DirectoryGroupMapping[];samlGroupMappings?:DirectoryGroupMapping[];viewers:(MemberRecordAccess&{toolPolicies?:ToolPolicies;id:string;actorId:string;teamId?:string|null;directoryTeamManaged?:boolean;email:string;role:WorkspaceRole;backupAdmin:boolean;contactFiles:boolean;scheduledNotes:boolean;contactOutreach:boolean;recordActivities:boolean})[];
  sharedNext?:string|null;shared:{id:string;ownerEmail:string;role:WorkspaceRole;meetingsVisible?:boolean;grantId:string;backupAdmin:boolean}[];
  sent:(MemberRecordAccess&{id:string;email:string;teamId?:string|null;teamName?:string|null;role:WorkspaceRole;expiresAt:string})[];incoming:(MemberRecordAccess&{id:string;ownerEmail:string;teamName?:string|null;role:WorkspaceRole;expiresAt:string})[]};
type Change=ToolChange|TeamChange|DirectoryGroupChange|{action:'grant';email:string}|({action:'invite';email:string;teamId?:string;role:WorkspaceRole}&MemberRecordAccess)|({action:'record_scope';id:string}&MemberRecordAccess)|{action:'revoke'|'cancel_invite';id:string}|
  {action:'role'|'invite_role';id:string;role:WorkspaceRole}|{action:'contact_files'|'scheduled_notes'|'contact_outreach'|'record_activities'|'backup_admin';id:string;enabled:boolean};

const roleLabel={viewer:'Viewer',editor:'Editor'} as const;
type Member=WorkspaceSharing['viewers'][number];
type UpdateSharing=(data:Change)=>Promise<boolean>;
const workspaceGuideId='workspace-role-guide';
function InvitationAccessPreview({role,access=fullRecordAccess,guideId,compact=false}:{role:WorkspaceRole;access?:MemberRecordAccess;guideId?:string;compact?:boolean}){
  const editing=role==='editor';
  if(access.viewScope!=='all'||access.editScope!=='all')return <section className="portable-access-preview" aria-label="Invitation access preview">
    <h3>{editing?'What an Editor can do':'What a Viewer can do'}</h3><p>Contacts, companies, deals, leads and tasks</p>
    <dl><div><dt>Can view</dt><dd>{scopeLabels[access.viewScope]}</dd></div>
      <div><dt>Can edit</dt><dd>{editing?scopeLabels[access.editScope]:'View only'}</dd></div></dl>
    <p>Team access includes the teammate’s own records. Limited editors can edit individual CRM records. Workspace-wide actions require broader access.</p>
  </section>;
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

function DirectoryRows<T>({items,noun,children}:{items:T[];noun:string;children:(item:T)=>ReactNode}){
  const [page,setPage]=useState(0);
  const size=25,last=Math.ceil(items.length/size)-1;
  const current=Math.min(page,last),start=current*size;
  return <>
    <ul className="portable-access-list">{items.slice(start,start+size).map(children)}</ul>
    {last>0&&<nav aria-label={noun+' pages'} className="portable-directory-pages">
      <button type="button" disabled={current===0} onClick={()=>setPage(current-1)}>Previous {noun}</button>
      <span role="status">{start+1}–{Math.min(start+size,items.length)} of {items.length}</span>
      <button type="button" disabled={current===last} onClick={()=>setPage(current+1)}>Next {noun}</button>
    </nav>}
  </>;
}

function MemberAccess({member,teams,change,remove,managed,inviteSignIn,settingsTab}:{settingsTab?:'users'|'teams';member:Member;teams:ReturnType<typeof teamOptions>;change:UpdateSharing;remove:()=>void;managed?:ManagedDirectory;inviteSignIn:boolean}){
  const [access,setAccess]=useState<MemberRecordAccess>({viewScope:member.viewScope,editScope:member.editScope});
  const primaryTeam=teams.find(team=>team.id===member.teamId);
  const extras=optionalAccess.filter(item=>member[item.field]).length;
  const protectedAdmin=Boolean(managed&&member.backupAdmin);
  const restrictedPromotion=Boolean(managed&&member.role==='viewer'&&optionalAccess.some(item=>member[item.field]&&!managed.permissions[item.field]));
  return <details className="portable-access-member">
    <summary>
      <span className="portable-access-person">{member.email}{primaryTeam&&<small className="portable-member-team">{primaryTeam.label}</small>}</span>
      <span className="portable-access-role" data-role={member.role}>{roleLabel[member.role]}</span>
      {member.backupAdmin&&<span className="portable-access-role">Backup administrator</span>}
      <span className="portable-access-count">{extras?extras+' extra '+(extras===1?'permission':'permissions'):'Standard access'}</span>
    </summary>
    <div className="portable-access-member-body">
      {!managed&&settingsTab!=='teams'&&<Link prefetch={false} href={'/?view=settings&section='+(settingsTab==='users'?'users-teams':'properties')+'&member='+member.id}>Preview record and field access</Link>}
      {settingsTab==='users'&&<><a href={'/?view=record-access&'+new URLSearchParams({actor:member.actorId})}>View access history</a>
        <details className="portable-tool-controls"><summary>Tool permissions</summary>
          <MemberToolEditor people={[member]} save={change}/>
        </details></>}
      {teams.length>0&&<label>Primary team
        <select aria-label={'Primary team for '+member.email} disabled={protectedAdmin||member.directoryTeamManaged} value={member.teamId??''}
          onChange={event=>void change({action:'team_assign',id:member.id,previousTeamId:member.teamId??null,teamId:event.target.value||null})}>
          <option value="">Unassigned</option>{teams.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>}
      {member.directoryTeamManaged&&<small>Your directory manages this primary team.</small>}
      {settingsTab!=='teams'&&<><label>Workspace role
        <select disabled={protectedAdmin} aria-label={'Access for '+member.email} aria-describedby={'role-help-'+member.id} value={member.role} onChange={event=>void change({
          action:'role',id:member.id,role:workspaceRole.parse(event.target.value),
        })}><option value="viewer">Viewer</option><option value="editor" disabled={restrictedPromotion}>Editor</option></select>
      </label>
      <small id={'role-help-'+member.id}>{member.role==='editor'?'Can create and edit shared records.':'Can view shared records.'}</small>
      {restrictedPromotion&&<small>The owner can promote this teammate. Their extra permissions include access you do not have.</small>}
      {!managed&&!member.backupAdmin&&<fieldset><legend>Record access</legend>
        <RecordScopeControls access={access} onChange={setAccess} editor={member.role==='editor'}/>
        <button type="button" disabled={access.viewScope===member.viewScope&&access.editScope===member.editScope}
          onClick={()=>void change({action:'record_scope',id:member.id,...access})}>Save record access</button>
      </fieldset>}
      <fieldset className="portable-access-grants"><legend>Extra permissions</legend>
        {optionalAccess.map(({field,action,label,accessible,hint})=><label key={field}>
          <input type="checkbox" disabled={protectedAdmin||Boolean(managed&&!managed.permissions[field])}
            aria-label={accessible+' with '+member.email} aria-describedby={field+'-help-'+member.id} checked={member[field]}
            onChange={event=>void change({action,id:member.id,enabled:event.target.checked})}/>
          <span><strong>{label}</strong><small id={field+'-help-'+member.id}>{hint}</small></span>
        </label>)}
      </fieldset>
      {!managed&&<fieldset className="portable-access-grants"><legend>Team administration</legend>
        <label><input type="checkbox" checked={member.backupAdmin} disabled={member.role!=='editor'||member.editScope!=='all'}
          aria-label={'Backup administrator for '+member.email} onChange={event=>void change({action:'backup_admin',id:member.id,enabled:event.target.checked})}/>
          <span><strong>Backup administrator</strong><small>
            {member.role==='viewer'?'Choose Editor to appoint this teammate.':
              'Can manage ordinary teammates and delegate permissions they hold. '+(inviteSignIn?
                'Their invitations can let eligible new accounts sign in to this host.':'This host requires the invited account to be approved for sign-in first.')+
              ' Switching to Viewer removes this appointment.'}
          </small></span></label>
      </fieldset>}
      {protectedAdmin?<p>Only the owner can change a backup administrator’s access.</p>:<RemovalControl key={member.id} email={member.email} remove={remove}/>}</>}
    </div>
  </details>;
}

function InvitationExpiry({expiresAt}:{expiresAt:string}){
  // Normalize Postgres timestamps before parsing in the browser.
  const instant=new Date(expiresAt.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00')).toISOString();
  return <time dateTime={instant}>{instant.slice(0,19).replace('T',' ')} UTC</time>;
}

const savedMessages:Partial<Record<Change['action'],string>>={
  directory_group_map:'Directory group linked.',directory_group_unmap:'Directory group unlinked.',
  team_create:'Team created.',team_edit:'Team updated.',team_assign:'Primary team updated.',team_remove:'Team removed.',
  grant:'Viewer access granted.',
  revoke:'Workspace access revoked.',
  cancel_invite:'Invitation cancelled.',
  invite_role:'Invitation list updated.',
  role:'Workspace role updated.',
  backup_admin:'Backup administrator access updated.',
};

export function PortableWorkspaceSharing({guest=false,expanded=false,initial,scope,settingsTab,ownerEmail}:{settingsTab?:'users'|'teams';ownerEmail?:string;guest?:boolean;expanded?:boolean;initial?:WorkspaceSharing;scope?:SharedRecordWriteScope}={}){
  const instanceId=useId();
  const guideId=expanded&&!scope?workspaceGuideId:instanceId;
  const [refreshedSharing,updateSharing]=useState<WorkspaceSharing>();
  const [sharingVersion,setSharingVersion]=useState(0);
  function setSharing(value:WorkspaceSharing|undefined){
    updateSharing(value);
    setSharingVersion(version=>version+1);
  }
  const sharing=refreshedSharing??initial;
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [bulkOpen,setBulkOpen]=useState(false);
  const selectedPeople=sharing?.viewers.filter(person=>selectedIds.includes(person.id))??[];
  const [mustRefresh,setMustRefresh]=useState(false);
  const inFlight=useRef(false);
  const [manualLink,setManualLink]=useState<{id:string;url:string}>();
  const [query,setQuery]=useState('');
  const [teamFilter,setTeamFilter]=useState(''),[includeChildren,setIncludeChildren]=useState(true);
  const [inviteAccess,setInviteAccess]=useState<MemberRecordAccess>(fullRecordAccess);
  const [inviteRole,setInviteRole]=useState<WorkspaceRole>('viewer');
  const [selectedTeam,setSelectedTeam]=useState<(SharedRecordWriteScope&{ownerEmail:string})>();
  const directory=useRef<HTMLHeadingElement>(null);
  const inviteForm=useRef<HTMLDetailsElement>(null);
  const canInvite=expanded&&!guest&&!!sharing;
  useEffect(()=>{
    if(!canInvite)return;
    function openFragment(){
      const hash=window.location.hash;
      for(const role of guideRoles){
        if(hash==='#'+guideId+'-'+role)openRoleGuide(guideId,role);
      }
      if(hash==='#team-directory')directory.current?.focus();
      if(hash==='#invite-teammate'&&inviteForm.current){
        inviteForm.current.open=true;
        inviteForm.current.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
      }
    }
    openFragment();
    window.addEventListener('hashchange',openFragment);
    return ()=>window.removeEventListener('hashchange',openFragment);
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
    const form=event.currentTarget,values=new FormData(form),email=String(values.get('email')||'');
    const data:Change=action==='grant'?{action,email}:{action,email,...inviteAccess,role:workspaceRole.parse(values.get('inviteRole')),teamId:String(values.get('inviteTeam')||'')||undefined};
    if(await change(data)){form.reset();setInviteRole('viewer');setInviteAccess(fullRecordAccess);setQuery('');setTeamFilter('');}
  }

  async function remove(data:Extract<Change,{action:'revoke'|'cancel_invite'}>){
    if(await change(data))directory.current?.focus();
  }

  const needle=query.trim().toLowerCase();
  const directoryTeams=teamOptions(sharing?.teams??[]);
  // A refresh or team removal can invalidate an open filter.
  const hasTeam=teamFilter==='unassigned'?directoryTeams.length>0:directoryTeams.some(team=>team.id===teamFilter);
  const filterTeam=hasTeam?teamFilter:'';
  const branch=new Set(directoryTeams.filter(team=>team.ancestors.includes(filterTeam)).map(team=>team.id));
  function matchesDirectory(person:{email:string;teamId?:string|null}){
    if(!person.email.toLowerCase().includes(needle))return false;
    if(!filterTeam)return true;
    if(filterTeam==='unassigned')return !person.teamId;
    return includeChildren?branch.has(person.teamId??''):person.teamId===filterTeam;
  }
  const members=sharing?.viewers.filter(matchesDirectory)??[];
  // A role or permission change rotates the grant ID. Keep the editor open for
  // the same person; fall back to the grant if identities share an email.
  const uniqueEmails=new Set<string>(),repeatedEmails=new Set<string>();
  for(const member of sharing?.viewers??[]){
    if(uniqueEmails.has(member.email))repeatedEmails.add(member.email);
    else uniqueEmails.add(member.email);
  }
  const invitations=sharing?.sent.filter(matchesDirectory)??[];
  const filtered=Boolean(needle||filterTeam);
  const noMatches=filtered&&!members.length&&!invitations.length;
  const directoryFilterKey=JSON.stringify([needle,filterTeam,includeChildren]);

  if(selectedTeam)return <div className="portable-workspace-settings">
    <button type="button" onClick={()=>{setSelectedTeam(undefined);void refresh();}}>Back to my workspaces</button>
    <h2>Team from {selectedTeam.ownerEmail}</h2>
    <p>You’re managing this team as a backup administrator. You can share the extra permissions you already have.</p>
    <PortableWorkspaceSharing expanded scope={selectedTeam}/>
  </div>;
  const disclosure=<details data-settings-tab={settingsTab} id="portable-workspace-sharing" open={guest||expanded||undefined}>
    <summary>Workspace sharing{sharing?.incoming.length?' · '+sharing.incoming.length+' pending':
      sharing?.shared.length?' · '+sharing.shared.length+(sharing.sharedNext?'+':'')+' shared with you':''}</summary>
    {error&&<p role="alert">{error}</p>}
    {(sharing||error)&&<p className="portable-sharing-refresh"><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh sharing</button></p>}
    {!sharing&&!error&&<p role="status">Loading workspace access…</p>}
    {(notice||busy)&&<p role="status">{notice||'Updating workspace access…'}</p>}
    {sharing&&<>
      {!settingsTab&&(expanded||guest)&&<WorkspaceRoleGuide initialRole={sharing.managed?'backup':guest?'viewer':'owner'} guideId={guideId}/>}
      {!settingsTab&&(guest||!expanded||sharing.shared.length>0)&&<><h2>Shared with you</h2>
      <JoinedWorkspaceList key={sharingVersion}
        initial={{items:sharing.shared.slice(0,25),next:sharing.shared.length>25?sharing.shared[24].id:sharing.sharedNext??null}}
        actions={workspace=><>
          {workspace.meetingsVisible!==false&&workspace.role==='editor'&&(expanded||guest)&&<PortableTeamScheduling workspaceId={workspace.id} grantId={workspace.grantId}/>}
          {workspace.backupAdmin&&<> · Backup administrator{' '}<button type="button" aria-label={'Manage team from '+workspace.ownerEmail}
            onClick={()=>setSelectedTeam({workspaceId:workspace.id,grantId:workspace.grantId,ownerEmail:workspace.ownerEmail})}>Manage team</button></>}
        </>}/></>}
      {!settingsTab&&sharing.incoming.length>0&&<>
        <h2>Invitations for you</h2>
        <ul>{sharing.incoming.map(invite=><li key={invite.id}>
          Workspace from {invite.ownerEmail} · {roleLabel[invite.role]}{invite.teamName&&<> · {invite.teamName}</>}{invite.viewScope!=='all'&&<> · {scopeLabels[invite.viewScope]}</>}{' '}
          <a href={workspaceInvitationPath(invite.id)}>Review invitation</a>
        </li>)}</ul>
      </>}
      {!settingsTab&&expanded&&!guest&&!sharing.managed&&sharing.owned&&<PortableTeamScheduling workspaceId={sharing.owned}/>}
      {!guest&&<>
      <fieldset disabled={busy||mustRefresh} className="portable-sharing-controls portable-access-controls">
      {settingsTab==='users'&&<p className="portable-settings-owner"><strong>{ownerEmail}</strong> · Workspace owner</p>}
      {settingsTab!=='teams'&&<details id="invite-teammate" ref={inviteForm} className="portable-access-add" open={!sharing.sent.length&&!sharing.viewers.length||undefined}>
      <summary>Invite a teammate</summary>
      <form onSubmit={event=>void grant(event,'invite')} className="portable-access-invite">
        <label>Teammate email<input name="email" type="email" required maxLength={254} placeholder="teammate@example.com"/></label>
        <label>Invitation role
          <select name="inviteRole" value={inviteRole} onChange={event=>setInviteRole(workspaceRole.parse(event.target.value))}><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
        </label>
        {directoryTeams.length>0&&<label>Primary team<select name="inviteTeam" defaultValue="">
          <option value="">No team</option>{directoryTeams.map(team=><option key={team.id} value={team.id}>{team.label}</option>)}
        </select></label>}
        <RecordScopeControls access={inviteAccess} onChange={setInviteAccess} editor={inviteRole==='editor'}/>
        <InvitationAccessPreview role={inviteRole} access={inviteAccess} guideId={guideId} compact={!expanded}/>
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
      </details>}</details>}
      {expanded&&settingsTab!=='users'&&<DirectoryTeams initiallyOpen={settingsTab==='teams'} teams={sharing.teams??[]} mappings={sharing.directoryGroupMappings} samlMappings={sharing.samlGroupMappings} oidcMappings={sharing.oidcGroupMappings} change={change}/>}
      <h2 id="team-directory" tabIndex={-1} ref={directory}>Team directory</h2>
      {settingsTab==='users'&&sharing.owned&&<a download href={'/api/workspaces?'+new URLSearchParams({
        view:'teammate-access',export:'csv',workspaceId:sharing.owned,
      })}>Export all active teammates’ access (CSV)</a>}
      {expanded&&sharing.owned&&(sharing.directoryGroupMappings||sharing.samlGroupMappings||sharing.oidcGroupMappings)&&<DirectoryEmployeeLookup teams={directoryTeams}/>}
      <p className="portable-access-count">{sharing.viewers.length} active {sharing.viewers.length===1?'teammate':'teammates'} · {sharing.sent.length} pending {sharing.sent.length===1?'invitation':'invitations'}{sharing.seatLimit!==null&&<> · Seat limit {sharing.seatLimit}</>}</p>
      {sharing.viewers.length+sharing.sent.length>0&&<div className="portable-access-search">
        <label>Find a teammate<input type="search" placeholder="Search by email" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {directoryTeams.length>0&&<label>Filter by primary team<select value={filterTeam} onChange={event=>setTeamFilter(event.target.value)}>
          <option value="">All teams</option><option value="unassigned">No primary team</option>
          {directoryTeams.map(team=><option key={team.id} value={team.id}>{team.label}</option>)}
        </select></label>}
        {branch.size>1&&<label className="directory-child-teams"><input type="checkbox" checked={includeChildren}
          onChange={event=>setIncludeChildren(event.target.checked)}/>Include child teams</label>}
        {query&&<button type="button" onClick={()=>setQuery('')}>Clear search</button>}
        {filtered&&!noMatches&&<span className="portable-access-count" role="status">
          {members.length+invitations.length} {members.length+invitations.length===1?'match':'matches'}
        </span>}
      </div>}
      {noMatches&&<p className="portable-settings-empty" role="status">{filterTeam?'No teammates or invitations match these filters.':'No matches. Try another email.'}</p>}
      {invitations.length>0&&<>
        <h3>Pending invitations <span className="portable-access-tally">{invitations.length}</span></h3>
        <DirectoryRows items={invitations} noun="invitations" key={directoryFilterKey}>{invite=><li key={invite.id}>
          <div className="portable-access-invitation">
            <div><strong className="portable-access-person">{invite.email}</strong> <span className="portable-access-role" data-role={invite.role}>{roleLabel[invite.role]}</span>
              <small>{invite.teamName&&<>Team: {directoryTeams.find(team=>team.id===invite.teamId)?.label??invite.teamName} · </>}{invite.viewScope!=='all'&&<>{scopeLabels[invite.viewScope]} · </>}Expires <InvitationExpiry expiresAt={invite.expiresAt}/></small></div>
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
        </li>}</DirectoryRows>
      </>}
      {(members.length>0||(!filtered&&expanded))&&<h3>People with access <span className="portable-access-tally">{members.length}</span></h3>}
      {settingsTab==='users'&&selectedPeople.length>0&&<div className="portable-bulk-tool-access">
        <strong>{selectedPeople.length} selected</strong>
        <button type="button" aria-expanded={bulkOpen} onClick={()=>setBulkOpen(!bulkOpen)}>Edit selected users’ permissions</button>
        <button type="button" onClick={()=>{setSelectedIds([]);setBulkOpen(false);}}>Clear selection</button>
        {bulkOpen&&<MemberToolEditor key={selectedPeople.map(p=>p.id).join(',')} people={selectedPeople}
          save={async data=>{const ok=await change(data);if(ok){setBulkOpen(false);setSelectedIds([]);}return ok;}}/>}
      </div>}
      {members.length>0?<DirectoryRows items={members} noun="teammates" key={directoryFilterKey}>{member=><li key={repeatedEmails.has(member.email)?member.id:member.email}>
        {settingsTab==='users'&&<label className="portable-member-select"><input type="checkbox" aria-label={'Select '+member.email}
          checked={selectedIds.includes(member.id)} onChange={e=>{const checked=e.currentTarget.checked;setSelectedIds(ids=>checked?[...ids,member.id]:ids.filter(id=>id!==member.id));}}/></label>}
        <MemberAccess settingsTab={settingsTab} key={member.id} member={member} teams={directoryTeams} managed={sharing.managed} inviteSignIn={!!sharing.inviteSignIn}
          change={change} remove={()=>void remove({action:'revoke',id:member.id})}/>
      </li>}</DirectoryRows>:!filtered&&expanded&&<p className="portable-settings-empty">No teammates have access yet.</p>}
      </fieldset>
      {settingsTab!=='teams'&&sharing.owned&&<details className="portable-access-review"><summary>Review assignments after access changes</summary>
        <p>Find records whose owner or assignee no longer has access.</p>
        <nav aria-label="Review assignments after access changes">
          <Link href="/tickets?assignee=unavailable">Open tickets with unavailable assignees</Link>
          <Link href="/?kind=tasks&taskView=unavailable-assignee">Tasks with unavailable assignees</Link>
          <Link href={enrollmentUrl('active',{assignee:'unavailable'})}>Sales sequences with unavailable assignees</Link>
          <Link href="/?kind=leads&owner=needs-routing">Leads needing routing</Link>
          <Link href="/?owner=unavailable">Contacts</Link>
          <Link href="/?kind=companies&owner=unavailable">Companies</Link>
          <Link href="/?kind=deals&owner=unavailable">Deals</Link>
          <Link href="/?view=custom-objects&owner=unavailable">Custom records</Link>
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
        {review.teamName&&<p>Primary team: <strong>{review.teamName}</strong></p>}
        <InvitationAccessPreview role={review.role} access={review}/>
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
