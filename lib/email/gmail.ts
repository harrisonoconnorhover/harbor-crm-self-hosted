import {GoogleConnectionError} from '../google-oauth-result';
import {googleRefreshFailure,readGoogleResponseJSON} from '../google-oauth-response';
import {receivedFileBytes} from './received-files';
import {MAX_ATTACHMENT_BYTES} from '../activity-attachments';
import {z} from 'zod';
import {gmailAttachmentStream,gmailThreadUpload} from './attachment-mime';
import type {EmailAttachmentData} from './attachments';
import {emailAddress,gmailRaw,emailThreadContext,type EmailThreadContext,type EmailContent} from './message';
export const GMAIL_READ_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPES=[GMAIL_READ_SCOPE,'https://www.googleapis.com/auth/gmail.send'];
export type GmailConfig={clientId:string;clientSecret:string;redirectUri:string};
export type GmailTokens={accessToken:string;refreshToken:string;expiresAt:number};
export class GmailError extends Error{code:'reauth'|'rejected'|'unavailable'|'unknown';constructor(code:GmailError['code'],message:string){super(message);this.code=code;}}
const tokenResult=z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),expires_in:z.number().positive(),scope:z.string().optional(),token_type:z.string()});
async function call(url:string,init:RequestInit,fetcher:typeof fetch,send=false,timeout=15000,maxBytes=256000){
 const signal=init.signal??AbortSignal.timeout(timeout);
 let r:Response;
 try{
  signal.throwIfAborted();
  r=await fetcher(url,{...init,redirect:'manual',signal});
 }catch{throw new GmailError(send?'unknown':'unavailable',send?'The send outcome is unknown. Check Gmail before sending another copy.':'Gmail is temporarily unavailable.');}
 if(!r.ok){
  const refresh=await googleRefreshFailure(init,r,'Gmail');
  if(refresh)throw new GmailError(refresh.code,refresh.message);
  await r.body?.cancel();
  if(r.status===401)throw new GmailError('reauth','Reconnect Gmail to continue.');
  if(r.status===429)throw new GmailError(send?'rejected':'unavailable','Gmail rate limit reached. Try again later.');
  if(r.status>=500)throw new GmailError(send?'unknown':'unavailable',send?'Gmail did not confirm the send outcome. Check before retrying.':'Gmail is temporarily unavailable.');
  throw new GmailError('rejected','Gmail rejected this request. Review the connection and message.');
 }
 try{return await readGoogleResponseJSON(r,maxBytes);}catch{throw new GmailError(send?'unknown':'unavailable','Gmail returned an unreadable response.');}}
