import {suppressedAddress} from '../lib/email/suppression';

// Inbox credentials belong to the web process, independently of scheduled Gmail.
export function portableGmailInboxConfig(){
  if(process.env.HARBOR_PORTABLE_INBOX_ENABLED!=='true')return undefined;
  const mode=process.env.HARBOR_PORTABLE_MODE;
  const {HARBOR_PORTABLE_INBOX_CLIENT_ID:clientId,HARBOR_PORTABLE_INBOX_CLIENT_SECRET:clientSecret,
    HARBOR_PORTABLE_INBOX_REFRESH_TOKEN:refreshToken,HARBOR_LOGIN_ORIGIN:origin}=process.env;
  const owner=suppressedAddress.safeParse(process.env.HARBOR_PORTABLE_INBOX_OWNER);
  const address=origin?URL.parse(origin):null;
  if(!owner.success||!clientId||!clientSecret||!refreshToken||!address||
     address.origin!==origin)return undefined;
  const local=mode==='local'&&address.protocol==='http:'&&address.hostname==='127.0.0.1';
  const hosted=mode==='hosted'&&address.protocol==='https:'&&process.env.HARBOR_PORTABLE_HOSTED_INBOX_ENABLED==='true';
  if(!local&&!hosted)return undefined;
  return {owner:owner.data,clientId,clientSecret,refreshToken,redirectUri:''};
}

export function portableGmailInboxOwner(){return portableGmailInboxConfig()?.owner;}
