import {RecordPermissionTable} from './portable-record-permission-table';
import {PortableDataQuality} from './portable-data-quality';
import {PortableAccountDefaults} from './portable-account-defaults-page';
import {PortableUsersTeams} from './portable-users-teams-page';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {listPortableStandardAccess} from '../db/postgres/standard-property-access';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {readOwnRecordPermissions} from '../db/postgres/workspace-viewer-store';
import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {portableCustomPropertyKinds} from '../lib/portable-custom-properties';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import {portableImportName} from '../lib/portable-contact-import';
import {PortableRecordImport} from './portable-contact-import-ui';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableCustomPropertySettings} from './portable-custom-properties-ui';
import {portableCalendarConfig} from './portable-calendar-config';
import {portableGmailInboxOwner} from './portable-gmail-inbox-config';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {outlookConfig} from './portable-outlook-provider';
import {portableDb} from './portable-db';
import {PortablePipelineSettings} from './portable-deal-pipeline-ui';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {withPortableNavigation} from './portable-navigation';
import {memberPropertyPreview} from '../db/postgres/member-property-preview';
import {MemberPropertyPreview} from './portable-member-property-preview';
import {PortableSettingsLayout} from './portable-settings-layout';
import './portable-contacts.css';

const settingsQuery=z.object({
  view:z.literal('settings'),
  section:z.enum(['overview','data-management','objects','properties','pipelines','integrations','users-teams','account-defaults','data-quality']).default('overview'),
  tab:z.enum(['users','teams']).optional(),member:z.string().guid().optional(),kind:portableCustomPropertyKinds.optional(),workspaceId:z.string().guid().optional(),
}).strict();
const importQuery=z.object({view:z.literal('import'),kind:portableCustomPropertyKinds.or(z.literal('paired')).default('contacts')}).strict();
function pagePath(input:Record<string,string|undefined>){
  return '/?'+new URLSearchParams(Object.entries(input).filter((pair):pair is [string,string]=>typeof pair[1]==='string'));
}
type Card=readonly [label:string,href:string,detail:string];
function SettingsCards({items}:{items:readonly Card[]}){
  return <div className="portable-settings-cards">{items.map(([label,href,detail])=>
    <a key={href} href={href}><strong>{label}</strong><span>{detail}</span></a>)}</div>;
}
function YourRecordPermissions({member,workspaceId}:{member:NonNullable<Awaited<ReturnType<typeof readOwnRecordPermissions>>>;workspaceId:string}){
  return <>
    <dl className="portable-access-identity">
      <div><dt>Role</dt><dd>{member.backupAdmin?'Backup administrator':member.role==='editor'?'Editor':'Viewer'}</dd></div>
      <div><dt>Primary team</dt><dd>{member.team??'No team'}</dd></div>
    </dl>
    <RecordPermissionTable member={member} self/>
    {effectiveMemberToolPolicy(member,'contacts').view!=='none'&&<a href={'/?workspaceId='+workspaceId}>Open shared records</a>}
  </>;
}
const propertiesPath='/?view=settings&section=properties';
const dataTools:readonly Card[]=[
  ['Properties',propertiesPath,'Manage fields, groups and field visibility.'],
  ['Objects','/?view=settings&section=objects','Choose an object to configure.'],
  ['CSV import','/?view=import','Preview spreadsheet changes and apply selected rows.'],
  ['Data quality','/?view=settings&section=data-quality','Review workspace data and issues that need attention.'],
  ['Duplicates','/?view=duplicates','Review matching contacts and companies.'],
  ['Integrations','/?view=settings&section=integrations','Find email, calendar and API connections.'],
  ['API access','/?view=api-access','Manage access tokens and outbound webhooks.'],
];
function IntegrationSettings({email}:{email:string}){
  const owner=email.toLowerCase();
  const connections:Card[]=[];
  if(portableGmailInboxOwner()===owner||portablePersonalGoogleConfig('gmail'))
    connections.push(['Gmail','/?view=email-settings#email-connection','Manage your Gmail connection.']);
  if(outlookConfig('outlook-mail'))
    connections.push(['Outlook mail','/?view=email-settings#outlook-connection','Manage your Microsoft mailbox connection.']);
  if(portableCalendarConfig()?.owner===owner||portablePersonalGoogleConfig('calendar')||outlookConfig('outlook-calendar'))
    connections.push(['Calendar connections','/?view=calendar','Manage available calendar connections and check availability.']);
  return <>
    <h2>Email and calendar</h2>
    {connections.length?<SettingsCards items={connections}/>:<p>Your host has not configured email or calendar connections for this account.</p>}
    <h2>Developer tools</h2>
    <SettingsCards items={[[ 'API access','/?view=api-access','Manage access tokens and outbound webhooks.' ]]}/>
  </>;
}
export async function PortableSettingsPage({input}:{input:Record<string,string|undefined>}){
  const parsed=settingsQuery.safeParse(input);
  if(!parsed.success)notFound();
  const {section,workspaceId,kind:selected,member}=parsed.data;
  if(parsed.data.tab&&section!=='users-teams'||selected&&section!=='properties'||workspaceId&&section!=='overview'||member&&(section!=='properties'&&section!=='users-teams'||selected||parsed.data.tab==='teams'))notFound();
  const user=await requireChatGPTUser(pagePath(input)),db=portableDb();
  const guest=portableWorkspaceGuest(user.email);
  if(guest&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig().allowedEmails)))notFound();
  const grant=workspaceId?await readOwnRecordPermissions(db,user.userId,workspaceId):undefined;
  if(workspaceId&&!grant)notFound();
  if(member){
    const preview=await memberPropertyPreview(db,user.userId,member);
    if(!preview)notFound();
    return withPortableNavigation(user.email,<main className="portable-contacts">
      <PortableCrmHeader email={user.email} page="settings"/>
      <PortableSettingsLayout active={section}><MemberPropertyPreview preview={preview} usersTab={section==='users-teams'}/></PortableSettingsLayout>
    </main>);
  }
  const kind=section==='pipelines'?'deals':selected??'contacts';
  const [properties,standardAccess,pipelines]=await Promise.all([
    section==='properties'||section==='pipelines'?listPortableCustomProperties(db,user.userId,kind):[],
    section==='properties'?listPortableStandardAccess(db,user.userId,kind):[],
    section==='pipelines'?readDealPipelines(db,user.userId):[],
  ]);
  const title={'users-teams':'Users & Teams','account-defaults':'Account defaults','data-quality':'Data quality',overview:workspaceId?'Your workspace access':'Settings',integrations:'Integrations',properties:'Properties',objects:'Objects',pipelines:'Pipelines','data-management':'Data management'}[section];
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} workspaceId={workspaceId} page={section==='integrations'||section==='data-management'?section:'settings'}/>
    <PortableSettingsLayout active={section} workspaceId={workspaceId}>
      <section><h1>{title}</h1>
        {grant&&workspaceId?<YourRecordPermissions member={grant} workspaceId={workspaceId}/>:
          section==='users-teams'?<PortableUsersTeams user={user} tab={parsed.data.tab??'users'}/>:
          section==='account-defaults'?<PortableAccountDefaults ownerId={user.userId}/>:
          section==='data-quality'?<PortableDataQuality ownerId={user.userId}/>:
          section==='overview'?<SettingsCards items={[
            ['Users & Teams','/?view=settings&section=users-teams','Manage teammates, permissions and teams.'],
            ['Account defaults','/?view=settings&section=account-defaults','Set your workspace name and regional preferences.'],
            ['Data quality','/?view=settings&section=data-quality','Review issues with workspace records and tools.'],
            ['Data management','/?view=settings&section=data-management','Configure records, imports and API access.'],
            ['Workspaces','/?view=workspaces','Manage access and invitations.'],
            ['Team directory','/?view=workspaces#team-directory','Find teammates and check their access.'],
            ['Job queue','/?view=job-queue','Review recent jobs and resolve failures.'],
            ['Getting started','/?view=getting-started','Set up your workspace and import your first records.'],
          ]}/>:
          section==='data-management'?<SettingsCards items={dataTools}/>:
          section==='integrations'?<IntegrationSettings email={user.email}/>:
          section==='objects'?<SettingsCards items={[
            ...portableCustomPropertyKinds.options.map(k=>[portableImportName(k),propertiesPath+'&kind='+k,'Configure fields and groups for '+k+'.'] as const),
            ['Deal pipelines','/?view=settings&section=pipelines','Manage deal stages, probabilities and required properties.'],
            ['Custom objects','/?view=custom-objects','Manage object definitions and records.'],
          ]}/>:
          section==='properties'?<>
            <nav className="portable-setting-tabs" aria-label="Property object">{portableCustomPropertyKinds.options.map(k=>
              <a key={k} href={propertiesPath+'&kind='+k} aria-current={k===kind?'page':undefined}>{portableImportName(k)}</a>)}</nav>
            <PortableCustomPropertySettings key={kind} kind={kind} properties={properties} standardAccess={standardAccess} initiallyOpen/>
          </>:<PortablePipelineSettings pipelines={[builtinPipeline,...pipelines]} customProperties={properties} initiallyOpen/>}
      </section>
    </PortableSettingsLayout>
  </main>,{actorId:user.userId,workspaceId});
}
export async function PortableCsvImportPage({input}:{input:Record<string,string|undefined>}){
  const parsed=importQuery.safeParse(input);
  if(!parsed.success)notFound();
  const user=await requireChatGPTUser(pagePath(input));
  if(portableWorkspaceGuest(user.email))notFound();
  const {kind}=parsed.data,properties=kind==='paired'?[]:await listPortableCustomProperties(portableDb(),user.userId,kind);
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="import"/>
    <section className="portable-import-destination"><h1>CSV import</h1>
      <nav className="portable-setting-tabs" aria-label="Import object">{[...portableCustomPropertyKinds.options,'paired' as const].map(k=>
        <a key={k} href={'/?view=import&kind='+k} aria-current={kind===k?'page':undefined}>{portableImportName(k)}</a>)}</nav>
      <PortableRecordImport key={kind} kind={kind} customProperties={properties} initiallyOpen/>
    </section>
  </main>,{actorId:user.userId});
}
