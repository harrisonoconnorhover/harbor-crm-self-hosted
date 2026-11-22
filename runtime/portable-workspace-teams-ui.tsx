'use client';
import {useState,type FormEvent} from 'react';
import {teamAncestors,type DirectoryGroupChange,type DirectoryGroupMapping,type DirectoryTeam,type TeamChange} from '../lib/portable-workspace-teams';

export function teamOptions(teams:DirectoryTeam[]){
  return teams.map(team=>({id:team.id,path:teamAncestors(teams,team.id)}))
    .map(({id,path})=>({id,label:path.map(item=>item.name).join(' / '),ancestors:path.map(item=>item.id)}))
    .sort((a,b)=>a.label.localeCompare(b.label));
}

function TeamParent({team,options}:{team?:DirectoryTeam;options:ReturnType<typeof teamOptions>}){
  const [parent,setParent]=useState(team?.parentId??'');
  const previous=options.find(item=>item.id===team?.parentId)?.ancestors??[];
  const next=options.find(item=>item.id===parent)?.ancestors??[];
  const gained=options.filter(item=>next.includes(item.id)&&!previous.includes(item.id));
  const lost=options.filter(item=>previous.includes(item.id)&&!next.includes(item.id));
  return <>
    <label>Parent team<select name="parent" value={parent} onChange={e=>setParent(e.target.value)}>
      <option value="">Top level</option>
      {options.filter(item=>!team||!item.ancestors.includes(team.id)).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {team&&parent!==(team.parentId??'')&&<section aria-label="Record access after move" aria-live="polite">
      <h3>Record access after move</h3>
      <p>Moving {team.name} changes team-only access to records owned by its editors and editors in its child teams.</p>
      {gained.length>0&&<p><strong>Gain team access</strong> · {gained.map(item=>item.label).join(', ')}</p>}
      {lost.length>0&&<p><strong>Lose team access</strong> · {lost.map(item=>item.label).join(', ')}</p>}
      <p>Each teammate’s view and edit settings determine what they can do.</p>
    </section>}
  </>;
}

function GroupMappingEditor({team,mapping,change,protocol}:{team:DirectoryTeam;protocol?:'saml'|'oidc';mapping?:DirectoryGroupMapping;
  change:(data:DirectoryGroupChange)=>Promise<boolean>}){
  const label=protocol==='oidc'?'OpenID Connect group':protocol?'Company SSO group':'Microsoft Entra group';
  const mappedKey=mapping&&('groupName' in mapping?mapping.groupName:mapping.externalId);
  function submit(key:string,unlink:boolean,expectedExternalId?:string){
    return change(protocol?{action:unlink?`${protocol}_group_unmap`:`${protocol}_group_map`,teamId:team.id,groupName:key,expectedExternalId}:
      {action:unlink?'directory_group_unmap':'directory_group_map',teamId:team.id,externalId:key});
  }
  async function link(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const key=mappedKey??String(form.get('externalId')??'').trim();
    await submit(key,false,String(form.get('expectedExternalId')??'')||undefined);
  }
  return <section aria-label={label}>
    <h3>{label}</h3>
    {mapping&&mappedKey?<>
      <p>{mapping.groupId?<strong>{mapping.displayName}</strong>:'Waiting for the directory to provision this group.'}</p>
      <p>{protocol?'Approved group name':'Group object ID'} <code>{mappedKey}</code></p>
      {protocol&&'groupName' in mapping&&(mapping.directoryId?<p>Directory group ID <code>{mapping.directoryId}</code></p>:
        mapping.groupId?<p>The directory provided this group by name only.</p>:<form onSubmit={link}>
          <label>Directory group ID<input name="expectedExternalId" maxLength={254} required spellCheck={false}/></label>
          <button type="submit">Require this ID on first sync</button>
        </form>)}
      <details><summary>Unlink directory group…</summary>
        <p>Unlinking clears the primary team for members assigned by this group. They keep their workspace access.</p>
        <button type="button" onClick={()=>void submit(mappedKey,true)}>Unlink directory group</button>
      </details>
    </>:<form onSubmit={link}>
      <label>{protocol?'Directory group name':'Microsoft Entra group object ID'}<input name="externalId" required maxLength={protocol?120:36}
        pattern={protocol?undefined:'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'} spellCheck={false}/></label>
      {protocol&&<><label>Directory group ID (recommended)<input name="expectedExternalId" maxLength={254} spellCheck={false}/></label>
        <p>Copy the exact external ID sent by your directory. Leave it blank only if group names are unique and your directory sends names only.</p></>}
      <p>Members provisioned by this group are assigned to {team.name} as their primary team.</p>
      <button type="submit">Link directory group</button>
    </form>}
  </section>;
}

export function DirectoryTeams({teams,mappings,samlMappings,oidcMappings,change,initiallyOpen=false}:{initiallyOpen?:boolean;teams:DirectoryTeam[];mappings?:DirectoryGroupMapping[];samlMappings?:DirectoryGroupMapping[];oidcMappings?:DirectoryGroupMapping[];change:(data:TeamChange|DirectoryGroupChange)=>Promise<boolean>}){
  const [selected,setSelected]=useState('');
  const [confirming,setConfirming]=useState(false);
  const options=teamOptions(teams);
  const team=teams.find(item=>item.id===selected);
  const entraMapping=mappings?.find(item=>item.teamId===selected);
  const oidcMapping=oidcMappings?.find(item=>item.teamId===selected);
  const samlMapping=samlMappings?.find(item=>item.teamId===selected);
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget,fields=new FormData(form);
    const name=String(fields.get('name')??'').trim(),parentId=String(fields.get('parent')??'')||null;
    const id=team?.id??crypto.randomUUID();
    const success=team?await change({action:'team_edit',id,revision:team.revision,name,parentId}):
      await change({action:'team_create',id,name,parentId});
    if(success)setSelected(id);
  }
  return <details className="portable-access-direct" open={initiallyOpen||undefined}>
    <summary>Teams and pods{teams.length?' · '+teams.length:''}</summary>
    <p>Organize teammates by department or pod. Assign a teammate in the directory below. Team-only access includes records owned by editors in that team and its child teams.</p>
    <label>Manage team<select value={team?.id??''} onChange={event=>{setSelected(event.target.value);setConfirming(false);}}>
      <option value="">New team</option>{options.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    <form key={team?team.id+'-'+team.revision:'new'} onSubmit={save}>
      <label>Team name<input name="name" required maxLength={80} defaultValue={team?.name??''}/></label>
      <TeamParent team={team} options={options}/>
      <button type="submit">{team?'Save team':'Create team'}</button>
    </form>
    {team&&mappings&&!oidcMapping&&!samlMapping&&<GroupMappingEditor key={'entra-'+team.id} team={team} mapping={entraMapping} change={change}/>}
    {team&&samlMappings&&!oidcMapping&&!entraMapping&&<GroupMappingEditor key={'saml-'+team.id} team={team} mapping={samlMapping} protocol="saml" change={change}/>}
    {team&&oidcMappings&&!samlMapping&&!entraMapping&&<GroupMappingEditor key={'oidc-'+team.id} team={team} mapping={oidcMapping} protocol="oidc" change={change}/>}
    {team&&(confirming?<div><span>Delete {team.name}?</span>{' '}
      <button type="button" onClick={async()=>{if(await change({action:'team_remove',id:team.id,revision:team.revision})){setSelected('');setConfirming(false);}}}>Delete empty team</button>{' '}
      <button type="button" onClick={()=>setConfirming(false)}>Cancel</button></div>:
      <button type="button" onClick={()=>setConfirming(true)}>Remove team</button>)}
  </details>;
}
