import {createOidcIdentityRoutes} from '../lib/identity-routes';
import {beginLogin,finishLogin,microsoft,revokeLogin} from './portable-identity';
import {portableLoginConfig,portableLoginProviders} from './portable-login-config';
import {portableRateLimit} from './portable-rate-limit';

function logFailure(stage:string){
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
export const logout=(request:Request)=>(portableLoginProviders().google?googleRoutes:microsoftRoutes).logout(request);
