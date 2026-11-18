import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {emailAddress} from './message';
const providerId=z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const inboxContext=z.object({recordId:z.string().min(1).max(150),recordCreatedAt:utcDateTime,email:emailAddress,connectionId:z.string().guid("Invalid uuid"),mailbox:emailAddress}).strict();
export const inboxSelection=inboxContext.extend({messageId:providerId,threadId:providerId,receivedAt:utcDateTime}).strict();
export const inboxSearch=z.object({recordId:z.string().min(1).max(150),subject:z.string().trim().max(100).default(''),after:z.object({context:inboxContext,subject:z.string().max(100),token:z.string().min(1).max(2000)}).strict().optional()}).strict();
export type InboxContext=z.infer<typeof inboxContext>;
export type InboxSelection=z.infer<typeof inboxSelection>;
export type InboxRow={selection:InboxSelection;sender:string;subject:string;processed:boolean;excluded:boolean;error?:string};
export type InboxPage={context:InboxContext;results:InboxRow[];next:z.infer<typeof inboxSearch>['after']|null;blocked:boolean;unavailable:number};
export type InboxPreview={selection:InboxSelection;sender:string;subject:string;body:string;attachments:string[];url:string;processed:boolean;excluded:boolean};
export type InboxLogResult={alreadyLogged:boolean;excluded:boolean;activityId:string};
export function gmailInboxURL(mailbox:string,messageId:string){return 'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(emailAddress.parse(mailbox))+'#all/'+providerId.parse(messageId);}
