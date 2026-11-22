import {sharedToolAllowed} from '../db/postgres/shared-tool-permission';
import {PortableCallsPage,portableCallsQuery} from './portable-calls-page';
import {eq} from 'drizzle-orm';
import {notFound} from 'next/navigation';
import Link from 'next/link';
import {z} from 'zod';
import {privateWorkspaces} from '../db/postgres/workspace-schema';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {ownerHelpState} from '../db/postgres/help-center-store';
import {portableArticlePath} from '../lib/portable-knowledge';
import {readInboxSnippets} from '../db/postgres/team-inbox-store';
import {ApiError} from '../lib/api-error';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {PortableEmailTemplates} from './portable-email-template-ui';
import {PortableMarketingPage} from './portable-marketing-page';
import {QuickReplyEditor} from './portable-team-inbox-ui';
import {PortableTeamScheduling} from './portable-team-scheduling-ui';
import './portable-contacts.css';
import './portable-settings.css';

const destination=z.object({view:z.enum(['campaigns','customer-portal','meetings','snippets','templates']),workspaceId:z.string().guid().optional()}).strict();

export async function PortableNavDestinationPage({input,user}:{input:Record<string,string|undefined>;user:{userId:string;email:string}}){
  const params=input.view==='calls'?portableCallsQuery.safeParse(input):destination.safeParse(input);
  if(!params.success)notFound();
  const {view,workspaceId}=params.data,db=portableDb();
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
  if(params.data.view==='calls')return <PortableCallsPage query={params.data} user={user}/>;
  if(view==='customer-portal'){
    if(workspaceId)notFound();
    const {center}=await ownerHelpState(db,user.userId);
    return <main className="portable-contacts">
      <PortableCrmHeader page="customer-portal" email={user.email}/>
      <section className="portable-settings-content" aria-labelledby="portal-title">
        <header className="portable-settings-heading"><h1 id="portal-title">Customer portal</h1></header>
        <section>
          <h2>{center?.enabled?center.name:'Portal closed'}</h2>
          {center?.enabled?<p><a href={'/help/'+center.id+'/cases'}>Open customer sign-in</a></p>:
            <p>Open the public help center to let invited customers view their published cases.</p>}
          <a href={portableArticlePath}>Manage help center</a>
        </section>
        <section>
          <h2>Share a case</h2>
          <p>Open a ticket and choose <strong>Customer portal</strong> to publish an update or manage its contact’s invitation.</p>
          <a href="/tickets">Open tickets</a>
        </section>
      </section>
    </main>;
  }
  if(view==='campaigns'){
    if(workspaceId)notFound();
    return <PortableMarketingPage user={user} campaigns/>;
  }
  if(view==='templates'){
    if(workspaceId)notFound();
    return <main className="portable-contacts">
      <PortableCrmHeader page="templates" email={user.email}/>
      <PortableEmailTemplates standalone/>
    </main>;
  }
  if(view==='snippets'){
    const shared=workspaceId?await readInboxSnippets(db,user.userId,workspaceId).catch(error=>{
      if(error instanceof ApiError&&(error.status===403||error.status===404))notFound();
      throw error;
    }):null;
    return <main className="portable-contacts">
      <PortableCrmHeader page="snippets" email={user.email} workspaceId={workspaceId}/>
      <section className="portable-settings-content"><header className="portable-settings-heading"><h1>Snippets</h1></header>
        <p>Use saved replies when composing a message in the workspace inbox.</p>
        {shared?(shared.items.length?<dl>{shared.items.map(item=><div key={item.id}><dt>{item.name}</dt><dd>{item.body}</dd></div>)}</dl>:
          <p>No snippets saved in this workspace.</p>):<div className="inbox-library"><QuickReplyEditor/></div>}
      </section>
    </main>;
  }
  const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
  if(workspaceId&&(grant?.role!=='editor'||!await sharedToolAllowed(db,user.userId,workspaceId,'meetings')))notFound();
  const owned=workspaceId?undefined:(await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(eq(privateWorkspaces.ownerId,user.userId)).limit(1))[0];
  const target=workspaceId??owned?.id;
  return <main className="portable-contacts">
    <PortableCrmHeader page="meetings" email={user.email} workspaceId={workspaceId}/>
    <section className="portable-settings-content"><header className="portable-settings-heading"><h1>Meetings</h1></header>
      {target?<PortableTeamScheduling workspaceId={target} grantId={grant?.id} initiallyExpanded/>:
        <p>Create your first CRM record to start scheduling meetings in your workspace. <Link href="/">Open contacts</Link></p>}
    </section>
  </main>;
}
