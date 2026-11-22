import {authCookie,readCookie,safeReturnPath} from '../lib/identity';
import {ATTEMPT_SECONDS,GoogleLoginAdmissionError,SESSION_SECONDS} from '../lib/identity-service';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {completePortableSamlSession,requestSessionHash,resolvePortableDirectorySamlEmail} from './portable-identity';
import {logFailure} from './portable-identity-routes';
import {portableLoginProviders} from './portable-login-config';
import {admitPortableLoginExchange,portableRateLimit} from './portable-rate-limit';
import {samlAttemptCookie,samlAttemptCookieName} from './portable-saml-cookie';
import {beginSamlAttempt,finishSamlAttempt,samlMetadata} from './portable-saml-provider';

const headers={'cache-control':'no-store','referrer-policy':'no-referrer'};
const unavailable=()=>new Response('Not found',{status:404,headers});
function redirect(location:string,cookies:string[]){
  const responseHeaders=new Headers({...headers,location});
  for(const cookie of cookies)responseHeaders.append('set-cookie',cookie);
  return new Response(null,{status:303,headers:responseHeaders});
}

export async function startSamlLogin(request:Request){
  const config=portableLoginProviders().saml;
  if(!config)return unavailable();
  const url=new URL(request.url);
  if(url.origin!==config.origin)return new Response('Invalid origin',{status:403,headers});
  const limited=await portableRateLimit('login_start','');
  if(limited)return limited;
  const paths=url.searchParams.getAll('return_to');
  const attempt=await beginSamlAttempt(config,safeReturnPath(paths.length===1?paths[0]:'/'),await requestSessionHash(request.headers)??undefined);
  return redirect(attempt.url,[samlAttemptCookie(attempt.browser,ATTEMPT_SECONDS)]);
}

export function getSamlMetadata(){
  const config=portableLoginProviders().saml;
  return config?new Response(samlMetadata(config),{headers:{...headers,'content-type':'application/samlmetadata+xml; charset=utf-8'}}):unavailable();
}

export async function completeSamlLogin(request:Request){
  const config=portableLoginProviders().saml;
  if(!config)return unavailable();
  if(new URL(request.url).origin!==config.origin)return new Response('Invalid origin',{status:403,headers});
  if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')
    return new Response('Submit the company sign-in form.',{status:415,headers});
  const clear=samlAttemptCookie('',0);
  let returnTo='/';
  try{
    const browser=readCookie(request.headers,samlAttemptCookieName,true);
    if(!browser)throw Error('Sign-in expired.',{cause:'attempt'});
    const text=await readBoundedRequestText(request,256*1024);
    if(text===null)return new Response('The sign-in form is too large.',{status:413,headers});
    const fields=new URLSearchParams(text),states=fields.getAll('RelayState'),responses=fields.getAll('SAMLResponse');
    if(states.length!==1||responses.length!==1)throw Error('Incomplete sign-in.',{cause:'attempt'});
    const result=await finishSamlAttempt(config,{browser,relayState:states[0],response:responses[0]},admitPortableLoginExchange,
      subject=>resolvePortableDirectorySamlEmail(config,subject));
    returnTo=result.returnTo;
    const session=await completePortableSamlSession(result.identity,returnTo,result.priorSessionHash);
    return redirect(new URL(session.returnTo,config.origin).href,[clear,authCookie('session',session.token,config.secure,SESSION_SECONDS)]);
  }catch(error){
    if(error instanceof GoogleLoginAdmissionError)return error.response;
    const cause=error instanceof Error?String(error.cause):'';
    const stage=['attempt','provider-identity','allowlist','account-conflict','session'].includes(cause)?cause:'callback';
    const retry=new URL('/auth/sign-in',config.origin);
    retry.searchParams.set('error',stage==='account-conflict'?'account_conflict':'sign_in_failed');
    retry.searchParams.set('reference',logFailure(stage));
    if(returnTo!=='/')retry.searchParams.set('return_to',returnTo);
    return redirect(retry.href,[clear]);
  }
}
