/* eslint-disable @next/next/no-html-link-for-pages -- Public trial documents need ordinary navigation in the standalone renderer. */
import {Anchor,ArrowLeft} from 'lucide-react';
import {env} from 'cloudflare:workers';
import {readPublicPilotContact} from '../lib/public-pilot-contact.mjs';
import {portableTrial} from '../lib/trial-platform';
import './trial-document.css';

export function TrialDocument({title,intro,children}:{title:string;intro:string;children:React.ReactNode}){
 const contact=env.HARBOR_AUTH_MODE==='google'?readPublicPilotContact(env.HARBOR_PUBLIC_PILOT_CONTACT):null;
 return <div className="trial-document">
  <header className="trial-document-header">
   <a href="/" className="trial-document-brand"><Anchor size={26} aria-hidden="true"/>harbor.</a>
   <a href="/" className="trial-document-back"><ArrowLeft size={15} aria-hidden="true"/>Back to Harbor</a>
  </header>
  <main className="trial-document-main">
   <p className="trial-document-eyebrow">{portableTrial?'Portable Harbor trial · Updated November 8, 2026':'Independent Harbor trial · Updated November 6, 2026'}</p>
   <h1>{title}</h1><p className="trial-document-intro">{intro}</p>
   <aside className="trial-document-scope" aria-label="Trial scope">
    <div>These pages cover the private, independent Google-sign-in trial. A separately hosted ChatGPT Sites copy has its own hosting arrangements.</div>
    {contact&&<div className="trial-document-contact"><strong>Installation operator</strong> {contact.name}<br/>
     <strong>Privacy and support contact</strong> <a href={'mailto:'+contact.email}>{contact.email}</a></div>}
   </aside>
   <article aria-label={title}>{children}</article>
  </main>
  <footer className="trial-document-footer"><nav aria-label="Trial information"><a href="/privacy">Trial privacy</a><a href="/terms">Trial terms</a><a href="/">Harbor</a></nav><p>Private evaluation · Business onboarding is pending</p></footer>
 </div>;
}
