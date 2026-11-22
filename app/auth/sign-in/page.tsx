import {env} from 'cloudflare:workers';
import {redirect} from 'next/navigation';
import {Anchor,Check,LockKeyhole} from 'lucide-react';
import {authMode,googleLoginCallbackPath,googleLoginSetupIssues,loginOrigin,safeReturnPath} from '@/lib/identity';
import {loginPageOptions} from '@/lib/login-page-options';
import {readPublicPilotContact} from '@/lib/public-pilot-contact.mjs';
import {portableTrial} from '@/lib/trial-platform';
import {ProviderLinks} from './provider-links';
import {PortableBookmarkLinks} from './portable-bookmark-links';
import '../auth.css';
import '../../trial-document.css';
export const dynamic='force-dynamic';
const signInSettings={
  HARBOR_LOGIN_GOOGLE_CLIENT_ID:'Paste the Google web client ID without spaces or line breaks.',
  HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'Paste the secret for the same Google web client without spaces or line breaks.',
  HARBOR_LOGIN_ALLOWED_EMAILS:'The approved workspace owners’ email addresses, separated by commas. Enter each address in full.',
};
export default async function SignIn({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams,returnTo=safeReturnPath(params.return_to);
  if(authMode(env)==='sites')redirect('/signin-with-chatgpt?return_to='+encodeURIComponent(returnTo));
  const support=portableTrial?readPublicPilotContact(env.HARBOR_PUBLIC_PILOT_CONTACT):null;
  const reference=portableTrial&&(params.error==='sign_in_failed'||params.error==='account_conflict')&&typeof params.reference==='string'
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.reference)
    ?params.reference:null;
  const {googleReady,microsoftReady,showGoogleSetup,showMicrosoftSetup,microsoftCallback,samlReady,oidcReady,showOidcSetup,oidcCallback,showSamlSetup,samlCallback,samlMetadata}=loginPageOptions(env);
  const chooseAccount=samlReady||oidcReady||showOidcSetup||showSamlSetup?(googleReady||microsoftReady?'approved account':'company account'):googleReady&&microsoftReady?'Google or Microsoft account':microsoftReady||showMicrosoftSetup?'Microsoft account':'Google account';
  let setupCallback:string|undefined;
  if(showGoogleSetup){
    try{setupCallback=loginOrigin(env).origin+googleLoginCallbackPath;}catch{/* No callback to show until the origin is valid. */}
  }
  const setupIssues=portableTrial&&setupCallback?googleLoginSetupIssues(env):null;
  const missingSettings=setupIssues?.missing??Object.keys(signInSettings) as (keyof typeof signInSettings)[];
  const settingsToCheck=[...missingSettings,...(setupIssues?.invalidCredentials??[])];
  const needsClient=missingSettings.includes('HARBOR_LOGIN_GOOGLE_CLIENT_ID')&&missingSettings.includes('HARBOR_LOGIN_GOOGLE_CLIENT_SECRET');
  const Links=portableTrial?PortableBookmarkLinks:ProviderLinks;
  return <div className="welcome-page">
    <header className="welcome-header">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Re-enter the authentication boundary with ordinary document navigation. */}
      <a className="auth-brand welcome-brand" href="/" aria-label="Harbor CRM home"><Anchor size={27} aria-hidden="true"/><span>harbor.</span></a>
      <span className="welcome-status"><span aria-hidden="true"/>Early access</span>
    </header>
    <main className="welcome-main">
      <section className="welcome-intro" aria-labelledby="welcome-title">
        <p className="welcome-eyebrow">A clear place for your customer relationships</p>
        <h1 id="welcome-title">Your relationships,<br/>in focus.</h1>
        <p className="welcome-description">Keep your contacts, companies and deals together. See the conversation history and the next step in one familiar workspace.</p>
        <ul className="welcome-highlights" aria-label="Harbor features">
          {['Contacts & companies','Deal pipelines','Notes & follow-ups'].map(label=><li key={label}><Check size={15} aria-hidden="true"/>{label}</li>)}
        </ul>
      </section>
      <section className="auth-card welcome-signin" id="sign-in" aria-labelledby="signin-title">
        <span className="welcome-card-icon" aria-hidden="true"><Anchor size={24}/></span>
        <h2 id="signin-title">Sign in to Harbor</h2>
        <p className="welcome-card-description">Use your {chooseAccount} to continue.</p>
        {params.error==='account_conflict'?<p role="alert">This Harbor address already belongs to a different sign-in. Use your original account or ask your administrator to check the {samlReady||oidcReady?'company sign-in':'Microsoft account'} binding.</p>:
          params.error&&<p role="alert">Sign-in could not be completed. Please start again and choose your {chooseAccount}.</p>}
        {reference&&<p className="auth-note welcome-support">If you contact support, share this reference <code>{reference}</code>.</p>}
        {params.signed_out&&<p role="status">You’re signed out of Harbor.</p>}
        <Links returnTo={returnTo} google={googleReady} microsoft={microsoftReady} saml={samlReady} oidc={oidcReady}/>
        {!googleReady&&!microsoftReady&&!samlReady&&!oidcReady&&<p role="alert">{showSamlSetup||showOidcSetup?'Company sign-in needs configuration. Contact the workspace administrator.':showMicrosoftSetup?'Microsoft sign-in needs configuration. Contact the workspace administrator.':'Google sign-in needs configuration. Contact the workspace administrator.'}</p>}
        {showOidcSetup&&<details className="welcome-setup"><summary>Setting up OpenID Connect?</summary>
          <p>Configure the issuer, web client credentials and employee subject bindings in Harbor’s private environment.</p>
          {oidcCallback&&<p>Redirect URI <code>{oidcCallback}</code></p>}
        </details>}
        {showSamlSetup&&<details className="welcome-setup">
          <summary>Setting up company sign-in?</summary>
          <p>Configure the company identity provider and employee bindings in Harbor’s private environment.</p>
          {samlMetadata&&samlCallback&&<dl><dt>Harbor entity ID</dt><dd><code>{samlMetadata}</code></dd><dt>Reply URL (ACS)</dt><dd><code>{samlCallback}</code></dd></dl>}
        </details>}
        {showMicrosoftSetup&&<details className="welcome-setup">
          <summary>Setting up Microsoft sign-in?</summary>
          <ol>
            <li>In Microsoft Entra, register a Web application for Harbor sign-in.{microsoftCallback&&<> Add this redirect URI <code>{microsoftCallback}</code></>}</li>
            <li>Set <code>HARBOR_LOGIN_MICROSOFT_TENANT_ID</code>, <code>HARBOR_LOGIN_MICROSOFT_CLIENT_ID</code> and <code>HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET</code> in this app’s private environment.</li>
            <li>In <code>HARBOR_LOGIN_MICROSOFT_BINDINGS</code>, map each approved directory object ID to its Harbor email. Set <code>HARBOR_LOGIN_ALLOWED_EMAILS</code> for the people who can own workspaces.</li>
          </ol>
        </details>}
        {setupCallback&&<details className="welcome-setup">
          <summary>Setting up this installation?</summary>
          <ol>
            {needsClient&&<li>In your Google Cloud project, create a Web application OAuth client for Harbor sign-in. If Google asks for test users, add the people who should sign in.</li>}
            <li>Add this exact URL to <strong>Authorized redirect URIs</strong>.<code>{setupCallback}</code></li>
            {settingsToCheck.length>0&&<li>In your hosting dashboard, open this Harbor app’s private environment settings and check the settings below.
              <dl className="welcome-setup-secrets">
                {settingsToCheck.map(key=><div key={key}><dt><code>{key}</code></dt><dd>{signInSettings[key]}</dd></div>)}
              </dl>
            </li>}
            {setupIssues?.invalidAllowlist&&<li>Fix <code>HARBOR_LOGIN_ALLOWED_EMAILS</code> in your hosting dashboard. Enter up to 100 full email addresses separated by commas, with no empty entries.</li>}
            <li>Apply the settings and reload this page. When the Google sign-in button appears, sign in with an approved account.</li>
          </ol>
        </details>}
        <p className="auth-note welcome-permissions"><LockKeyhole size={16} aria-hidden="true"/><span>{microsoftReady||samlReady||oidcReady?'Harbor uses your sign-in to identify you. Mail and calendar connections are separate.':'Sign-in shares your name and email address with Harbor. It does not connect Gmail or Calendar.'}</span></p>
        <p className="auth-note welcome-invite">Joining a shared workspace? Use the account your administrator approved for the invited address.</p>
        {portableTrial&&<p className="auth-note welcome-support">
          {support?<>Need help signing in? <a href={'mailto:'+support.email}>Contact {support.name}</a>.</>:
            'Need help signing in? Contact the person who invited you.'}
        </p>}
        <nav className="welcome-policy-links" aria-label="Trial information"><a href="/privacy">Trial privacy</a><a href="/terms">Trial terms</a></nav>
      </section>
      <figure className="welcome-preview" aria-labelledby="welcome-preview-caption">
        <div className="welcome-preview-heading"><strong>Contacts</strong><span>All contacts</span><span className="welcome-preview-count">3 records</span></div>
        <div className="welcome-preview-table"><table><thead><tr><th>Contact</th><th>Company</th><th>Next step</th></tr></thead><tbody>
          <tr><td><span className="welcome-avatar" aria-hidden="true">MC</span><strong>Mira Chen</strong></td><td>Juniper Studio</td><td><span className="welcome-next-step">Review proposal</span></td></tr>
          <tr><td><span className="welcome-avatar" aria-hidden="true">SR</span><strong>Sam Rivera</strong></td><td>Northline Supply</td><td>Book follow-up</td></tr>
          <tr><td><span className="welcome-avatar" aria-hidden="true">AM</span><strong>Alex Morgan</strong></td><td>Fieldwork Co.</td><td>Check in Friday</td></tr>
        </tbody></table></div>
        <figcaption id="welcome-preview-caption">Illustrative workspace · Fictional sample data</figcaption>
      </figure>
    </main>
  </div>;
}
