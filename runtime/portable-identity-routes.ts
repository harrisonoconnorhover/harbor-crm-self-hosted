import {samlAttemptCookie} from './portable-saml-cookie';
import {createLogoutRoute,createOidcIdentityRoutes} from '../lib/identity-routes';
import {beginLogin,finishLogin,microsoft,companyOidc,revokeLogin} from './portable-identity';
import {portableLoginConfig,portableLoginProviders} from './portable-login-config';
import {portableRateLimit} from './portable-rate-limit';

export function logFailure(stage:string){
  const reference=crypto.randomUUID();
  console.warn(JSON.stringify({event:'harbor_portable_sign_in_failed',reference,stage}));
  return reference;
}
const admitStart=()=>portableRateLimit('login_start','');
const googleRoutes=createOidcIdentityRoutes(()=>!!portableLoginProviders().google,portableLoginConfig,
  {beginLogin,finishLogin,revokeLogin},logFailure,admitStart);
const microsoftRoutes=createOidcIdentityRoutes(()=>!!portableLoginProviders().microsoft,portableLoginConfig,
  {...microsoft,revokeLogin},logFailure,admitStart);
export const {startLogin:startGoogleLogin,completeLogin:completeGoogleLogin}=googleRoutes;
export const {startLogin:startMicrosoftLogin,completeLogin:completeMicrosoftLogin}=microsoftRoutes;
const companyRoutes=createOidcIdentityRoutes(()=>!!portableLoginProviders().oidc,portableLoginConfig,
  {...companyOidc,revokeLogin},logFailure,admitStart);
export const {completeLogin:completeCompanyLogin}=companyRoutes;
export async function startCompanyLogin(request:Request){
  try{return await companyRoutes.startLogin(request);}
  catch{
    const reference=logFailure('provider-discovery');
    const url=new URL('/auth/sign-in',portableLoginConfig().origin);
    url.searchParams.set('error','sign_in_failed');
    url.searchParams.set('reference',reference);
    return new Response(null,{status:303,headers:{location:url.href,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  }
}
const endSession=createLogoutRoute(()=>Object.values(portableLoginProviders()).some(Boolean),portableLoginConfig,revokeLogin);
export async function logout(request:Request){
  const response=await endSession(request);
  if(response.status===303&&portableLoginProviders().saml)response.headers.append('set-cookie',samlAttemptCookie('',0));
  return response;
}
