'use client';

import {useRouter} from 'next/navigation';
import {useState,useSyncExternalStore} from 'react';
import type {CalendarSlot} from '../lib/calendar/suggestions';
import {GuestBookingForm} from '../app/availability/guest-booking-form';
import './portable-guest-times.css';
import {bookingSlotFormatter} from '../lib/calendar/booking-slot-label';

const preferenceKey='harbor:guest-booking:display-local-time';

const subscribe=()=>()=>{};
const browserZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone=()=>'';
function prefersLocalTime(){
  try{return sessionStorage.getItem(preferenceKey)==='yes';}catch{return false;}
}

export function PortableGuestTimes({id,timeZone,slots,guestProof,teamCalendar}:{id:string;timeZone:string;slots:(CalendarSlot&{label:string})[];guestProof:boolean;teamCalendar:boolean}){
  const router=useRouter();
  const localZone=useSyncExternalStore(subscribe,browserZone,serverZone);
  const [choice,setChoice]=useState<boolean|null>(null);
  const useLocal=choice??(Boolean(localZone)&&prefersLocalTime());
  const zone=useLocal&&localZone?localZone:timeZone;
  const format=zone!==timeZone?bookingSlotFormatter(zone):null;
  const displayed=format?slots.map(slot=>({...slot,label:format(slot)})):slots;
  return <div className="portable-booking-times">
    {slots.length>0&&localZone&&localZone!==timeZone?<label>Display time zone
      <select value={useLocal?'local':'organizer'} onChange={event=>{
        const local=event.target.value==='local';
        setChoice(local);
        try{sessionStorage.setItem(preferenceKey,local?'yes':'no');}catch{/* Storage is optional. */}
      }}>
        <option value="organizer">Booking page · {timeZone}</option>
        <option value="local">Your time zone · {localZone}</option>
      </select>
    </label>:<p>Times shown in {zone}.</p>}
    <p>{guestProof&&slots.length?'Verify your email for the time you want.':'Contact the organizer to confirm a time.'}</p>
    {guestProof?<GuestBookingForm id={id} slots={displayed} refreshAlternatives={teamCalendar?()=>router.refresh():undefined}/>:
      displayed.length?<ul>{displayed.map(slot=><li key={slot.start}><time dateTime={slot.start}>{slot.label}</time></li>)}</ul>:
      <p>There are no open times on this page.</p>}
  </div>;
}
