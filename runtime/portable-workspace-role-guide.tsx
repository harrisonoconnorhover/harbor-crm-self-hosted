import {useId} from 'react';
import type {WorkspacePermission,WorkspaceRole} from '../lib/portable-workspace-access';
import './portable-workspace-role-guide.css';

const roleNames={owner:'Owner',backup:'Backup administrator',editor:'Editor',viewer:'Viewer'} as const;
type GuideRole=keyof typeof roleNames;
const roles=Object.keys(roleNames) as GuideRole[];
type Capability={label:string;hint?:string;access:Record<GuideRole,string>};

const everyone={owner:'Yes',backup:'Yes',editor:'Yes',viewer:'Yes'};
const ownerOnly={owner:'Yes',backup:'No',editor:'No',viewer:'No'};
const crm:Capability[]=[
  {label:'Find and open CRM records',hint:'Contacts, companies, deals, tasks, leads and tickets.',access:everyone},
  {label:'Edit shared records and complete tasks',access:{...everyone,viewer:'No'}},
  {label:'Merge duplicate contacts or companies',hint:'Editors need all four extra permissions for a Contact merge, or Company and deal activities for a Company merge.',
    access:{owner:'Yes',backup:'With required extras',editor:'With required extras',viewer:'No'}},
  {label:'Import records from CSV',access:ownerOnly},
  {label:'View saved dashboards',access:{owner:'All in workspace',backup:'Shared only',editor:'Shared only',viewer:'Shared only'}},
  {label:'Edit or share a dashboard',access:ownerOnly},
  {label:'Set up pipelines, workflows and API tokens',access:ownerOnly},
];
const team:Capability[]=[
  {label:'Invite, change roles and remove teammates',access:{...ownerOnly,backup:'Ordinary members only'}},
  {label:'Grant Viewer access without an invitation',hint:'For an approved account that has already signed in.',access:ownerOnly},
  {label:'Change extra permissions',access:{...ownerOnly,owner:'Any teammate',backup:'Only permissions held'}},
  {label:'Appoint or change a backup administrator',access:ownerOnly},
];

const extras={
  contactFiles:{action:'contact_files',label:'Contact files',accessible:'Share contact files',
    hint:'Includes earlier versions on all contacts. Editors can upload and replace files.',
    owner:'Download, upload and replace',editor:'Download, upload and replace',viewer:'Download'},
  scheduledNotes:{action:'scheduled_notes',label:'Scheduled notes',accessible:'Share scheduled notes',
    hint:'Editors can schedule notes on contacts. Cancel and retry controls are reserved for the owner.',
    owner:'View, schedule and manage',editor:'View and schedule',viewer:'View'},
  contactOutreach:{action:'contact_outreach',label:'Contact outreach',accessible:'Share logged Contact outreach',
    hint:'Includes the contact timeline. Editors can add, correct and remove manual logs.',
    owner:'View and log',editor:'View and log',viewer:'View'},
  recordActivities:{action:'record_activities',label:'Company and deal activities',accessible:'Share logged Company and Deal activities',
    hint:'Includes logged notes, calls and meetings across all companies and deals. Editors can add, correct and remove manual logs.',
    owner:'View and log',editor:'View and log',viewer:'View'},
} as const satisfies Record<WorkspacePermission,{action:string;label:string;accessible:string;hint:string;owner:string;editor:string;viewer:string}>;

export const optionalAccess=(Object.keys(extras) as WorkspacePermission[]).map(field=>({field,...extras[field]}));
const optional:Capability[]=optionalAccess.map(({label,hint,owner,editor,viewer})=>({label,hint,access:{owner,backup:editor,editor,viewer}}));
const groups=[
  {id:'records',title:'Everyday CRM',rows:crm},
  {id:'team',title:'Team access',rows:team},
  {id:'extras',title:'Extra permissions',rows:optional},
];

export function WorkspaceRoleGuide({initialRole,guideId}:{initialRole:GuideRole;guideId:string}){
  const chooser=useId();
  return <details className="portable-role-guide">
    <summary id={guideId+'-title'}>Compare workspace roles</summary>
    <div className="portable-role-guide-body" id={guideId} role="region" aria-labelledby={guideId+'-title'} tabIndex={-1}>
      <p><strong>Viewer</strong> is the default invitation. Choose <strong>Editor</strong> for someone who works deals or completes tasks.
        The owner can appoint an Editor as a <strong>Backup administrator</strong> after they join.</p>
      <nav aria-label="Role guide sections" className="portable-guide-links">
        {groups.map(group=><a key={group.id} href={'#'+guideId+'-'+group.id}>{group.title}</a>)}
      </nav>
      <fieldset className="portable-guide-chooser"><legend>Role to display</legend>
        {roles.map(role=><label key={role}><input type="radio" id={guideId+'-'+role} name={chooser} defaultChecked={role===initialRole} value={role}/>{roleNames[role]}</label>)}
      </fieldset>
      {groups.map(group=><table className="portable-role-matrix" key={group.title}>
        <caption id={guideId+'-'+group.id}>{group.title}{group.id==='extras'?' · off for new teammates':''}</caption>
        <thead><tr><th scope="col">Capability</th>{roles.map(role=><th key={role} scope="col" data-column={role}>{roleNames[role]}</th>)}</tr></thead>
        <tbody>
          {group.rows.map(({label,hint,access})=><tr key={label}>
            <th scope="row">{label}{hint&&<small>{hint}</small>}</th>
            {roles.map(role=><td key={role} data-column={role} data-answer={access[role]==='No'?'no':access[role]==='Yes'?'yes':undefined}>{access[role]}</td>)}
          </tr>)}
        </tbody>
      </table>)}
      <div className="portable-guide-notes">
        <p><strong>Extra permissions are separate.</strong> The last four rows apply to teammates only after each permission is turned on for them. Appointing a backup administrator does not enable any extras.</p>
        <p><strong>Delegation has limits.</strong> A backup administrator cannot change the owner or any backup administrator, including themselves. They can promote a Viewer only if they hold all of that Viewer’s extra permissions. Switching a backup administrator to Viewer removes the appointment.</p>
        <p><strong>Personal accounts stay private.</strong> A workspace role never grants access to another person’s mailbox, calendar connection, server credentials or database backups.</p>
      </div>
    </div>
  </details>;
}

export function openRoleGuide(id:string,role:WorkspaceRole){
  const body=document.getElementById(id),guide=body?.closest('details');
  if(!body||!guide)return;
  guide.open=true;
  const choice=body.querySelector<HTMLInputElement>('input[value="'+role+'"]');
  if(choice)choice.checked=true;
  body.focus();
}
