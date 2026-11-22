import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';

type Credentials={HARBOR_BEEFREE_CLIENT_ID?:string;HARBOR_BEEFREE_CLIENT_SECRET?:string};
const unavailable=()=>new ApiError(502,'Beefree could not start an editor session. Check the Email Builder credentials and try again.');
export function beefreeConfigured(environment:Credentials){
  return Boolean(environment.HARBOR_BEEFREE_CLIENT_ID?.trim()&&environment.HARBOR_BEEFREE_CLIENT_SECRET?.trim());
}

export async function createBeefreeSession(workspaceId:string,environment:Credentials,send:typeof fetch=fetch){
  if(!beefreeConfigured(environment))throw new ApiError(409,'Configure the Beefree Email Builder credentials on the web service first.');
  const uid='harbor-'+workspaceId;
  let token:{access_token?:unknown;v2?:unknown};
  try{
    const response=await send('https://auth.getbee.io/loginV2',{
      method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10_000),
      headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({client_id:environment.HARBOR_BEEFREE_CLIENT_ID,client_secret:environment.HARBOR_BEEFREE_CLIENT_SECRET,uid}),
    });
    if(!response.ok)throw unavailable();
    const text=await readBoundedRequestText(response,32*1024);
    if(!text)throw unavailable();
    token=JSON.parse(text);
    if(!token||typeof token.access_token!=='string'||!token.access_token.trim()||token.v2!==true)throw unavailable();
    return {uid,token:{access_token:token.access_token,v2:true as const}};
  }catch{throw unavailable();}
}
