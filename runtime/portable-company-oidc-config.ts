import {createHash} from 'node:crypto';
import {loginOrigin,parseAllowedEmails,type IdentityEnvironment} from '../lib/identity';

export const oidcSettings=['HARBOR_LOGIN_OIDC_ISSUER','HARBOR_LOGIN_OIDC_CLIENT_ID','HARBOR_LOGIN_OIDC_CLIENT_SECRET','HARBOR_LOGIN_OIDC_BINDINGS'] as const;
export const oidcCallbackPath='/auth/oidc/callback';
export function oidcDirectoryScope(issuer:string){
  return 'directory:oidc:'+createHash('sha256').update(issuer).digest('hex');
}
export function validOidcSubject(subject:string){
  return /^[\x20-\x7e]{1,255}$/.test(subject);
}
export function oidcSubjectKey(issuer:string,subject:string){
  return createHash('sha256').update(JSON.stringify([issuer,subject])).digest('hex');
}
export function oidcEndpoint(value:string,localOrigin?:string){
  const url=new URL(value);
  if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.origin===localOrigin)))
    throw Error('Company sign-in endpoints require HTTPS.');
  return url;
}
export function companyOidcConfig(environment:IdentityEnvironment&Partial<Record<typeof oidcSettings[number],string>>,allowDirectoryOnly=false){
  const origin=loginOrigin(environment),allowedEmails=parseAllowedEmails(environment.HARBOR_LOGIN_ALLOWED_EMAILS);
  const issuer=environment.HARBOR_LOGIN_OIDC_ISSUER??'',clientId=environment.HARBOR_LOGIN_OIDC_CLIENT_ID,clientSecret=environment.HARBOR_LOGIN_OIDC_CLIENT_SECRET;
  const candidate=new URL(issuer);
  const localOrigin=origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(candidate.hostname)?candidate.origin:undefined;
  if(oidcEndpoint(issuer,localOrigin).search||issuer.length>2048||!clientId?.trim()||!clientSecret?.trim())
    throw Error('Set the exact company issuer, client ID and client secret.');
  const raw=environment.HARBOR_LOGIN_OIDC_BINDINGS||(allowDirectoryOnly?'{}':'');
  if(raw.length>64000)throw Error('Company sign-in bindings are too large.');
  const parsed:unknown=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Enter a mapping of provider subjects to Harbor addresses.');
  const entries=Object.entries(parsed);
  if((!entries.length&&!allowDirectoryOnly)||entries.length>100)throw Error('Configure between one and 100 company sign-in bindings.');
  const bindings=new Map<string,string>(),addresses=new Set<string>();
  for(const [sub,address] of entries){
    if(!validOidcSubject(sub)||typeof address!=='string'||address.includes(','))throw Error('Invalid company sign-in binding.');
    const [email]=parseAllowedEmails(address);
    if(addresses.has(email))throw Error('Each company subject needs its own Harbor address.');
    addresses.add(email);bindings.set(oidcSubjectKey(issuer,sub),email);
  }
  return {origin:origin.origin,secure:origin.protocol==='https:',allowedEmails,issuer,clientId,clientSecret,bindings,
    localOrigin,redirectUri:origin.origin+oidcCallbackPath,attemptSecret:JSON.stringify([issuer,clientId,clientSecret])};
}
export type CompanyOidcConfig=ReturnType<typeof companyOidcConfig>;
