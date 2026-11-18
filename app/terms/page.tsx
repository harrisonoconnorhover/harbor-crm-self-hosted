import {TrialDocument} from '../trial-document';
import {portableTrial} from '../../lib/trial-platform';
export const metadata={title:'Trial terms · Harbor CRM'};
export const dynamic='force-dynamic';

export default function Terms(){
 return <TrialDocument title="Trial terms" intro="The current evaluation boundaries, before Harbor is used for a real business.">
  <section><h2>A private evaluation</h2><p>Harbor is currently an invitation-only evaluation. Access is limited to the people approved for this installation. These pages explain its evaluation conditions.</p><p>Use fictional sample records while business onboarding is pending. Do not rely on the trial as your only copy of important information or for time-critical work. Features may change or be unavailable, and this trial has no promised uptime, support response or delivery time.</p></section>
  <section><h2>Use only access and data you are allowed to use</h2><p>Use your own authorized account and respect workspace access rules. Only upload, import or share information you have permission to use for this evaluation. Do not use the trial to send spam, bypass access controls or carry out unlawful activity.</p><p>Account passwords, private keys and authentication codes do not belong in CRM records. Keep an export or other appropriate copy of information you need to retain.</p></section>
  {portableTrial?
   <section><h2>Review scheduled notes</h2><p>When the operator runs the background worker, a scheduled note can be added to its contact after you close Harbor. Check Scheduled notes for its saved status and attempt history before creating a new request.</p></section>:
   <section><h2>Review actions that affect other people</h2><p>Google sign-in, connecting Gmail, connecting Calendar and enabling background processing are separate choices. Connecting a service does not authorize every possible use of it. Review recipients, attendees, content and workflow destinations before sending, scheduling or enabling actions.</p><p>Enabled workflows, email sequences and other background processors may perform their configured actions later. Turn off the relevant automation when it should stop, and check its saved outcome before retrying an uncertain send or invitation. External providers have their own terms, permissions and limits.</p></section>}
  <section><h2>Leaving the trial</h2><p>{portableTrial?'Signing out ends your Harbor session. Saved CRM records, files and job history remain.':'You can sign out and disconnect your connected Google services. Those actions do not delete information already saved in Harbor or messages and events already created in Google.'} Ask the person operating this installation about exports, data removal and retained recovery copies. See <a href="/privacy">Trial privacy</a> for the data handling details.</p></section>
  <section><h2>Before real business use</h2><p>Agree on support, privacy, retention and recovery arrangements with the installation operator. Review the terms appropriate to the business before relying on Harbor for day-to-day work.</p></section>
 </TrialDocument>;
}
