// Fold at 75 UTF-8 bytes so a long meeting name survives import into desktop calendars.
function foldLine(value:string){
  const encoder=new TextEncoder();
  let line='',length=0;
  for(const char of value){
    const bytes=encoder.encode(char).length;
    if(length+bytes>75){line+='\r\n ';length=1;}
    line+=char;length+=bytes;
  }
  return line;
}

export function bookingCalendarFile(id:string,title:string,start:string,end:string,now=new Date()){
  const stamp=(date:Date)=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const text=title.replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/[;,]/g,char=>'\\'+char)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu,'');
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Harbor CRM//Team scheduling//EN','BEGIN:VEVENT',
    'UID:'+id+'@harbor-booking','DTSTAMP:'+stamp(now),'DTSTART:'+stamp(new Date(start)),
    'DTEND:'+stamp(new Date(end)),'SUMMARY:'+text,'END:VEVENT','END:VCALENDAR',''].map(foldLine).join('\r\n');
}

export function downloadBooking(id:string,title:string,start:string,end:string){
  const url=URL.createObjectURL(new Blob([bookingCalendarFile(id,title,start,end)],{type:'text/calendar;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;link.download='harbor-meeting.ics';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
