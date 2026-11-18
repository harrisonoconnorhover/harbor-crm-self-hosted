import {sendGmail} from '../email/gmail';
import {guestProofMinutes,type GuestBookingClaim} from './guest-booking';

export function deliverGuestCode(accessToken:string,sender:string,claim:GuestBookingClaim,code:string,fetcher:typeof fetch=fetch){
  return sendGmail(accessToken,{
    to:[claim.email],cc:[],bcc:[],subject:'Your Harbor meeting verification code',
    body:'Enter this code on the meeting availability page:\n\n'+code+
      '\n\nIt expires within '+guestProofMinutes+' minutes. If you did not request a meeting, you can ignore this email.',
  },sender,'<harbor-booking-'+claim.id+'@harbor.invalid>',new Date(claim.createdAt).toISOString(),fetcher);
}
