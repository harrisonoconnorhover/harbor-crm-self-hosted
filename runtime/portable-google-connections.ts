import {claimGoogleAttempt,readGoogleGrant,saveGoogleAttempt,saveGoogleGrant,updateGoogleGrant,type GoogleActor} from '../db/postgres/portable-google-store';
import type {PortableGoogleProvider} from '../db/postgres/portable-google-schema';
import {ApiError} from '../lib/api-error';
import {CALENDAR_AVAILABILITY_SCOPES,CalendarError,calendarAuthorization,calendarIdentity,calendarTokens} from '../lib/calendar/google';
import {authorizationURL,exchangeCode,GMAIL_READ_SCOPE,GmailError,mailboxEmail,refreshTokens} from '../lib/email/gmail';
import {randomSecret,seal,sha256,unseal} from '../lib/email/crypto';
import {GoogleConnectionError} from '../lib/google-oauth-result';
import {portableDb} from './portable-db';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {requestIdentity,requestSessionHash} from './portable-identity';

type Provider=PortableGoogleProvider;
type Config=NonNullable<ReturnType<typeof portablePersonalGoogleConfig>>;
type Grant=NonNullable<Awaited<ReturnType<typeof readGoogleGrant>>>;
const gmailScopes=[GMAIL_READ_SCOPE];
const needsGoogleReconnect=(error:unknown)=>
  (error instanceof GmailError||error instanceof CalendarError)&&error.code==='reauth';
const aad=(config:Config,actor:GoogleActor,provider:Provider,label:string,id:string)=>
  JSON.stringify(['harbor-personal-google-v1',config.redirectUri,config.clientId,actor.userId,actor.email,provider,label,id]);

export function boundedGoogleRead(){
  const deadline=AbortSignal.timeout(12_000);
  const fetcher:typeof fetch=(input,init)=>fetch(input,{
    ...init,signal:init?.signal?AbortSignal.any([deadline,init.signal]):deadline,
  });
  return {deadline,fetcher};
}
export {boundedGoogleRead as boundedGmailRead};

export async function personalGoogleActor(request:Request,user:{userId:string;email:string}):Promise<GoogleActor>{
  const sessionHash=await requestSessionHash(request.headers);
  if(!sessionHash)throw new ApiError(401,'Sign in again to manage this connection.');
  return {userId:user.userId,email:user.email,sessionHash};
}

async function assertSession(request:Request,actor:GoogleActor){
  const current=await requestIdentity(request.headers);
  if(current?.userId!==actor.userId||current.email!==actor.email||await requestSessionHash(request.headers)!==actor.sessionHash)
    throw new ApiError(401,'Sign in again to use this connection.');
}

async function assertGrant(request:Request,actor:GoogleActor,expected:Grant){
  await assertSession(request,actor);
  const current=await readGoogleGrant(portableDb(),actor,expected.provider);
  if(!current||current.id!==expected.id||current.refreshToken!==expected.refreshToken||current.needsReconnect)
    throw new ApiError(409,'This Google connection changed. Refresh and try again.');
}

export async function startPersonalGoogle(actor:GoogleActor,provider:Provider,config:Config){
  const state=randomSecret(),stateHash=await sha256(state),verifier=randomSecret();
  const saved=await saveGoogleAttempt(portableDb(),actor,{provider,stateHash,expiresAt:Date.now()+600_000,
    verifier:await seal(verifier,config.key,aad(config,actor,provider,'attempt',stateHash))});
  if(!saved)throw new ApiError(401,'Sign in again to connect Google.');
  const challenge=await sha256(verifier);
  const url=new URL(provider==='gmail'?authorizationURL(config,state,challenge,gmailScopes):
    calendarAuthorization(config,state,challenge,CALENDAR_AVAILABILITY_SCOPES));
  url.searchParams.set('login_hint',actor.email);
  return url.toString();
}

async function providerEmail(provider:Provider,accessToken:string,fetcher:typeof fetch=fetch){
  return (provider==='gmail'?await mailboxEmail(accessToken,fetcher):(await calendarIdentity(accessToken,fetcher)).email).toLowerCase();
}

