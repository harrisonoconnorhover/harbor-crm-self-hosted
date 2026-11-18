import {z} from 'zod';
import {emailAddress,emailMessageId,emailThreadContext,type EmailThreadContext} from './message';
import {gmailMessageMetadata} from './gmail';
import {decodedHeader} from './replies';
export const createReplyInput=z.object({id:z.string().guid("Invalid uuid"),sourceEmailId:z.string().guid("Invalid uuid"),replyId:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),mode:z.enum(['reply','all'])}).strict();
export type CreateReplyInput=z.infer<typeof createReplyInput>;
const metadata=gmailMessageMetadata.extend({payload:z.object({headers:z.array(z.object({name:z.string().max(200),value:z.string().max(16000)})).max(200)})});
// Split only outside quoted display names, comments and angle brackets. Never guess malformed recipients.
export function replyAddresses(value:string){
 if(!value.trim())return [];if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw Error('The recipient header contains invalid characters.');
 const parts:string[]=[];let current='',quoted=false,escaped=false,angle=0,comment=0;
 const unfolded=value.replace(/\r?\n[ \t]+/g,' ');if(/[\r\n]/.test(unfolded))throw Error('The recipient header contains an invalid line break.');
 for(const char of unfolded){if(escaped){if(!comment)current+=char;escaped=false;continue;}if(char==='\\'&&(quoted||comment)){if(!comment)current+=char;escaped=true;continue;}if(!quoted&&char==='('){comment++;continue;}if(comment){if(char===')')comment--;continue;}if(char==='"')quoted=!quoted;if(!quoted){if(char==='<')angle++;if(char==='>')angle--;if(angle<0||angle>1)throw Error('The recipient header is ambiguous.');if(char===','&&!angle){parts.push(current);current='';continue;}}current+=char;}
 if(quoted||angle||comment||escaped)throw Error('The recipient header is incomplete.');parts.push(current);if(parts.length>100)throw Error('This reply has too many recipients.');
 return parts.map(part=>{const text=part.trim(),match=text.match(/^[^<>]*<([^<>]+)>\s*$/);const parsed=emailAddress.safeParse(match?match[1]:text);if(!parsed.success)throw Error('A recipient could not be read. Open the original in Gmail.');return parsed.data;});
}
export function buildThreadReply(raw:unknown,input:CreateReplyInput,mailbox:string,rootEmailId:string,ownRecipients?:{to:string[];cc:string[]}){
 const source=metadata.parse(raw),get=(name:string)=>{const found=source.payload.headers.filter(h=>h.name.toLowerCase()===name.toLowerCase());if(found.length>1)throw Error('The original email has ambiguous '+name+' headers.');return found[0]?.value||'';};
 const inReplyTo=emailMessageId.parse(get('Message-ID').trim()),subject=decodedHeader(get('Subject'));
 const referencesRaw=get('References')||get('In-Reply-To'),refs=(referencesRaw.match(/<[^<>]+>/g)||[]).map(v=>emailMessageId.parse(v));const unique=[...new Set([...refs.filter(v=>v!==inReplyTo),inReplyTo])];const references=unique.length>20?[unique[0],...unique.slice(-19)]:unique;
 const to:string[]=[],cc:string[]=[],seen=new Set([mailbox.toLowerCase()]);const add=(target:string[],values:string[])=>{for(const address of values)if(!seen.has(address.toLowerCase())){seen.add(address.toLowerCase());target.push(address);}};
 if(ownRecipients){add(to,ownRecipients.to);if(input.mode==='all')add(cc,ownRecipients.cc);}
 else{add(to,replyAddresses(get('Reply-To')||get('From')));if(input.mode==='all'){add(cc,replyAddresses(get('To')));add(cc,replyAddresses(get('Cc')));}}
 if(!to.length&&cc.length)to.push(cc.shift()!);if(!to.length)throw Error('There are no external reply recipients. Start a new email and choose a recipient.');if(to.length+cc.length>50)throw Error('Use at most 50 reply recipients. Open this conversation in Gmail.');
 const threadContext:EmailThreadContext=emailThreadContext.parse({sourceEmailId:input.sourceEmailId,rootEmailId,sourceReplyId:input.replyId||'',sourceMessageId:source.id,threadId:source.threadId,inReplyTo,references,subject,mailbox,mode:input.mode});
 return {threadContext,content:{to,cc,bcc:[],subject,body:''}};
}
