import {createGoogleIdentityRoutes} from '../lib/identity-routes';
import {env} from './portable-env';
import {beginLogin,finishLogin,revokeLogin} from './portable-identity';
import {portableRateLimit} from './portable-rate-limit';

const routes=createGoogleIdentityRoutes(env,{beginLogin,finishLogin,revokeLogin},stage=>{
  const reference=crypto.randomUUID();
  console.warn(JSON.stringify({event:'harbor_portable_sign_in_failed',reference,stage}));
  return reference;
});

export async function startGoogleLogin(request:Request){
  return await portableRateLimit('login_start','')??routes.startGoogleLogin(request);
}
export const {completeGoogleLogin,logout}=routes;
