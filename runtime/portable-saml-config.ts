import {createHash,X509Certificate} from 'node:crypto';
import {loginOrigin,parseAllowedEmails,type IdentityEnvironment} from '../lib/identity';

export const samlCallbackPath='/auth/saml/callback';
export const samlMetadataPath='/auth/saml/metadata';
export const samlLoginSettings=['HARBOR_LOGIN_SAML_ISSUER','HARBOR_LOGIN_SAML_ENTRY_POINT',
  'HARBOR_LOGIN_SAML_CERT','HARBOR_LOGIN_SAML_BINDINGS','HARBOR_LOGIN_SAML_ATTEMPT_SECRET'] as const;
type Environment=IdentityEnvironment&Partial<Record<typeof samlLoginSettings[number],string>>;

export function validSamlNameId(value:string){
  return value.length>0&&value.length<=1024&&value===value.trim()&&value.isWellFormed()&&
    Array.from(value).every(char=>char.charCodeAt(0)>=0x20&&char!=='\u007f');
}

export function samlDirectoryScope(issuer:string){
  return 'directory:saml:'+createHash('sha256').update(issuer).digest('hex');
}

export function samlSubject(issuer:string,nameId:string){
  return createHash('sha256').update(JSON.stringify([issuer,nameId])).digest('hex');
}

export function samlLoginConfig(env:Environment,allowDirectoryOnly=false){
  const origin=loginOrigin(env),allowedEmails=parseAllowedEmails(env.HARBOR_LOGIN_ALLOWED_EMAILS);
  const issuer=env.HARBOR_LOGIN_SAML_ISSUER??'';
  if(!issuer||issuer.length>2048||/\s/.test(issuer))throw Error('Set the SAML identity provider entity ID.');
  const entry=URL.parse(env.HARBOR_LOGIN_SAML_ENTRY_POINT??'');
  const local=origin.protocol==='http:'&&entry?.protocol==='http:'&&['localhost','127.0.0.1'].includes(entry.hostname);
  if(!entry||(!local&&entry.protocol!=='https:')||entry.username||entry.password||entry.hash)
    throw Error('Set the HTTPS SAML identity provider sign-in URL.');

  const pem=(env.HARBOR_LOGIN_SAML_CERT??'').replaceAll('\\n','\n').trim();
  const blocks=pem.split(/(?<=-----END CERTIFICATE-----)\s+(?=-----BEGIN CERTIFICATE-----)/);
  if(blocks.length>2||blocks.some(block=>block.length>24000||!/^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/.test(block)))
    throw Error('Set one public PEM signing certificate, or two during a certificate change.');
  const certificates=blocks.map(block=>new X509Certificate(block));
  const attemptSecret=env.HARBOR_LOGIN_SAML_ATTEMPT_SECRET??'';
  if(!/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/.test(attemptSecret)||
    ![Buffer.from(attemptSecret,'base64').toString('base64'),Buffer.from(attemptSecret,'base64').toString('base64url')].includes(attemptSecret))
    throw Error('Set a base64-encoded 32-byte SAML attempt secret.');
  const raw=env.HARBOR_LOGIN_SAML_BINDINGS||(allowDirectoryOnly?'{}':'');
  if(!raw||raw.length>64000)throw Error('Set SAML NameID bindings.');
  const parsed:unknown=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Set SAML bindings as a JSON object.');
  const entries=Object.entries(parsed);
  if((!entries.length&&!allowDirectoryOnly)||entries.length>100)throw Error('Configure one to 100 SAML bindings.');
  const bindings=new Map<string,string>(),emails=new Set<string>();
  for(const [nameId,address] of entries){
    if(!validSamlNameId(nameId)||typeof address!=='string'||address.includes(','))throw Error('Invalid SAML NameID binding.');
    const [email]=parseAllowedEmails(address);
    if(emails.has(email))throw Error('Each SAML identity needs a distinct Harbor email address.');
    bindings.set(samlSubject(issuer,nameId),email);
    emails.add(email);
  }
  return {origin:origin.origin,secure:origin.protocol==='https:',allowedEmails,issuer,entryPoint:entry.href,
    certificates,attemptSecret,bindings,entityId:origin.origin+samlMetadataPath,redirectUri:origin.origin+samlCallbackPath};
}
export type SamlLoginConfig=ReturnType<typeof samlLoginConfig>;
