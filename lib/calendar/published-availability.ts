import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {ApiError} from '../api-error';
import {validTimeZone} from '../email/schedule';
import type {CalendarSlot} from './suggestions';

const id=z.string().guid("Invalid uuid");
const timestamp=utcDateTime.refine(value=>Number.isFinite(Date.parse(value)));
const slot=z.object({start:timestamp,end:timestamp}).strict();
export const availabilityPageInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('publish'),id,previousId:id.nullable(),title:z.string().trim().min(1).max(100),
    timeZone:z.string().max(100).refine(validTimeZone),slots:z.array(slot).min(1).max(12),allowGuestProof:z.boolean().optional()}).strict(),
  z.object({action:z.literal('unpublish'),id}).strict(),
]);
export type AvailabilityPageInput=z.output<typeof availabilityPageInput>;
export type PublishedAvailability={id:string;title:string;timeZone:string;slots:CalendarSlot[];allowGuestProof:boolean};

export function availabilityState(saved:PublishedAvailability|null|undefined){
  // An empty row carries the new revision after revocation, fencing older publish requests.
  return {revision:saved?.id??null,page:saved?.slots.length?saved:null};
}

export type AvailabilityState=ReturnType<typeof availabilityState>;
export type VerifiedBookingCursor={pageId:string;afterId:string};

export function sameAvailabilityPage(saved:PublishedAvailability|null|undefined,page:PublishedAvailability){
  return saved?.id===page.id&&saved.title===page.title&&saved.timeZone===page.timeZone&&saved.allowGuestProof===page.allowGuestProof&&
    saved.slots.length===page.slots.length&&saved.slots.every((slot,i)=>slot.start===page.slots[i].start&&slot.end===page.slots[i].end);
}

export function availabilityPageFromInput(input:Extract<AvailabilityPageInput,{action:'publish'}>):PublishedAvailability{
  const slots=input.slots.map(({start,end})=>({start:new Date(start).toISOString(),end:new Date(end).toISOString()}))
    .sort((a,b)=>a.start.localeCompare(b.start));
  return {id:input.id,title:input.title,timeZone:input.timeZone,slots,allowGuestProof:input.allowGuestProof??false};
}

export function validatePublishedSlots(slots:CalendarSlot[],now=Date.now()){
  if(new Set(slots.map(slot=>slot.start)).size!==slots.length||slots.some(({start,end})=>{
    const from=Date.parse(start),to=Date.parse(end);
    return from<=now||to>now+14*86_400_000||to-from<15*60_000||to-from>120*60_000;
  }))throw new ApiError(400,'Choose distinct future times of 15 to 120 minutes within the next 14 days.');
}

export const futurePublishedSlots=(slots:CalendarSlot[],now=Date.now())=>slots.filter(slot=>Date.parse(slot.start)>now);
export const availabilityPageChanged=()=>new ApiError(409,'The availability page changed. Reload it before trying again.');
