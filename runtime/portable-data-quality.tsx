import Link from 'next/link';
import {readOwnerDataQuality} from '../db/postgres/data-quality-store';
import {portableRecordPath} from '../lib/portable-record-path';
import {portableRecordLabels} from '../lib/portable-records';
import {portableDb} from './portable-db';
import {QualityDuplicates} from './portable-quality-duplicates';
import {WorkspaceNumber} from './portable-workspace-format';
import './portable-data-quality.css';

const propertiesPath='/?view=settings&section=properties';
const propertyChecks=[['unused','Unused'],['noData','No data'],['duplicate','Similar labels'],['format','Formatting issues']] as const;
const audienceStates:Record<string,string>={missing:'No sync recorded',ready:'Current',syncing:'In progress',stalled:'Inactive · no progress for five minutes',
  failed:'Failed',stale:'Inactive · snapshot older than 24 hours'};

export async function PortableDataQuality({ownerId}:{ownerId:string}){
  const quality=await readOwnerDataQuality(portableDb(),ownerId);
  const properties=quality?.properties??[];
  const workflows=quality?.workflows;
  const integrations=quality?.integrations;
  return <div className="portable-data-quality">
    <section aria-label="Duplicates"><h2>Duplicates</h2><QualityDuplicates/></section>
    <section aria-label="Properties"><h2>Properties</h2>
      <p>Checks custom fields on active contacts, companies and deals. An unused field has no values and no reference in saved-view columns, report filters or deal-stage requirements. Formatting checks flag irregular label spacing and values that do not match the field type or available choices.</p>
      <dl>{propertyChecks.map(([key,label])=><div key={key}><dt>{label}</dt><dd><WorkspaceNumber value={properties.filter(p=>p[key]).length}/></dd></div>)}</dl>
      {properties.some(p=>propertyChecks.some(([key])=>p[key]))&&<details><summary>Review fields</summary>
        <ul>{properties.filter(p=>propertyChecks.some(([key])=>p[key])).map(p=><li key={p.kind+':'+p.id}>
          <a href={propertiesPath+'&kind='+p.kind+'#property-'+p.id}>{p.label} · {portableRecordLabels[p.kind]}</a>
          <small>{propertyChecks.filter(([key])=>p[key]).map(([,label])=>label).join(' · ')}</small>
          {p.malformedId&&<Link prefetch={false} aria-label={'Review affected record for '+p.label} href={portableRecordPath(p.kind,p.malformedId)}>Review affected record</Link>}
        </li>)}</ul></details>}
      <Link prefetch={false} href={propertiesPath}>Manage properties</Link>
    </section>
    <section aria-label="Records"><h2>Records</h2>
      <p>Checks required names, name spacing, contact email format, and company domains and website addresses. Deals are checked against their current stage requirements.</p>
      <dl>{(['contacts','companies'] as const).flatMap(kind=>{
        const row=quality?.records.find(r=>r.kind===kind);
        return (['missing','format'] as const).map(key=>{
          const id=row?.[key==='missing'?'missingId':'formatId'];
          const label=(kind==='contacts'?'Contacts':'Companies')+(key==='missing'?' missing a name':' with formatting issues');
          return <div key={kind+key}><dt>{id?<Link prefetch={false} href={portableRecordPath(kind,id)} title="Review the first matching record">{label}</Link>:label}</dt><dd><WorkspaceNumber value={row?.[key]??0}/></dd></div>;
        });
      })}
        <div><dt>{quality?.stageRequirements.firstId?<Link prefetch={false} href={portableRecordPath('deals',quality.stageRequirements.firstId)}>Deals missing stage requirements</Link>:'Deals missing stage requirements'}</dt>
          <dd><WorkspaceNumber value={quality?.stageRequirements.count??0}/></dd></div>
      </dl>
      <div className="quality-links"><Link prefetch={false} href="/">Open contacts</Link><Link prefetch={false} href="/?kind=companies">Open companies</Link></div>
    </section>
    <section aria-label="Integrations"><h2>Integrations</h2><dl>
      <div><dt>Salesforce audience sync</dt><dd>{audienceStates[integrations?.audience??'missing']}</dd></div>
      <div><dt>Failed or uncertain Salesforce form deliveries</dt><dd><WorkspaceNumber value={integrations?.salesforceDeliveries??0}/></dd></div>
      <div><dt>Failed or uncertain webhook deliveries</dt><dd><WorkspaceNumber value={integrations?.webhookDeliveries??0}/></dd></div>
    </dl><div className="quality-links"><Link prefetch={false} href="/?view=settings&section=integrations">Manage integrations</Link>
      <Link prefetch={false} href="/?view=api-access">Review webhooks</Link></div></section>
    <section aria-label="Workflows"><h2>Workflows</h2>
      <dl><div><dt>Never enrolled a record</dt><dd><WorkspaceNumber value={workflows?.unused??0}/></dd></div>
        <div><dt>Workflows with unresolved run issues</dt><dd><WorkspaceNumber value={workflows?.issues??0}/></dd></div></dl>
      <p>Includes unreviewed failed actions, actions needing attention, missed queue admissions and unavailable Gmail connections.</p>
      <div className="quality-links"><Link prefetch={false} href="/?view=workflows">Open workflows</Link><Link prefetch={false} href="/?view=workflows#recent-runs">Review recent runs</Link></div>
    </section>
  </div>;
}
