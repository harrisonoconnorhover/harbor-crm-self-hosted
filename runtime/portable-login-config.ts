import {loginConfig as googleConfig,loginOrigin,parseAllowedEmails,sessionRequestFailure,type IdentityEnvironment} from '../lib/identity';
import {samlLoginConfig,samlLoginSettings,type SamlLoginConfig} from './portable-saml-config';
export {samlDirectoryScope} from './portable-saml-config';
import {companyOidcConfig,oidcSettings} from './portable-company-oidc-config';
import {env} from './portable-env';

export const microsoftCallbackPath='/auth/microsoft/callback';
export const microsoftLoginSettings=['HARBOR_LOGIN_MICROSOFT_TENANT_ID','HARBOR_LOGIN_MICROSOFT_CLIENT_ID',
  'HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET','HARBOR_LOGIN_MICROSOFT_BINDINGS'] as const;
export type PortableLoginEnvironment=IdentityEnvironment&Partial<Record<typeof microsoftLoginSettings[number]|typeof samlLoginSettings[number]|typeof oidcSettings[number]|
  'HARBOR_DIRECTORY_AUTHORITY_WORKSPACE_ID'|'HARBOR_DIRECTORY_EMAIL_DOMAIN'|'HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID'|'HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN'|
  'HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID'|'HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN'|'HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED',string>>;
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const consumerTenant='9188040d-6c67-4c5b-b112-36a304b66dad';

export function microsoftLoginConfig(environment:PortableLoginEnvironment=env,allowDirectoryOnly=false){
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
  if(entries.length>100||(!entries.length&&(!allowDirectoryOnly||tenant===consumerTenant)))
    throw Error('Set Microsoft account bindings, or configure a company directory and independent owner sign-in.');
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
  let google:ReturnType<typeof googleConfig>|undefined,microsoft:ReturnType<typeof microsoftLoginConfig>|undefined,saml:ReturnType<typeof samlLoginConfig>|undefined;
  let oidc:ReturnType<typeof companyOidcConfig>|undefined;
  try{oidc=companyOidcConfig(environment);}catch{/* Optional provider configuration is reported by doctor. */}
  try{google=googleConfig(environment);}catch{/* Show setup information for the optional provider. */}
  try{saml=samlLoginConfig(environment);}catch{/* Directory-only SAML can be enabled below. */}
  const invited=environment.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true';
  const hasOwnerBinding=(config:{bindings:Map<string,string>;allowedEmails:string[]}|undefined)=>
    !!config&&Array.from(config.bindings.values()).some(email=>config.allowedEmails.includes(email));
  const delegatedMicrosoft=invited&&!!directoryAuthority(environment)&&(!!google||hasOwnerBinding(saml)||hasOwnerBinding(oidc));
  try{microsoft=microsoftLoginConfig(environment,delegatedMicrosoft);}catch{/* The operator can correct settings in doctor. */}
  if(!saml&&invited&&samlDirectoryAuthority(environment)&&(google||hasOwnerBinding(microsoft)||hasOwnerBinding(oidc))){
    try{saml=samlLoginConfig(environment,true);}catch{/* An incomplete directory configuration cannot admit sessions. */}
  }
  if(!oidc&&invited&&oidcDirectoryAuthority(environment)&&(google||hasOwnerBinding(microsoft)||hasOwnerBinding(saml))){
    try{oidc=companyOidcConfig(environment,true);}catch{/* The installation check reports incomplete provider settings. */}
  }
  if(oidc&&!google&&!hasOwnerBinding(microsoft)&&!hasOwnerBinding(saml)&&!hasOwnerBinding(oidc))oidc=undefined;
  return {google,microsoft,saml,oidc};
}
let deploymentProviders:ReturnType<typeof readProviders>|undefined;
export function portableLoginProviders(environment:PortableLoginEnvironment=env){
  // The server reads its private environment at startup; requests share one validated configuration.
  return environment===env?(deploymentProviders??=readProviders(env)):readProviders(environment);
}
export function portableLoginConfig(environment:PortableLoginEnvironment=env){
  const {google,microsoft,saml,oidc}=portableLoginProviders(environment);
  const provider=google??(microsoft?.bindings.size?microsoft:undefined);
  // A directory-only employee provider must not replace the operator’s booking receipt key.
  if(provider)return provider;
  if(saml?.bindings.size)return {origin:saml.origin,secure:saml.secure,allowedEmails:saml.allowedEmails,clientSecret:saml.attemptSecret};
  if(oidc)return oidc;
  throw Error('Configure Harbor sign-in.');
}
export function portableRequestFailure(request:Request){
  try{return sessionRequestFailure(request,portableLoginConfig());}
  catch{return new Response('Harbor sign-in needs configuration. Contact the workspace administrator.',{status:503,headers:{'cache-control':'no-store'}});}
}

