import {notFound} from 'next/navigation';
import {z} from 'zod';
import {utcDateTime} from '@/lib/iso-date-time';
import type {PublishedAvailability} from '@/lib/calendar/published-availability';
import {AvailabilityCard,GuestBookingForm} from './guest-booking-form';

export const metadata={title:'Meeting availability · Harbor',robots:{index:false,follow:false},referrer:'no-referrer'};

export function publicAvailabilityPage(read:(id:string,after?:string)=>Promise<(PublishedAvailability&{next?:string|null})|null>,proofAvailable:(id:string)=>boolean|Promise<boolean>,paged=false){
  return async function AvailabilityPage({params,searchParams}:{params:Promise<{id:string}>;searchParams?:Promise<Record<string,string|string[]|undefined>>}){
    const {id}=await params;
    if(!z.string().guid("Invalid uuid").safeParse(id).success)notFound();
    const cursor=paged?(await searchParams)?.after:undefined;
    const after=utcDateTime.optional().safeParse(cursor);
    if(!after.success)notFound();
    const page=await read(id,after.data);
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
      {paged&&'next' in page&&(page.next||after.data)&&<nav aria-label="Available time pages">
        {after.data&&<a href={'/availability/'+id}>Earliest times</a>}{' '}
        {page.next&&<a href={'/availability/'+id+'?'+new URLSearchParams({after:page.next})}>Later times</a>}
      </nav>}
    </AvailabilityCard>;
  };
}
