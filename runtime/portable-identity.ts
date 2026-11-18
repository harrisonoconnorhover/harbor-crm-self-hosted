import {postgresIdentityStore} from '../db/postgres/identity-store';
import {workspaceSignInAllowed} from '../db/postgres/workspace-sign-in-store';
import {createGoogleIdentityService,createOidcIdentityService} from '../lib/identity-service';
import {portableDb} from './portable-db';
import {admitPortableLoginExchange} from './portable-rate-limit';
import {env} from './portable-env';
import {microsoftLoginConfig,portableLoginConfig,portableLoginProviders} from './portable-login-config';
import {microsoftLoginURL,exchangeMicrosoftIdentity} from './portable-microsoft-identity';

export const inviteSignInEnabled=()=>process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true';
export const portableWorkspaceGuest=(email:string)=>!portableLoginConfig().allowedEmails.includes(email);

type Provider='google'|'microsoft';
function store(provider:Provider){
  const providers=portableLoginProviders();
  return postgresIdentityStore(portableDb(),{provider,
    reservedForMicrosoft:email=>Array.from(providers.microsoft?.bindings.values()??[]).includes(email),
    activeSession:(subject,email)=>{
      if(!subject)return !!providers.google;
      const config=providers.microsoft;
      if(!config)return false;
      const [tenant,objectId]=subject.split(':');
      return tenant===config.tenant&&config.bindings.get(objectId)===email;
    },
  });
}
const invitation=(provider:Provider)=>(email:string,account:{subject:string}|{userId:string},ownerEmails:string[])=>
  inviteSignInEnabled()?workspaceSignInAllowed(portableDb(),email,{...account,provider},ownerEmails):Promise.resolve(false);

const google=createGoogleIdentityService(env,()=>store('google'),admitPortableLoginExchange,invitation('google'));
export const microsoft=createOidcIdentityService(()=>microsoftLoginConfig(),()=>store('microsoft'),
  {provider:'microsoft',authorizationUrl:microsoftLoginURL,exchange:exchangeMicrosoftIdentity},admitPortableLoginExchange,invitation('microsoft'));
const session=()=>portableLoginProviders().google?google:microsoft;
export const {beginLogin,finishLogin}=google;
export const requestSessionHash=(headers:Headers)=>session().sessionHash(headers);
export const requestIdentity=(headers:Headers)=>session().sessionIdentity(headers);
export const revokeLogin=(headers:Headers,allDevices:boolean)=>session().revokeLogin(headers,allDevices);
