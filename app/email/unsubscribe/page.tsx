import {UnsubscribeForm} from './unsubscribe-form';
import './unsubscribe.css';
export const metadata={title:'Unsubscribe · Harbor',robots:{index:false,follow:false},referrer:'no-referrer'};
export default function UnsubscribePage(){
 return <main className="unsubscribe-page"><section className="unsubscribe-card">
  <span className="unsubscribe-brand">⚓ harbor.</span>
  <h1>Unsubscribe from email</h1>
  <p>Stop future Harbor emails to the address that received this link from the sending workspace. You do not need to sign in.</p>
  <UnsubscribeForm/>
  <p className="unsubscribe-detail">A message already submitted to Gmail may still arrive. This does not change other workspaces, Calendar invitations or email sent outside Harbor.</p>
  <noscript><p>Enable JavaScript to confirm this request using the unsubscribe link in your email.</p></noscript>
  <a href="/privacy">Trial privacy</a>
 </section></main>;
}
