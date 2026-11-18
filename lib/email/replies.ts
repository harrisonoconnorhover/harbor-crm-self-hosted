import {Parser} from 'htmlparser2';
import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {decode64,emailAddress} from './message';
import {gmailMessageMetadata,type GmailMessageMetadata} from './gmail';
export const replyCursor=z.object({at:utcDateTime,id:z.string().min(1).max(200)}).strict();
export type ReplyCursor=z.infer<typeof replyCursor>;
export type ReplyPage={results:{id:string;sender:string;subject:string;receivedAt:string;body:string|null}[];next:ReplyCursor|null;lastCheckedAt:string};
export type ReplySyncResult={logged:number;alreadyLogged:number;ignored:number;excluded?:number;excludedConversation?:boolean;failed:{id:string;error:string}[];next:ReplyCursor|null;checkedAt:string};
export const receivedTime=(message:GmailMessageMetadata)=>{const n=Number(message.internalDate);if(!Number.isSafeInteger(n)||n<0||n>Date.now()+300000)throw Error('Gmail returned an invalid received date.');return new Date(n).toISOString();};
export function inboundCandidate(m:GmailMessageMetadata,original:GmailMessageMetadata){return m.id!==original.id&&m.threadId===original.threadId&&Number(m.internalDate)>=Number(original.internalDate)&&!m.labelIds.some(l=>['SENT','DRAFT','SPAM','TRASH'].includes(l));}
export const headersSchema=z.array(z.object({name:z.string().max(200),value:z.string().max(16000)})).max(200);
export function decodedHeader(value:string){return value.replace(/\?=\s+=\?/g,'?==?').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(whole,charset,encoding,data)=>{try{const bytes=encoding.toLowerCase()==='b'?decode64(data):Uint8Array.from(data.replaceAll('_',' ').replace(/=([0-9a-f]{2})/gi,(_:string,n:string)=>String.fromCharCode(parseInt(n,16))),(c:string)=>c.charCodeAt(0));return new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{return whole;}}).replace(/[\x00-\x1f\x7f]/g,' ').trim();}
function textFromHTML(html:string){let text='',hidden=0;const hiddenTags=new Set(['script','style','head','title']);const parser=new Parser({onopentag(name){if(hiddenTags.has(name))hidden++;if(!hidden&&['p','div','br','li','tr','blockquote','h1','h2','h3'].includes(name))text+='\n';},ontext(value){if(!hidden)text+=value;},onclosetag(name){if(hiddenTags.has(name))hidden=Math.max(0,hidden-1);if(!hidden&&['p','div','li','tr','blockquote'].includes(name))text+='\n';}},{decodeEntities:true});parser.end(html);return text.replace(/\n{3,}/g,'\n\n').trim();}
export function parseGmailReply(raw:unknown,original:GmailMessageMetadata,mailbox:string,forForward=false,filesIncluded:boolean|'selected'=false){
 const message=gmailMessageMetadata.extend({payload:z.unknown().optional()}).parse(raw);if(!inboundCandidate(message,original))return null;
 const top=z.object({headers:headersSchema.default([])}).parse(message.payload),header=(name:string)=>decodedHeader(top.headers.find(h=>h.name.toLowerCase()===name)?.value||'');
 const from=header('from'),angle=from.match(/<([^<>]+)>\s*$/),address=emailAddress.safeParse(angle?angle[1]:from);
 if(!address.success)throw Error('The reply sender could not be read. Open this message in Gmail.');
 if(address.data.toLowerCase()===mailbox.toLowerCase())return null;
 const parsedBody=readGmailBody(message.payload),attachments=parsedBody.attachments;
 const parsed={text:parsedBody.text},subject=(forForward?header('subject'):header('subject').slice(0,500))||'(No subject)',sender=forForward?from:from.slice(0,500),to=forForward?header('to'):header('to').slice(0,1000),cc=forForward?header('cc'):header('cc').slice(0,1000);
 const text=((forForward?'---------- Forwarded message ----------\nDate: '+receivedTime(message):'Received email')+'\nFrom: '+sender+'\nSubject: '+subject+(to?'\nTo: '+to:'')+(cc?'\nCc: '+cc:'')+'\n\n'+(parsed.text.trim()||'[No readable text body]')+(attachments.length?(forForward?(filesIncluded==='selected'?'\n\nOriginal attachments (only selected files are included):\n':filesIncluded?'\n\nAttachments:\n':'\n\nOriginal attachments (not included; open in Gmail):\n'):'\n\nAttachments (use Received files):\n')+attachments.join('\n'):''))
  .replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
 if(forForward&&text.length>31998)throw Error('This reply is too large to forward in Harbor. Forward it in Gmail, or start a new draft with selected text.');
 return {id:message.id,sender,subject,receivedAt:receivedTime(message),body:!forForward&&text.length>10000?text.slice(0,9850)+'\n\n[Message shortened in Harbor. Open the original in Gmail for the complete email and attachments.]':text};
}

export function replySenderAddress(raw:unknown){const parsed=z.object({payload:z.object({headers:headersSchema.default([])})}).parse(raw),values=parsed.payload.headers.filter(h=>h.name.toLowerCase()==='from');if(values.length!==1)throw Error('The reply sender could not be read. Open this message in Gmail.');const from=decodedHeader(values[0].value),angle=from.match(/<([^<>]+)>\s*$/);return emailAddress.parse(angle?angle[1]:from);}

// Shared inert MIME rendering for logged replies, forwards and explicit conversation reads.
export function readGmailBody(payload:unknown){
 let nodes=0;const attachments:string[]=[];
 const partSchema=z.object({mimeType:z.string().max(100),filename:z.string().max(1000).default(''),headers:headersSchema.default([]),body:z.object({data:z.string().max(1000000).optional(),attachmentId:z.string().max(500).optional()}).prefault({}),parts:z.array(z.unknown()).max(200).default([])});
 function body(part:unknown,depth=0):{text:string;plain:boolean}{if(++nodes>300||depth>25)throw Error('This message has too many MIME parts. Open it in Gmail.');const p=partSchema.parse(part),type=p.mimeType.toLowerCase();if(p.filename){attachments.push(decodedHeader(p.filename).slice(0,200));return {text:'',plain:false};}if(type.startsWith('multipart/')){const children=p.parts.map(v=>body(v,depth+1));if(type==='multipart/alternative')return children.find(c=>c.plain&&c.text)||children.find(c=>c.text)||{text:'',plain:false};return {text:children.map(c=>c.text).filter(Boolean).join('\n\n'),plain:children.some(c=>c.plain)};}
 if(!['text/plain','text/html'].includes(type))return {text:'',plain:false};
 if(p.body.attachmentId&&!p.body.data)throw Error('Gmail stored this message body separately. Open it in Gmail.');
 const charset=p.headers.find(h=>h.name.toLowerCase()==='content-type')?.value.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1]||'utf-8';let value:string;try{value=new TextDecoder(charset,{fatal:true}).decode(decode64(p.body.data||''));}catch{throw Error('The reply text encoding could not be read. Open it in Gmail.');}
 return {text:type==='text/html'?textFromHTML(value):value,plain:type==='text/plain'};
 }
 const parsed=body(payload);return {text:parsed.text.replace(/\r\n?/g,"\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,""),attachments};
}
