import {z} from 'zod';
import {emailAddress} from '../email/message';
import {calendarWindow,meetingInput} from './model';

const canonicalUuid=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());

export const portableInvite=meetingInput.pick({id:true,title:true,start:true,end:true,timeZone:true}).extend({
  id:canonicalUuid,contactId:canonicalUuid,recipient:emailAddress.transform(email=>email.toLowerCase()),
}).strict().refine(({start,end,timeZone})=>calendarWindow.safeParse({start,end,timeZone}).success);
export type PortableInvite=z.infer<typeof portableInvite>;

export const portableReschedule=z.object({
  id:canonicalUuid,meetingId:canonicalUuid,revision:z.number().int().nonnegative().max(2_147_483_646),
  start:z.string(),end:z.string(),timeZone:z.string(),
}).strict().refine(({start,end,timeZone})=>calendarWindow.safeParse({start,end,timeZone}).success);
export type PortableReschedule=z.infer<typeof portableReschedule>;
