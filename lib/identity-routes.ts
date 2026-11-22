import {authMode,loginConfig,authCookie,readCookie,cookieName,type IdentityEnvironment} from './identity';
import {SESSION_SECONDS,ATTEMPT_SECONDS,GoogleLoginAdmissionError,GoogleLoginFailure,type createGoogleIdentityService} from './identity-service';
import {readBoundedRequestText} from './bounded-request-text';
const headers={'cache-control':'no-store','referrer-policy':'no-referrer'};
const logoutBodyLimit=512;
function redirect(url:string,cookies:string[]=[]){const h=new Headers({...headers,location:url});for(const cookie of cookies)h.append('set-cookie',cookie);return new Response(null,{status:303,headers:h});}
export function createGoogleIdentityRoutes(env:IdentityEnvironment,identity:Pick<ReturnType<typeof createGoogleIdentityService>,'beginLogin'|'finishLogin'|'revokeLogin'>,referenceForFailure?:(stage:string)=>string){
 const routes=createOidcIdentityRoutes(()=>authMode(env)==='google',()=>loginConfig(env),identity,referenceForFailure);
 return {startGoogleLogin:routes.startLogin,completeGoogleLogin:routes.completeLogin,logout:routes.logout};
}
export function createOidcIdentityRoutes(enabled:()=>boolean,configure:()=>{origin:string;secure:boolean},
 identity:{beginLogin:(path:string)=>Promise<{url:string;browser:string}>;finishLogin:(state:string,browser:string,code:string)=>Promise<{token:string;returnTo:string}>;
   revokeLogin:(headers:Headers,allDevices:boolean)=>Promise<void>},referenceForFailure?:(stage:string)=>string,admitStart?:()=>Promise<Response|null>){
 const {beginLogin,finishLogin,revokeLogin}=identity;
 async function startLogin(request:Request){
   if(!enabled())return new Response('Not found',{status:404});
   const config=configure();
   if(new URL(request.url).origin!==config.origin)return new Response('Invalid origin',{status:403,headers});
   const denial=await admitStart?.();if(denial)return denial;
   const returnPaths=new URL(request.url).searchParams.getAll('return_to');
   const result=await beginLogin(returnPaths.length===1?returnPaths[0]:'/');
   return redirect(result.url,[authCookie('attempt',result.browser,config.secure,ATTEMPT_SECONDS)]);
 }
 async function completeLogin(request:Request){
   if(!enabled())return new Response('Not found',{status:404});
   const config=configure(),url=new URL(request.url);
   if(url.origin!==config.origin)return new Response('Invalid origin',{status:403,headers});
   const clear=authCookie('attempt','',config.secure,0);
   try{
     const states=url.searchParams.getAll('state'),codes=url.searchParams.getAll('code');
     const code=!url.searchParams.has('error')&&codes.length===1?codes[0]:'';
     const result=await finishLogin(states.length===1?states[0]:'',readCookie(request.headers,cookieName('attempt',config.secure),true)||'',code);
     await revokeLogin(request.headers,false);
     return redirect(new URL(result.returnTo,config.origin).href,[clear,authCookie('session',result.token,config.secure,SESSION_SECONDS)]);
   }catch(error){
     if(error instanceof GoogleLoginAdmissionError)return error.response;
     // Only our own fixed stage labels may enter logs. Never log the exception,
     // provider response, authorization code, cookie or identity.
     const stage=error instanceof Error&&['attempt','provider','provider-network','provider-response','provider-identity','allowlist','account','account-conflict','session'].includes(String(error.cause))?String(error.cause):'callback';
     const reference=referenceForFailure?.(stage);
     if(!reference)console.warn('Harbor sign-in failed at stage: '+stage);
     // Never send provider errors, codes or tokens to logs or the browser.
     const retry=new URL('/auth/sign-in',config.origin);
     retry.searchParams.set('error',stage==='account-conflict'?'account_conflict':'sign_in_failed');
     if(reference)retry.searchParams.set('reference',reference);
     if(error instanceof GoogleLoginFailure&&error.returnTo&&error.returnTo!=='/')retry.searchParams.set('return_to',error.returnTo);
     return redirect(retry.href,[clear]);
   }
 }
 return {startLogin,completeLogin,logout:createLogoutRoute(enabled,configure,revokeLogin)};
}

export function createLogoutRoute(enabled:()=>boolean,configure:()=>{origin:string;secure:boolean},revokeLogin:(headers:Headers,allDevices:boolean)=>Promise<void>){
 return async function logout(request:Request){
   if(!enabled())return new Response('Not found',{status:404});
   const config=configure();
   if(request.headers.get('origin')!==config.origin||new URL(request.url).origin!==config.origin)return new Response('Submit this action from Harbor.',{status:403,headers});
   const type=request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
   if(type!=='application/x-www-form-urlencoded')return new Response('Submit the Harbor sign-out form.',{status:415,headers});
   let body:string|null;
   try{body=await readBoundedRequestText(request,logoutBodyLimit);}
   catch{return new Response('Could not read the sign-out form.',{status:400,headers});}
   if(body===null)return new Response('The sign-out form is too large.',{status:413,headers});
   const scopes=new URLSearchParams(body).getAll('scope'),[scope]=scopes;
   if(scopes.length!==1||scope!=='all'&&scope!=='current')return new Response('Choose which sessions to end.',{status:400,headers});
   await revokeLogin(request.headers,scope==='all');
   return redirect(config.origin+'/auth/sign-in?signed_out=1',[authCookie('session','',config.secure,0),authCookie('attempt','',config.secure,0)]);
 };
}
