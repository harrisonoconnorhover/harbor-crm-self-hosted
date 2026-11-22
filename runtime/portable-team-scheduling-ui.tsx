'use client';

import {ApiError} from '../lib/api-error';

import './portable-team-scheduling.css';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {enrollmentUrl} from '../lib/portable-sales-sequences';
import {downloadBooking} from '../lib/calendar/booking-file';
import {scheduledInstants} from '../lib/email/schedule';
import type {RescheduleRoster,CollectiveRosterPreview,BookingHostOptions,BookingReviewFilter,BookingHost,HostSearch,TeamBookingCursor,TeamChange,TeamSchedule,TeamTimeOff,TeamWindow} from '../lib/calendar/team-booking';

const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const format=(slot:TeamWindow)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'})
  .formatRange(new Date(slot.start),new Date(slot.end));

function CalendarHostNotice({page}:{page:TeamSchedule['pages'][number]}){
  if(!page.hostIssues.length)return null;
  const blocked=page.mode==='collective'||page.hostIssues.length===page.hosts.length;
  const reasons={former:'Host offer no longer exists',access:'Scheduling access removed',hours:'No upcoming hours offered'};
  return <aside className="team-host-notice" aria-label="Host coverage">
    <strong>{blocked?'New bookings blocked':'Round-robin coverage reduced'}</strong>
    <ul>{page.hostIssues.map(({id,reason})=><li key={id}>{page.hostLabels[id]} · {reasons[reason]}</li>)}</ul>
  </aside>;
}

function timeOffLabel(period:TeamTimeOff){
  const start=[period.from,period.startTime].filter(Boolean).join(' ');
  const end=[period.through===period.from?'':period.through,period.endTime].filter(Boolean).join(' ');
  return (end?start+' – '+end:start)+' · '+period.timeZone;
}

async function read<T>(url:string,input?:TeamChange):Promise<T>{
  const response=await fetch(url,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{cache:'no-store'});
  const result=await response.json() as T&{error?:string};
  if(!response.ok)throw new ApiError(response.status,result.error??'Could not load the team calendar.');
  return result;
}

