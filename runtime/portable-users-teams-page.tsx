import Link from 'next/link';
import {readWorkspaceSharing} from '../db/postgres/workspace-viewer-store';
import {portableDb} from './portable-db';
import {inviteSignInEnabled} from './portable-identity';
import {portableDirectoryOwnerOidcIssuer,portableDirectoryOwnerIssuer,portableDirectoryOwnerTenant} from './portable-login-config';
import {PortableWorkspaceSharing} from './portable-workspace-ui';

export async function PortableUsersTeams({user,tab}:{user:{userId:string;email:string};tab:'users'|'teams'}){
  const sharing=await readWorkspaceSharing(portableDb(),user.userId,user.email,undefined,
    portableDirectoryOwnerTenant(user.email),portableDirectoryOwnerIssuer(user.email),portableDirectoryOwnerOidcIssuer(user.email));
  return <>
    <nav className="portable-setting-tabs" aria-label="Users and teams">
      <Link prefetch={false} href="/?view=settings&section=users-teams" aria-current={tab==='users'?'page':undefined}>Users</Link>
      <Link prefetch={false} href="/?view=settings&section=users-teams&tab=teams" aria-current={tab==='teams'?'page':undefined}>Teams</Link>
    </nav>
    <PortableWorkspaceSharing key={tab} expanded settingsTab={tab} ownerEmail={user.email}
      initial={{...sharing,inviteSignIn:inviteSignInEnabled()}}/>
  </>;
}
