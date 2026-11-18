import {z} from 'zod';
import type {OutlookProvider} from '../db/postgres/portable-google-schema';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {loginOrigin,parseAllowedEmails} from '../lib/identity';
import {ApiError} from '../lib/api-error';

const tenantId = z.string().regex(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
const graphOrigin = 'https://graph.microsoft.com';
export type OutlookConfig = {
  tenant:string; clientId:string; clientSecret:string; key:string; redirectUri:string;
  scope:'Mail.Read'|'Calendars.ReadBasic'|'Calendars.Read'; fullCalendar:boolean;
};

export function outlookConfig(provider:OutlookProvider, email?:string):OutlookConfig|undefined {
  const settings = process.env;
  if (settings.HARBOR_PORTABLE_OUTLOOK_ENABLED !== 'true') return;
  const {HARBOR_OUTLOOK_TENANT_ID:tenant, HARBOR_OUTLOOK_CLIENT_ID:clientId,
    HARBOR_OUTLOOK_CLIENT_SECRET:clientSecret, HARBOR_OUTLOOK_KEY:key} = settings;
  if (!tenantId.safeParse(tenant).success || !tenant || !clientId || !clientSecret || !key ||
      /\s/.test(clientId + clientSecret) || !tenantId.safeParse(clientId).success ||
      clientId.toLowerCase() === settings.HARBOR_LOGIN_MICROSOFT_CLIENT_ID?.toLowerCase()) return;
  try {
    if (Buffer.from(key,'base64url').length !== 32 || !/^[A-Za-z0-9+/_-]{43}=?$/.test(key)) return;
    const origin = loginOrigin({HARBOR_LOGIN_ORIGIN:settings.HARBOR_LOGIN_ORIGIN});
    if (origin.origin !== settings.HARBOR_LOGIN_ORIGIN ||
        !(settings.HARBOR_PORTABLE_MODE === 'hosted' && origin.protocol === 'https:' ||
          settings.HARBOR_PORTABLE_MODE === 'local' && origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) return;
    const calendar = provider === 'outlook-calendar';
    const optedIn = settings.HARBOR_OUTLOOK_CALENDAR_READ_EMAILS?.trim();
    const fullCalendar = Boolean(optedIn && parseAllowedEmails(optedIn).includes(email?.toLowerCase()??''));
    const scope = calendar ? (fullCalendar?'Calendars.Read':'Calendars.ReadBasic') : 'Mail.Read';
    return {tenant:tenant.toLowerCase(),clientId,clientSecret,key,scope,fullCalendar,
      redirectUri:origin.origin+'/api/outlook/'+(calendar?'calendar':'mail')+'/callback'};
  } catch { return; }
}

export class OutlookAuthorizationError extends Error {
  constructor(readonly reason:'permissions'|'reconnect'|'denied'|'expired'|'wrong_account'|'failed'){
    super('Microsoft connection '+reason.replace('_',' '));
  }
}

function authEndpoint(config:OutlookConfig, action:'authorize'|'token') {
  const authority=config.tenant==='9188040d-6c67-4c5b-b112-36a304b66dad'?'consumers':config.tenant;
  return new URL('https://login.microsoftonline.com/'+authority+'/oauth2/v2.0/'+action);
}

function scopes(config:OutlookConfig) {
  return ['offline_access',graphOrigin+'/User.Read',graphOrigin+'/'+config.scope].join(' ');
}

export function outlookAuthorization(config:OutlookConfig, state:string, challenge:string, email:string) {
  const url = authEndpoint(config,'authorize');
  url.search = new URLSearchParams({client_id:config.clientId,response_type:'code',response_mode:'query',
    redirect_uri:config.redirectUri,scope:scopes(config),state,code_challenge:challenge,
    code_challenge_method:'S256',login_hint:email}).toString();
  return url.href;
}

const tokenString = z.string().min(1).max(32768);
const tokenResponse = z.object({token_type:z.literal('Bearer'),access_token:tokenString,
  refresh_token:tokenString.optional(),scope:z.string().max(8192)});
export async function outlookTokens(config:OutlookConfig, grant:{code:string; verifier:string}|{refresh:string}, signal:AbortSignal) {
  const body = new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,scope:scopes(config)});
  if ('code' in grant) {
    body.set('grant_type','authorization_code');
    body.set('code',grant.code);
    body.set('code_verifier',grant.verifier);
    body.set('redirect_uri',config.redirectUri);
  } else {
    body.set('grant_type','refresh_token');
    body.set('refresh_token',grant.refresh);
  }
  const response = await fetch(authEndpoint(config,'token'),{method:'POST',body,signal,redirect:'error',cache:'no-store'});
  const data:unknown = JSON.parse(await readBoundedRequestText(response,131072) || 'null');
  if (!response.ok) {
    if (z.object({error:z.enum(['invalid_grant','interaction_required','consent_required'])}).safeParse(data).success)
      throw new OutlookAuthorizationError('reconnect');
    throw new OutlookAuthorizationError('failed');
  }
  const result = tokenResponse.safeParse(data);
  if (!result.success) throw new OutlookAuthorizationError('failed');
  const granted = new Set(result.data.scope.trim().toLowerCase().split(/\s+/).map(s=>s.replace('https://graph.microsoft.com/','')));
  // Microsoft may return already-consented read scopes for this registration.
  const allowed = new Set(['openid','profile','email','offline_access','user.read','mail.read','calendars.readbasic']);
  if (config.fullCalendar) allowed.add('calendars.read');
  if (!granted.has('user.read') || !granted.has(config.scope.toLowerCase()) || [...granted].some(scope=>!allowed.has(scope)))
    throw new OutlookAuthorizationError('permissions');
  const refreshToken = result.data.refresh_token ?? ('refresh' in grant ? grant.refresh : undefined);
  if (!refreshToken) throw new OutlookAuthorizationError('permissions');
  return {accessToken:result.data.access_token,refreshToken};
}

