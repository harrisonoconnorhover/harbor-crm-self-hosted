import {effectiveMemberToolPolicy,memberRecordTools,memberToolNames,type MemberToolScope} from '../lib/portable-tool-permissions';
import type {readOwnRecordPermissions} from '../db/postgres/workspace-viewer-store';

type Member=NonNullable<Awaited<ReturnType<typeof readOwnRecordPermissions>>>;
export function RecordPermissionTable({member,self=false}:{member:Member;self?:boolean}){
  const own=self?'Your own records':'Their own records';
  const scopes={all:'All records',team:member.team?(self?'Your team and child teams':'Their team and child teams'):own,owned:own,none:'None'} satisfies Record<MemberToolScope,string>;
  const rows=memberRecordTools.map(tool=>({tool,access:effectiveMemberToolPolicy(member,tool)}));
  return <>
    <div className="portable-self-access-table" role="region" aria-label="Record permissions" tabIndex={0}>
      <table><caption>Record permissions</caption>
        <thead><tr>{['Records','View','Create','Edit','Delete'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map(({tool,access})=>{
          return <tr key={tool}><th scope="row">{memberToolNames[tool]}</th><td>{scopes[access.view]}</td><td>{access.create?'Yes':'No'}</td>
            <td>{scopes[access.edit]}</td><td>{access.delete?scopes[access.edit]:'None'}</td></tr>;
        })}</tbody>
      </table>
    </div>
    {member.teamPaths.length>0&&rows.some(({access})=>access.view==='team'||access.edit==='team')&&
      <details><summary>Teams included in team-only access</summary>
        <p>Team access includes records owned by editors in the listed teams, plus the member’s own records.</p>
        <ul>{member.teamPaths.map((path,i)=><li key={i}>{path}</li>)}</ul>
      </details>}
  </>;
}
