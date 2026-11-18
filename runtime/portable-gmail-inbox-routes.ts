import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {readContacts} from '../db/postgres/contact-store';
import {loggedPortableGmailIds,logPortableGmail} from '../db/postgres/portable-gmail-log-store';
import {portableNeverLogExclusion} from '../db/postgres/portable-never-log-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {GMAIL_READ_SCOPE,GmailError,gmailMessage,gmailMessageMetadata,gmailReceivedHeaders,gmailReceivedIndex,gmailReceivedPreviewHeaders,mailboxEmail,refreshTokens} from '../lib/email/gmail';
import {sha256} from '../lib/email/crypto';
import {cookieName,loginConfig,readCookie} from '../lib/identity';
import {gmailInboxURL} from '../lib/email/inbox';
import {emailAddress} from '../lib/email/message';
import {portableGmailSummaryLimit as textLimit} from '../lib/portable-contact-activities';
import {decodedHeader,headersSchema,readGmailBody,receivedTime,replySenderAddress} from '../lib/email/replies';
import {replyAddresses} from '../lib/email/thread-reply';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {requestIdentity} from './portable-identity';
import {portableGmailAccessToken} from './portable-gmail-config';
import {readGoogleGrant} from '../db/postgres/portable-google-store';
import {boundedGmailRead,personalGoogleAccess,personalGoogleActor} from './portable-google-connections';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {ApiError} from '../lib/api-error';
import {portableGmailInboxConfig} from './portable-gmail-inbox-config';

const signature=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const cursor=z.object({token:z.string().min(1).max(2000),proof:signature}).strict();
const selection=z.object({id:gmailMessageMetadata.shape.id,threadId:gmailMessageMetadata.shape.threadId,
  receivedAt:z.string().length(24).datetime(),proof:signature}).strict();
const recordIdInput=z.string().guid("Invalid uuid");
const query=z.union([
  z.object({recordId:recordIdInput,subject:z.string().trim().max(100)
    .refine(value=>!/[\x00-\x1f\x7f]/.test(value)).default(''),after:cursor.optional()}).strict(),
  z.object({recordId:recordIdInput,preview:selection}).strict(),
]);
const connectionCheck=z.object({action:z.literal('check_connection')}).strict();
const logRequest=z.object({recordId:recordIdInput,selection}).strict();
const headerPayload=z.object({payload:z.object({headers:headersSchema.default([])})});
const excludedLabels=new Set(['SENT','DRAFT','SPAM','TRASH']);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const expiredSession=()=>json({error:'Sign in again to read this mailbox.'},401);
const blocked=()=>json({items:[],next:null,unavailable:0,blocked:true});
const matchingProof=(actual:string,expected:string)=>timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
const staleSelection=()=>json({error:'This received email changed. Start a new search.'},409);
const blockedParticipant=()=>json({code:'never_log',error:'A Never Log rule excludes this message from preview.'},409);
const mailboxAuthorization=(error:string)=>json({code:'mailbox_authorization',error},409);

function messageSummary(raw:unknown,item:{id:string;threadId:string},address:string,owner:string){
  const metadata=gmailMessageMetadata.parse(raw);
  if(metadata.id!==item.id||metadata.threadId!==item.threadId||metadata.labelIds.some(label=>excludedLabels.has(label))||
     replySenderAddress(raw).toLowerCase()!==address)return null;
  const {headers}=headerPayload.parse(raw).payload;
  const subjects=headers.filter(header=>header.name.toLowerCase()==='subject');
  if(subjects.length>1)return null;
  const sender=decodedHeader(headers.find(header=>header.name.toLowerCase()==='from')!.value).slice(0,500);
  const subject=decodedHeader(subjects[0]?.value??'').slice(0,500)||'(No subject)';
  return {id:metadata.id,sender,subject,receivedAt:receivedTime(metadata),url:gmailInboxURL(owner,metadata.id)};
}

function verifiedMessage(raw:unknown,item:z.infer<typeof selection>,address:string,owner:string){
  try{
    const summary=messageSummary(raw,item,address,owner);
    if(!summary||summary.receivedAt!==item.receivedAt)return null;
    const {headers}=headerPayload.parse(raw).payload;
    const participants:string[]=[];
    for(const field of ['to','cc']){
      const values=headers.filter(header=>header.name.toLowerCase()===field);
      if(values.length>1)return null;
      participants.push(...replyAddresses(values[0]?.value??''));
    }
    return {summary,participants:participants.map(value=>value.toLowerCase()).filter(value=>value!==owner)};
  }catch{return null;}
}

const boundedText=(text:string)=>text.slice(0,textLimit).replace(/[\uD800-\uDBFF]$/,'');
function logResponse(result:Awaited<ReturnType<typeof logPortableGmail>>){
  switch(result.state){
    case 'new':return undefined;
    case 'unauthorized':return expiredSession();
    case 'logged':return json({logged:true,activityId:result.activityId,alreadyLogged:result.alreadyLogged});
    case 'sender':return blocked();
    case 'participant':return blockedParticipant();
    case 'conflict':return json({error:'This message was already logged from a different Contact or selection.'},409);
    case 'future':return json({error:'Gmail returned a future received date. Try again later.'},409);
    case 'changed':return staleSelection();
    case 'connection':return mailboxAuthorization('Your Gmail connection changed. Start a new search after reconnecting.');
  }
}

