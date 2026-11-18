import {z} from 'zod';
import {emailAddress,type EmailContent} from './message';

export const suppressedAddress=emailAddress.transform(value=>value.toLowerCase());
export const suppressionInput=z.object({id:z.string().guid("Invalid uuid"),email:suppressedAddress}).strict();
export const suppressionQuery=z.object({query:z.string().trim().max(254).default(''),after:z.string().max(254).default('')}).strict();
export type EmailSuppression={id:string;email:string;createdAt:string;recipientOptedOutAt:string|null};
export type EmailSuppressionPage={results:EmailSuppression[];total:number;next:string|null};
export const queuedRecipientBlockedNotice='A recipient is on the Do not email list. Harbor checks the list again before sending.';
export const emailRecipients=(content:Pick<EmailContent,'to'|'cc'|'bcc'>)=>[...content.to,...content.cc,...content.bcc].map(value=>suppressedAddress.parse(value));
