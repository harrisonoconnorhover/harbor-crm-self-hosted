import {notFound} from 'next/navigation';
import {z} from 'zod';
import {AvailabilityCard} from '../app/availability/guest-booking-form';
import {bookingSlotFormatter} from '../lib/calendar/booking-slot-label';
import {utcDateTime} from '../lib/iso-date-time';
import {portableGuestBookingEnabled} from './portable-guest-booking';
import {readPortablePublishedAvailability} from './portable-published-availability';
import {PortableGuestTimes} from './portable-guest-times';

export {metadata} from '../app/availability/public-page';

export default async function PortableAvailabilityPage({params,searchParams}:{
  params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>;
}){
  const {id}=await params;
  if(!z.string().guid().safeParse(id).success)notFound();
  const cursor=utcDateTime.optional().safeParse((await searchParams)?.after);
  if(!cursor.success)notFound();
  const page=await readPortablePublishedAvailability(id,cursor.data);
  if(!page)notFound();
  const guestProof=page.allowGuestProof&&portableGuestBookingEnabled();
  const label=bookingSlotFormatter(page.timeZone);
  const next='next' in page?page.next:null;
  return <AvailabilityCard>
    <h1>{page.title}</h1>
    <PortableGuestTimes id={page.id} timeZone={page.timeZone} slots={page.slots.map(({start,end})=>({start,end,label:label({start,end})}))} guestProof={guestProof} teamCalendar={'next' in page}/>
    {(next||cursor.data)&&<nav aria-label="Available time pages">
      {cursor.data&&<a href={'/availability/'+id}>Earliest times</a>}{' '}
      {next&&<a href={'/availability/'+id+'?'+new URLSearchParams({after:next})}>Later times</a>}
    </nav>}
  </AvailabilityCard>;
}
