/* eslint-disable @next/next/no-html-link-for-pages -- Portable CRM uses document navigation. */
import {PortableRecordImport} from './portable-contact-import-ui';
import {ArrowRight,FileSpreadsheet,Handshake,ListChecks,NotebookPen,Users} from 'lucide-react';
import {PortableSettingsLayout} from './portable-settings-layout';
import {PortableCrmHeader} from './portable-crm-header';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import type {PortablePersonalGoogleReadiness} from './portable-google-config';
import './portable-contacts.css';
import './portable-guide.css';

const googleProviders={
  gmail:{name:'Gmail',access:'read-only messages from your contacts',href:'/?view=email-settings',link:'Open Email settings'},
  calendar:{name:'Google Calendar',access:'read-only free/busy times',href:'/?view=calendar',link:'Open Calendar'},
};
const googleIssues={
  origin:'The sign-in origin does not match this deployment mode.',
  credentials:'This connection’s OAuth client ID or secret is not set.',
  shared_client:'This connection needs its own OAuth client, separate from sign-in and other Google connections.',
  key:'The personal Google encryption key is missing or invalid.',
  callback:'The connection callback address could not be prepared.',
};

const connectionStates={
  not_connected:{message:'Ready to connect.',action:(name:string)=>'Connect '+name},
  connected:{message:'Connection saved.',action:(name:string)=>'Check '+name+' connection'},
  reconnect:{message:'Reconnect needed.',action:(name:string)=>'Reconnect '+name},
  unavailable:{message:'Saved connection status is temporarily unavailable.',action:undefined},
};
type SetupProvider=PortablePersonalGoogleReadiness&{connection?:keyof typeof connectionStates};

function PersonalGoogleSetup({google}:{google:SetupProvider[]}){
  return <>
    <h2 id="personal-google-title">Connect Gmail and Calendar</h2>
    <ul aria-labelledby="personal-google-title">
      {google.map(({provider,status,connection='not_connected'})=>{
        const item=googleProviders[provider];
        const next=connectionStates[connection],action=next.action?.(item.name);
        return <li key={provider}><strong>{item.name}</strong> ({item.access})
          {status==='ready'?<p>{next.message} <a href={item.href}>{item.link}</a>{action?<> and choose <strong>{action}</strong>.</>:'.'}</p>
            :status==='legacy'?<p>Managed by this Harbor installation. <a href={item.href}>{item.link}</a>.</p>
            :<p>Unavailable: {googleIssues[status]} Ask your administrator to check setup (status <code>{status}</code>).</p>}</li>;
      })}
    </ul>
  </>;
}

export function PortableGettingStarted({email,customProperties,google}:{email:string;customProperties:PortableCustomProperty[];google?:SetupProvider[]}){
  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="getting-started"/>
    <PortableSettingsLayout active="getting-started">
    <section className="portable-guide" aria-labelledby="getting-started-title">
      <div className="portable-guide-intro"><p className="portable-guide-kicker">Workspace guide</p>
        <h1 id="getting-started-title">Get started with Harbor</h1>
        <p>Bring in your records, invite the people who work on them, and give your team a first follow-up.</p>
      </div>
      <div className="portable-guide-grid">
        <section className="portable-guide-card"><FileSpreadsheet aria-hidden="true"/><h2>Bring your records</h2>
          <p>Preview a spreadsheet before importing. Use the sample below if you want to try it first.</p>
          <a href="#guide-import">Choose a CSV import <ArrowRight aria-hidden="true"/></a></section>
        <section className="portable-guide-card"><Users aria-hidden="true"/><h2>Bring your team</h2>
          <p>Choose Viewer or Editor, then share the invitation link. Manage access from the team directory.</p>
          <a href="/?view=workspaces#invite-teammate">Invite a teammate</a></section>
      </div>
      <section className="portable-guide-section"><h2>Everyday work</h2><ul className="portable-guide-actions">
        <li><NotebookPen aria-hidden="true"/><div><a href="/">Open Contacts</a><p>Under <strong>Logged activities</strong>, record the conversation. If files are enabled, download attachments under <strong>Contact files</strong>.</p></div></li>
        <li><Handshake aria-hidden="true"/><div><a href="/?kind=deals&amp;view=board">Open the Deals board</a><p>Link a deal to a company and contact, then move it to the next stage.</p></div></li>
        <li><ListChecks aria-hidden="true"/><div><a href="/?kind=tasks">Open Tasks</a><p>Assign the next follow-up, link it to the record, and mark it complete when it’s done.</p></div></li>
      </ul></section>
      <section className="portable-guide-section" id="guide-import"><h2>Import from a spreadsheet</h2>
        <p>For a first run, download <a href="/harbor-starter-contacts-and-companies.csv" download>fictional contacts and companies</a> or a <a href="/harbor-starter-contacts.csv" download>contacts-only sample</a>. Match the columns and review the preview before saving.</p>
        <PortableRecordImport kind="paired" customProperties={[]}/>
        <PortableRecordImport kind="contacts" customProperties={customProperties}/>
      </section>
      {google&&<section className="portable-guide-section"><PersonalGoogleSetup google={google}/></section>}
      <section className="portable-guide-section"><h2>Check background work</h2>
        <p>On a contact, open <strong>Scheduled notes</strong> and enter a test note. Leave <strong>Run at</strong> blank and choose <strong>Schedule note</strong> to queue it now.</p>
        <p>Follow <strong>View job</strong> for its result. If it stays queued, open the <a href="/?view=job-queue">Job queue</a> and check when the worker last reported.</p>
      </section>
      <footer><a href="/privacy">Privacy notice</a> · <a href="/terms">Trial terms</a></footer>
    </section>
    </PortableSettingsLayout>
  </main>;
}
