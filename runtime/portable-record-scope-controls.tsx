'use client';
import {scopeLabels,recordScope,recordScopes,validRecordAccess,type MemberRecordAccess} from '../lib/portable-workspace-access';

export function RecordScopeControls({access,onChange,editor}:{access:MemberRecordAccess;onChange:(access:MemberRecordAccess)=>void;editor:boolean}){
  return <>
    <label>Can view<select value={access.viewScope} onChange={event=>{
      const viewScope=recordScope.parse(event.target.value);
      onChange({viewScope,editScope:validRecordAccess({...access,viewScope})?access.editScope:viewScope});
    }}>{recordScopes.map(scope=><option key={scope} value={scope}>{scopeLabels[scope]}</option>)}</select></label>
    {editor&&<label>Can edit<select value={access.editScope} onChange={event=>onChange({...access,editScope:recordScope.parse(event.target.value)})}>
      {recordScopes.filter(editScope=>validRecordAccess({...access,editScope})).map(scope=><option key={scope} value={scope}>{scopeLabels[scope]}</option>)}
    </select></label>}
  </>;
}
