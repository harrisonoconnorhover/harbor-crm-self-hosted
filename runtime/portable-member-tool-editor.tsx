'use client';

import {useState} from 'react';
import {isAuxiliaryTool,editableAuxiliaryTool,effectiveMemberToolPolicy,memberToolNames,memberTools,type MemberTool,type MemberToolPolicy,type ToolPolicies} from '../lib/portable-tool-permissions';
import type {MemberRecordAccess,WorkspaceRole} from '../lib/portable-workspace-access';

type Person=MemberRecordAccess&{id:string;email:string;role:WorkspaceRole;toolPolicies?:ToolPolicies};
export type ToolChange={action:'tool_permissions';ids:string[];tool:MemberTool;policy:MemberToolPolicy};
type Props={people:Person[];save:(change:ToolChange)=>Promise<boolean>};
const scopeOptions=[['none','None'],['owned','Owned only'],['team','Team only'],['all','All records']] as const;
function common(values:string[]){return values.every(value=>value===values[0])?values[0]:'';}

export function MemberToolEditor({people,save}:Props){
  const [tool,setTool]=useState<MemberTool>(memberTools[0]);
  return <div className="portable-member-tools">
    <label>Tool<select aria-label="Tool" value={tool} onChange={e=>setTool(e.target.value as MemberTool)}>
      {memberTools.map(value=><option key={value} value={value}>{memberToolNames[value]}</option>)}
    </select></label>
    <ToolActions key={tool} people={people} tool={tool} save={save}/>
  </div>;
}

function ToolActions({people,tool,save}:Props&{tool:MemberTool}){
  const current=people.map(person=>effectiveMemberToolPolicy(person,tool));
  const original={view:common(current.map(p=>p.view)),create:common(current.map(p=>String(p.create))),
    edit:common(current.map(p=>p.edit)),delete:common(current.map(p=>String(p.delete)))};
  const [changes,setChanges]=useState<Partial<typeof original>>({});
  const fields={...original,...changes};
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const canWrite=people.some(p=>p.role==='editor');
  const dirty=(Object.keys(original) as (keyof typeof original)[]).some(key=>fields[key]!==original[key]);
  const rank=(scope:string)=>scopeOptions.findIndex(([key])=>key===scope);
  async function submit(event:React.FormEvent){
    event.preventDefault();
    if(saving||!dirty)return;
    if(Object.values(fields).some(v=>!v)){setError('Choose a value for each mixed permission before saving.');return;}
    setError('');
    const policy:MemberToolPolicy={view:fields.view as MemberToolPolicy['view'],edit:fields.edit as MemberToolPolicy['edit'],
      create:fields.create==='true',delete:fields.delete==='true'};
    setSaving(true);
    try{
      if(await save({action:'tool_permissions',tool,ids:people.map(p=>p.id),policy}))setChanges({});
    }finally{setSaving(false);}
  }
  function change(key:keyof typeof original,value:string){
    const next={...changes,[key]:value};
    if(key==='view'&&value==='none')Object.assign(next,{create:'false',edit:'none',delete:'false'});
    else if(key==='view'&&rank(value)<rank(fields.edit))next.edit=value;
    if(next.edit==='none')next.delete='false';
    setChanges(next);
  }
  return <form onSubmit={submit}>
    <fieldset disabled={saving}><legend>{memberToolNames[tool]} access</legend>
      {(['view','create','edit','delete'] as const).map(key=>{
        if(isAuxiliaryTool(tool)&&key!=='view'&&!(key==='edit'&&editableAuxiliaryTool(tool))&&!(key==='create'&&tool==='files'))return null;
        const isScope=key==='view'||key==='edit';
        return <label key={key}>{key[0].toUpperCase()+key.slice(1)}
          <select aria-label={key[0].toUpperCase()+key.slice(1)} value={fields[key]} onChange={e=>change(key,e.target.value)} required disabled={key!=='view'&&(!canWrite||fields.view==='none')||key==='delete'&&fields.edit==='none'}>
            {!fields[key]&&<option value="">Mixed · choose a value</option>}
            {isScope?scopeOptions.filter(([v])=>!isAuxiliaryTool(tool)||v==='all'||v==='none').map(([value,label])=><option key={value} value={value}
              disabled={key==='edit'&&!!fields.view&&rank(value)>rank(fields.view)}>{isAuxiliaryTool(tool)&&value==='all'?'Allow':label}</option>):
              <><option value="true">Allow</option><option value="false">Deny</option></>}
          </select></label>;
      })}
    </fieldset>
    <p>Workspace role, record scope and field restrictions also apply.</p>
    {error&&<p role="alert">{error}</p>}
    <button type="submit" disabled={saving||!dirty}>{people.length===1?'Save tool permissions':'Apply to '+people.length+' users'}</button>
  </form>;
}
