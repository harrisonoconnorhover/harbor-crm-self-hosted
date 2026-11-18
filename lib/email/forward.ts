import {receivedFileSelection,type ReceivedFileSelection} from './received-selection';
import {z} from 'zod';
import {draftContent,type EmailContent} from './message';
import {plainEmailHtml} from './rich-text';
export const createForwardInput=z.object({id:z.string().guid("Invalid uuid"),sourceEmailId:z.string().guid("Invalid uuid"),replyId:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),receivedFiles:receivedFileSelection.optional()}).strict().refine(v=>v.receivedFiles===undefined||!!v.replyId,'Select files only when forwarding a received email.');
export type EmailForwardContext={sourceEmailId:string;sourceReplyId:string;received:boolean;subjectShortened:boolean;receivedFilesIncluded?:boolean;receivedFileSelection?:ReceivedFileSelection;receivedFilesOmitted?:number};
export function forwardContent(source:{subject:string;body:string;bodyHtml?:string;attachments?:EmailContent['attachments'];sender:string;sentAt:string;to:string[];cc:string[]}){
 const subject=/^fw(?:d)?:\s*/i.test(source.subject)?source.subject:'Fwd: '+(source.subject||'(No subject)');
 const quote='---------- Forwarded message ----------\nFrom: '+source.sender+'\nDate: '+source.sentAt+'\nSubject: '+source.subject+(source.to.length?'\nTo: '+source.to.join(', '):'')+(source.cc.length?'\nCc: '+source.cc.join(', '):'')+'\n\n';
 const content=draftContent.safeParse({to:[],cc:[],bcc:[],subject:subject.slice(0,200),body:'\n\n'+quote+source.body,...(source.bodyHtml?{bodyHtml:'<p><br></p>'+plainEmailHtml(quote)+source.bodyHtml}:{}),...(source.attachments?.length?{attachments:source.attachments}:{})});
 if(!content.success)throw Error('This message is too large or has unsupported content for Harbor forwarding. Forward it in Gmail, or start a new draft with selected text.');
 return {content:content.data,subjectShortened:subject.length>200};
}
