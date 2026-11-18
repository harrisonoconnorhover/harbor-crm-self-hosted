import {postgresIdentityStore} from '../db/postgres/identity-store';
import {workspaceSignInAllowed} from '../db/postgres/workspace-sign-in-store';
import {loginConfig} from '../lib/identity';
import {createGoogleIdentityService} from '../lib/identity-service';
import {portableDb} from './portable-db';
import {admitPortableLoginExchange} from './portable-rate-limit';
import {env} from './portable-env';

export const inviteSignInEnabled=()=>process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true';
export const portableWorkspaceGuest=(email:string)=>!loginConfig(env).allowedEmails.includes(email);

export const {beginLogin,finishLogin,sessionHash:requestSessionHash,sessionIdentity:requestIdentity,revokeLogin}=createGoogleIdentityService(env,()=>{
  return postgresIdentityStore(portableDb());
},admitPortableLoginExchange,async(email,account,allowedEmails)=>
  inviteSignInEnabled()&&await workspaceSignInAllowed(portableDb(),email,account,allowedEmails));