export function PortableTeamScheduling({workspaceId,grantId,initiallyExpanded=false}:{workspaceId:string;grantId?:string;initiallyExpanded?:boolean}){
  const url='/api/workspaces?'+new URLSearchParams({team:'booking',workspaceId,...grantId?{grantId}:{}});
  const [state,setState]=useState<TeamSchedule|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [timedLeave,setTimedLeave]=useState(false);
  const [bookingPage,setBookingPage]=useState<TeamBookingCursor|null>(null);
  const [bookingFilter,setBookingFilter]=useState<BookingReviewFilter|null>(null);
  const [guestFilter,setGuestFilter]=useState(''),[guestInput,setGuestInput]=useState('');
  const [hostInput,setHostInput]=useState(''),[hostSearch,setHostSearch]=useState<HostSearch>({query:''});
  const [selectedHosts,setSelectedHosts]=useState<BookingHost[]>([]);
  const [editingHosts,setEditingHosts]=useState<TeamSchedule['pages'][number]|null>(null);
  const hostEditor=useRef<HTMLHeadingElement>(null);
  const bookingsHeading=useRef<HTMLHeadingElement>(null);
  const [move,setMove]=useState<{id:string;original:string;roster?:RescheduleRoster;slots:TeamWindow[];after?:string;next:string|null}|null>(null);
  const [roster,setRoster]=useState<(CollectiveRosterPreview&{id:string})|null>(null);
  const [handoff,setHandoff]=useState<BookingHostOptions&{id:string}|null>(null);
  const [calendarId,setCalendarId]=useState(''),[slots,setSlots]=useState<TeamWindow[]>([]);
  const [selectedSlot,setSelectedSlot]=useState('');
  const [timesPage,setTimesPage]=useState<{after?:string;next:string|null}>({next:null});
  const [busy,setBusy]=useState(false),active=useRef(false),pending=useRef({key:'',id:''});
  const disclosure=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(initiallyExpanded&&disclosure.current)disclosure.current.open=true;},[initiallyExpanded]);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function run(work:()=>Promise<void>){
    if(active.current)return;
    active.current=true;setBusy(true);setError('');setMessage('');
    try{await work();}catch(error){setError(error instanceof Error?error.message:'Could not save. Refresh and try again.');}
    finally{active.current=false;setBusy(false);}
  }
  async function loadBookings(cursor:TeamBookingCursor|null,email=guestFilter,hostFilter=hostSearch,filter=bookingFilter){
    const params=new URLSearchParams(cursor?{bookingAfter:cursor.start,bookingId:cursor.id}:undefined);
    if(filter==='formerHosts')params.set('formerHosts','1');
    else if(filter==='outsideHours')params.set('outsideHours','1');
    else if(filter)params.set('duringTimeOff',filter==='mine'?'1':'team');
    if(email)params.set('guestEmail',email);
    if(hostFilter.query)params.set('hostSearch',hostFilter.query);
    if(hostFilter.after){
      params.set('hostAfterEmail',hostFilter.after.email);
      params.set('hostAfterId',hostFilter.after.id);
    }
    setState(await read<TeamSchedule>(params.size?url+'&'+params:url));
    setHostSearch(hostFilter);
    setGuestFilter(email);setBookingFilter(filter);
    setBookingPage(cursor);setRoster(null);setMove(null);setHandoff(null);
  }
  async function refresh(){
    await loadBookings(bookingPage);
    setSlots([]);setCalendarId('');setTimesPage({next:null});
  }
  function browseBookings(cursor:TeamBookingCursor|null,filter=bookingFilter,guest=guestFilter){
    void run(async()=>{
      await loadBookings(cursor,guest,hostSearch,filter);
      setGuestInput(guest);
      requestAnimationFrame(()=>{bookingsHeading.current?.focus();bookingsHeading.current?.scrollIntoView({block:'center'});});
    });
  }
  async function findTimes(id:string,after?:string,requireChoice=false){
    const params=new URLSearchParams({page:id,...after?{after}:{}});
    const result=await read<{slots:TeamWindow[];next:string|null}>(url+'&'+params);
    setSelectedSlot(requireChoice?'':result.slots[0]?.start??'');
    setSlots(result.slots);setCalendarId(id);setTimesPage({after,next:result.next});
  }
  async function findReplacement(id:string,original:string,after?:string,useRoster=false){
    const params=new URLSearchParams({move:id,...after?{after}:{},...useRoster?{useRoster:'1'}:{}});
    const result=await read<{slots:TeamWindow[];next:string|null;roster?:RescheduleRoster;original?:string}>(url+'&'+params);
    if(result.original&&result.original!==original){await refresh();throw Error('The booking time changed. Review the updated meeting.');}
    setRoster(null);setHandoff(null);setMove({id,original,after,...result});
  }
  async function findHosts(id:string,start:string){
    const options=await read<BookingHostOptions>(url+'&replaceHost='+id);
    if(options.start!==start){await refresh();throw Error('The booking time changed. Review the updated meeting.');}
    setRoster(null);setMove(null);setHandoff({id,...options});
  }
  async function reviewRoster(id:string){
    const preview=await read<CollectiveRosterPreview>(url+'&collectiveHosts='+id);
    setMove(null);setHandoff(null);setRoster({id,...preview});
  }
  async function save(input:TeamChange,notice:string){
    try{await read(url,input);}
    catch(error){
      if(error instanceof ApiError&&error.status===409){
        if(input.action==='book'){
          try{await findTimes(input.pageId,timesPage.after,true);}
          catch{setSlots([]);setCalendarId('');throw Error('Availability changed. Select Find a time to load the current choices.');}
        }
        if(input.action==='cancel')await refresh();
      }
      throw error;
    }
    await refresh();setMessage(notice);
    pending.current={key:'',id:''};
  }
  function submit(event:FormEvent<HTMLFormElement>,work:(fields:FormData)=>Promise<void>){
    event.preventDefault();const fields=new FormData(event.currentTarget);void run(()=>work(fields));
  }
  function requestId(key:string){
    if(pending.current.key!==key)pending.current={key,id:crypto.randomUUID()};
    return pending.current.id;
  }
  async function offer(fields:FormData){
    if(!state)return;
    const instant=(key:string)=>{
      const dates=scheduledInstants(String(fields.get(key)),zone);
      if(dates.length!==1)throw Error('Choose an unambiguous local time.');
      return dates[0];
    };
    const slot:TeamWindow={start:instant('start'),end:instant('end')};
    const minutes=(Date.parse(slot.end)-Date.parse(slot.start))/60_000;
    if(minutes<15||minutes>480)throw Error('Choose a window between 15 minutes and eight hours.');
    const provider=fields.get('check');
    if(provider==='live')slot.liveGoogle=true;
    if(provider==='google'||provider==='outlook'){
      const response=await fetch(provider==='google'?'/api/calendar/availability':'/api/outlook/availability',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(provider==='outlook'?slot:{...slot,timeZone:zone}),
      });
      const result=await response.json() as {availability?:string;error?:string};
      if(!response.ok||result.availability!=='free')throw Error(result.error??'The full window could not be confirmed free. Choose a different window.');
    }
    const windows=state.windows.filter(w=>Date.parse(w.end)>Date.now());
    if(!windows.some(w=>w.start===slot.start&&w.end===slot.end&&w.liveGoogle===slot.liveGoogle))windows.push(slot);
    await save({action:'offer',revision:state.revision,windows},'Availability saved.');
  }
  return <details className="portable-team-scheduling" ref={disclosure} onToggle={event=>{
    if(event.currentTarget.open&&!state)void run(refresh);
  }}>
    <summary>Team scheduling</summary>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <button type="button" disabled={busy} onClick={()=>void run(refresh)}>Refresh schedule</button>
    {state&&<fieldset disabled={busy}>
      <legend>My available times</legend>
      {!state.canEditAvailability?<div>
        <p>You have view access to this schedule.</p>
        {state.weekly&&<p>{state.weekly.days.map(day=>weekdays[day-1]).join(', ')} · {state.weekly.start}–{state.weekly.end} · {state.weekly.timeZone}</p>}
        {state.windows.map(w=><p key={w.start+w.end}>{format(w)}</p>)}
        {state.timeOff.map(period=><p key={timeOffLabel(period)}>Time off · {timeOffLabel(period)}</p>)}
      </div>:<>
      <p>Offer a window in {zone} for the next 14 days. Harbor checks its meeting reservations when someone books. Connected calendars can be checked when you add a window.</p>
      <details><summary>Weekly availability</summary>
        <p>{state.weekly?state.weekly.days.map(day=>weekdays[day-1]).join(', ')+' · '+state.weekly.start+'–'+state.weekly.end+(state.weekly.end<state.weekly.start?' (next day)':'')+' · '+state.weekly.timeZone:'Set recurring hours to offer times in the next 14 days.'}</p>
        <form key={state.revision} aria-label="Weekly availability" onSubmit={event=>submit(event,async fields=>{
          const days=fields.getAll('day').map(Number);
          if(!days.length)throw Error('Choose at least one weekday.');
          await save({action:'weekly',revision:state.revision,hours:{days,start:String(fields.get('start')),
            end:String(fields.get('end')),timeZone:String(fields.get('zone')),liveGoogle:fields.has('liveGoogle')}},'Weekly availability saved.');
        })}>
          <fieldset><legend>Days your shift starts</legend>{weekdays.map((name,i)=><label key={name}>
            <input name="day" type="checkbox" value={i+1} defaultChecked={state.weekly?.days.includes(i+1)??false}/>{name}</label>)}</fieldset>
          <label>Weekly start<input name="start" type="time" defaultValue={state.weekly?.start??'09:00'} required/></label>
          <label>Weekly end<input name="end" type="time" defaultValue={state.weekly?.end??'17:00'} required/></label>
          <p>An earlier end time falls on the following day. A shift can last up to eight hours.</p>
          <label>Time zone<input name="zone" defaultValue={state.weekly?.timeZone??zone} required maxLength={100}/></label>
          {(state.liveGoogle||state.weekly?.liveGoogle)&&<label><input type="checkbox" name="liveGoogle" defaultChecked={state.weekly?.liveGoogle}/>
            Check my shared Google free/busy when booking</label>}
          <button>Save weekly hours</button>{' '}
          {state.weekly&&<button type="button" onClick={()=>void run(()=>save({action:'weekly',revision:state.revision,hours:null},'Weekly availability removed.'))}>Remove weekly hours</button>}
        </form>
      </details>
      <details><summary>Time off{state.timeOff.length?' ('+state.timeOff.length+')':''}</summary>
        <p>Block time on all your team calendars in this workspace. Existing bookings stay on your schedule.</p>
        {state.timeOff.length>0&&<ul>{state.timeOff.map(period=><li key={[period.from,period.startTime,period.through,period.endTime,period.timeZone].join('/')}>
          {timeOffLabel(period)}{period.pauseLeadRouting?' · Lead routing paused':''}{' '}
          {!state.owner&&<button type="button" onClick={()=>void run(()=>save({action:'timeOff',operation:'add',
            period:{...period,pauseLeadRouting:!period.pauseLeadRouting},revision:state.revision},'Time off updated.'))}>
            {period.pauseLeadRouting?'Allow lead routing':'Pause lead routing'}</button>}{' '}
          <button type="button" aria-label={'Remove time off '+[period.from,period.startTime,'through',period.through,period.endTime,period.timeZone].filter(Boolean).join(' ')}
            onClick={()=>void run(()=>save({action:'timeOff',operation:'remove',period,revision:state.revision},'Time off removed.'))}>Remove</button>
        </li>)}</ul>}
        {state.timeOff.length>0&&<button type="button" onClick={()=>browseBookings(null,'mine','')}>Review bookings during my time off</button>}
        <form aria-label="Add time off" onSubmit={event=>submit(event,async fields=>{
          const from=String(fields.get('from')),through=String(fields.get('through')||from);
          if(through<from)throw Error('Choose a last day on or after the first day.');
          const times=timedLeave?{startTime:String(fields.get('startTime')),endTime:String(fields.get('endTime'))}:{};
          if(times.startTime&&times.endTime&&from===through&&times.startTime>=times.endTime)throw Error('Choose a later end time or enter the date the absence ends.');
          await save({action:'timeOff',operation:'add',revision:state.revision,period:{from,through,...times,timeZone:String(fields.get('zone')),
            pauseLeadRouting:fields.has('pauseLeadRouting')}},'Time off saved.');
        })}>
          <label>First day off<input name="from" type="date" required/></label>
          <label>Last day off (optional)<input name="through" type="date"/></label>
          <label><input type="checkbox" checked={timedLeave} onChange={event=>setTimedLeave(event.target.checked)}/>Set start and end times</label>
          {timedLeave&&<><label>Start time<input type="time" name="startTime" required/></label>
            <label>End time<input type="time" name="endTime" required/></label></>}
          <label>Time zone<input name="zone" defaultValue={state.weekly?.timeZone??zone} required maxLength={100}/></label>
          {!state.owner&&<label><input type="checkbox" name="pauseLeadRouting"/>Also pause automatic lead assignment during this time</label>}
          <button>Save time off</button>
        </form>
      </details>
      <ul>{state.windows.map(w=><li key={w.start+w.end+!!w.liveGoogle}>{format(w)}{w.liveGoogle?' · live Google check':''}{' '}
        <button type="button" onClick={()=>void run(()=>save({action:'offer',revision:state.revision,
          windows:state.windows.filter(other=>other!==w&&Date.parse(other.end)>Date.now())},'Window removed.'))}>Remove window</button></li>)}</ul>
      <form onSubmit={event=>submit(event,offer)}>
        <label>Start<input name="start" type="datetime-local" required/></label>
        <label>End<input name="end" type="datetime-local" required/></label>
        <label>Availability source<select name="check"><option value="manual">I’m available</option>
          {state.liveGoogle&&<option value="live">Let the organizer recheck my shared Google free/busy when booking</option>}
          <option value="google">Check my Google Calendar now</option><option value="outlook">Check my Outlook Calendar now</option></select></label>
        <button disabled={state.windows.length>=12}>Add available time</button>
      </form>
      </>}
      {state.owner&&<>
        <h3 ref={hostEditor} tabIndex={-1}>{editingHosts?'Edit hosts for '+editingHosts.title:'Team calendars'}</h3>
        <form onSubmit={event=>submit(event,()=>loadBookings(bookingPage,guestFilter,{query:hostInput.trim()}))}>
          <label>Find available hosts<input type="search" maxLength={160} value={hostInput} onChange={event=>setHostInput(event.target.value)}/></label>
          <button>Find hosts</button>
        </form>
        <form onSubmit={event=>submit(event,async fields=>{
          if(editingHosts){
            await save({action:'changeHosts',id:editingHosts.id,expectedHosts:editingHosts.hosts,hosts:selectedHosts.map(h=>h.id)},'Calendar hosts saved.');
            setEditingHosts(null);setSelectedHosts([]);return;
          }
          const config={title:String(fields.get('title')),mode:fields.get('mode') as 'collective'|'rotation',
            duration:Number(fields.get('duration')) as 15|30|60,hosts:selectedHosts.map(host=>host.id),publicEnabled:fields.has('public')};
          if(!config.hosts.length)throw Error('Choose at least one host.');
          await save({action:'create',id:requestId(JSON.stringify(config)),...config},'Calendar created.');setSelectedHosts([]);
        })}>
          {!editingHosts&&<><label>Calendar name<input name="title" required maxLength={100}/></label>
          <label>Booking method<select name="mode"><option value="collective">All hosts together</option><option value="rotation">Round robin</option></select></label>
          <label>Meeting length<select name="duration" defaultValue="30">{[15,30,60].map(n=><option key={n} value={n}>{n} minutes</option>)}</select></label></>}
          <fieldset><legend>Hosts</legend>
            {state.hosts.map(host=>{
              const checked=selectedHosts.some(h=>h.id===host.id);
              return <label key={host.id}><input type="checkbox" checked={checked} disabled={!checked&&selectedHosts.length>=12}
                onChange={()=>setSelectedHosts(checked?selectedHosts.filter(h=>h.id!==host.id):[...selectedHosts,host])}/>{host.label}</label>;
            })}
            {!state.hosts.length&&<p>{hostSearch.query?'No available hosts match your search.':'No available hosts on this page.'}</p>}
            {hostSearch.after&&<button type="button" onClick={()=>void run(()=>loadBookings(bookingPage,guestFilter,{query:hostSearch.query}))}>First hosts</button>}{' '}
            {state.nextHosts&&<button type="button" onClick={()=>void run(()=>loadBookings(bookingPage,guestFilter,{query:hostSearch.query,after:state.nextHosts??undefined}))}>More hosts</button>}
            {selectedHosts.length>0&&<div><p>{selectedHosts.length} of 12 hosts selected</p>
              {selectedHosts.filter(h=>!state.hosts.some(row=>row.id===h.id)).map(h=><button key={h.id} type="button"
                onClick={()=>setSelectedHosts(selectedHosts.filter(item=>item.id!==h.id))}>Remove {h.label}</button>)}</div>}
          </fieldset>
          {!editingHosts&&state.publicBooking&&<label><input type="checkbox" name="public"/>Let guests book by link after verifying their email</label>}
          <button disabled={!selectedHosts.length}>{editingHosts?'Save hosts':'Create calendar'}</button>
          {editingHosts&&<button type="button" onClick={()=>{setEditingHosts(null);setSelectedHosts([]);}}>Cancel host changes</button>}
        </form>
        <ul>{state.pages.map(page=><li key={page.id}><strong>{page.title}</strong> · {page.mode==='collective'?'All hosts':'Round robin'} · {page.duration} min{' '}
          <details><summary>Hosts ({page.hosts.length})</summary><p>{page.hosts.map(id=>page.hostLabels[id]).join(', ')}</p></details>
          <CalendarHostNotice page={page}/>
          {page.publicEnabled&&state.publicBooking&&<a href={'/availability/'+page.id}>Guest booking link</a>}{' '}
          <button type="button" onClick={()=>{
            setError('');setMessage('');setEditingHosts(page);setSelectedHosts(page.hosts.map(id=>({id,label:page.hostLabels[id]})));
            requestAnimationFrame(()=>{hostEditor.current?.focus();hostEditor.current?.scrollIntoView({block:'center'});});
          }}>Edit hosts</button>{' '}
          <button type="button" onClick={()=>void run(()=>findTimes(page.id))}>Find a time</button>{' '}
          <button type="button" onClick={()=>void run(()=>save({action:'close',id:page.id},'Calendar closed. Existing bookings remain on the schedule.'))}>Close calendar</button>
        </li>)}</ul>
        {calendarId&&(slots.length?<form onSubmit={event=>submit(event,async fields=>{
          const details={pageId:calendarId,email:String(fields.get('email')),start:String(fields.get('slot'))};
          await save({action:'book',id:requestId(JSON.stringify(details)),...details},'Meeting reserved in Harbor.');
        })}><label>Open times in {zone}<select name="slot" required value={selectedSlot} onChange={event=>setSelectedSlot(event.target.value)}>
            {!selectedSlot&&<option value="" disabled>Choose another time</option>}{slots.map(s=><option key={s.start} value={s.start}>{format(s)}</option>)}</select></label>
          <label>Guest email<input name="email" type="email" required/></label><button>Reserve in Harbor</button>
        </form>:<p>No open times. Check the hosts’ available windows.</p>)}
        {calendarId&&(timesPage.after||timesPage.next)&&<nav aria-label="Available time pages">
          {timesPage.after&&<button type="button" onClick={()=>void run(()=>findTimes(calendarId))}>Earliest times</button>}{' '}
          {timesPage.next&&<button type="button" onClick={()=>void run(()=>findTimes(calendarId,timesPage.next??undefined))}>Later times</button>}
        </nav>}
      </>}
      <h3 ref={bookingsHeading} tabIndex={-1}>{bookingFilter==='outsideHours'?'Bookings outside current hours':bookingFilter==='formerHosts'?'Bookings with former hosts':bookingFilter==='team'?'Team bookings during time off':bookingFilter==='mine'?'My bookings during time off':state.owner?'Upcoming team bookings':'My upcoming bookings'}</h3>
      {state.owner&&bookingFilter!=='team'&&<button type="button" onClick={()=>browseBookings(null,'team','')}>Review team bookings during time off</button>}
      {state.owner&&bookingFilter!=='formerHosts'&&<button type="button" onClick={()=>browseBookings(null,'formerHosts','')}>Review bookings with former hosts</button>}
      {bookingFilter!=='outsideHours'&&<button type="button" onClick={()=>browseBookings(null,'outsideHours','')}>Review bookings outside current hours</button>}
      {bookingFilter&&<button type="button" onClick={()=>browseBookings(null,null)}>Show all upcoming bookings</button>}
      <form onSubmit={event=>submit(event,fields=>loadBookings(null,String(fields.get('guest')).trim()))}>
        <label>Find bookings by guest email<input type="email" name="guest" value={guestInput} onChange={event=>setGuestInput(event.target.value)}/></label>
        <button>Find bookings</button>{' '}
        {guestFilter&&<button type="button" onClick={()=>void run(async()=>{await loadBookings(null,'');setGuestInput('');})}>Clear guest filter</button>}
      </form>
      {state.meetings.length?<ul>{state.meetings.map(m=><li key={m.id}><strong>{m.title}</strong> · {format(m)} · {m.email} · {m.hostNames.join(', ')}{' '}
        {m.outsideHoursHostNames&&<p>Outside current hours · {m.outsideHoursHostNames.join(', ')}</p>}
        {m.formerHostNames&&<p>Former host · {m.formerHostNames.join(', ')}</p>}
        {m.awayHostNames&&<p>Host on leave · {m.awayHostNames.join(', ')}</p>}
        {state.owner&&<>{m.multipleContacts&&<span>Multiple contacts use this guest email. </span>}
          <a href={enrollmentUrl('active',{bookingId:m.id})}>Review guest sequences</a>{' '}</>}
        <button type="button" onClick={()=>downloadBooking(m.id,m.title,m.start,m.end)}>Download calendar file</button>{' '}
        {m.canReschedule&&
          <button type="button" aria-expanded={move?.id===m.id} onClick={()=>move?.id===m.id?setMove(null):void run(()=>findReplacement(m.id,m.start))}>Reschedule</button>}{' '}
        {m.canReschedule&&state.pages.some(p=>p.id===m.pageId&&p.mode==='rotation')&&
          <button type="button" aria-expanded={handoff?.id===m.id} onClick={()=>handoff?.id===m.id?setHandoff(null):void run(()=>findHosts(m.id,m.start))}>Change host</button>}
        {m.canReschedule&&state.pages.some(p=>p.id===m.pageId&&p.mode==='collective')&&
          <button type="button" aria-expanded={roster?.id===m.id} onClick={()=>roster?.id===m.id?setRoster(null):void run(()=>reviewRoster(m.id))}>Review collective hosts</button>}
        {roster?.id===m.id&&(roster.changed?<div>
          <p>Currently booked · {roster.booked.map(h=>h.label).join(', ')}</p>
          <p>Calendar roster · {roster.proposed.map(h=>h.label).join(', ')}</p>
          {roster.available?<><p>The guest keeps the same time and booking link. Tell the guest and hosts about the change.</p>
            <button type="button" onClick={()=>void run(()=>save({action:'useCalendarHosts',id:m.id,expectedStart:roster.start,
              expectedHosts:roster.booked.map(h=>h.id),calendarHosts:roster.calendarHosts},'Collective hosts updated.'))}>Use calendar roster</button></>:
            <p>The calendar hosts are not all available at the booked time.</p>}
        </div>:<p>The booked hosts match the calendar roster.</p>)}
        {handoff?.id===m.id&&(handoff.hosts.length?<form onSubmit={event=>submit(event,fields=>save({action:'replaceHost',
          id:m.id,expectedStart:handoff.start,expectedHost:handoff.expectedHost,host:String(fields.get('host'))},'Booking host changed.'))}>
          <label>Available host at this time<select name="host">{handoff.hosts.map(person=><option value={person.id} key={person.id}>{person.label}</option>)}</select></label>
          <p>The guest keeps the same time. Let them know who will attend.</p><button>Save new host</button>
        </form>:<p>No other hosts on this calendar are available at the booked time.</p>)}
        {move?.id===m.id&&<form onSubmit={event=>submit(event,fields=>save({action:'reschedule',id:m.id,expectedStart:move.original,
          start:String(fields.get('replacement')),roster:move.roster},'Booking rescheduled.'))}>
          <label>Hosts for the new time<select value={move.roster?'roster':'booked'} onChange={event=>{
            const useRoster=event.target.value==='roster';
            void run(()=>findReplacement(m.id,m.start,undefined,useRoster));
          }}><option value="booked">Keep booked hosts</option><option value="roster">Use current calendar roster</option></select></label>
          {move.slots.length?<><label>New time in {zone}<select key={move.slots[0].start} name="replacement">{move.slots.map(slot=>
            <option value={slot.start} key={slot.start}>{format(slot)}</option>)}</select></label>
            <p>{move.roster?(state.pages.find(p=>p.id===m.pageId)?.mode==='rotation'?'Round robin will assign an available host.':'All current calendar hosts will attend.'):'The same hosts will attend.'} Share the updated time with your guest.</p><button>Save new time</button></>:<p>No other times available for these hosts.</p>}
          {move.after&&<button type="button" onClick={()=>void run(()=>findReplacement(m.id,move.original,undefined,!!move.roster))}>Earliest replacement times</button>}
          {move.next&&<button type="button" onClick={()=>void run(()=>findReplacement(m.id,move.original,move.next??undefined,!!move.roster))}>Later replacement times</button>}
        </form>}
        {state.owner&&<button type="button" onClick={()=>void run(()=>save({action:'cancel',id:m.id,expectedStart:m.start},'Booking cancelled.'))}>Cancel booking</button>}
      </li>)}</ul>:<p>{bookingPage?'No later bookings.':guestFilter?'No upcoming bookings for this guest.':bookingFilter==='outsideHours'?'No bookings outside current hours.':bookingFilter==='formerHosts'?'All booked hosts are on their calendars.':bookingFilter?'No bookings overlap time off.':'No upcoming bookings.'}</p>}
      {(bookingPage||state.nextBookings)&&<nav aria-label="Upcoming booking pages">
        {bookingPage&&<button type="button" onClick={()=>browseBookings(null)}>Earliest bookings</button>}{' '}
        {state.nextBookings&&<button type="button" onClick={()=>browseBookings(state.nextBookings)}>Later bookings</button>}
      </nav>}
    </fieldset>}
  </details>;
}
