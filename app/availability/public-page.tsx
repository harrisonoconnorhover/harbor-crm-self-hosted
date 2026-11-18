import {notFound} from 'next/navigation';
import {z} from 'zod';
import type {PublishedAvailability} from '@/lib/calendar/published-availability';
import {AvailabilityCard,GuestBookingForm} from './guest-booking-form';

export const metadata={title:'Meeting availability · Harbor',robots:{index:false,follow:false},referrer:'no-referrer'};

export function publicAvailabilityPage(read:(id:string)=>Promise<PublishedAvailability|null>,proofAvailable:(id:string)=>boolean|Promise<boolean>){
  return async function AvailabilityPage({params}:{params:Promise<{id:string}>}){
    const {id}=await params;
    if(!z.string().guid("Invalid uuid").safeParse(id).success)notFound();
    const page=await read(id);
    if(!page)notFound();
    const guestProof=page.allowGuestProof&&await proofAvailable(id);
    const format=new Intl.DateTimeFormat('en',{
      timeZone:page.timeZone,dateStyle:'full',timeStyle:'short',
    });
    return <AvailabilityCard>
      <h1>{page.title}</h1>
      <p>Times shown in {page.timeZone}. {guestProof&&page.slots.length?'Verify your email for the time you want.':'Contact the organizer to confirm a time.'}</p>
      {guestProof?<GuestBookingForm id={page.id} slots={page.slots.map(slot=>({start:slot.start,
        label:format.formatRange(new Date(slot.start),new Date(slot.end))}))}/>:page.slots.length?<ul>{page.slots.map(({start,end})=><li key={start}>
        <time dateTime={start}>{format.formatRange(new Date(start),new Date(end))}</time>
      </li>)}</ul>:<p>There are no open times on this page.</p>}
    </AvailabilityCard>;
  };
}
