'use client';

import Link from 'next/link';
import {useState,type FormEvent} from 'react';
import type {ownedDirectoryEmployees,ownedDirectoryRoster} from '../db/postgres/workspace-directory-access';

type Matches=Awaited<ReturnType<typeof ownedDirectoryEmployees>>;
type Roster=Awaited<ReturnType<typeof ownedDirectoryRoster>>;
type Mode='email'|'editor'|'viewer'|'inactive';
function EmployeeAccess({row}:{row:Matches[number]}){
  return <>{row.displayName&&<>{row.displayName} · </>}{row.provider} · {row.role?
    'Active · '+(row.backupAdmin?'Backup administrator':row.role==='editor'?'Editor':'Viewer')+(row.team?' · '+row.team:''):'Inactive · No workspace access'}{row.memberId&&<> · <Link prefetch={false}
      href={'/?view=settings&section=properties&member='+row.memberId}>Review record and field access</Link></>} · <Link prefetch={false}
      href={'/?'+new URLSearchParams({view:'record-access',actor:row.actorId})}>View record access history</Link></>;
}

export function DirectoryEmployeeLookup({teams}:{teams:{id:string;label:string;ancestors:string[]}[]}){
  const [teamId,setTeamId]=useState('');
  const [includeChildren,setIncludeChildren]=useState(false);
  const [result,setResult]=useState<{email:string;matches:Matches}>();
  const [mode,setMode]=useState<Mode>('email');
  const [roster,setRoster]=useState<Roster>();
  const [pages,setPages]=useState<string[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const hasChildren=Boolean(teamId)&&teams.some(team=>team.id!==teamId&&team.ancestors.includes(teamId));
  async function lookup(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    await load(String(new FormData(event.currentTarget).get('email')??'').trim().toLowerCase());
  }
  async function load(email:string,starts:string[]=[]){
    if(busy)return;
    setResult(undefined);setRoster(undefined);setError('');setBusy(true);
    try{
      const query=new URLSearchParams({directoryRoster:mode});
      if(teamId&&(mode==='editor'||mode==='viewer')){
        query.set('teamId',teamId);
        if(hasChildren&&includeChildren)query.set('includeChildren','1');
      }
      const after=starts.at(-1);
      if(after)query.set('after',after);
      const response=mode==='email'?await fetch('/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'lookup_directory_employee',email})}):await fetch('/api/workspaces?'+query,{cache:'no-store'});
      if(!response.ok)throw Error();
      if(mode==='email')setResult({email,matches:(await response.json() as {employees:Matches}).employees});
      else{setRoster(await response.json() as Roster);setPages(starts);}
    }catch{setError('Could not check directory access. Refresh Workspaces and try again.');}
    finally{setBusy(false);}
  }
  return <details className="portable-access-direct">
    <summary>Check company directory access</summary>
    <form onSubmit={lookup}>
      <label>Find employees by<select value={mode} disabled={busy} onChange={event=>{
        setMode(event.target.value as Mode);setTeamId('');setIncludeChildren(false);setResult(undefined);setRoster(undefined);setPages([]);setError('');
      }}>
        <option value="email">Email address</option><option value="editor">Active editors</option>
        <option value="viewer">Active viewers</option><option value="inactive">Inactive employees</option>
      </select></label>
      {(mode==='editor'||mode==='viewer')&&<label>Primary team<select disabled={busy} value={teamId} onChange={event=>{
        setTeamId(event.target.value);setIncludeChildren(false);setRoster(undefined);setPages([]);setError('');
      }}><option value="">All teams</option><option value="unassigned">No primary team</option>
        {teams.map(team=><option key={team.id} value={team.id}>{team.label}</option>)}
      </select></label>}
      {hasChildren&&<label className="directory-child-teams"><input type="checkbox" checked={includeChildren} disabled={busy}
        onChange={event=>{setIncludeChildren(event.target.checked);setRoster(undefined);setPages([]);setError('');}}/> Include child teams</label>}
      {mode==='email'&&<label>Employee email<input type="email" name="email" required maxLength={254} disabled={busy}/></label>}
      <button disabled={busy}>{busy?'Checking…':'Check access'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {result&&<div role="status">{result.matches.length?<>
      <strong>{result.email}</strong>
      <ul>{result.matches.map((row,index)=><li key={index}><EmployeeAccess row={row}/></li>)}</ul>
    </>:<p>No company directory entry for {result.email} in this workspace.</p>}</div>}
    {roster&&<div role="status">{roster.employees.length?<ul>{roster.employees.map(row=><li key={row.id}>
      <strong>{row.email}</strong> · <EmployeeAccess row={row}/></li>)}</ul>:<p>No matching directory employees on this page.</p>}
      {(pages.length>0||roster.next)&&<div>
        <span>Page {pages.length+1}</span>
        {pages.length>0&&<button type="button" disabled={busy} onClick={()=>void load('',pages.slice(0,-1))}>Previous employees</button>}
        {roster.next&&<button type="button" disabled={busy} onClick={()=>roster.next&&void load('',[...pages,roster.next])}>Next employees</button>}
      </div>}
    </div>}
  </details>;
}
