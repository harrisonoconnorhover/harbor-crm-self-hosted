import {companyDirectoryIdentity} from '../db/postgres/company-directory-identity';
import type {SamlLoginConfig} from './portable-saml-config';
import {postgresIdentityStore} from '../db/postgres/identity-store';
import {workspaceSignInAllowed} from '../db/postgres/workspace-sign-in-store';
import {safeReturnPath} from '../lib/identity';
import {createGoogleIdentityService,createIdentitySessions,createOidcIdentityService,issueLoginSession,type VerifiedGoogleIdentity} from '../lib/identity-service';
import {portableDb} from './portable-db';
import {admitPortableLoginExchange} from './portable-rate-limit';
import {env} from './portable-env';
import {oidcDirectoryCanBind,directoryCanBind,portableLoginConfig,portableLoginProviders,samlDirectoryAuthority,samlDirectoryCanBind} from './portable-login-config';
import {companyLoginUrl,exchangeCompanyIdentity} from './portable-company-oidc';
import {microsoftLoginURL,exchangeMicrosoftIdentity} from './portable-microsoft-identity';

export const inviteSignInEnabled=()=>process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true';
export const portableWorkspaceGuest=(email:string)=>!portableLoginConfig().allowedEmails.includes(email);

type Provider='google'|'microsoft'|'saml'|'oidc';
function store(provider?:Provider){
  const providers=portableLoginProviders();
  return postgresIdentityStore(portableDb(),{provider,
    reservedForOtherProvider:email=>
      (provider!=='oidc'&&Array.from(providers.oidc?.bindings.values()??[]).includes(email))||
      (provider!=='microsoft'&&Array.from(providers.microsoft?.bindings.values()??[]).includes(email))||
      (provider!=='saml'&&Array.from(providers.saml?.bindings.values()??[]).includes(email)),
    activeSession:({oidcSubject,oidcDirectoryIssuer,samlSubject,samlDirectoryIssuer,microsoftSubject,email,directoryAuthority})=>{
      if(oidcSubject){
        const config=providers.oidc;
        if(!config)return false;
        return config.bindings.has(oidcSubject)?config.bindings.get(oidcSubject)===email:
          oidcDirectoryIssuer===config.issuer&&oidcDirectoryCanBind(config,directoryAuthority,email);
      }
      if(samlSubject){
        const config=providers.saml;
        if(!config)return false;
        return config.bindings.has(samlSubject)?config.bindings.get(samlSubject)===email:
          samlDirectoryIssuer===config.issuer&&samlDirectoryCanBind(config,directoryAuthority,email);
      }
      if(!microsoftSubject)return !!providers.google;
      const config=providers.microsoft;
      if(!config)return false;
      const [tenant,objectId]=microsoftSubject.split(':');
      return tenant===config.tenant&&(config.bindings.has(objectId)?config.bindings.get(objectId)===email:directoryCanBind(config,directoryAuthority,email));
    },
  });
}
const invitation=(provider?:Provider)=>(email:string,account:{subject:string}|{userId:string},ownerEmails:string[])=>
  inviteSignInEnabled()?workspaceSignInAllowed(portableDb(),email,{...account,provider},ownerEmails):Promise.resolve(false);

const google=createGoogleIdentityService(env,()=>store('google'),admitPortableLoginExchange,invitation('google'));
export const microsoft=createOidcIdentityService(()=>{
  const config=portableLoginProviders().microsoft;
  if(!config)throw Error('Configure Microsoft sign-in.');
  return config;
},()=>store('microsoft'),
  {provider:'microsoft',authorizationUrl:microsoftLoginURL,exchange:exchangeMicrosoftIdentity},admitPortableLoginExchange,invitation('microsoft'));
export const companyOidc=createOidcIdentityService(()=>{
  const config=portableLoginProviders().oidc;
  if(!config)throw Error('Configure company OpenID Connect sign-in.');
  return config;
},()=>store('oidc'),{provider:'oidc',authorizationUrl:companyLoginUrl,exchange:exchangeCompanyIdentity},admitPortableLoginExchange,invitation('oidc'));
const session=createIdentitySessions(portableLoginConfig,()=>store(),invitation());
export const {beginLogin,finishLogin}=google;
export const {sessionHash:requestSessionHash,sessionIdentity:requestIdentity,revokeLogin}=session;

export async function resolvePortableDirectorySamlEmail(config:SamlLoginConfig,subject:string){
  const authority=samlDirectoryAuthority();
  if(!inviteSignInEnabled()||!authority)return;
  const email=await companyDirectoryIdentity(portableDb(),'saml',authority.workspaceId,config.issuer,subject);
  return email&&samlDirectoryCanBind(config,authority.workspaceId,email)?email:undefined;
}

export async function completePortableSamlSession(identity:VerifiedGoogleIdentity,returnTo:string,priorSessionHash?:string|null){
  const config=portableLoginProviders().saml;
  if(!config||(config.bindings.get(identity.subject)??await resolvePortableDirectorySamlEmail(config,identity.subject))!==identity.email)
    throw Error('This account is not bound to the configured SAML directory.',{cause:'provider-identity'});
  if(!config.allowedEmails.includes(identity.email)&&
    !await invitation('saml')(identity.email,{subject:identity.subject},config.allowedEmails))
    throw Error('This account has no current workspace access.',{cause:'allowlist'});
  const now=Date.now(),identityStore=store('saml');
  const userId=await identityStore.recordIdentity(identity,now);
  const token=await issueLoginSession(identityStore,userId,now,priorSessionHash);
  return {token,userId,returnTo:safeReturnPath(returnTo)};
}
