import {SAML,InMemoryCacheProvider,ValidateInResponseTo} from '@node-saml/node-saml';
import {DOMParser} from '@xmldom/xmldom';
import {EncryptJWT,jwtDecrypt} from 'jose';
import {z} from 'zod';
import {randomSecret} from '../lib/email/crypto';
import {safeReturnPath} from '../lib/identity';
import {samlSubject,validSamlNameId,type SamlLoginConfig} from './portable-saml-config';

const lifetimeMs=600_000,clockSkewMs=5_000;
const persistentNameId='urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const bearer='urn:oasis:names:tc:SAML:2.0:cm:bearer';
const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const attempt=z.object({state:token,requestId:z.string().regex(/^_hb_[A-Za-z0-9_-]{43}$/),returnTo:z.string().max(1500),
  priorSessionHash:token.optional(),iat:z.number().int()});
const instant=z.iso.datetime({offset:true});
const text=z.object({_:z.string().min(1)});
const confirmation=z.object({$:z.object({Method:z.string()}),SubjectConfirmationData:z.array(z.object({$:z.object({
  Recipient:z.string().optional(),InResponseTo:z.string().optional(),NotOnOrAfter:instant.optional(),NotBefore:instant.optional(),
})})).optional()});
const signedClaims=z.object({Assertion:z.object({
  $:z.object({Version:z.literal('2.0'),IssueInstant:instant}),
  Issuer:z.tuple([text]),
  Subject:z.tuple([z.object({NameID:z.tuple([text.extend({$:z.object({Format:z.literal(persistentNameId)})})]),
    SubjectConfirmation:z.array(confirmation).min(1)})]),
  Conditions:z.tuple([z.object({$:z.object({NotOnOrAfter:instant,NotBefore:instant.optional()}),
    AudienceRestriction:z.array(z.object({Audience:z.array(text).min(1)})).min(1)})]),
  AuthnStatement:z.array(z.object({})).min(1),
})});

function provider(config:SamlLoginConfig,cacheProvider?:InMemoryCacheProvider,requestId?:string){
  return new SAML({entryPoint:config.entryPoint,idpCert:config.certificates.map(cert=>cert.toString()),idpIssuer:config.issuer,issuer:config.entityId,
    audience:config.entityId,callbackUrl:config.redirectUri,identifierFormat:persistentNameId,disableRequestedAuthnContext:true,
    wantAssertionsSigned:true,wantAuthnResponseSigned:true,acceptedClockSkewMs:clockSkewMs,maxAssertionAgeMs:lifetimeMs,
    validateInResponseTo:ValidateInResponseTo.always,requestIdExpirationPeriodMs:lifetimeMs,
    ...(cacheProvider?{cacheProvider}:{}),...(requestId?{generateUniqueId:()=>requestId}:{})});
}
export function samlMetadata(config:SamlLoginConfig){
  return provider(config).generateServiceProviderMetadata(null);
}

export async function beginSamlAttempt(config:SamlLoginConfig,returnTo:string,priorSessionHash?:string){
  const state=randomSecret(),requestId='_hb_'+randomSecret();
  const encrypt=(path:string)=>new EncryptJWT({state,requestId,returnTo:path,priorSessionHash:token.optional().parse(priorSessionHash)})
    .setProtectedHeader({alg:'dir',enc:'A256GCM'}).setIssuedAt().setExpirationTime('10m').setIssuer(samlSubject(config.issuer,config.entityId))
    .setAudience(config.entityId).encrypt(Buffer.from(config.attemptSecret,'base64'));
  let browser=await encrypt(safeReturnPath(returnTo));
  if(browser.length>3800)browser=await encrypt('/');
  const url=await provider(config,undefined,requestId).getAuthorizeUrlAsync(state,{});
  return {url,browser};
}

// Called only after node-saml verifies both signatures, including the Response root,
// and its configured idpIssuer. Version 5.2 only warns about an old Destination.
function requireResponseDestination(response:string,callbackUrl:string){
  const reject=()=>{throw Error('Invalid SAML response envelope.');};
  const document=new DOMParser({errorHandler:reject}).parseFromString(Buffer.from(response,'base64').toString('utf8'),'application/xml');
  const root=document.documentElement;
  if(document.doctype||root.namespaceURI!=='urn:oasis:names:tc:SAML:2.0:protocol'||root.localName!=='Response'||
    root.getAttribute('Destination')!==callbackUrl)reject();
}

export async function finishSamlAttempt(config:SamlLoginConfig,input:{browser:string;relayState:string;response:string},consume:(state:string)=>Promise<void>,
  directoryEmail?:(subject:string)=>Promise<string|undefined>){
  let saved:z.infer<typeof attempt>;
  try{
    if(input.browser.length>3800)throw Error();
    const {payload}=await jwtDecrypt(input.browser,Buffer.from(config.attemptSecret,'base64'),{issuer:samlSubject(config.issuer,config.entityId),audience:config.entityId,
      keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM'],requiredClaims:['exp','iat'],maxTokenAge:'10m'});
    saved=attempt.parse(payload);
    if(saved.state!==input.relayState)throw Error();
  }catch{throw Error('The SAML sign-in attempt expired or did not match this browser.',{cause:'attempt'});}
  await consume(saved.state);

  let nameId:string;
  try{
    if(!input.response||input.response.length>262144)throw Error();
    // Only the ID sealed into this browser's attempt is available to the library.
    // The database receipt above enforces one use across all web instances.
    const cache=new InMemoryCacheProvider({keyExpirationPeriodMs:lifetimeMs});
    await cache.saveAsync(saved.requestId,new Date(saved.iat*1000).toISOString());
    const result=await provider(config,cache).validatePostResponseAsync({SAMLResponse:input.response});
    requireResponseDestination(input.response,config.redirectUri);
    const assertion=signedClaims.parse(result.profile?.getAssertion?.()).Assertion;
    const now=Date.now(),issued=Date.parse(assertion.$.IssueInstant);
    if(issued>now+clockSkewMs||issued+lifetimeMs+clockSkewMs<=now||assertion.Issuer[0]._!==config.issuer)throw Error();
    // Read the signed assertion only. Version 5.2 warns about a mismatched Recipient.
    const accepts=assertion.Subject[0].SubjectConfirmation.some(c=>c.$.Method===bearer&&c.SubjectConfirmationData?.some(({ $:data })=>
      data.InResponseTo===saved.requestId&&data.Recipient===config.redirectUri&&data.NotOnOrAfter&&
      Date.parse(data.NotOnOrAfter)>now-clockSkewMs&&(!data.NotBefore||Date.parse(data.NotBefore)<=now+clockSkewMs)));
    if(!accepts)throw Error();
    nameId=assertion.Subject[0].NameID[0]._;
    if(!validSamlNameId(nameId))throw Error();
  }catch{throw Error('Harbor could not verify the SAML sign-in assertion.',{cause:'provider-identity'});}
  const subject=samlSubject(config.issuer,nameId),email=config.bindings.get(subject)??await directoryEmail?.(subject);
  if(!email)throw Error('This SAML identity has no Harbor binding.',{cause:'allowlist'});
  return {identity:{subject,email,fullName:null},returnTo:safeReturnPath(saved.returnTo),priorSessionHash:saved.priorSessionHash};
}
