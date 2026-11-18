import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {ApiError} from '../api-error';
import {randomSecret,sha256} from '../email/crypto';
import {suppressedAddress} from '../email/suppression';
import {guestStatusRetention} from './guest-booking-status';
import {guestProofWindow} from './guest-proof-window';
import type {GuestInvitationStatus} from './guest-invitation';
import type {CalendarSlot} from './suggestions';

const uuid=z.string().guid("Invalid uuid").transform(id=>id.toLowerCase());
const start=utcDateTime.refine(value=>Number.isFinite(Date.parse(value))).transform(value=>new Date(value).toISOString());
export const guestBookingInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('request'),requestId:uuid,email:suppressedAddress,start}).strict(),
  z.object({action:z.literal('verify'),requestId:uuid,code:z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),
]);
export type GuestBookingInput=z.output<typeof guestBookingInput>;
export type GuestBookingClaim={
  id:string;pageId:string;workspaceId:string;email:string;start:string;end:string;
  codeHash:string;createdAt:number;expiresAt:number;
};
export type GuestBookingSummary=Pick<GuestBookingClaim,'id'|'email'|'start'|'end'>&{verifiedAt:number|null;invitation?:GuestInvitationStatus|null};
export {guestProofMinutes,guestProofWindow} from './guest-proof-window';
export const guestRequestDay=86_400_000;
export const guestRequestLimit=12;
export const guestRequestRetention=guestStatusRetention;
export const guestPageUnavailable=()=>new ApiError(404,'This availability link is no longer open.');

export type GuestBookingPage={
  workspaceId:string;id:string;slots:CalendarSlot[];
};

type Operations={
  load:()=>Promise<GuestBookingPage|null>;
  claim:(claim:GuestBookingClaim)=>Promise<boolean>;
  verify:(requestId:string,codeHash:string,now:number)=>Promise<string|null>;
  send:(claim:GuestBookingClaim,code:string)=>Promise<void>;
};

export async function processGuestBooking(input:GuestBookingInput,operations:Operations,now=Date.now()){
  if(input.action==='verify'){
    const receipt=await operations.verify(input.requestId,await sha256(input.code),now);
    if(!receipt)throw new ApiError(400,'The verification code is incorrect or expired.');
    return {verified:true as const,receipt};
  }
  const page=await operations.load();
  if(!page)throw guestPageUnavailable();
  const slot=page.slots.find(value=>value.start===input.start&&Date.parse(value.start)>now);
  if(!slot)throw new ApiError(409,'This time is no longer offered. Reload the availability page.');
  const code=randomSecret();
  const claim:GuestBookingClaim={id:input.requestId,pageId:page.id,workspaceId:page.workspaceId,
    email:input.email,...slot,codeHash:await sha256(code),createdAt:now,
    expiresAt:Math.min(now+guestProofWindow,Date.parse(slot.start))};
  // Repeat requests return the same generic result, even after a lost mail receipt.
  if(await operations.claim(claim))await operations.send(claim,code);
  return {accepted:true as const};
}
