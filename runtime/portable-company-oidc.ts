import {createRemoteJWKSet,customFetch,jwtVerify} from 'jose';
import {z} from 'zod';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {sha256} from '../lib/email/crypto';
import {companyDirectoryIdentity} from '../db/postgres/company-directory-identity';
import {portableDb} from './portable-db';
import {oidcDirectoryAuthority,oidcDirectoryCanBind} from './portable-login-config';
import {validOidcSubject,oidcEndpoint,oidcSubjectKey,type CompanyOidcConfig} from './portable-company-oidc-config';

async function readJson(url:URL,init?:RequestInit){
  let response:Response;
  try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch{throw Error('Company identity provider unavailable.',{cause:'provider-network'});}
  if(!response.ok){await response.body?.cancel();throw Error('Company identity provider declined the request.',{cause:'provider-response'});}
  return JSON.parse(await readBoundedRequestText(response,65536)??'') as unknown;
}
async function discover(config:CompanyOidcConfig){
  const url=new URL(config.issuer.replace(/\/$/,'')+'/.well-known/openid-configuration');
  const info=z.object({issuer:z.literal(config.issuer),authorization_endpoint:z.string(),token_endpoint:z.string(),jwks_uri:z.string(),
    token_endpoint_auth_methods_supported:z.array(z.string()).default(['client_secret_basic'])}).parse(await readJson(url));
  const basic=info.token_endpoint_auth_methods_supported.includes('client_secret_basic');
  if(!basic&&!info.token_endpoint_auth_methods_supported.includes('client_secret_post'))throw Error('Unsupported company client authentication.');
  const endpoint=(value:string)=>oidcEndpoint(value,config.localOrigin);
  return {authorization:endpoint(info.authorization_endpoint),token:endpoint(info.token_endpoint),basic,
    keys:createRemoteJWKSet(endpoint(info.jwks_uri),{[customFetch]:(input,init)=>fetch(input,{...init,redirect:'error'})})};
}
const cache=new WeakMap<CompanyOidcConfig,{expires:number;result:ReturnType<typeof discover>}>();
function metadata(config:CompanyOidcConfig){
  const prior=cache.get(config);
  if(prior&&prior.expires>Date.now())return prior.result;
  const result=discover(config);
  cache.set(config,{result,expires:Date.now()+300000});
  void result.catch(()=>{if(cache.get(config)?.result===result)cache.delete(config);});
  return result;
}
export async function companyLoginUrl(config:CompanyOidcConfig,state:string,nonce:string,verifier:string){
  const url=new URL((await metadata(config)).authorization);
  for(const [name,value] of Object.entries({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',
    scope:'openid profile',state,nonce,code_challenge_method:'S256',code_challenge:await sha256(verifier)}))url.searchParams.set(name,value);
  return url.href;
}
export async function exchangeCompanyIdentity(config:CompanyOidcConfig,code:string,verifier:string,nonce:string){
  const {token,basic,keys}=await metadata(config);
  const body=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:config.redirectUri});
  const headers=new Headers();
  if(basic){
    const encode=(value:string)=>new URLSearchParams([['',value]]).toString().slice(1);
    headers.set('authorization','Basic '+Buffer.from(encode(config.clientId)+':'+encode(config.clientSecret)).toString('base64'));
  }else{body.set('client_id',config.clientId);body.set('client_secret',config.clientSecret);}
  const result=await readJson(token,{method:'POST',body,headers});
  try{
    const {id_token}=z.object({id_token:z.string().max(24000)}).parse(result);
    const {payload}=await jwtVerify(id_token,keys,{algorithms:['RS256'],issuer:config.issuer,audience:config.clientId,
      requiredClaims:['sub','exp','iat','nonce'],maxTokenAge:'10m',clockTolerance:5});
    if(!payload.sub||!validOidcSubject(payload.sub)||payload.nonce!==nonce||(payload.azp!==undefined&&payload.azp!==config.clientId)||
      (Array.isArray(payload.aud)&&payload.aud.some(aud=>aud!==config.clientId)))throw Error('Unexpected company token claims.');
    const subject=oidcSubjectKey(config.issuer,payload.sub);
    let email=config.bindings.get(subject);
    const authority=oidcDirectoryAuthority();
    if(!email&&authority){
      const candidate=await companyDirectoryIdentity(portableDb(),'oidc',authority.workspaceId,config.issuer,subject);
      if(candidate&&oidcDirectoryCanBind(config,authority.workspaceId,candidate))email=candidate;
    }
    if(!email)throw Error('Unbound company identity.');
    return {subject,email,fullName:typeof payload.name==='string'?payload.name.slice(0,300):null};
  }catch{throw Error('Company identity verification failed.',{cause:'provider-identity'});}
}
