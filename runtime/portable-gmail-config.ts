import {suppressedAddress} from '../lib/email/suppression';
import {GmailError,mailboxEmail,refreshTokens,type GmailConfig} from '../lib/email/gmail';

export function portableGmailOwner(){
  if(process.env.HARBOR_PORTABLE_GMAIL_ENABLED!=='true')return undefined;
  const owner=suppressedAddress.safeParse(process.env.HARBOR_PORTABLE_GMAIL_OWNER);
  return owner.success?owner.data:undefined;
}

export function portableWorkflowGmailOwner(){
  return process.env.HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED==='true'?portableGmailOwner():undefined;
}

export function portableGmailConfig(){
  const owner=portableGmailOwner();
  const {HARBOR_PORTABLE_GMAIL_CLIENT_ID:clientId,HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:clientSecret,
    HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:refreshToken,HARBOR_LOGIN_ORIGIN:origin}=process.env;
  if(!owner||!clientId||!clientSecret||!refreshToken||!origin)return undefined;
  let url:URL;
  try{url=new URL(origin);}catch{return undefined;}
  if(url.origin!==origin||url.protocol!=='https:'&&
     !(process.env.HARBOR_PORTABLE_MODE!=='hosted'&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))return undefined;
  return {owner,clientId,clientSecret,refreshToken,origin,redirectUri:''};
}

export async function portableGmailAccessToken(config:GmailConfig&{owner:string;refreshToken:string},requiredScopes?:readonly string[]){
  const tokens=await refreshTokens(config,config.refreshToken,fetch,requiredScopes);
  const sender=suppressedAddress.parse(await mailboxEmail(tokens.accessToken));
  if(sender!==config.owner)throw new GmailError('reauth','The configured mailbox does not match the owner.');
  return tokens.accessToken;
}
