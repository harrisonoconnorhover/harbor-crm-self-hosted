import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {RecordPermissionTable} from './portable-record-permission-table';
import {MemberRecordCheck} from './portable-member-record-check';
import Link from 'next/link';
import type {memberPropertyPreview} from '../db/postgres/member-property-preview';
import {portableCustomPropertyKinds,portablePropertyGroupFields} from '../lib/portable-custom-properties';
import {scopeLabels,type RecordScope} from '../lib/portable-workspace-access';
import {portableImportName} from '../lib/portable-contact-import';

export function MemberPropertyPreview({preview,usersTab=false}:{usersTab?:boolean;preview:NonNullable<Awaited<ReturnType<typeof memberPropertyPreview>>>}){
  const scopeLabel=(scope:RecordScope)=>scope==='team'&&!preview.team?scopeLabels.owned:scopeLabels[scope];
  return <section className="portable-field-preview"><Link prefetch={false} href={usersTab?'/?view=settings&section=users-teams':'/?view=workspaces#team-directory'}>{usersTab?'Back to Users':'Back to team directory'}</Link>
    <h1>Record and field access for {preview.email}</h1>
    <section aria-label="Record access"><h2>Record access</h2>
      <dl><div><dt>Role</dt><dd>{preview.backupAdmin?'Backup administrator':preview.role==='editor'?'Editor':'Viewer'}</dd></div>
        <div><dt>Primary team</dt><dd>{preview.team??'No team'}</dd></div>
        <div><dt>Default view scope</dt><dd>{scopeLabel(preview.viewScope)}</dd></div>
        <div><dt>Default edit scope</dt><dd>{preview.role==='editor'?scopeLabel(preview.editScope):'View only'}</dd></div></dl>
      <MemberRecordCheck memberId={preview.grantId}/>
    </section>
    <RecordPermissionTable member={preview}/>
    <p>These rules apply to the records this teammate can open. Fields without a visibility restriction are visible.</p>
    {portableCustomPropertyKinds.options.map(kind=>{
      const access=effectiveMemberToolPolicy(preview,kind);
      const labels=portablePropertyGroupFields(kind,[]);
      const fields=[
        ...preview.fields.filter(field=>field.kind===kind),
        ...preview.rules.filter(rule=>rule.kind===kind&&rule.id!=='stage')
          .map(rule=>({...rule,label:labels.find(field=>field.id===rule.id)?.label??rule.id})),
      ].sort((a,b)=>a.label.localeCompare(b.label));
      const stage=kind==='deals'?preview.rules.find(rule=>rule.kind==='deals'&&rule.id==='stage'):undefined;
      return <section key={kind} aria-label={portableImportName(kind)}>
        <h2>{portableImportName(kind)}</h2>
        {access.view==='none'?<p>No access to these records.</p>:<p>View: {scopeLabel(access.view)} · Edit: {access.edit==='none'?'None':scopeLabel(access.edit)}</p>}
        {fields.length?<dl>{fields.map(field=><div key={field.id}><dt>{field.label}</dt>
          <dd>{field.visible?'Visible':'Hidden'}</dd></div>)}</dl>:<p>No restricted fields.</p>}
        {stage&&<p>Deal stage is visible. {stage.visible&&access.edit!=='none'?'This teammate can move deals they can edit.':'This teammate cannot move deals between stages.'}</p>}
        <Link prefetch={false} href={'/?view=settings&section=properties&kind='+kind}>Manage {kind} properties</Link>
      </section>;
    })}
  </section>;
}
