export type HarborIdentity = {userId:string; email:string; displayName:string; fullName:string|null};
export type IdentityEnvironment = {
  HARBOR_AUTH_MODE?:string;
  HARBOR_LOGIN_ORIGIN?:string;
  HARBOR_LOGIN_ALLOWED_EMAILS?:string;
  HARBOR_LOGIN_GOOGLE_CLIENT_ID?:string;
  HARBOR_LOGIN_GOOGLE_CLIENT_SECRET?:string;
};
export const googleLoginCallbackPath='/auth/google/callback';
export function authMode(env:IdentityEnvironment):'sites'|'google' {
  const mode=env.HARBOR_AUTH_MODE||'sites';
  if(mode!=='sites'&&mode!=='google')throw Error('Invalid Harbor authentication mode.');
  return mode;
}
export function loginOrigin(env:IdentityEnvironment) {
  const origin=new URL(env.HARBOR_LOGIN_ORIGIN||'');
  const local=origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname);
  if((origin.protocol!=='https:'&&!local)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Set a secure Harbor login origin.');
  return origin;
}
function parseAllowedEmails(value:string|undefined) {
  const allowedEmails=(value||'').split(',').map(v=>v.trim().toLowerCase());
  if(allowedEmails.length>100||allowedEmails.some(v=>!/^[-a-z0-9.!#$%&'+/=?^_`{|}~]+@[-a-z0-9]+(?:\.[-a-z0-9]+)+$/.test(v)||v.length>254))throw Error('Configure the allowed Google sign-in email addresses.');
  return allowedEmails;
}
const googleClientSettings=['HARBOR_LOGIN_GOOGLE_CLIENT_ID','HARBOR_LOGIN_GOOGLE_CLIENT_SECRET'] as const;
const credentialWhitespace=/\s/;

export function googleLoginSetupIssues(env:IdentityEnvironment) {
  const settings=[...googleClientSettings,'HARBOR_LOGIN_ALLOWED_EMAILS'] as const;
  const missing=settings.filter(key=>!env[key]);
  const invalidCredentials=googleClientSettings.filter(key=>credentialWhitespace.test(env[key]??''));
  let invalidAllowlist=false;
  if(env.HARBOR_LOGIN_ALLOWED_EMAILS){
    try{parseAllowedEmails(env.HARBOR_LOGIN_ALLOWED_EMAILS);}catch{invalidAllowlist=true;}
  }
  return {missing,invalidCredentials,invalidAllowlist};
}
export function loginConfig(env:IdentityEnvironment) {
  const origin=loginOrigin(env);
  const {HARBOR_LOGIN_GOOGLE_CLIENT_ID:clientId,HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:clientSecret}=env;
  if(!clientId||!clientSecret||credentialWhitespace.test(clientId)||credentialWhitespace.test(clientSecret))
    throw Error('Google sign-in is not configured.');
  const allowedEmails=parseAllowedEmails(env.HARBOR_LOGIN_ALLOWED_EMAILS);
  return {allowedEmails,origin:origin.origin,secure:origin.protocol==='https:',clientId,clientSecret,redirectUri:origin.origin+googleLoginCallbackPath};
}
export function safeReturnPath(value:unknown) {
  if(typeof value!=='string'||value.length>1500||/%5c/i.test(value)||!value.startsWith('/')||value.startsWith('//'))return '/';
  try{const u=new URL(value,'https://harbor.invalid');
    if(u.origin!=='https://harbor.invalid'||u.pathname.startsWith('//')||/^\/(auth(?:\/|$)|signin-with-chatgpt|signout-with-chatgpt|callback)/.test(u.pathname))return '/';
    const path=u.pathname+u.search+u.hash;
    return path.length<=1500?path:'/';
  }catch{return '/'}
}
export function cookieName(kind:'session'|'attempt',secure:boolean){return (secure?'__Host-':'')+'harbor-'+kind;}
export function readCookie(headers:Headers,name:string,encrypted=false){
  const values=(headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
  if(values.length!==1)return null;
  const value=values[0].slice(name.length+1);return (encrypted?/^[A-Za-z0-9_.-]{1,3800}$/:/^[A-Za-z0-9_-]{43}$/).test(value)?value:null;
}
export function authCookie(kind:'session'|'attempt',value:string,secure:boolean,maxAge:number){
  return `${cookieName(kind,secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
// Enforce this at the Worker boundary, before any route can use a session.
export function identityRequestFailure(request:Request,env:IdentityEnvironment):Response|null {
  try{
    if(authMode(env)==='sites')return null;
    const config=loginConfig(env);
    if(new URL(request.url).origin!==config.origin)return new Response('Harbor login origin does not match this deployment.',{status:421});
    const unsafe=!['GET','HEAD','OPTIONS'].includes(request.method);
    if(unsafe&&readCookie(request.headers,cookieName('session',config.secure))&&request.headers.get('origin')!==config.origin)
      return Response.json({error:'Submit this action from Harbor.'},{status:403,headers:{'cache-control':'no-store'}});
    return null;
  }catch{return new Response('Harbor sign-in needs configuration. Contact the workspace administrator.',{status:503,headers:{'cache-control':'no-store'}});}
}
