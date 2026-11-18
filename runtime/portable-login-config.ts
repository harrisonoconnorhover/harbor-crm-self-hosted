import {loginConfig as googleConfig,loginOrigin,parseAllowedEmails,sessionRequestFailure,type IdentityEnvironment} from '../lib/identity';
import {env} from './portable-env';

export const microsoftCallbackPath='/auth/microsoft/callback';
export const microsoftLoginSettings=['HARBOR_LOGIN_MICROSOFT_TENANT_ID','HARBOR_LOGIN_MICROSOFT_CLIENT_ID',
  'HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET','HARBOR_LOGIN_MICROSOFT_BINDINGS'] as const;
export type PortableLoginEnvironment=IdentityEnvironment&Partial<Record<typeof microsoftLoginSettings[number],string>>;
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const consumerTenant='9188040d-6c67-4c5b-b112-36a304b66dad';

export function microsoftLoginConfig(environment:PortableLoginEnvironment=env){
  const origin=loginOrigin(environment);
  const allowedEmails=parseAllowedEmails(environment.HARBOR_LOGIN_ALLOWED_EMAILS);
  const tenant=environment.HARBOR_LOGIN_MICROSOFT_TENANT_ID?.toLowerCase()??'';
  const clientId=environment.HARBOR_LOGIN_MICROSOFT_CLIENT_ID?.toLowerCase()??'';
  const clientSecret=environment.HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET;
  if(!guid.test(tenant)||!guid.test(clientId)||!clientSecret||/\s/.test(clientSecret))
    throw Error('Set a tenant GUID, application GUID and secret for the Microsoft sign-in app.');
  const raw=environment.HARBOR_LOGIN_MICROSOFT_BINDINGS??'';
  if(!raw||raw.length>36000)throw Error('Set Microsoft sign-in bindings.');
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Enter Microsoft sign-in bindings as a JSON object.');
  const entries=Object.entries(value);
  if(!entries.length||entries.length>100)throw Error('Configure between one and 100 Microsoft sign-in bindings.');
  const bindings=new Map<string,string>(),addresses=new Set<string>();
  for(const [source,address] of entries){
    const oid=source.toLowerCase();
    if(!guid.test(oid)||bindings.has(oid)||typeof address!=='string'||address.includes(','))throw Error('Invalid Microsoft sign-in binding.');
    const [email]=parseAllowedEmails(address);
    if(addresses.has(email))throw Error('Each Microsoft account needs its own Harbor address.');
    addresses.add(email);
    bindings.set(oid,email);
  }
  const authority='https://login.microsoftonline.com/'+(tenant===consumerTenant?'consumers':tenant);
  return {origin:origin.origin,secure:origin.protocol==='https:',allowedEmails,tenant,clientId,clientSecret,bindings,
    issuer:'https://login.microsoftonline.com/'+tenant+'/v2.0',authority,redirectUri:origin.origin+microsoftCallbackPath};
}

function readProviders(environment:PortableLoginEnvironment){
  let google:ReturnType<typeof googleConfig>|undefined,microsoft:ReturnType<typeof microsoftLoginConfig>|undefined;
  try{google=googleConfig(environment);}catch{/* Show setup information for the optional provider. */}
  try{microsoft=microsoftLoginConfig(environment);}catch{/* The operator can correct settings in doctor. */}
  return {google,microsoft};
}
let deploymentProviders:ReturnType<typeof readProviders>|undefined;
export function portableLoginProviders(environment:PortableLoginEnvironment=env){
  // The server reads its private environment at startup; requests share one validated configuration.
  return environment===env?(deploymentProviders??=readProviders(env)):readProviders(environment);
}
export function portableLoginConfig(environment:PortableLoginEnvironment=env){
  const {google,microsoft}=portableLoginProviders(environment);
  const provider=google??microsoft;
  if(!provider)throw Error('Configure Harbor sign-in.');
  // Existing Google-only deployments keep their original session and receipt settings.
  return provider;
}
export function portableRequestFailure(request:Request){
  try{return sessionRequestFailure(request,portableLoginConfig());}
  catch{return new Response('Harbor sign-in needs configuration. Contact the workspace administrator.',{status:503,headers:{'cache-control':'no-store'}});}
}
