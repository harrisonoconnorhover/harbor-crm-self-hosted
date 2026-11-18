import {z} from 'zod';
import {claimConnectionAttempt,readConnectionGrant,saveConnectionAttempt,saveConnectionGrant,updateConnectionGrant,
  type ConnectionActor} from '../db/postgres/portable-connection-store';
import type {OutlookProvider} from '../db/postgres/portable-google-schema';
import {ApiError} from '../lib/api-error';
import {randomSecret,seal,sha256,unseal} from '../lib/email/crypto';
import {assertConnectionSession,personalConnectionActor} from './portable-connection-session';
import {portableDb} from './portable-db';
import {outlookAuthorization,OutlookAuthorizationError,outlookConfig,outlookMailbox,outlookTokens,type OutlookConfig} from './portable-outlook-provider';

const secretShape = z.object({accountId:z.string().min(1),refresh:z.string().min(1)});
function context(config:OutlookConfig,actor:ConnectionActor,provider:OutlookProvider,purpose:'attempt'|'grant',id:string) {
  const binding = ['harbor-outlook-v1',config.tenant,config.clientId,config.redirectUri,actor.userId,actor.email,provider,purpose,id];
  // The original Basic and Mail grants keep their binding. Full calendar reads require a fresh consent flow.
  if (config.scope==='Calendars.Read') binding.push(config.scope);
  return JSON.stringify(binding);
}

export async function startOutlook(actor:ConnectionActor,provider:OutlookProvider,config:OutlookConfig) {
  const state=randomSecret(), stateHash=await sha256(state), verifier=randomSecret();
  const saved=await saveConnectionAttempt(portableDb(),actor,{provider,stateHash,expiresAt:Date.now()+600_000,
    verifier:await seal(verifier,config.key,context(config,actor,provider,'attempt',stateHash))});
  if (!saved) throw new ApiError(401,'Sign in again to connect Outlook.');
  return outlookAuthorization(config,state,await sha256(verifier),actor.email);
}

export async function completeOutlook(request:Request,actor:ConnectionActor,provider:OutlookProvider,config:OutlookConfig,state:string,code:string|null) {
  const stateHash=await sha256(state);
  const attempt=await claimConnectionAttempt(portableDb(),actor,provider,stateHash);
  if (!attempt) throw new OutlookAuthorizationError('expired');
  if (!code) throw new OutlookAuthorizationError('denied');
  const verifier=await unseal(attempt,config.key,context(config,actor,provider,'attempt',stateHash));
  await assertConnectionSession(request,actor);
  const signal=AbortSignal.timeout(12_000);
  const {accessToken,refreshToken}=await outlookTokens(config,{code,verifier},signal);
  const mailbox=await outlookMailbox(config,accessToken,signal);
  if (mailbox.email!==actor.email.toLowerCase()) throw new OutlookAuthorizationError('wrong_account');
  const id=crypto.randomUUID();
  const sealed=await seal(JSON.stringify({accountId:mailbox.accountId,refresh:refreshToken}),config.key,context(config,actor,provider,'grant',id));
  if (!await saveConnectionGrant(portableDb(),actor,stateHash,{provider,id,refreshToken:sealed})) throw new OutlookAuthorizationError('expired');
}

export async function outlookAccess(request:Request,user:{userId:string;email:string},provider:OutlookProvider) {
  const config=outlookConfig(provider,user.email);
  if (!config) throw new ApiError(404,'Outlook connections are not configured.');
  const actor=await personalConnectionActor(request,user);
  const db=portableDb();
  const saved=await readConnectionGrant(db,actor,provider);
  if (!saved || saved.needsReconnect) throw new ApiError(409,'Connect or reconnect Outlook in Harbor settings.');
  const grant=saved;
  const changed=()=>new ApiError(409,'This Outlook connection changed. Refresh and try again.');
  const assertCurrent=async()=>{
    await assertConnectionSession(request,actor);
    const current=await readConnectionGrant(db,actor,provider);
    if (!current || current.id!==grant.id || current.needsReconnect) throw changed();
  };
  const reconnect=async():Promise<never>=>{
    await assertConnectionSession(request,actor);
    if (!await updateConnectionGrant(db,actor,grant,{needsReconnect:true})) throw changed();
    throw new ApiError(409,'Reconnect Outlook in Harbor settings.');
  };
  await assertCurrent();
  const binding=context(config,actor,provider,'grant',grant.id);
  let secret:z.infer<typeof secretShape>;
  try { secret=secretShape.parse(JSON.parse(await unseal(grant.refreshToken,config.key,binding))); }
  catch { return reconnect(); }
  try {
    const signal=AbortSignal.timeout(12_000);
    const tokens=await outlookTokens(config,{refresh:secret.refresh},signal);
    const mailbox=await outlookMailbox(config,tokens.accessToken,signal);
    if (mailbox.accountId!==secret.accountId || mailbox.email!==actor.email.toLowerCase()) return reconnect();
    if (tokens.refreshToken!==secret.refresh) {
      const refreshToken=await seal(JSON.stringify({...secret,refresh:tokens.refreshToken}),config.key,binding);
      // Microsoft can rotate on each refresh. The first concurrent refresh wins;
      // another read of the same active grant may still use its own access token.
      await updateConnectionGrant(db,actor,grant,{refreshToken});
    }
    await assertCurrent();
    return {accessToken:tokens.accessToken,accountId:mailbox.accountId,mailboxEmail:mailbox.email,grantId:grant.id,assertCurrent};
  } catch (error) {
    if (error instanceof OutlookAuthorizationError && (error.reason==='reconnect' || error.reason==='permissions')) return reconnect();
    if (error instanceof ApiError) throw error;
    throw new ApiError(503,'Outlook is temporarily unavailable. Try again shortly.');
  }
}