export function authorizationURL(config:GmailConfig,state:string,challenge:string,scopes:readonly string[]=GMAIL_SCOPES){const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();return u.toString();}
export async function exchangeCode(config:GmailConfig,code:string,verifier:string,fetcher:typeof fetch=fetch,requiredScopes:readonly string[]=GMAIL_SCOPES):Promise<GmailTokens>{const raw=await call('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectUri,code,code_verifier:verifier,grant_type:'authorization_code'})},fetcher);const t=tokenResult.parse(raw);if(t.token_type.toLowerCase()!=='bearer'||!t.refresh_token||!requiredScopes.every(s=>t.scope?.split(/\s+/).includes(s)))throw new GoogleConnectionError('permissions','Gmail read and send permission with offline access is required. Connect again.');return {accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+t.expires_in*1000};}
export async function refreshTokens(config:GmailConfig,refreshToken:string,fetcher:typeof fetch=fetch,requiredScopes:readonly string[]=[]):Promise<GmailTokens>{
 const raw=await call('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'})},fetcher);
 const t=tokenResult.parse(raw),granted=t.scope?.split(/\s+/);
 if(t.token_type.toLowerCase()!=='bearer')throw new GmailError('reauth','Reconnect Gmail to continue.');
 if(granted&&!requiredScopes.every(scope=>granted.includes(scope)))
  throw new GmailError('reauth','Reconnect Gmail and grant both read and send permissions.');
 return {accessToken:t.access_token,refreshToken:t.refresh_token||refreshToken,expiresAt:Date.now()+t.expires_in*1000};
}
const auth=(token:string)=>({authorization:'Bearer '+token});
export async function mailboxEmail(token:string,fetcher:typeof fetch=fetch){const data=await call('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',{headers:auth(token)},fetcher);return z.object({emailAddress}).parse(data).emailAddress;}
export async function sendGmail(token:string,content:EmailContent,sender:string,messageId:string,at:string,fetcher:typeof fetch=fetch,files:EmailAttachmentData[]=[],thread?:EmailThreadContext|null){
 const context=thread?emailThreadContext.parse(thread):null;let result:unknown;
 if(files.length){const mime=gmailAttachmentStream(content,sender,messageId,at,files,context),upload=context?gmailThreadUpload(mime,context.threadId):{contentType:'message/rfc822',body:mime};result=await call('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType='+(context?'multipart':'media')+'&fields=id,threadId',{method:'POST',headers:{...auth(token),'content-type':upload.contentType},body:upload.body},fetcher,true,60000);}
 else result=await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send?fields=id,threadId',{method:'POST',headers:{...auth(token),'content-type':'application/json'},body:JSON.stringify({raw:gmailRaw(content,sender,messageId,at,false,context),...(context?{threadId:context.threadId}:{})})},fetcher,true);
 const parsed=z.object({id:z.string().min(1).max(200),threadId:z.string().max(200).optional()}).safeParse(result);if(!parsed.success)throw new GmailError('unknown','Gmail did not return a message ID. Check the send outcome before retrying.');return parsed.data;
}
export async function findSentGmail(token:string,messageId:string,fetcher:typeof fetch=fetch,
 sentTime?:string|{earliest:number;latest:number}){
 const index=z.object({messages:z.array(z.object({id:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/)})).max(25).default([]),nextPageToken:z.string().optional()});
 // Exact lookup and fallback metadata share one budget. An unfinished
 // fallback cannot establish whether a matching sent copy is unique.
 const request={headers:auth(token),signal:AbortSignal.timeout(15_000)};
 const list=async(query:string,limit:number)=>index.parse(await call('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+new URLSearchParams({q:query,maxResults:String(limit),fields:'messages/id,nextPageToken,resultSizeEstimate'}),request,fetcher));
 const result=await list('in:sent rfc822msgid:'+messageId,2);
 if(result.messages.length>1||result.nextPageToken)throw new GmailError('unknown','More than one sent copy was found. Review Gmail before continuing.');
 if(result.messages[0])return result.messages[0].id;
 // Consumer Gmail can replace Message-ID. Match our exact custom header in a bounded send-time window.
 const earliest=typeof sentTime==='string'?Date.parse(sentTime):sentTime?.earliest??NaN;
 const latest=typeof sentTime==='string'?earliest:sentTime?.latest??earliest;
 if(!Number.isFinite(earliest)||!Number.isFinite(latest)||latest<earliest)return null;
 const candidates=await list(`in:sent after:${Math.floor(earliest/1000)-300} before:${Math.floor(latest/1000)+300}`,25);
 if(candidates.nextPageToken)throw new GmailError('unknown','Too many sent messages to confirm this email safely. Check Gmail before starting another draft.');
 const matches:string[]=[];
 for(const candidate of candidates.messages){
  const query=new URLSearchParams({format:'metadata',metadataHeaders:'X-Harbor-Message-ID',fields:'id,labelIds,payload/headers'});
  const raw=await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(candidate.id)+'?'+query,request,fetcher);
  const m=z.object({id:z.string(),labelIds:z.array(z.string()).default([]),payload:z.object({headers:z.array(z.object({name:z.string(),value:z.string()})).default([])}).optional()}).parse(raw);
  if(m.id!==candidate.id)throw new GmailError('unavailable','Gmail returned a different message. Check again later.');
  const headers=m.payload?.headers.filter(h=>h.name.toLowerCase()==='x-harbor-message-id')||[];
  if(m.labelIds.includes('SENT')&&headers.length===1&&headers[0].value===messageId)matches.push(m.id);
 }
 if(matches.length>1)throw new GmailError('unknown','More than one sent copy was found. Review Gmail before continuing.');
 return matches[0]||null;
}
export async function revokeGmail(token:string,fetcher:typeof fetch=fetch){const r=await fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});await r.body?.cancel();return r.ok;}

