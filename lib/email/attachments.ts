import {z} from 'zod';
import {attachmentName,MAX_ATTACHMENT_BYTES} from '../activity-attachments';
export const MAX_EMAIL_ATTACHMENT_BYTES=20*1024*1024;
export const MAX_EMAIL_ATTACHMENTS=20;
export const emailAttachment=z.object({id:z.string().guid("Invalid uuid"),name:z.string().max(200).refine(v=>{try{encodeURIComponent(v);return attachmentName(v)===v;}catch{return false;}},'Invalid attachment name.'),size:z.number().int().positive().max(MAX_ATTACHMENT_BYTES),contentVersion:z.union([z.literal(''),z.string().guid("Invalid uuid")])}).strict();
export const emailAttachments=z.array(emailAttachment).max(MAX_EMAIL_ATTACHMENTS).refine(v=>new Set(v.map(f=>f.id)).size===v.length,'Choose each attachment only once.').refine(v=>v.reduce((n,f)=>n+f.size,0)<=MAX_EMAIL_ATTACHMENT_BYTES,'Email attachments must total 20 MB or less.');
export type EmailAttachment=z.infer<typeof emailAttachment>;
export type EmailAttachmentData=EmailAttachment&{bytes:Uint8Array};
