import type {PortableGoogleProvider} from '../db/postgres/portable-google-schema';
import {googleConnectionSetup} from '../lib/google-connection-setup';
import {portableCalendarConfig} from './portable-calendar-config';
import {portableGmailInboxOwner} from './portable-gmail-inbox-config';

type PersonalGoogleIssue='origin'|'credentials'|'shared_client'|'key'|'callback';
export type PortablePersonalGoogleReadiness={provider:PortableGoogleProvider;status:'ready'|'legacy'|PersonalGoogleIssue};

export const portablePersonalGoogleCallbackPath=(provider:PortableGoogleProvider)=>'/api/google/'+provider+'/callback';

function personalGoogleClient(provider:PortableGoogleProvider){
  const prefix='HARBOR_PORTABLE_PERSONAL_'+provider.toUpperCase();
  return {clientId:process.env[prefix+'_CLIENT_ID'],clientSecret:process.env[prefix+'_CLIENT_SECRET']};
}

// Server-only: the config result carries secrets. Readiness exposes only a fixed status code.
function personalGoogleCheck(provider:PortableGoogleProvider){
  const origin=process.env.HARBOR_LOGIN_ORIGIN;
  const address=origin?URL.parse(origin):null;
  if(!origin||!address||address.origin!==origin||
    !(address.protocol==='https:'&&process.env.HARBOR_PORTABLE_MODE==='hosted'||
      address.protocol==='http:'&&address.hostname==='127.0.0.1'&&process.env.HARBOR_PORTABLE_MODE==='local'))return {issue:'origin'} as const;
  const {clientId,clientSecret}=personalGoogleClient(provider);
  const other=provider==='gmail'?'CALENDAR':'GMAIL';
  if(!clientId||!clientSecret)return {issue:'credentials'} as const;
  if(clientId===process.env.HARBOR_LOGIN_GOOGLE_CLIENT_ID||
    clientId===process.env['HARBOR_PORTABLE_PERSONAL_'+other+'_CLIENT_ID']||
    clientId===process.env.HARBOR_PORTABLE_GMAIL_CLIENT_ID||clientId===process.env.HARBOR_PORTABLE_INBOX_CLIENT_ID||
    clientId===process.env.HARBOR_PORTABLE_CALENDAR_CLIENT_ID)return {issue:'shared_client'} as const;
  const key=process.env.HARBOR_PORTABLE_PERSONAL_GOOGLE_KEY;
  if(!key)return {issue:'key'} as const;
  const path=portablePersonalGoogleCallbackPath(provider),redirectUri=origin+path;
  const setup=googleConnectionSetup({clientId,clientSecret,redirectUri,key},path,origin);
  if(!setup.configured)return {issue:setup.checks.encryption==='ready'?'callback':'key'} as const;
  return {config:{clientId,clientSecret,redirectUri,key}};
}

export function portablePersonalGoogleConfig(provider:PortableGoogleProvider){
  if(process.env.HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED!=='true')return;
  const check=personalGoogleCheck(provider);
  return 'config' in check?check.config:undefined;
}

export function portablePersonalGoogleDeploymentReadiness(){
  if(process.env.HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED!=='true')return;
  const status=(provider:PortableGoogleProvider)=>{
    const {clientId,clientSecret}=personalGoogleClient(provider);
    if(!clientId&&!clientSecret)return 'disabled';
    const check=personalGoogleCheck(provider);
    return 'config' in check?'ok':check.issue;
  };
  return {gmail:status('gmail'),calendar:status('calendar')};
}

// Mirrors the web screens: a deployment connection owned by this user takes precedence over personal consent.
export function portablePersonalGoogleReadiness(email:string):PortablePersonalGoogleReadiness[]|undefined{
  if(process.env.HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED!=='true')return;
  const owner=email.toLowerCase();
  const legacy={gmail:portableGmailInboxOwner()===owner,calendar:portableCalendarConfig()?.owner===owner};
  return (['gmail','calendar'] as const).map(provider=>{
    if(legacy[provider])return {provider,status:'legacy'};
    const check=personalGoogleCheck(provider);
    return {provider,status:'config' in check?'ready':check.issue};
  });
}