export function portableDirectoryConfig(){
  const config=portableLoginProviders().microsoft;
  return process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true'&&config&&config.tenant!==consumerTenant?config:undefined;
}

export function portableSamlDirectoryConfig(){
  return process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true'?portableLoginProviders().saml:undefined;
}

export function portableOidcDirectoryConfig(){
  return process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED==='true'?portableLoginProviders().oidc:undefined;
}
export function portableDirectoryOwnerOidcIssuer(email:string){
  const config=portableOidcDirectoryConfig();
  return config?.allowedEmails.includes(email.toLowerCase())?config.issuer:undefined;
}

export function portableDirectoryOwnerTenant(email:string){
  const config=portableDirectoryConfig();
  return config?.allowedEmails.includes(email.toLowerCase())?config.tenant:undefined;
}

export function portableDirectoryOwnerIssuer(email:string){
  const config=portableSamlDirectoryConfig();
  return config?.allowedEmails.includes(email.toLowerCase())?config.issuer:undefined;
}

// This workspace's directory may attest new employee addresses for one exact domain.
function configuredAuthority(workspace:string|undefined,emailDomain:string|undefined){
  const workspaceId=workspace?.toLowerCase(),domain=emailDomain?.toLowerCase();
  if(!workspaceId||!guid.test(workspaceId)||!domain||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))return;
  return {workspaceId,domain};
}
export function directoryAuthority(environment:PortableLoginEnvironment=env){
  return configuredAuthority(environment.HARBOR_DIRECTORY_AUTHORITY_WORKSPACE_ID,environment.HARBOR_DIRECTORY_EMAIL_DOMAIN);
}
export function samlDirectoryAuthority(environment:Pick<PortableLoginEnvironment,
  'HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID'|'HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN'>=env){
  return configuredAuthority(environment.HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID,environment.HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN);
}
export function oidcDirectoryAuthority(environment:PortableLoginEnvironment=env){
  return configuredAuthority(environment.HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID,environment.HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN);
}
function directoryMayAttest(authority:ReturnType<typeof configuredAuthority>,allowedEmails:string[],workspaceId:string|null,email:string){
  if(!authority||authority.workspaceId!==workspaceId||email.split('@')[1]!==authority.domain||
    allowedEmails.includes(email)||process.env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED!=='true')return false;
  const {oidc,saml,microsoft}=portableLoginProviders();
  return ![oidc,saml,microsoft].some(provider=>provider&&Array.from(provider.bindings.values()).includes(email));
}
export function oidcDirectoryCanBind(config:ReturnType<typeof companyOidcConfig>,workspaceId:string|null,email:string){
  return directoryMayAttest(oidcDirectoryAuthority(),config.allowedEmails,workspaceId,email);
}
export function samlDirectoryCanBind(config:SamlLoginConfig,workspaceId:string|null,email:string){
  return directoryMayAttest(samlDirectoryAuthority(),config.allowedEmails,workspaceId,email);
}
export function directoryCanBind(config:ReturnType<typeof microsoftLoginConfig>,workspaceId:string|null,email:string){
  return config.tenant!==consumerTenant&&directoryMayAttest(directoryAuthority(),config.allowedEmails,workspaceId,email);
}