async function route(request:Request){
  try{
    const writing=request.method==='PUT';
    const user=await portableApiIdentity(request,writing?'api_write':'api_read');
    if(user instanceof Response)return user;
    const addressOfOwner=user.email.toLowerCase();
    const configuredInbox=portableGmailInboxConfig();
    const config=configuredInbox?.owner===addressOfOwner?configuredInbox:undefined;
    const personalConfig=config?undefined:portablePersonalGoogleConfig('gmail');
    if(!config&&!personalConfig)return configuredInbox?
      json({error:'Only the configured private mailbox owner can search received email.'},403):json({error:'Inbox lookup is unavailable.'},404);
    if(user.guest)return json({error:'Open your own mailbox to search received email.'},403);
    const actor=personalConfig?await personalGoogleActor(request,user):null;
    const grant=actor?await readGoogleGrant(portableDb(),actor,'gmail'):null;
    if(personalConfig&&(!grant||grant.needsReconnect))return mailboxAuthorization(grant?.needsReconnect
      ?'Reconnect your Gmail account in Email settings.':'Connect your Gmail account in Email settings.');
    let personalConnection:Awaited<ReturnType<typeof personalGoogleAccess>>|undefined;
    const sessionToken=readCookie(request.headers,cookieName('session',loginConfig(env).secure));
    if(!sessionToken)return expiredSession();
    const sessionHash=await sha256(sessionToken);
    const sessionActive=async()=>{
      const current=await requestIdentity(request.headers);
      if(current?.userId!==user.userId||current.email!==user.email)return false;
      await personalConnection?.assertCurrent();
      return true;
    };

    if(new URL(request.url).search)return json({error:'Invalid inbox request.'},400);
    const raw=await readBoundedRequestText(request,16_000);
    if(raw===null)return json({error:'Inbox request is too large.'},413);
    let body:unknown;
    try{body=JSON.parse(raw);}catch{return json({error:'Check the inbox search details.'},400);}
    if(!writing&&connectionCheck.safeParse(body).success){
      if(!await sessionActive())return expiredSession();
      if(personalConfig&&actor&&grant){
        personalConnection=await personalGoogleAccess(request,actor,'gmail',personalConfig,{expectedId:grant.id});
      }else if(config)await portableGmailAccessToken(config,[GMAIL_READ_SCOPE]);
      if(!await sessionActive())return expiredSession();
      return json({connection:'ok'});
    }
    const input=(writing?logRequest:query).safeParse(body);
    if(!input.success)return json({error:'Check the inbox search details.'},400);
    const {recordId}=input.data;
    const chosen='selection' in input.data?input.data.selection:'preview' in input.data?input.data.preview:null;
    const {subject,after}='subject' in input.data?input.data:{subject:'',after:undefined};
    const db=portableDb();
    const readContact=()=>readContacts(db,user.userId,{id:recordId,limit:1});
    const record=await readContact();
    if(!record||!('id' in record))return json({error:'Contact not found in your workspace.'},404);
    const email=record.data.email??'';
    const contactAddress=emailAddress.safeParse(email);
    if(!contactAddress.success)return json({error:'Add a valid Contact email before searching.'},400);
    const address=contactAddress.data.toLowerCase();
    if(address===addressOfOwner)return json({error:'Choose a Contact with a different email from the mailbox.'},400);

    const proof=(purpose:string,...values:string[])=>createHmac('sha256',config?.clientSecret??personalConfig!.key).update(JSON.stringify([
      purpose,user.userId,sessionHash,addressOfOwner,grant?.id??null,record.id,record.createdAt,record.revision,address,...values,
    ])).digest('base64url');
    const pageProof=(token:string)=>proof('harbor-portable-inbox-v1',subject,token);
    const previewProof=(id:string,threadId:string,receivedAt:string)=>proof('harbor-portable-inbox-preview-v1',id,threadId,receivedAt);
    if(chosen&&!matchingProof(chosen.proof,previewProof(chosen.id,chosen.threadId,chosen.receivedAt)))return staleSelection();
    if(after&&!matchingProof(after.proof,pageProof(after.token))){
      return json({error:'The Contact or search changed. Start from the first page.'},409);
    }
    const checkRules=async(participants:string[]=[])=>{
      const rule=await portableNeverLogExclusion(db,user.userId,address,participants);
      if(rule==='sender')return blocked();
      if(rule==='participant')return blockedParticipant();
    };
    const saveLog=chosen&&writing?(participants:string[],summary?:string)=>logPortableGmail(db,user.userId,addressOfOwner,
      {id:record.id,createdAt:record.createdAt,revision:record.revision,email},
      {messageId:chosen.id,threadId:chosen.threadId,occurredAt:Date.parse(chosen.receivedAt)},address,participants,sessionHash,summary,grant?.id):null;
    const excluded=saveLog?logResponse(await saveLog([])):await checkRules();
    if(excluded)return excluded;
    const recheckContact=async(participants:string[]=[])=>{
      const current=await readContact();
      if(!current||!('id' in current)||current.createdAt!==record.createdAt||current.revision!==record.revision||
         current.data.email!==record.data.email)return json({error:'The Contact changed. Start a new search.'},409);
      const blocked=await checkRules(participants);
      return await sessionActive()?blocked:expiredSession();
    };
    const {deadline,fetcher:boundedFetch}=boundedGmailRead();
    if(!await sessionActive())return expiredSession();
    let accessToken:string;
    if(personalConfig&&actor&&grant){
      personalConnection=await personalGoogleAccess(request,actor,'gmail',personalConfig,{expectedId:grant.id,gmailFetch:boundedFetch});
      accessToken=personalConnection.accessToken;
    }else if(config){
      ({accessToken}=await refreshTokens(config,config.refreshToken,boundedFetch,[GMAIL_READ_SCOPE]));
      if(!await sessionActive())return expiredSession();
      if((await mailboxEmail(accessToken,boundedFetch)).toLowerCase()!==addressOfOwner){
        return mailboxAuthorization('The configured Gmail inbox belongs to a different account. Ask your Harbor administrator to configure the intended mailbox.');
      }
    }else return expiredSession();
    if(!await sessionActive())return expiredSession();
    const readMailbox=<T>(operation:()=>Promise<T>)=>personalConnection?personalConnection.read(operation):operation();
    if(chosen){
      const metadata=await readMailbox(()=>gmailReceivedPreviewHeaders(accessToken,chosen.id,boundedFetch));
      const verified=verifiedMessage(metadata,chosen,address,addressOfOwner);
      if(!verified)return staleSelection();
      const denied=await recheckContact(verified.participants);
      if(denied)return denied;
      const message=await readMailbox(()=>gmailMessage(accessToken,chosen.id,true,boundedFetch));
      const current=verifiedMessage(message,chosen,address,addressOfOwner);
      if(!current)return staleSelection();
      let body:string;
      try{body=readGmailBody((message as {payload:unknown}).payload).text.trim();}
      catch{return json({error:'Harbor could not read this message body. Open it in Gmail.'},422);}
      if(deadline.aborted)return json({error:'The inbox lookup timed out. Try again.'},503);
      const participants=[...verified.participants,...current.participants];
      if(saveLog){
        const {sender,subject}=current.summary;
        const summary='From: '+sender+'\nSubject: '+subject+'\n\n'+(body||'No readable text body.');
        const suffix='\n\n[Shortened. Open the original in Gmail for the complete message.]';
        const text=summary.length>textLimit?boundedText(summary.slice(0,textLimit-suffix.length))+suffix:summary;
        return logResponse(await saveLog(participants,text))??json({error:'Could not confirm the log. Retry the same selection.'},503);
      }
      const changed=await recheckContact(participants);
      if(changed)return changed;
      return json({body:boundedText(body)||'No readable text body.',truncated:body.length>textLimit});
    }
    const page=await readMailbox(()=>gmailReceivedIndex(accessToken,address,subject,after?.token,boundedFetch));
    if(!await sessionActive())return expiredSession();
    const seen=new Set<string>();
    const messages=page.messages.filter(item=>!seen.has(item.id)&&seen.add(item.id));
    const summaries=await readMailbox(()=>Promise.all(messages.map(async item=>{
      try{
        const summary=messageSummary(await gmailReceivedHeaders(accessToken,item.id,boundedFetch),item,address,addressOfOwner);
        return summary?{...summary,selection:{...item,receivedAt:summary.receivedAt,proof:previewProof(item.id,item.threadId,summary.receivedAt)}}:null;
      }
      catch(error){if(error instanceof GmailError&&error.code==='reauth')throw error;return null;}
    })));
    if(deadline.aborted)return json({error:'The inbox lookup timed out. Try again.'},503);
    const found=summaries.filter(item=>item!==null);
    const logged=await loggedPortableGmailIds(db,user.userId,addressOfOwner,found.map(item=>item.id));
    const changed=await recheckContact();
    if(changed)return changed;
    const items=found.map(item=>logged.has(item.id)?{...item,logged:true}:item);
    const token=page.nextPageToken;
    return json({items,next:token?{token,proof:pageProof(token)}:null,unavailable:page.messages.length-items.length});
  }catch(error){
    if(error instanceof ApiError)return error.status===409?mailboxAuthorization(error.message):json({error:error.message},error.status);
    if(error instanceof GmailError&&error.code==='reauth')return mailboxAuthorization(
      'The configured Gmail inbox needs authorization. Ask your Harbor administrator to reauthorize the mailbox.');
    return json({error:'The inbox lookup is unavailable. Try again.'},503);
  }
}

export {route as POST,route as PUT};
