import {createRemoteJWKSet,jwtVerify,customFetch,type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import {sha256} from './email/crypto';
import type {loginConfig} from './identity';
type Config=ReturnType<typeof loginConfig>;
export const googleTokenEndpoint='https://oauth2.googleapis.com/token';
export const googleSigningKeysEndpoint='https://www.googleapis.com/oauth2/v3/certs';
// Fixed Google endpoints. Workers supports manual, not error, redirect mode.
// Both token and JWKS readers reject non-success responses without following redirects.
// Tests inject a key resolver; deployments cannot configure one.
const keys=createRemoteJWKSet(new URL(googleSigningKeysEndpoint),{
  [customFetch]:(url,options)=>fetch(url,{...options,redirect:'manual'}),
});
export async function googleLoginURL(config:Config,state:string,nonce:string,verifier:string){
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:await sha256(verifier),code_challenge_method:'S256',prompt:'select_account'}).toString();
  return url.toString();
}
const claims=z.object({sub:z.string().min(1).max(255),email:z.string().email().max(254),email_verified:z.literal(true),name:z.string().max(300).optional(),nonce:z.string(),azp:z.string().optional()});
export async function verifyGoogleIdentity(idToken:string,clientId:string,nonce:string,key:JWTVerifyGetKey=keys){
  const {payload}=await jwtVerify(idToken,key,{algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,requiredClaims:['exp','iat','sub','nonce','email','email_verified'],maxTokenAge:'10m',clockTolerance:5});
  const p=claims.parse(payload);
  if(p.nonce!==nonce||(p.azp!==undefined&&p.azp!==clientId)||(Array.isArray(payload.aud)&&payload.aud.length>1&&p.azp!==clientId))throw Error('Google identity does not match this sign-in.');
  return {subject:p.sub,email:p.email.toLowerCase(),fullName:p.name||null};
}
export async function exchangeGoogleIdentity(config:Config,code:string,verifier:string,nonce:string,fetcher:typeof fetch=fetch,key:JWTVerifyGetKey=keys){
  let response:Response;
  try {response=await fetcher(googleTokenEndpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectUri,code,code_verifier:verifier,grant_type:'authorization_code'})});}catch{throw new Error('Google connection failed.',{cause:'provider-network'});}
  if(!response.ok){await response.body?.cancel();throw new Error('Google could not complete sign-in.',{cause:'provider-response'});}
  const reader=response.body?.getReader();if(!reader)throw Error('Empty Google response.');
  let text='';const decoder=new TextDecoder();let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32000)throw Error('Google response is too large.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();reader.releaseLock();}
  const result=z.object({id_token:z.string().max(24000)}).parse(JSON.parse(text));
  try{return await verifyGoogleIdentity(result.id_token,config.clientId,nonce,key)}catch{throw new Error('Google identity verification failed.',{cause:'provider-identity'});}
}