export async function completePersonalGoogle(request:Request,actor:GoogleActor,provider:Provider,config:Config,state:string,code:string|null){
  const stateHash=await sha256(state);
  const claimed=await claimGoogleAttempt(portableDb(),actor,provider,stateHash);
  if(!claimed)throw new GoogleConnectionError('expired','Connection attempt is no longer available.');
  if(!code)throw new GoogleConnectionError('denied','Google did not authorize access.');
  const verifier=await unseal(claimed,config.key,aad(config,actor,provider,'attempt',stateHash));
  await assertSession(request,actor);
  const {deadline,fetcher}=boundedGoogleRead();
  const id=crypto.randomUUID();
  let refreshToken:string;
  try{
    const tokens=provider==='gmail'?await exchangeCode(config,code,verifier,fetcher,gmailScopes):
      await calendarTokens(config,{code,verifier},CALENDAR_AVAILABILITY_SCOPES,fetcher);
    await assertSession(request,actor);
    if(await providerEmail(provider,tokens.accessToken,fetcher)!==actor.email.toLowerCase())
      throw new ApiError(409,'Choose the same Google account you used to sign in to Harbor.');
    refreshToken=await seal(tokens.refreshToken,config.key,aad(config,actor,provider,'grant',id));
    deadline.throwIfAborted();
  }catch(error){
    if(deadline.aborted&&(error===deadline.reason||error instanceof GmailError||error instanceof CalendarError))
      throw new GoogleConnectionError('provider_unavailable','Google took too long to complete the connection.');
    throw error;
  }
  if(!await saveGoogleGrant(portableDb(),actor,stateHash,{provider,id,refreshToken}))
    throw new GoogleConnectionError('expired','Connection attempt is no longer available.');
}

export async function personalGoogleAccess(request:Request,actor:GoogleActor,provider:Provider,
  config:Config,{expectedId,gmailFetch,calendarFetch}: {expectedId?:string;gmailFetch?:typeof fetch;calendarFetch?:typeof fetch}={}){
  const saved=await readGoogleGrant(portableDb(),actor,provider);
  if(!saved)throw new ApiError(409,'Connect your Google account in Harbor before continuing.');
  if(saved.needsReconnect)throw new ApiError(409,'Reconnect your Google account in Harbor before continuing.');
  let row=saved;
  if(expectedId&&expectedId!==row.id)throw new ApiError(409,'This Google connection changed. Refresh and try again.');
  const context=aad(config,actor,provider,'grant',row.id);
  const reconnect=async()=>{
    await assertSession(request,actor);
    if(!await updateGoogleGrant(portableDb(),actor,row,{needsReconnect:true}))
      throw new ApiError(409,'This Google connection changed. Refresh and try again.');
    throw new ApiError(409,'Reconnect your Google account in Harbor before continuing.');
  };
  let refresh:string;
  try{refresh=await unseal(row.refreshToken,config.key,context);}
  catch{return await reconnect();}
  await assertGrant(request,actor,row);
  const fetcher=(provider==='gmail'?gmailFetch:calendarFetch)??boundedGoogleRead().fetcher;
  let accessToken:string;
  try{
    const tokens=provider==='gmail'?await refreshTokens(config,refresh,fetcher,gmailScopes):
      await calendarTokens(config,{refreshToken:refresh},CALENDAR_AVAILABILITY_SCOPES,fetcher);
    await assertGrant(request,actor,row);
    if(await providerEmail(provider,tokens.accessToken,fetcher)!==actor.email.toLowerCase())return await reconnect();
    await assertGrant(request,actor,row);
    if(tokens.refreshToken!==refresh){
      const refreshToken=await seal(tokens.refreshToken,config.key,context);
      if(!await updateGoogleGrant(portableDb(),actor,row,{refreshToken}))
        throw new ApiError(409,'This Google connection changed. Refresh and try again.');
      row={...row,refreshToken};
    }
    accessToken=tokens.accessToken;
  }catch(error){
    if(needsGoogleReconnect(error))return await reconnect();
    throw error;
  }
  const current=row;
  const read=async <T>(operation:()=>Promise<T>)=>{
    try{return await operation();}
    catch(error){
      if(needsGoogleReconnect(error))return await reconnect();
      throw error;
    }
  };
  return {id:current.id,accessToken,assertCurrent:()=>assertGrant(request,actor,current),read};
}