const profile = z.object({id:z.string().min(1).max(256),mail:z.string().nullish(),userPrincipalName:z.string().nullish()});
export async function outlookMailbox(config:OutlookConfig, token:string, signal:AbortSignal) {
  const url = new URL('/v1.0/me',graphOrigin);
  url.searchParams.set('$select','id,mail,userPrincipalName');
  const response = await fetch(url,{headers:{authorization:'Bearer '+token},signal,redirect:'error',cache:'no-store'});
  if (response.status===401 || response.status===403) throw new OutlookAuthorizationError('reconnect');
  if (!response.ok) throw new OutlookAuthorizationError('failed');
  const result = profile.safeParse(JSON.parse(await readBoundedRequestText(response,8192) || 'null'));
  if (!result.success) throw new OutlookAuthorizationError('failed');
  return {accountId:config.tenant+':'+result.data.id,email:(result.data.mail || result.data.userPrincipalName || '').toLowerCase()};
}

const resourcePage = z.object({value:z.array(z.object({id:z.string().min(1).max(2048)})).max(1)});

export async function checkOutlookResource(provider:OutlookProvider, accessToken:string, signal:AbortSignal) {
  const calendar = provider === 'outlook-calendar';
  const resource = calendar ? 'Calendar' : 'Inbox';
  const url = new URL(calendar?'/v1.0/me/calendar/calendarView':'/v1.0/me/mailFolders/inbox/messages',graphOrigin);
  url.searchParams.set('$select','id');
  url.searchParams.set('$top','1');
  if (calendar) {
    const now = Date.now();
    url.searchParams.set('startDateTime',new Date(now).toISOString());
    url.searchParams.set('endDateTime',new Date(now+60_000).toISOString());
  }
  const result = await fetch(url,{method:'GET',headers:{authorization:'Bearer '+accessToken},signal,redirect:'error',cache:'no-store'});
  if (!result.ok) {
    void result.body?.cancel().catch(()=>{});
    if (result.status===401 || result.status===403) {
      throw new ApiError(409,'Microsoft recognized your account but denied access to your Outlook '+resource+
        '. Ask your administrator to check this app’s delegated '+(calendar?'calendar':'mail')+' permission.');
    }
    if (result.status===429) throw new ApiError(429,'Outlook is busy. Try checking again in a moment.');
    throw new ApiError(503,'Microsoft could not check your Outlook '+resource+'. Try again.');
  }
  const raw = await readBoundedRequestText(result,16_384);
  if (!raw || !resourcePage.safeParse(JSON.parse(raw)).success) {
    throw new ApiError(503,'Microsoft returned an unreadable response for your Outlook '+resource+'. Try again.');
  }
}
