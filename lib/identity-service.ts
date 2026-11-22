import {EncryptJWT,jwtDecrypt} from 'jose';
import {z} from 'zod';
import {randomSecret,sha256} from './email/crypto';
import {loginConfig,safeReturnPath,readCookie,cookieName,type HarborIdentity,type IdentityEnvironment} from './identity';
import {googleLoginURL,exchangeGoogleIdentity} from './google-identity';

export const SESSION_SECONDS=7*86400;
export const ATTEMPT_SECONDS=600;
export class GoogleLoginAdmissionError extends Error {
  readonly response:Response;
  constructor(response:Response){
    super('Harbor sign-in admission was blocked.');
    this.response=response;
  }
}
export class GoogleLoginFailure extends Error {
  readonly returnTo:string|undefined;
  constructor(stage:string,returnTo:string|undefined){
    super('Harbor sign-in step failed.',{cause:stage});
    this.returnTo=returnTo;
  }
}
export type VerifiedGoogleIdentity=Awaited<ReturnType<typeof exchangeGoogleIdentity>>;
export type LoginSession={tokenHash:string;userId:string;createdAt:number;expiresAt:number};
export type GoogleIdentityStore={
  recordIdentity(identity:VerifiedGoogleIdentity,now:number):Promise<string>;
  saveSession(session:LoginSession,priorSessionHash?:string|null):Promise<void>;
  findSession(tokenHash:string,now:number):Promise<Omit<HarborIdentity,'displayName'>|undefined>;
  revokeSession(tokenHash:string,allDevices:boolean,now:number):Promise<void>;
};

async function attemptKey(secret:string,provider:string){
  return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode((provider==='google'?'Harbor login attempt v1':'Harbor '+provider+' login attempt v1')+'\0'+secret)));
}
const attemptClaims=z.object({
  state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  returnTo:z.string().max(1500),
});

type AdditionalSignIn=(email:string,account:{subject:string}|{userId:string},allowedEmails:string[])=>Promise<boolean>;

export function createGoogleIdentityService(environment:IdentityEnvironment,getStore:()=>GoogleIdentityStore,
  admitExchange?:(state:string)=>Promise<void>,allowAdditional?:AdditionalSignIn){
  return createOidcIdentityService(()=>loginConfig(environment),getStore,
    {provider:'google',authorizationUrl:googleLoginURL,exchange:exchangeGoogleIdentity},admitExchange,allowAdditional);
}

export function createOidcIdentityService<Config extends ReturnType<typeof loginConfig>&{attemptSecret?:string}>(
  configure:()=>Config,getStore:()=>GoogleIdentityStore,
  protocol:{provider:'google'|'microsoft'|'oidc';authorizationUrl:(config:Config,state:string,nonce:string,verifier:string)=>Promise<string>;
    exchange:(config:Config,code:string,verifier:string,nonce:string)=>Promise<VerifiedGoogleIdentity>},
  admitExchange?:(state:string)=>Promise<void>,allowAdditional?:AdditionalSignIn){
  async function beginLogin(returnTo:string){
    const config=configure(),state=randomSecret(),nonce=randomSecret(),verifier=randomSecret();
    const browser=await new EncryptJWT({state,nonce,verifier,returnTo:safeReturnPath(returnTo)})
      .setProtectedHeader({alg:'dir',enc:'A256GCM'}).setAudience(config.origin).setIssuedAt().setExpirationTime('10m').encrypt(await attemptKey(config.attemptSecret??config.clientSecret,protocol.provider));
    return {url:await protocol.authorizationUrl(config,state,nonce,verifier),browser};
  }

  async function finishLogin(state:string,browser:string,code:string,exchange=protocol.exchange){
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||browser.length>3800||code.length>4000)throw Error('This sign-in has expired. Start again.');
    let stage='attempt',returnTo:string|undefined;
    try{
      const config=configure(),now=Date.now();
      const {payload}=await jwtDecrypt(browser,await attemptKey(config.attemptSecret??config.clientSecret,protocol.provider),{audience:config.origin,keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM'],requiredClaims:['exp','iat'],maxTokenAge:'10m'});
      const attempt=attemptClaims.parse(payload);
      if(attempt.state!==state)throw Error('This sign-in belongs to a different browser attempt.');
      returnTo=safeReturnPath(attempt.returnTo);
      if(!code)throw Error('No authorization code was returned.');
      if(admitExchange)await admitExchange(state);
      // The nonce and PKCE verifier bind the authorization code to this browser attempt.
      stage='provider';
      const identity=await exchange(config,code,attempt.verifier,attempt.nonce);
      stage='allowlist';
      if(!config.allowedEmails.includes(identity.email)&&
        !await allowAdditional?.(identity.email,{subject:identity.subject},config.allowedEmails)){
        throw Error('This account is not allowed to sign in to this Harbor deployment.');
      }
      stage='account';
      const store=getStore(),userId=await store.recordIdentity(identity,now);
      stage='session';
      const token=await issueLoginSession(store,userId,now);
      return {token,returnTo,userId};
    }catch(error){
      if(error instanceof GoogleLoginAdmissionError)throw error;
      const cause=error instanceof Error&&['provider-network','provider-response','provider-identity','account-conflict'].includes(String(error.cause))?String(error.cause):stage;
      throw new GoogleLoginFailure(cause,returnTo);
    }
  }

  return {beginLogin,finishLogin,...createIdentitySessions(configure,getStore,allowAdditional)};
}

export async function issueLoginSession(store:GoogleIdentityStore,userId:string,now:number,priorSessionHash?:string|null){
  const token=randomSecret();
  await store.saveSession({tokenHash:await sha256(token),userId,createdAt:now,expiresAt:now+SESSION_SECONDS*1000},priorSessionHash);
  return token;
}

export function createIdentitySessions(configure:()=>{secure:boolean;allowedEmails:string[]},getStore:()=>GoogleIdentityStore,
  allowAdditional?:AdditionalSignIn){
  function hashSessionCookie(headers:Headers,secure:boolean){
    const token=readCookie(headers,cookieName('session',secure));
    return token?sha256(token):null;
  }
  const sessionHash=(headers:Headers)=>hashSessionCookie(headers,configure().secure);

  async function sessionIdentity(headers:Headers):Promise<HarborIdentity|null>{
    const config=configure(),hash=await hashSessionCookie(headers,config.secure);
    if(!hash)return null;
    const row=await getStore().findSession(hash,Date.now());
    if(!row||!config.allowedEmails.includes(row.email)&&
      !await allowAdditional?.(row.email,{userId:row.userId},config.allowedEmails))return null;
    return {...row,displayName:row.fullName||row.email};
  }

  async function revokeLogin(headers:Headers,allDevices:boolean){
    const hash=await sessionHash(headers);
    if(hash)await getStore().revokeSession(hash,allDevices,Date.now());
  }

  return {sessionHash,sessionIdentity,revokeLogin};
}