const gmailId=z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const gmailMessageMetadata=z.object({id:gmailId,threadId:gmailId,internalDate:z.string().regex(/^\d{1,15}$/),labelIds:z.array(z.string().max(100)).max(100).default([])});
export type GmailMessageMetadata=z.infer<typeof gmailMessageMetadata>;
export async function gmailReceivedIndex(token:string,address:string,subject:string,pageToken?:string,fetcher:typeof fetch=fetch){
 const quote=(value:string)=>'"'+value.replace(/[\\"]/g,'\\$&')+'"';
 const q='from:'+quote(emailAddress.parse(address))+' -in:sent -in:drafts -in:spam -in:trash'+(subject?' subject:'+quote(subject):'');
 const query=new URLSearchParams({q,maxResults:'10',includeSpamTrash:'false',fields:'messages(id,threadId),nextPageToken,resultSizeEstimate',...(pageToken?{pageToken}:{})});
 const value=await call('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+query,{headers:auth(token)},fetcher);
 const parsed=z.object({messages:z.array(z.object({id:gmailId,threadId:gmailId})).max(10).default([]),nextPageToken:z.string().max(2000).optional()}).safeParse(value);
 if(!parsed.success)throw new GmailError('unavailable','Gmail returned an unreadable message page. Refresh and try again.');
 return parsed.data;
}
export async function gmailMessage(token:string,id:string,full=false,fetcher:typeof fetch=fetch):Promise<unknown>{
 const query=new URLSearchParams({format:full?'full':'metadata',fields:full?'id,threadId,internalDate,labelIds,payload':'id,threadId,internalDate,labelIds'});
 return call('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(gmailId.parse(id))+'?'+query,{headers:auth(token)},fetcher,false,15000,full?1048576:256000);
}
export async function gmailThreadIndex(token:string,id:string,fetcher:typeof fetch=fetch){
 const query=new URLSearchParams({format:'metadata',fields:'id,messages(id,threadId,internalDate,labelIds)'});
 const data=await call('https://gmail.googleapis.com/gmail/v1/users/me/threads/'+encodeURIComponent(gmailId.parse(id))+'?'+query,{headers:auth(token)},fetcher);
 const parsed=z.object({id:gmailId,messages:z.array(gmailMessageMetadata).max(1000)}).safeParse(data);
 if(!parsed.success||parsed.data.id!==id)throw new GmailError('unavailable','This Gmail thread could not be read within Harbor’s limits. Open it in Gmail.');
 return parsed.data.messages;
}

async function gmailHeaders(token:string,id:string,names:string[],fetcher:typeof fetch){
 const query=new URLSearchParams({format:'metadata',fields:'id,threadId,internalDate,labelIds,payload/headers'});
 for(const name of names)query.append('metadataHeaders',name);
 return call('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(gmailId.parse(id))+'?'+query,{headers:auth(token)},fetcher);
}

export function gmailReplyHeaders(token:string,id:string,fetcher:typeof fetch=fetch){
 return gmailHeaders(token,id,['From','Reply-To','To','Cc','Subject','Message-ID','References','In-Reply-To'],fetcher);
}

export function gmailReceivedHeaders(token:string,id:string,fetcher:typeof fetch=fetch){
 return gmailHeaders(token,id,['From','Subject'],fetcher);
}

export function gmailReceivedPreviewHeaders(token:string,id:string,fetcher:typeof fetch=fetch){
 return gmailHeaders(token,id,['From','Subject','To','Cc'],fetcher);
}

export async function gmailReceivedAttachment(token:string,messageId:string,attachmentId:string,size:number,fetcher:typeof fetch=fetch){
 if(size>MAX_ATTACHMENT_BYTES)throw new GmailError('rejected','Received files must be 10 MB or smaller.');
 const id=z.string().min(1).max(500).parse(attachmentId),raw=await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(gmailId.parse(messageId))+'/attachments/'+encodeURIComponent(id),{headers:auth(token)},fetcher,false,30000,Math.ceil(MAX_ATTACHMENT_BYTES/3)*4+4096);
 const result=z.object({size:z.number().int().nonnegative(),data:z.string()}).parse(raw);if(result.size!==size)throw new GmailError('unavailable','The received attachment size changed. Refresh and try again.');return receivedFileBytes(result.data,size);
}
