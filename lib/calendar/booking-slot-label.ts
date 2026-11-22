import type {CalendarSlot} from './suggestions';

// The offset distinguishes the two occurrences of a repeated local hour.
export function bookingSlotFormatter(timeZone:string){
  const clock=new Intl.DateTimeFormat('en',{timeZone,dateStyle:'full',timeStyle:'short'});
  const offset=new Intl.DateTimeFormat('en',{timeZone,timeZoneName:'shortOffset'});
  const zoneAt=(date:Date)=>offset.formatToParts(date).find(part=>part.type==='timeZoneName')!.value;
  return (slot:CalendarSlot)=>{
    const start=new Date(slot.start),end=new Date(slot.end);
    const from=zoneAt(start),to=zoneAt(end);
    return from===to?clock.formatRange(start,end)+' ('+from+')':
      clock.format(start)+' ('+from+') – '+clock.format(end)+' ('+to+')';
  };
}
