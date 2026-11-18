import {lstat,open,stat,unlink} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {authorizationURL,exchangeCode,GMAIL_SCOPES,mailboxEmail} from '../lib/email/gmail';
import {calendarAuthorization,calendarIdentity,calendarTokens,CALENDAR_AVAILABILITY_SCOPES,CALENDAR_OWNED_SCOPE} from '../lib/calendar/google';
import {suppressedAddress} from '../lib/email/suppression';
import {GoogleConnectionError} from '../lib/google-oauth-result';
import {authorizePortableGoogleGrant,googleGrantCallbackUrl,GoogleGrantLoopbackError} from './portable-google-grant-loopback';

export class GoogleGrantPreparationError extends Error {}

const otherClientSettings=['HARBOR_LOGIN_GOOGLE_CLIENT_ID','HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID',
  'HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID','HARBOR_PORTABLE_INBOX_CLIENT_ID'];
const calendarWriteScopes=[...CALENDAR_AVAILABILITY_SCOPES,CALENDAR_OWNED_SCOPE];

async function validateDestination(path:string){
  if(!isAbsolute(path))throw new GoogleGrantPreparationError('Choose an absolute path for a new grant file.');
  const parent=await stat(dirname(path)).catch(()=>null);
  if(!parent?.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0){
    throw new GoogleGrantPreparationError('Use an existing directory you own with owner-only permissions.');
  }
  const existing=await lstat(path).catch(error=>{
    if(error.code==='ENOENT')return null;
    throw new GoogleGrantPreparationError('Could not check the grant file path.');
  });
  if(existing)throw new GoogleGrantPreparationError('Choose a new grant file path. The existing file was preserved.');
}

async function saveGrant(path:string,setting:string,token:string){
  // A one-line env file must preserve the exact value and cannot contain extra assignments.
  if(!/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(token)){
    throw new GoogleGrantPreparationError('Google returned a refresh token that could not be saved safely.');
  }
  const file=await open(path,'wx',0o600).catch(()=>{
    throw new GoogleGrantPreparationError('Could not create the private grant file. Use a new path.');
  });
  try{
    await file.writeFile(`${setting}=${token}\n`);
    await file.close();
  }catch{
    await file.close().catch(()=>{});
    await unlink(path).catch(()=>{});
    throw new GoogleGrantPreparationError('Could not save the private grant file. Check its directory.');
  }
}

export async function preparePortableGoogleGrant(provider:'gmail'|'calendar',path:string){
  const prefix=provider==='gmail'?'HARBOR_PORTABLE_GMAIL':'HARBOR_PORTABLE_CALENDAR';
  const other=provider==='gmail'?'HARBOR_PORTABLE_CALENDAR_CLIENT_ID':'HARBOR_PORTABLE_GMAIL_CLIENT_ID';
  const owner=suppressedAddress.safeParse(process.env[prefix+'_OWNER']);
  const clientId=process.env[prefix+'_CLIENT_ID'],clientSecret=process.env[prefix+'_CLIENT_SECRET'];
  if(!owner.success||!clientId||!clientSecret){
    throw new GoogleGrantPreparationError(`Set ${prefix}_OWNER, ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET for this command.`);
  }
  if([...otherClientSettings,other].some(setting=>process.env[setting]===clientId)){
    throw new GoogleGrantPreparationError('Use a dedicated OAuth client for this grant.');
  }
  await validateDestination(path);
  const config={clientId,clientSecret,redirectUri:googleGrantCallbackUrl};
  const authorize=(state:string,challenge:string)=>provider==='gmail'
    ?authorizationURL(config,state,challenge,GMAIL_SCOPES)
    :calendarAuthorization(config,state,challenge,calendarWriteScopes);
  try{
    await authorizePortableGoogleGrant({authorize,async exchange(code,verifier){
      const tokens=provider==='gmail'?await exchangeCode(config,code,verifier):
        await calendarTokens(config,{code,verifier},calendarWriteScopes);
      const account=provider==='gmail'?await mailboxEmail(tokens.accessToken):(await calendarIdentity(tokens.accessToken)).email;
      if(account.toLowerCase()!==owner.data){
        throw new GoogleGrantPreparationError('Google returned a different account. Start again with the configured owner.');
      }
      await saveGrant(path,prefix+'_REFRESH_TOKEN',tokens.refreshToken);
    }});
  }catch(error){
    if(error instanceof GoogleGrantPreparationError)throw error;
    if(error instanceof GoogleGrantLoopbackError)throw new GoogleGrantPreparationError(error.message);
    if(error instanceof GoogleConnectionError&&error.reason==='permissions'){
      throw new GoogleGrantPreparationError('Google did not return all requested permissions and offline access. Start again.');
    }
    throw new GoogleGrantPreparationError('Google could not complete or verify the grant. Check the client setup and try again.');
  }
}
