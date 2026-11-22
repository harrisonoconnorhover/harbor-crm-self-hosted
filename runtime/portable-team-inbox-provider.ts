import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {emailAddress,emailMessageId} from '../lib/email/message';
import {textFromHTML} from '../lib/email/replies';

const address=emailAddress.transform(v=>v.toLowerCase());
const route=z.object({workspaceId:z.string().guid(),mailbox:address,inbound:address}).strict();
function routes(){
  const raw=process.env.HARBOR_TEAM_INBOX_ROUTES;
  if(!raw)return [];
  try{
    const result=z.array(route).max(100).parse(JSON.parse(raw));
    for(const key of ['inbound','mailbox'] as const)
      if(new Set(result.map(r=>r[key])).size!==result.length)throw Error();
    return result;
  }catch{throw new ApiError(503,'Check the team inbox mailbox configuration.');}
}

export function configuredInbox(workspaceId:string,mailbox:string){
  const match=routes().find(r=>r.workspaceId===workspaceId&&r.mailbox===mailbox);
  if(match)return {...match,token:process.env.HARBOR_TEAM_INBOX_POSTMARK_TOKEN?.trim()};
}
export function authorizeIncoming(authorization:string|null){
  const secret=process.env.HARBOR_TEAM_INBOX_SECRET;
  if(!secret||secret.length<32||!process.env.HARBOR_TEAM_INBOX_ROUTES)throw new ApiError(503,'Team inbox intake is not configured.');
  const expected='Basic '+Buffer.from('harbor:'+secret).toString('base64');
  const hash=(value:string)=>createHash('sha256').update(value).digest();
  if(!timingSafeEqual(hash(authorization??''),hash(expected)))throw new ApiError(403,'Inbox credentials were rejected.');
}

const delivery=z.object({
  OriginalRecipient:address,FromFull:z.object({Email:address}),MessageID:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/),
  Subject:z.string().default(''),TextBody:z.string().optional(),HtmlBody:z.string().optional(),StrippedTextReply:z.string().optional(),
  Headers:z.array(z.object({Name:z.string(),Value:z.string()})).max(1000).default([]),
  Attachments:z.array(z.unknown()).optional(),
});
const bodyLimit=16000;
export function parseInbound(payload:unknown){
  const mail=delivery.parse(payload);
  // Only the provider's envelope recipient selects the destination workspace.
  const target=routes().find(r=>r.inbound===mail.OriginalRecipient);
  if(!target)throw new ApiError(403,'Unrecognized inbound address.');
  const header=(name:string)=>mail.Headers.filter(h=>h.Name.toLowerCase()===name).map(h=>h.Value);
  const ids=header('message-id');
  const internetId=ids.length===1?emailMessageId.safeParse(ids[0].trim()).data:undefined;
  const references=[...header('references'),...header('in-reply-to')].flatMap(h=>h.match(/<[^<>\s]+>/g)??[])
    .filter(id=>emailMessageId.safeParse(id).success).slice(-20);
  const text=(mail.StrippedTextReply?.trim()||mail.TextBody?.trim()||textFromHTML(mail.HtmlBody??'')).replaceAll('\0','');
  const notice=mail.Attachments?.length?'\n[Attachments available in the source mailbox.]':'';
  const available=bodyLimit-notice.length;
  const body=(text.length>available?text.slice(0,available-14)+'\n[Truncated]':text||'[No message text]')+notice;
  return {workspaceId:target.workspaceId,mailbox:target.mailbox,sender:mail.FromFull.Email,
    subject:mail.Subject.replace(/\p{Cc}+/gu,' ').trim().slice(0,300)||'(No subject)',
    providerId:mail.MessageID,internetId,references,body};
}

type Reply={replyId:string;sender:string;mailbox:string;subject:string;internetId:string;inReplyTo:string|null};
type Receipt={state:'sent'|'failed'|'uncertain';providerId?:string};
export async function deliverInboxReply(token:string,reply:Reply,body:string,send:typeof fetch=fetch):Promise<Receipt>{
  const headers=[{Name:'Message-ID',Value:reply.internetId}];
  if(reply.inReplyTo)headers.push({Name:'In-Reply-To',Value:reply.inReplyTo},{Name:'References',Value:reply.inReplyTo});
  try{
    const response=await send('https://api.postmarkapp.com/email',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{accept:'application/json','content-type':'application/json','X-Postmark-Server-Token':token},
      body:JSON.stringify({From:reply.mailbox,ReplyTo:reply.mailbox,To:reply.sender,
        Subject:/^re:/i.test(reply.subject)?reply.subject:'Re: '+reply.subject,TextBody:body,Headers:headers,Metadata:{harbor_reply_id:reply.replyId},TrackOpens:false,TrackLinks:'None'})});
    const receipt=z.object({ErrorCode:z.number().int(),MessageID:z.string().optional()}).parse(await response.json());
    if(response.ok&&receipt.ErrorCode===0&&typeof receipt.MessageID==='string'&&receipt.MessageID.length>0&&receipt.MessageID.length<=200)
      return {state:'sent',providerId:receipt.MessageID};
    if([401,422].includes(response.status)&&Number.isInteger(receipt.ErrorCode)&&receipt.ErrorCode>0)return {state:'failed'};
  }catch{/* The provider may have accepted the message before the response was lost. */}
  return {state:'uncertain'};
}
