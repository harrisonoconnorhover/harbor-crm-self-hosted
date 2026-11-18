import {createRemoteJWKSet,customFetch,jwtVerify,type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {sha256} from '../lib/email/crypto';
import type {microsoftLoginConfig} from './portable-login-config';

type Config=ReturnType<typeof microsoftLoginConfig>;
export const microsoftIdentityScopes='openid profile email';
const claims=z.object({ver:z.literal('2.0'),sub:z.string().min(1).max(255),oid:z.string().guid(),
  tid:z.string().guid(),nonce:z.string(),aud:z.string(),name:z.string().max(300).optional()});
let cachedKeys:{authority:string;resolve:JWTVerifyGetKey}|undefined;

function signingKeys(config:Config){
  if(cachedKeys?.authority!==config.authority){
    const resolve=createRemoteJWKSet(new URL(config.authority+'/discovery/v2.0/keys'),{
      [customFetch]:(input,init)=>fetch(input,{...init,redirect:'manual'}),
    });
    cachedKeys={authority:config.authority,resolve};
  }
  return cachedKeys.resolve;
}
export async function microsoftLoginURL(config:Config,state:string,nonce:string,verifier:string){
  const url=new URL(config.authority+'/oauth2/v2.0/authorize');
  url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',response_mode:'query',
    scope:microsoftIdentityScopes,state,nonce,code_challenge_method:'S256',code_challenge:await sha256(verifier),prompt:'select_account'}).toString();
  return url.toString();
}
export async function verifyMicrosoftIdentity(config:Config,idToken:string,nonce:string,key:JWTVerifyGetKey=signingKeys(config)){
  const {payload}=await jwtVerify(idToken,key,{algorithms:['RS256'],issuer:config.issuer,audience:config.clientId,
    requiredClaims:['exp','iat','sub','nonce','tid','oid'],maxTokenAge:'10m',clockTolerance:5});
  const token=claims.parse(payload);
  if(token.aud!==config.clientId||token.nonce!==nonce||token.tid.toLowerCase()!==config.tenant)
    throw Error('Microsoft identity does not match this sign-in.');
  // Microsoft explicitly treats email and preferred_username as mutable display claims.
  // Only a locally pinned tenant + directory object identifies a Harbor address.
  const objectId=token.oid.toLowerCase(),email=config.bindings.get(objectId);
  if(!email)throw Error('Microsoft identity has no Harbor binding.');
  return {subject:config.tenant+':'+objectId,email,fullName:token.name||null};
}
export async function exchangeMicrosoftIdentity(config:Config,code:string,verifier:string,nonce:string,fetcher:typeof fetch=fetch,
  key:JWTVerifyGetKey=signingKeys(config)){
  let response:Response;
  try{
    response=await fetcher(config.authority+'/oauth2/v2.0/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,
        redirect_uri:config.redirectUri,grant_type:'authorization_code',code,code_verifier:verifier,scope:microsoftIdentityScopes})});
  }catch{throw Error('Microsoft connection failed.',{cause:'provider-network'});}
  if(!response.ok){await response.body?.cancel();throw Error('Microsoft could not complete sign-in.',{cause:'provider-response'});}
  try{
    const text=await readBoundedRequestText(response,32000);
    if(!text)throw Error('Missing Microsoft token response.');
    const {id_token}=z.object({id_token:z.string().min(1).max(24000)}).parse(JSON.parse(text));
    return await verifyMicrosoftIdentity(config,id_token,nonce,key);
  }catch{throw Error('Microsoft identity verification failed.',{cause:'provider-identity'});}
}
