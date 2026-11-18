import {findPortablePublishedAvailability} from '../db/postgres/published-availability-store';
import {claimPortableGuestRequest,portableGuestDeliveryAllowed,prunePortableGuestRequests,recordPortableGuestDelivery,
  verifyPortableGuestRequest} from '../db/postgres/guest-booking-store';
import {portableOpenCalendarSlots} from '../db/postgres/portable-meeting-store';
import {deliverGuestCode} from '../lib/calendar/guest-booking-mail';
import {guestBookingRoute} from '../lib/calendar/guest-booking-route';
import {guestPageUnavailable,processGuestBooking,type GuestBookingInput} from '../lib/calendar/guest-booking';
import {portableCalendarConfig} from './portable-calendar-config';
import {portableDb} from './portable-db';
import {portableGmailAccessToken,portableGmailConfig} from './portable-gmail-config';
import {portableWorkspaceGuest} from './portable-identity';
import {portableRateLimit} from './portable-rate-limit';
import {issueGuestStatusReceipt} from '../lib/calendar/guest-booking-status';
import {loginConfig} from '../lib/identity';
import {env} from './portable-env';
import {ApiError} from '../lib/api-error';

export function portableGuestBookingEnabled(){
  if(process.env.HARBOR_PUBLIC_AVAILABILITY_ENABLED!=='true'||
    process.env.HARBOR_GUEST_BOOKING_PROOF_ENABLED!=='true')return false;
  const mailbox=portableGmailConfig();
  return !!mailbox&&portableCalendarConfig()?.owner===mailbox.owner;
}

async function portableGuestBooking(pageId:string,input:GuestBookingInput){
  const db=portableDb(),mail=portableGmailConfig(),calendar=portableCalendarConfig();
  const page=await findPortablePublishedAvailability(db,pageId);
  if(!page?.allowGuestProof||!mail||mail.owner!==page.email||calendar?.owner!==page.email||portableWorkspaceGuest(page.email))throw guestPageUnavailable();
  const rate=await portableRateLimit('public_form','booking:'+page.id);
  if(rate)throw new ApiError(rate.status,'Please wait before trying again.');
  return processGuestBooking(input,{
    load:async()=>({...page,slots:await portableOpenCalendarSlots(db,page.ownerId,page.slots)}),
    claim:claim=>claimPortableGuestRequest(db,page,claim),
    verify:(requestId,hash,now)=>verifyPortableGuestRequest(db,page,requestId,hash,now,
      ()=>issueGuestStatusReceipt(loginConfig(env),{workspaceId:page.workspaceId,pageId:page.id,requestId},now)),
    async send(claim,code){
      let delivery='blocked',providerId:string|undefined;
      try{
        const token=await portableGmailAccessToken(mail);
        if(await portableGuestDeliveryAllowed(db,page,claim)){
          delivery='unknown';
          const receipt=await deliverGuestCode(token,mail.owner,claim,code,async(url,init)=>{
            if(!await portableGuestDeliveryAllowed(db,page,claim)){delivery='blocked';throw guestPageUnavailable();}
            return fetch(url,init);
          });
          delivery='sent';providerId=receipt.id;
        }
      }catch{/* The same send claim is never reused. */}
      await recordPortableGuestDelivery(db,page,claim.id,delivery,providerId);
      // Keep retention cleanup out of the one-shot delivery and receipt.
      try{await prunePortableGuestRequests(db,claim.createdAt);}
      catch{console.warn(JSON.stringify({event:'harbor_portable_guest_request_cleanup_failed'}));}
    },
  });
}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  return guestBookingRoute(request,(await params).id,portableGuestBookingEnabled(),portableGuestBooking);
}
