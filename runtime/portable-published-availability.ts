import {z} from 'zod';
import {findPortablePublishedAvailability,portableOwnerAvailability,savePortableAvailability} from '../db/postgres/published-availability-store';
import {portableOpenCalendarSlots} from '../db/postgres/portable-meeting-store';
import {ApiError} from '../lib/api-error';
import {futurePublishedSlots} from '../lib/calendar/published-availability';
import {ownerAvailabilityRoute} from '../lib/calendar/published-availability-route';
import {portableApiIdentity} from './portable-api-identity';
import {portableCalendarConfig,portableGuestInvitesEnabled} from './portable-calendar-config';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest,requestSessionHash} from './portable-identity';

const enabled=()=>process.env.HARBOR_PUBLIC_AVAILABILITY_ENABLED==='true';
const cursorId=z.string().guid('Invalid uuid').transform(id=>id.toLowerCase());
const bookingCursor=z.object({pageId:cursorId,afterId:cursorId}).strict();

function verifiedBookingCursor(request:Request){
  const params=new URL(request.url).searchParams;
  if(!params.size)return undefined;
  const cursor=bookingCursor.safeParse(Object.fromEntries(params));
  if(params.size!==2||!cursor.success)throw new ApiError(400,'Check the verified booking page cursor.');
  return cursor.data;
}

export function portableAvailabilityRoute(request:Request){
  const sharing=enabled();
  return ownerAvailabilityRoute(request,sharing,async()=>{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(sharing&&(user.guest||portableCalendarConfig()?.owner!==user.email))
      throw new ApiError(403,'Calendar sharing is unavailable for this account.');
    return user;
  },async owner=>({
    ...await portableOwnerAvailability(portableDb(),owner.userId,process.env.HARBOR_GUEST_BOOKING_PROOF_ENABLED==='true',verifiedBookingCursor(request)),
    ...(portableGuestInvitesEnabled()?{guestInvitesEnabled:true as const}:{}),
  }),async (owner,input)=>{
    const hash=await requestSessionHash(request.headers);
    if(!hash)throw new ApiError(403,'Sign in again to manage availability.');
    return savePortableAvailability(portableDb(),owner,input,hash);
  });
}

export async function readPortablePublishedAvailability(id:string){
  if(!enabled())return null;
  const account=portableCalendarConfig();
  if(!account)return null;
  const db=portableDb(),page=await findPortablePublishedAvailability(db,id);
  if(!page||page.email!==account.owner||portableWorkspaceGuest(page.email))return null;
  const future=futurePublishedSlots(page.slots);
  if(!future.length)return null;
  const slots=await portableOpenCalendarSlots(db,page.ownerId,future);
  return {id:page.id,title:page.title,timeZone:page.timeZone,slots,allowGuestProof:page.allowGuestProof};
}
