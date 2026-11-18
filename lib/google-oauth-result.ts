// Only these fixed reasons may cross the OAuth callback boundary. Never expose
// provider response text, authorization codes, tokens, or arbitrary error messages.
export type GoogleConnectionReason='expired'|'permissions'|'denied'|'setup'|'provider_rejected'|'provider_unavailable'|'failed';
export class GoogleConnectionError extends Error {
 constructor(public reason:GoogleConnectionReason,message:string){super(message);}
}
export function googleConnectionNotice(provider:'Gmail'|'Google Calendar',outcome:string|null,reason:string|null){
 if(!outcome)return '';
 if(outcome==='connected')return `${provider} connected.`;
 switch(reason){
  case 'expired':return 'This connection attempt expired or was already used. Start a new connection and complete the Google screens within ten minutes.';
  case 'permissions':return provider==='Gmail'
   ?'Google did not grant all required access. Connect again and select both Gmail read and send permissions. Harbor also needs offline access to keep the connection working.'
   :'Google did not grant all required access. Connect again and select calendar events, availability and account email permissions. Harbor also needs offline access to keep the connection working.';
  case 'denied':return 'Google did not authorize access. Start a new connection with an approved account and review the requested permissions. While the app is in testing, that account must be on its test-user list.';
  case 'setup':return 'The Google connection setup is incomplete or its callback address does not match Harbor. Ask the administrator to check the OAuth client and server configuration.';
  case 'provider_rejected':return 'Google rejected the connection request. Start a new connection. If it fails again, ask the administrator to check the OAuth client, enabled API and test-user access.';
  case 'provider_unavailable':return 'Google could not complete the connection right now. Wait a moment, then start a new connection.';
  default:return `${provider} connection was not completed. Start a new connection. If it fails again, ask the administrator to investigate.`;
 }
}
