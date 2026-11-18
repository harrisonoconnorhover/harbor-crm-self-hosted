/* eslint-disable @next/next/no-html-link-for-pages -- Use a fresh document request when crossing the sign-out boundary. */
import {env} from 'cloudflare:workers';
import {redirect} from 'next/navigation';
import {authMode,safeReturnPath} from '@/lib/identity';
import {loginPageOptions} from '@/lib/login-page-options';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import '../auth.css';
export const dynamic='force-dynamic';
export default async function SignOut({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
  const params=await searchParams;
  if(authMode(env)==='sites')redirect('/signout-with-chatgpt?return_to='+encodeURIComponent(safeReturnPath(params.return_to||'/')));
  const user=await getChatGPTUser(),{microsoftReady}=loginPageOptions(env);
  return <main className="auth-shell"><section className="auth-card"><a className="auth-brand" href="/">⚓ Harbor</a><h1>Sign out of Harbor</h1><p>{user?.email||'Your session has ended.'}</p>
    <form action="/auth/logout" method="post"><button className="auth-primary" name="scope" value="current">Sign out of this browser</button>{user&&<button className="auth-secondary" name="scope" value="all">Sign out of all Harbor sessions</button>}</form>
    <a href="/">Return to Harbor</a><p className="auth-note">This ends Harbor access on the selected devices. {microsoftReady?'Your identity provider and connected services keep their own sessions.':'Your Google account and connected Gmail or Calendar remain connected.'}</p>
  </section></main>;
}
