import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyTeamBookings({request,origin,headers,other,sql,calendar:google,readMail}){
  const api='/api/workspaces';
  const get=(url,auth=headers)=>request(url,{headers:auth});
  const post=(url,body,auth=headers)=>request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function ok(pending){
    const response=await pending;
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name:'Scheduling rehearsal'}}));
  const sharing=await ok(post(api,{action:'grant',email:'other@example.test'}));
  let grant=sharing.viewers.find(v=>v.email==='other@example.test');
  // Several independent browser scenarios share these two fictional accounts.
  const resetFixtureBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const ownerPath=api+'?team=booking&workspaceId='+sharing.owned;
  let memberPath=ownerPath+'&grantId='+grant.id;
  const meetings='/?view=meetings',sharedMeetings=meetings+'&workspaceId='+sharing.owned;
  assert.match(await (await get(meetings)).text(),/<h1>Meetings<\/h1>/);
  assert.equal((await get(sharedMeetings,other)).status,404);
  assert.equal((await get(memberPath,other)).status,403);
  grant=(await ok(post(api,{action:'role',role:'editor',id:grant.id}))).viewers.find(v=>v.email==='other@example.test');
  memberPath=ownerPath+'&grantId='+grant.id;
  assert.match(await (await get(sharedMeetings,other)).text(),/<summary>Team scheduling<\/summary>/);
  const at=Math.ceil((Date.now()+86400000)/900000)*900000;
  const date=minutes=>new Date(at+minutes*60000).toISOString();
  const offer=(start,end,revision=0)=>({action:'offer',revision,windows:[{start:date(start),end:date(end)}]});
  const change=body=>ok(post(ownerPath,body));
  await change(offer(0,180));
  const windowsAt=(start,end)=>({start:date(start),end:date(end)});
  await ok(post(memberPath,{action:'offer',revision:0,windows:[
    windowsAt(30,70),windowsAt(70,120),{...windowsAt(45,60),liveGoogle:true},
    windowsAt(210,230),windowsAt(231,251),
  ]},other));
  assert.equal((await post(memberPath,offer(30,60),other)).status,409);
  const {hosts,publicBooking}=await ok(get(ownerPath));assert.equal(publicBooking,true);assert.equal(hosts.length,2);
  const calendar=(mode,publicEnabled)=>({action:'create',id:randomUUID(),title:'Fictional demo '+mode,hosts:hosts.map(h=>h.id),mode,duration:30,publicEnabled});
  const collective=calendar('collective',true),rotation={...calendar('rotation',false),title:'Fictional two-host rotation'};
  assert.equal((await post(memberPath,collective,other)).status,403);
  await change(collective);await change(rotation);
  const slots=async page=>(await ok(get(ownerPath+'&page='+page.id))).slots.map(s=>s.start);
  assert.deepEqual(await slots(collective),[30,45,60,75,90].map(date));
  assert.ok((await slots(rotation)).includes(date(0)));
  const memberOffer=hosts.find(host=>host.label.includes('other@example.test'));
  const issuesFor=async id=>(await ok(get(ownerPath))).pages.find(page=>page.id===id).hostIssues;
  const setMeetingAccess=async (view,edit)=>{
    const updated=await ok(post(api,{action:'tool_permissions',ids:[grant.id],tool:'meetings',policy:{view,edit,create:false,delete:false}}));
    grant=updated.viewers.find(v=>v.email==='other@example.test');memberPath=ownerPath+'&grantId='+grant.id;
  };
  await setMeetingAccess('none','none');
  assert.deepEqual(await issuesFor(collective.id),[{id:memberOffer.id,reason:'access'}]);
  assert.deepEqual(await slots(collective),[]);
  assert.ok((await slots(rotation)).includes(date(0)));
  const guestView=await get('/availability/'+collective.id,{});
  assert.equal(guestView.status,200);assert.doesNotMatch(await guestView.text(),/other@example.test|Scheduling access removed/);
  await setMeetingAccess('all','none');
  assert.deepEqual(await issuesFor(collective.id),[]);
  const memberRead=await ok(get(memberPath,other));
  assert.deepEqual(memberRead.pages,[]);assert.equal(memberRead.canEditAvailability,false);
  await setMeetingAccess('all','all');
  await ok(post(memberPath,{action:'offer',revision:memberRead.revision,windows:[]},other));
  assert.deepEqual(await issuesFor(rotation.id),[{id:memberOffer.id,reason:'hours'}]);
  await ok(post(memberPath,{action:'offer',revision:memberRead.revision+1,windows:memberRead.windows},other));
  assert.deepEqual(await issuesFor(rotation.id),[]);assert.ok((await slots(collective)).includes(date(60)));
  await resetFixtureBudgets();
  const book=(page,minute)=>({action:'book',pageId:page.id,id:randomUUID(),start:date(minute),email:'fictional@example.test'});
  assert.equal((await get(memberPath+'&page='+rotation.id,other)).status,404);
  assert.equal((await get(ownerPath+'&page='+randomUUID())).status,404);
  for(const minute of [31,105,210]){
    assert.equal((await post(ownerPath,book(collective,minute))).status,409,'Reject an off-grid start or one without full collective coverage.');
  }
  // The booking management screen looks up guest contacts. A slot-only request must be independent of that lookup.
  await sql.begin(async tx=>{
    await tx`LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE`;
    const later=await ok(get(ownerPath+'&page='+collective.id+'&after='+encodeURIComponent(date(46))));
    assert.deepEqual(later.slots.map(slot=>slot.start),[60,75,90].map(date));
  });
  assert.ok(!(await slots(rotation)).includes(date(210)),'An actual gap splits a host’s availability.');
  await google.mode('team_busy');
  assert.deepEqual(await slots(collective),[60,75,90].map(date),'A partial live window protects the whole overlapping meeting.');
  assert.equal((await post(ownerPath,book(collective,45))).status,409);
  assert.ok((await slots(rotation)).includes(date(45)),'A different available rep can cover that slot.');
  await google.mode('free');
  const requests=Array.from({length:4},()=>book(rotation,60));
  const responses=await Promise.all(requests.map(body=>post(ownerPath,body)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,200,409,409]);
  await change(requests[responses.findIndex(r=>r.ok)]);
  const booked=(await ok(get(ownerPath))).meetings;
  assert.equal(booked.length,2);assert.equal(new Set(booked.flatMap(m=>m.hostNames)).size,2);
  assert.equal((await ok(get(memberPath,other))).meetings.length,1);
  assert.ok(!(await slots(collective)).includes(date(45)));
  for(const meeting of booked)await change({action:'cancel',id:meeting.id});
  const guestPath='/api/public/availability/'+collective.id,guestId=randomUUID(),guest='team-booking@example.test';
  const {record:guestContact}=await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name:'Fictional booking contact',email:guest}}));
  const {sequence}=await ok(post('/api/sequences',{action:'save',id:randomUUID(),expectedRevision:0,name:'Demo follow-up',
    steps:[{id:randomUUID(),type:'task',delayDays:0,taskType:'Call',title:'Call about the demo',notes:''}]}));
  const [workspace]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.owned}`;
  const enroll=async(contactId=guestContact.id)=>{
    const id=randomUUID();
    await ok(post('/api/sequences',{action:'enroll',id,sequenceId:sequence.id,expectedRevision:sequence.revision,
      assigneeId:workspace.owner_id,contactId,recipient:null}));
    return id;
  };
  const bookingStopPending=async id=>(await ok(get('/api/sequences?enrollmentId='+id))).enrollment.bookingStopPending;
  const activeEnrollment=await enroll();
  const publicPage=await get('/availability/'+collective.id,{});
  assert.equal(publicPage.status,200);assert.ok(!(await publicPage.text()).includes('other@example.test'));
  assert.equal((await get('/availability/'+rotation.id,{})).status,404);
  await ok(post(guestPath,{action:'request',requestId:guestId,email:guest,start:date(60)},{}));
  assert.equal((await ok(get(ownerPath))).meetings.length,0);
  const code=(await readMail()).find(message=>message.address===guest)?.code;
  assert.ok(code,'the simulated provider received the verification code');
  assert.equal(await bookingStopPending(activeEnrollment),false);
  const proof={action:'verify',requestId:guestId,code};
  const [a,b]=await Promise.all([ok(post(guestPath,proof,{})),ok(post(guestPath,proof,{}))]);
  assert.equal(a.receipt,b.receipt);
  assert.equal(await bookingStopPending(activeEnrollment),true);
  await ok(post('/api/sequences',{action:'stop',id:activeEnrollment}));
  const nextEnrollment=await enroll();
  await ok(post(guestPath,proof,{}));
  assert.equal(await bookingStopPending(nextEnrollment),false);
  await ok(post('/api/sequences',{action:'stop',id:nextEnrollment}));
  const [confirmed]=(await ok(get(memberPath,other))).meetings;
  const outside=await ok(get(ownerPath+'&outsideHours=1&guestEmail='+guest));
  assert.deepEqual(outside.meetings,[],'A meeting spanning continuous offers is inside both hosts’ hours.');
  assert.equal(confirmed.email,guest);assert.equal(confirmed.hostNames.length,2);
  const personal=await ok(post('/api/calendar/availability',{start:date(60),end:date(90),timeZone:'UTC'}));
  assert.equal(personal.availability,'busy');assert.equal(personal.held,true);
  const status=()=>ok(post('/api/public/booking-status',{receipt:a.receipt},{}));
  assert.deepEqual(await status(),{state:'reserved',start:date(60),end:date(90),calendar:{id:guestId,title:collective.title}});
  const move=(expected,to,id=confirmed.id)=>({action:'reschedule',id,expectedStart:date(expected),start:date(to)});
  assert.equal((await get(memberPath+'&move='+confirmed.id,other)).status,404);
  assert.equal((await post(memberPath,move(60,75),other)).status,403);
  const alternatives=await ok(get(ownerPath+'&move='+confirmed.id));
  assert.deepEqual(alternatives.slots.map(s=>s.start),[30,45,75,90].map(date));
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const tab=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await tab.context().addCookies([{name,value,url:origin}]);
    await tab.goto(origin+meetings);
    await tab.getByRole('button',{name:'Reschedule',exact:true}).click();
    await tab.getByLabel('New time in').selectOption(date(75));
    await tab.getByRole('button',{name:'Save new time'}).click();
    await tab.getByText('Booking rescheduled.',{exact:true}).waitFor();
    await resetFixtureBudgets();
    await verifyBookingHostChange({tab,origin,meetings,ownerPath,memberPath,other,collectiveId:confirmed.id,rotation,hosts,book,change,post,get,ok,date,readMail});
    await resetFixtureBudgets();
    await verifyBookingSequenceReview({tab,origin,guest,rotation,enroll,book,change,get,post,ok,memberPath,other});
    await resetFixtureBudgets();
  }finally{await browser.close();}
  await change(move(60,75));
  assert.equal((await post(ownerPath,move(60,30))).status,409);
  const held=book(collective,30);
  await change(held);
  assert.equal((await post(ownerPath,move(75,30))).status,409);
  assert.deepEqual(await status(),{state:'reserved',start:date(75),end:date(105),calendar:{id:guestId,title:collective.title}});
  assert.deepEqual((await ok(get(memberPath,other))).meetings.find(m=>m.id===confirmed.id).hostNames,confirmed.hostNames);
  await change({action:'cancel',id:held.id});
  assert.ok((await slots(collective)).includes(date(45)));
  assert.ok(!(await slots(rotation)).includes(date(75)));
  await change({action:'close',id:collective.id});assert.equal((await get('/availability/'+collective.id,{})).status,404);
  assert.equal((await status()).state,'reserved');
  assert.equal((await post(ownerPath,move(75,30))).status,409);
  assert.equal((await post(ownerPath,collective)).status,409);
  await change({action:'cancel',id:confirmed.id});assert.equal((await status()).state,'cancelled');
  assert.ok((await slots(rotation)).includes(date(75)));
  const liveOffer=offer(30,120,(await ok(get(memberPath,other))).revision);liveOffer.windows[0].liveGoogle=true;
  await ok(post(memberPath,liveOffer,other));
  const liveCalendar=calendar('collective',false);
  await change(liveCalendar);
  await google.mode('free');assert.ok((await slots(liveCalendar)).includes(date(60)));
  for(const unavailable of ['team_busy','team_no_access']){
    await google.mode(unavailable);
    assert.deepEqual(await slots(liveCalendar),[]);
    assert.equal((await post(ownerPath,book(liveCalendar,60))).status,409);
    assert.ok((await slots(rotation)).includes(date(60)));
  }
  await google.mode('free');
  const first=book(rotation,30),second=book(rotation,90);
  await change(first);await change(second);
  const assigned=(await ok(get(ownerPath))).meetings;
  assert.equal(assigned.length,2);assert.notDeepEqual(assigned[0].hostNames,assigned[1].hostNames);
  const covered=assigned.find(meeting=>meeting.hostNames.some(label=>label.includes('owner@example.test')));
  const alternativesPath=ownerPath+'&replaceHost='+covered.id;
  const coverage=await ok(get(alternativesPath));
  assert.equal(coverage.hosts.length,1);
  await google.mode('team_busy');
  assert.deepEqual((await ok(get(alternativesPath))).hosts,[]);
  assert.equal((await post(ownerPath,{action:'replaceHost',id:covered.id,expectedStart:covered.start,
    expectedHost:coverage.expectedHost,host:coverage.hosts[0].id})).status,409);
  const unchanged=(await ok(get(ownerPath))).meetings.find(meeting=>meeting.id===covered.id);
  assert.deepEqual(unchanged.hostNames,covered.hostNames);
  await google.mode('free');
  const rotating=assigned[0];
  const to={action:'reschedule',id:rotating.id,expectedStart:rotating.start,start:date(45)};
  const siblingTime={...to,start:date(60)};
  const moved=await Promise.all([post(ownerPath,to),post(ownerPath,siblingTime)]);
  assert.deepEqual(moved.map(result=>result.status).sort(),[200,409]);
  const rescheduled=(await ok(get(ownerPath))).meetings.find(m=>m.id===rotating.id);
  assert.deepEqual(rescheduled.hostNames,rotating.hostNames);
  await change({...to,expectedStart:rescheduled.start,start:rotating.start});
  const liveBooking=book(liveCalendar,60);
  await change(liveBooking);
  for(const previous of [first,second])await change({action:'cancel',id:previous.id});
  assert.ok((await ok(get(ownerPath+'&move='+liveBooking.id))).slots.some(s=>s.start===date(75)));
  await google.mode('team_no_access');
  assert.equal((await post(ownerPath,{action:'reschedule',id:liveBooking.id,expectedStart:date(60),start:date(75)})).status,409);
  assert.equal((await ok(get(ownerPath))).meetings.find(m=>m.id===liveBooking.id).start,date(60));
  await google.mode('free');
  // The same rep can offer time in two workspaces. Only one booking may claim it.
  await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name:'Second scheduling workspace'}},other));
  const siblingPath=api+'?team=booking&workspaceId='+(await ok(get(api,other))).owned;
  await ok(post(siblingPath,offer(0,180),other));
  const [siblingHost]=(await ok(get(siblingPath,other))).hosts;
  const boundary={...calendar('rotation',false),hosts:[siblingHost.id]};
  await ok(post(siblingPath,boundary,other));
  const memberOnly={...calendar('rotation',false),hosts:[hosts.find(h=>h.label.includes('other@example.test')).id]};
  await change(memberOnly);
  for(const existing of (await ok(get(ownerPath))).meetings)await change({action:'cancel',id:existing.id});
  const race=await Promise.all([post(ownerPath,book(memberOnly,60)),post(siblingPath,book(boundary,60),other)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const after=await ok(get(siblingPath+'&page='+boundary.id,other));
  assert.ok(!after.slots.some(s=>s.start===date(75)));
  assert.ok(after.slots.some(s=>s.start===date(90)));
  const windows=Array.from({length:5},(_,day)=>({start:date((day+2)*1440),end:date((day+2)*1440+480)}));
  for(const [path,actor] of [[ownerPath,headers],[memberPath,other]]){
    const {revision}=await ok(get(path,actor));
    await ok(post(path,{action:'offer',revision,windows},actor));
  }
  const deep={...calendar('collective',true),title:'Fictional five-day coverage'};
  await change(deep);
  const firstTimes=await ok(get(ownerPath+'&page='+deep.id));
  assert.equal(firstTimes.slots.length,120);
  assert.equal(firstTimes.next,firstTimes.slots.at(-1).start);
  const laterTimes=await ok(get(ownerPath+'&page='+deep.id+'&after='+encodeURIComponent(firstTimes.next)));
  assert.equal(laterTimes.slots.length,35);
  assert.equal(laterTimes.next,null);
  assert.equal(new Set([...firstTimes.slots,...laterTimes.slots].map(slot=>slot.start)).size,155);
  assert.ok(laterTimes.slots[0].start>firstTimes.next);
  assert.equal((await get(ownerPath+'&page='+deep.id+'&after=invalid')).status,400);
  await resetFixtureBudgets();
  const laterPath=ownerPath+'&page='+deep.id+'&after='+encodeURIComponent(firstTimes.next);
  const siblingSlots=siblingPath+'&page='+boundary.id;
  const burstStart=performance.now();
  await Promise.all(Array.from({length:50},async(_,i)=>{
    const result=i%2?await ok(get(laterPath)):await ok(get(siblingSlots,other));
    assert.deepEqual(result,i%2?laterTimes:after);
  }));
  console.log('50 concurrent team availability reads across two workspaces: '+Math.round(performance.now()-burstStart)+' ms total');
  await resetFixtureBudgets();
  await verifyLaterTimeBooking({origin,headers,deep,firstTimes,laterTimes,readMail,ownerPath,get,post,ok});
  const lateBooking=(await ok(get(ownerPath))).meetings.find(m=>m.email==='later-time@example.test');
  assert.equal(lateBooking.start,laterTimes.slots.at(-1).start);
  assert.equal(lateBooking.hostNames.length,2);
  assert.equal((await post(ownerPath,{...book(deep,0),start:lateBooking.start})).status,409);
  const guestApi='/api/public/availability/'+deep.id,requestId=randomUUID(),address='changing-hosts@example.test';
  await ok(post(guestApi,{action:'request',requestId,email:address,start:firstTimes.slots[0].start},{}));
  const pendingCode=(await readMail()).find(m=>m.address===address)?.code;
  assert.ok(pendingCode);
  const remaining=hosts.find(h=>h.label.includes('other@example.test')),replacement={
    action:'changeHosts',id:deep.id,expectedHosts:deep.hosts,hosts:[remaining.id],
  };
  assert.equal((await post(memberPath,replacement,other)).status,403);
  assert.equal((await post(ownerPath,{...replacement,hosts:[randomUUID()]})).status,409);
  await change(replacement);await change(replacement);
  assert.equal((await post(ownerPath,{...replacement,hosts:deep.hosts})).status,409);
  const amended=(await ok(get(ownerPath))).pages.find(p=>p.id===deep.id);
  assert.deepEqual(amended.hosts,[remaining.id]);assert.equal(amended.publicEnabled,true);
  assert.equal((await get('/availability/'+deep.id,{})).status,200);
  const guestProof=await ok(post(guestApi,{action:'verify',requestId,code:pendingCode},{}));
  assert.ok(guestProof.receipt);
  const assignedNow=(await ok(get(ownerPath))).meetings.find(m=>m.email===address);
  assert.deepEqual(assignedNow.hostNames,[remaining.label]);
  const formerHosts=ownerPath+'&formerHosts=1';
  const former=(await ok(get(formerHosts))).meetings;
  assert.deepEqual(former.find(m=>m.id===lateBooking.id).formerHostNames,hosts.filter(h=>h.id!==remaining.id).map(h=>h.label));
  assert.ok(!former.some(m=>m.id===assignedNow.id));
  assert.deepEqual((await ok(get(formerHosts+'&guestEmail='+encodeURIComponent(address)))).meetings,[]);
  assert.equal((await get(memberPath+'&formerHosts=1',other)).status,403);
  assert.equal((await get(formerHosts+'&duringTimeOff=team')).status,400);
  const beforeMove=(await ok(get(ownerPath+'&move='+lateBooking.id))).slots[0];
  await change({action:'reschedule',id:lateBooking.id,expectedStart:lateBooking.start,start:beforeMove.start});
  const kept=(await ok(get(ownerPath))).meetings.find(m=>m.id===lateBooking.id);
  assert.deepEqual(kept.hostNames,lateBooking.hostNames);assert.equal(kept.start,beforeMove.start);
  const solo=hosts.find(h=>h.id!==remaining.id);
  const rosterPreview=id=>ok(get(ownerPath+'&collectiveHosts='+id));
  const adopt=(id,preview)=>({action:'useCalendarHosts',id,expectedStart:preview.start,
    expectedHosts:preview.booked.map(h=>h.id),calendarHosts:preview.calendarHosts});
  const reduction=await rosterPreview(kept.id);
  assert.ok(reduction.available&&reduction.changed);
  assert.deepEqual(reduction.proposed.map(h=>h.label),[remaining.label]);
  const shrink=adopt(kept.id,reduction);
  assert.equal((await get(memberPath+'&collectiveHosts='+kept.id,other)).status,403);
  assert.equal((await post(memberPath,shrink,other)).status,403);
  assert.equal((await post(ownerPath,{...shrink,expectedStart:lateBooking.start})).status,409);
  await change(shrink);await change(shrink);
  assert.deepEqual((await rosterPreview(kept.id)).booked.map(h=>h.label),[remaining.label]);
  const competing=await Promise.all([[solo.id],deep.hosts].map(ids=>post(ownerPath,{...replacement,expectedHosts:[remaining.id],hosts:ids})));
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
  const current=(await ok(get(ownerPath))).pages.find(p=>p.id===deep.id);
  await change({...replacement,expectedHosts:current.hosts,hosts:deep.hosts});
  assert.ok(!(await ok(get(formerHosts))).meetings.some(m=>m.id===lateBooking.id));
  const setLiveCalendar=async enabled=>ok(post(memberPath,{action:'offer',revision:(await ok(get(memberPath,other))).revision,
    windows:enabled?windows.map(slot=>({...slot,liveGoogle:true})):windows},other));
  await setLiveCalendar(true);
  const expansion=await rosterPreview(assignedNow.id);
  assert.ok(expansion.available&&expansion.changed);
  const grow=adopt(assignedNow.id,expansion);
  await google.mode('team_no_access');
  assert.equal((await post(ownerPath,grow)).status,409);
  assert.deepEqual((await rosterPreview(assignedNow.id)).booked.map(h=>h.label),[remaining.label]);
  await google.mode('free');
  const collectiveStatus=()=>ok(post('/api/public/booking-status',{receipt:guestProof.receipt},{}));
  const originalStatus=await collectiveStatus();
  const soloPage={...calendar('rotation',false),hosts:[solo.id]};
  await change(soloPage);
  const competingMeeting={...book(soloPage,0),start:assignedNow.start};
  await change(competingMeeting);
  assert.equal((await post(ownerPath,grow)).status,409);
  const blockedPreview=await rosterPreview(assignedNow.id);
  assert.equal(blockedPreview.available,false);
  assert.deepEqual(blockedPreview.booked.map(h=>h.label),[remaining.label]);
  await change({action:'cancel',id:competingMeeting.id});
  await change({...replacement,expectedHosts:deep.hosts,hosts:[remaining.id]});
  assert.equal((await post(ownerPath,grow)).status,409);
  await change({...replacement,expectedHosts:[remaining.id],hosts:deep.hosts});
  await resetFixtureBudgets();
  const rosterBrowser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await rosterBrowser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+meetings);
    const row=page.locator('li').filter({hasText:address});
    await row.getByRole('button',{name:'Review collective hosts'}).click();
    assert.match(await row.getByText(/^Calendar roster ·/).innerText(),/owner@example.test/);
    await row.getByRole('button',{name:'Use calendar roster'}).click();
    await page.getByText('Collective hosts updated.',{exact:true}).waitFor();
  }finally{await rosterBrowser.close();}
  await change(grow);
  const afterAdopt=await rosterPreview(assignedNow.id);
  assert.equal(afterAdopt.changed,false);
  assert.deepEqual(afterAdopt.booked.map(h=>h.label).sort(),[remaining.label,solo.label].sort());
  assert.deepEqual(await collectiveStatus(),originalStatus);
  await setLiveCalendar(false);
  for(const meeting of (await ok(get(ownerPath))).meetings)await change({action:'cancel',id:meeting.id});
  await resetFixtureBudgets();
  await verifyRosterRescheduling({ownerPath,memberPath,other,origin,headers,meetings,calendar,hosts,date,ok,get,post,change,readMail,chromium});
  await resetFixtureBudgets();
  await verifyWeeklyClockChanges(sql);
  await verifyWeeklyHours({origin,sharedMeetings,memberPath,ownerPath,other,get,post,ok,change,memberOnly,readMail,google,calendar});
  await resetFixtureBudgets();
  await verifyTimeOff({sql,origin,headers,sharedMeetings,memberPath,ownerPath,other,get,post,ok,change,memberOnly,calendar,readMail});
  await resetFixtureBudgets();
  await verifyUpcomingBookingPages({sql,change,remaining,workspaceId:sharing.owned,pageId:deep.id,ownerPath,memberPath,headers,other,get,ok,origin});
  await ok(post(api,{action:'revoke',id:grant.id}));assert.equal((await get(memberPath,other)).status,403);
  const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_team_availability WHERE grant_id=${grant.id}`;assert.equal(count,0);
  const afterRevocation=await ok(get(ownerPath));
  const firstFormer=await ok(get(formerHosts));
  assert.equal(firstFormer.meetings.length,100);
  assert.ok(firstFormer.meetings.every(m=>m.formerHostNames.length===1&&m.formerHostNames[0]===remaining.label));
  const tailFormer=await ok(get(formerHosts+'&'+new URLSearchParams({bookingAfter:firstFormer.nextBookings.start,bookingId:firstFormer.nextBookings.id})));
  assert.equal(tailFormer.meetings.length,4);
  assert.equal(tailFormer.nextBookings,null);
  assert.deepEqual((await ok(get(formerHosts+'&guestEmail=sales-guest%40example.test'))).meetings,[]);
  assert.equal(afterRevocation.hosts.length,1);
  assert.equal(afterRevocation.pages.find(p=>p.id===deep.id).hostLabels[remaining.id],'Former host');
  assert.deepEqual(await slots(deep),[]);
  assert.deepEqual(await issuesFor(deep.id),[{id:remaining.id,reason:'former'}]);
  const repairBrowser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const guestPage=await repairBrowser.newPage();
    const publicUrl=origin+'/availability/'+deep.id;
    await guestPage.goto(publicUrl);
    await guestPage.getByText('There are no open times on this page.',{exact:true}).first().waitFor();
    const page=await repairBrowser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+meetings);
    const row=page.locator('li').filter({has:page.getByText(deep.title,{exact:true})});
    await row.getByText('New bookings blocked',{exact:true}).waitFor();
    await row.getByText('Former host · Host offer no longer exists',{exact:true}).waitFor();
    const roundRobin=page.locator('li').filter({has:page.getByText(rotation.title,{exact:true})}).filter({has:page.getByRole('button',{name:'Edit hosts',exact:true})});
    await roundRobin.getByText('Round-robin coverage reduced',{exact:true}).waitFor();
    await row.getByRole('button',{name:'Edit hosts'}).click();
    await page.getByRole('button',{name:'Remove Former host',exact:true}).click();
    await page.getByRole('button',{name:'Save hosts',exact:true}).click();
    await page.getByText('Calendar hosts saved.',{exact:true}).waitFor();
    await row.getByLabel('Host coverage').waitFor({state:'detached'});
    await guestPage.reload();
    assert.equal(guestPage.url(),publicUrl);
    await guestPage.getByLabel('Meeting time').selectOption((await slots(deep))[0]);
  }finally{await repairBrowser.close();}
  assert.deepEqual(await issuesFor(deep.id),[]);
  assert.deepEqual((await ok(get(ownerPath))).pages.find(p=>p.id===deep.id).hosts,[solo.id]);
  assert.ok((await slots(deep)).length);
  assert.equal((await get('/availability/'+deep.id,{})).status,200);
  await verifyBookingHostPicker({sql,workspaceId:sharing.owned,ownerPath,headers,post,get,ok,origin,date});
}

async function verifyBookingSequenceReview({tab,origin,guest,rotation,enroll,book,change,get,post,ok,memberPath,other}){
  const makeContact=async(name,email)=>(await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name,email}}))).record;
  const duplicate=await makeContact('Second scheduling contact',guest);
  const unrelated=await makeContact('Unrelated sequence contact','another-guest@example.test');
  const firstRun=await enroll(),secondRun=await enroll(duplicate.id),otherRun=await enroll(unrelated.id);
  const ambiguous={...book(rotation,0),email:guest};
  await change(ambiguous);
  const review='/api/sequences?view=enrollments&state=active&bookingId='+ambiguous.id;
  const queue=await ok(get(review));
  assert.deepEqual(queue.items.map(row=>row.id).sort(),[firstRun,secondRun].sort());
  assert.ok(queue.items.every(row=>!row.bookingStopPending));
  assert.equal(queue.booking.email,guest);
  const next=await ok(get(review+'&after='+queue.items[0].id));
  assert.deepEqual(next.items.map(item=>item.id),[queue.items[1].id]);
  assert.equal((await get(review,other)).status,404);
  assert.equal((await get(review.replace(ambiguous.id,randomUUID()))).status,404);
  assert.ok((await ok(get(memberPath,other))).meetings.every(m=>!Object.hasOwn(m,'multipleContacts')));

  await tab.reload();
  const booking=tab.getByRole('listitem').filter({has:tab.getByText(rotation.title,{exact:true})})
    .filter({hasText:'Multiple contacts use this guest email.'});
  const link=booking.getByRole('link',{name:'Review guest sequences'});
  const path=await link.getAttribute('href');
  assert.equal(new URL((await get(path,{})).headers.get('location'),origin).searchParams.get('return_to'),path);
  await link.click();
  await tab.getByText('Contacts currently using '+guest,{exact:true}).waitFor();
  await tab.getByRole('link',{name:'Second scheduling contact · Demo follow-up'}).click();
  await tab.getByRole('button',{name:'Stop enrollment',exact:true}).click();
  await tab.getByRole('button',{name:'Confirm stop',exact:true}).click();
  await tab.getByText('Stopped',{exact:true}).first().waitFor();
  await tab.getByRole('link',{name:'Back to active enrollments'}).click();
  await tab.getByRole('link',{name:'Fictional booking contact · Demo follow-up'}).waitFor();
  assert.deepEqual((await ok(get(review))).items.map(row=>row.id),[firstRun]);
  assert.equal((await ok(get('/api/sequences?enrollmentId='+otherRun))).enrollment.state,'active');
  await tab.getByRole('link',{name:'Stopped',exact:true}).click();
  await tab.getByRole('link',{name:'Second scheduling contact · Demo follow-up'}).waitFor();
  await change({action:'cancel',id:ambiguous.id});
  for(const id of [firstRun,otherRun])await ok(post('/api/sequences',{action:'stop',id}));
}

async function verifyWeeklyClockChanges(client){
  await import('tsx/esm');
  const {weeklyOfferWindows}=await import('../db/postgres/team-booking-store.ts');
  const {PgDialect}=await import('drizzle-orm/pg-core');
  const {sql}=await import('drizzle-orm');
  async function weeklyBounds(asOf,start,end,weekday=7){
    const windows=weeklyOfferWindows(sql`${asOf}::timestamptz`);
    const query=new PgDialect().sqlToQuery(sql`SELECT win.starts,win.ends FROM
      (SELECT ARRAY[${weekday}::integer] AS weekly_days,'America/New_York' AS weekly_zone,${start}::time AS weekly_start,
        ${end}::time AS weekly_end,false AS weekly_live) o
      CROSS JOIN LATERAL (${windows}) win WHERE win.starts<win.ends ORDER BY win.starts`);
    const rows=await client.unsafe(query.sql,query.params);
    return rows.map(row=>[new Date(row.starts).toISOString(),new Date(row.ends).toISOString()]);
  }
  const sundays=async(...args)=>(await weeklyBounds(...args)).map(([starts])=>starts);
  // Early Sunday still sees Saturday night's shift across both clock changes.
  for(const [now,start,end] of [
    ['2026-03-08T05:30:00Z','2026-03-08T03:00:00.000Z','2026-03-08T10:00:00.000Z'],
    ['2026-11-01T04:30:00Z','2026-11-01T02:00:00.000Z','2026-11-01T11:00:00.000Z'],
  ])assert.deepEqual((await weeklyBounds(now,'22:00','06:00',6))[0],[start,end]);
  const skipped=await weeklyBounds('2026-03-08T05:30:00Z','22:00','02:30',6);
  assert.ok(skipped.length>0&&skipped.every(([start])=>start>'2026-03-09'));
  assert.deepEqual(await sundays('2026-03-01T05:00:00Z','09:00','10:00'),
    ['2026-03-01T14:00:00.000Z','2026-03-08T13:00:00.000Z']);
  assert.deepEqual(await sundays('2026-03-01T05:00:00Z','02:30','03:30'),['2026-03-01T07:30:00.000Z']);
  assert.deepEqual(await sundays('2026-10-25T04:00:00Z','09:00','10:00'),
    ['2026-10-25T13:00:00.000Z','2026-11-01T14:00:00.000Z']);
}

async function verifyWeeklyHours({origin,sharedMeetings,memberPath,ownerPath,other,get,post,ok,change,memberOnly,readMail,google,calendar}){
  const before=await ok(get(memberPath,other));
  const day=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  const first=new Date(day+'T23:30:00+05:45');
  const nextWeek=new Date(+first+7*86400000).toISOString();
  const weekday=first.getUTCDay()||7;
  const hours={timeZone:'Asia/Kathmandu',days:[weekday],start:'23:30',end:'01:00',liveGoogle:true};
  const edit={action:'weekly',revision:before.revision,hours};
  assert.equal((await post(memberPath,{...edit,hours:{...hours,timeZone:'Missing/Zone'}},other)).status,400);
  for(const end of ['23:30','23:44','07:31'])assert.equal((await post(memberPath,{...edit,hours:{...hours,end}},other)).status,400);
  assert.equal((await post(ownerPath,edit,other)).status,403);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+sharedMeetings);
    await page.getByText('Weekly availability',{exact:true}).click();
    const form=page.getByRole('form',{name:'Weekly availability'});
    await form.getByLabel(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][weekday-1],{exact:true}).check();
    await form.getByLabel('Time zone').fill(hours.timeZone);
    await form.getByLabel('Check my shared Google free/busy when booking').check();
    await form.getByLabel('Weekly start').fill(hours.start);
    await form.getByLabel('Weekly end').fill(hours.end);
    await form.getByRole('button',{name:'Save weekly hours'}).click();
    await page.getByText('Weekly availability saved.',{exact:true}).waitFor();
    await page.getByText(/23:30–01:00 \(next day\)/).waitFor();
  }finally{await browser.close();}
  const saved=await ok(get(memberPath,other));
  assert.deepEqual(saved.weekly,hours);
  assert.deepEqual(saved.windows,before.windows);
  assert.equal((await post(memberPath,{...edit,hours:null},other)).status,409);
  const oneOff={action:'offer',revision:saved.revision,windows:[]};
  await ok(post(memberPath,oneOff,other));
  assert.deepEqual((await ok(get(memberPath,other))).weekly,hours);
  assert.ok((await ok(get(ownerPath))).hosts.some(h=>h.id===memberOnly.hosts[0]));
  const list=async()=> (await ok(get(ownerPath+'&page='+memberOnly.id+'&after='+encodeURIComponent(new Date(+first-900000).toISOString())))).slots.map(s=>s.start);
  assert.deepEqual(await list(),[0,15,30,45,60,10080,10095,10110,10125,10140].map(minutes=>new Date(+first+minutes*60000).toISOString()));
  const booking={action:'book',id:randomUUID(),pageId:memberOnly.id,start:new Date(+first+45*60000).toISOString(),email:'weekly-guest@example.test'};
  await google.mode('team_busy');
  assert.deepEqual(await list(),[]);
  assert.equal((await post(ownerPath,booking)).status,409);
  await google.mode('free');
  const owner=await ok(get(ownerPath));
  const nextMorning={...hours,days:[weekday%7+1],start:'00:15',end:'01:15',liveGoogle:false};
  // Isolate this weekly-overlap check from the five-day one-off windows set up earlier.
  await change({action:'offer',revision:owner.revision,windows:[]});
  await change({action:'weekly',revision:owner.revision+1,hours:nextMorning});
  const joint=calendar('collective',true);
  await change(joint);
  const overlap=await ok(get(ownerPath+'&page='+joint.id+'&after='+encodeURIComponent(first.toISOString())));
  assert.deepEqual(overlap.slots.map(slot=>slot.start),[45,60,10125,10140].map(minutes=>new Date(+first+minutes*60000).toISOString()));
  const guestApi='/api/public/availability/'+joint.id;
  const start=await post(guestApi,{action:'request',requestId:booking.id,email:booking.email,start:booking.start},{});
  assert.equal(start.status,202,await start.clone().text());
  const code=(await readMail()).find(mail=>mail.address===booking.email)?.code;
  assert.ok(code);
  const verify=()=>ok(post(guestApi,{action:'verify',requestId:booking.id,code},{}));
  const proof=await verify();
  assert.ok(proof.receipt);
  assert.equal((await verify()).receipt,proof.receipt);
  const jointBooking=(await ok(get(ownerPath))).meetings.find(m=>m.id===booking.id);
  assert.equal(jointBooking.hostNames.length,2);
  const filter='&outsideHours=1&guestEmail='+booking.email;
  const review=async(path,actor)=>(await ok(get(path+filter,actor))).meetings;
  assert.deepEqual(await review(ownerPath),[]);
  assert.equal((await get(ownerPath+filter+'&formerHosts=1')).status,400);
  assert.equal((await get(ownerPath+filter+'&page='+joint.id)).status,400);
  assert.ok(!(await list()).includes(booking.start));
  assert.equal((await post(ownerPath,{...booking,id:randomUUID()})).status,409);
  await ok(post(memberPath,{action:'weekly',revision:saved.revision+1,hours:null},other));
  assert.ok(!(await list()).includes(nextWeek));
  const [rep]=jointBooking.hostNames.filter(label=>label.includes('other@example.test'));
  const [organizer]=jointBooking.hostNames.filter(label=>label.includes('owner@example.test'));
  for(const [path,actor] of [[ownerPath,undefined],[memberPath,other]]){
    const [conflict]=await review(path,actor);
    assert.equal(conflict.id,booking.id);
    assert.deepEqual(conflict.outsideHoursHostNames,[rep]);
  }
  const phone=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await phone.newPage({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+sharedMeetings);
    await page.getByRole('button',{name:'Review bookings outside current hours'}).click();
    await page.getByRole('heading',{name:'Bookings outside current hours'}).waitFor();
    await page.getByText('Outside current hours · '+rep,{exact:true}).first().waitFor();
  }finally{await phone.close();}
  const half=new Date(Date.parse(booking.start)+900000).toISOString();
  const cover=async(revision,end)=>ok(post(memberPath,{...oneOff,revision,windows:[{start:booking.start,end}]},other));
  await cover(saved.revision+2,half);
  assert.deepEqual((await review(ownerPath))[0].outsideHoursHostNames,[rep]);
  await cover(saved.revision+3,jointBooking.end);
  assert.deepEqual(await review(ownerPath),[]);
  await change({action:'weekly',revision:owner.revision+2,hours:null});
  assert.deepEqual((await review(ownerPath))[0].outsideHoursHostNames,[organizer]);
  assert.deepEqual(await review(memberPath,other),[]);
  assert.ok((await ok(get(memberPath,other))).meetings.some(m=>m.id===booking.id));
  await change({action:'cancel',id:booking.id});
  assert.deepEqual(await review(ownerPath),[]);
  // Restore the schedule before the existing revoke/rejoin rehearsal.
  await change({action:'weekly',revision:owner.revision+3,hours:owner.weekly});
  await change({action:'offer',revision:owner.revision+4,windows:owner.windows});
  await ok(post(memberPath,{...oneOff,revision:saved.revision+4,windows:before.windows},other));
  await ok(post(memberPath,{...edit,hours:{...hours,start:'09:00',end:'10:00'},revision:saved.revision+5},other));
}

async function verifyTimeOff({sql,origin,headers,sharedMeetings,memberPath,ownerPath,other,get,post,ok,change,memberOnly,calendar,readMail}){
  const owner=await ok(get(ownerPath)),rep=await ok(get(memberPath,other));
  const day=new Date(Date.now()+3*86400000);
  while((day.getUTCDay()||7)!==rep.weekly.days[0])day.setUTCDate(day.getUTCDate()+1);
  const from=day.toISOString().slice(0,10);
  const through=new Date(+day+86400000).toISOString().slice(0,10);
  const midnight=Date.parse(from+'T00:00:00+05:45'),at=minutes=>new Date(midnight+minutes*60000).toISOString();
  const end=2*24*60,period={from,through,timeZone:'Asia/Kathmandu'};
  const windows=[{start:at(-60),end:at(120)},{start:at(end-60),end:at(end+60)}];
  await change({action:'offer',windows,revision:owner.revision});
  await ok(post(memberPath,{action:'offer',windows,revision:rep.revision},other));
  const collective=calendar('collective',true),rotating=calendar('rotation',false);
  await change(collective);await change(rotating);
  const slots=async page=>(await ok(get(ownerPath+'&page='+page.id+'&after='+encodeURIComponent(at(-61))))).slots.map(slot=>slot.start);
  const before=await slots(collective);
  const guestApi='/api/public/availability/'+collective.id;
  const pending={action:'request',requestId:randomUUID(),start:at(0),email:'time-off-guest@example.test'};
  await ok(post(guestApi,pending,{}));
  const code=(await readMail()).find(m=>m.address===pending.email)?.code;
  assert.ok(code);
  const book=(page,minutes)=>({action:'book',id:randomUUID(),pageId:page.id,start:at(minutes),email:'existing-meeting@example.test'});
  const confirmed=book(collective,60);
  await change(confirmed);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+sharedMeetings);
    await page.getByText('Time off',{exact:true}).click();
    const form=page.getByRole('form',{name:'Add time off'});
    await form.getByLabel('First day off').fill(from);
    await form.getByLabel('Set start and end times').check();
    await form.getByLabel('Start time',{exact:true}).fill('00:00');
    await form.getByLabel('End time',{exact:true}).fill('00:30');
    await form.getByRole('button',{name:'Save time off'}).click();
    const firstBreak=page.getByRole('button',{name:'Remove time off '+from+' 00:00 through '+from+' 00:30 '+period.timeZone});
    await firstBreak.waitFor();
    const partial=await slots(collective);
    assert.ok(partial.includes(at(-30))&&partial.includes(at(30)));
    assert.ok(!partial.includes(at(-15))&&!partial.includes(at(15)));
    // A second absence on the same date can flag an existing booking independently.
    await form.getByLabel('Start time',{exact:true}).fill('01:05');
    await form.getByLabel('End time',{exact:true}).fill('01:20');
    await form.getByRole('button',{name:'Save time off'}).click();
    const secondBreak=page.getByRole('button',{name:'Remove time off '+from+' 01:05 through '+from+' 01:20 '+period.timeZone});
    await secondBreak.waitFor();
    await firstBreak.click();
    await firstBreak.waitFor({state:'detached'});
    assert.ok((await slots(collective)).includes(at(0)));
    assert.deepEqual((await ok(get(memberPath+'&duringTimeOff=1',other))).meetings.map(row=>row.id),[confirmed.id]);
    await secondBreak.click();
    await secondBreak.waitFor({state:'detached'});
    await form.getByLabel('Set start and end times').uncheck();
    await form.getByLabel('Last day off').fill(through);
    assert.equal(await form.getByLabel('Time zone').inputValue(),period.timeZone);
    await form.getByLabel('Also pause automatic lead assignment during this time').check();
    await form.getByRole('button',{name:'Save time off'}).click();
    await page.getByText('Time off saved.',{exact:true}).waitFor();
    assert.deepEqual((await ok(get(memberPath,other))).timeOff,[{...period,pauseLeadRouting:true}]);
    await page.getByRole('button',{name:'Allow lead routing',exact:true}).click();
    await page.getByRole('button',{name:'Pause lead routing',exact:true}).waitFor();
    const saved=await ok(get(memberPath,other));
    assert.deepEqual(saved.timeOff,[{...period,pauseLeadRouting:false}]);
    assert.deepEqual((await ok(get(ownerPath))).timeOff,[]);
    assert.equal((await post(memberPath,{action:'timeOff',operation:'remove',period,revision:saved.revision-1},other)).status,409);
    const held=await slots(collective);
    assert.ok(held.includes(at(-30))&&held.includes(at(end)));
    for(const minute of [-15,0,15,end-15]){
      assert.ok(before.includes(at(minute)));
      assert.ok(!held.includes(at(minute)));
    }
    assert.ok(!(await slots(memberOnly)).includes(at(9*60)),'Recurring hours are also blocked');
    assert.equal((await post(guestApi,{action:'verify',requestId:pending.requestId,code},{})).status,409);
    assert.equal((await post(guestApi,{...pending,requestId:randomUUID()},{})).status,409);
    assert.ok(saved.meetings.some(m=>m.id===confirmed.id));
    const reassigned=book(rotating,0);
    await change(reassigned);
    const meeting=(await ok(get(ownerPath))).meetings.find(m=>m.id===reassigned.id);
    assert.equal(meeting.hostNames.length,1);assert.match(meeting.hostNames[0],/owner@example\.test/);
    await page.getByRole('button',{name:'Review bookings during my time off'}).click();
    const heading=page.getByRole('heading',{name:'My bookings during time off'});
    await heading.waitFor();
    await page.waitForFunction(()=>document.activeElement?.textContent==='My bookings during time off');
    const affected=await ok(get(memberPath+'&duringTimeOff=1',other));
    assert.deepEqual(affected.meetings.map(m=>m.id),[confirmed.id]);
    assert.deepEqual((await ok(get(ownerPath+'&duringTimeOff=1'))).meetings,[]);
    assert.equal((await get(memberPath+'&duringTimeOff=team',other)).status,403);
    assert.equal(await page.getByRole('button',{name:'Review team bookings during time off'}).count(),0);
    const teamConflicts=ownerPath+'&duringTimeOff=team';
    const conflicts=await ok(get(teamConflicts));
    assert.deepEqual(conflicts.meetings.map(m=>m.id),[confirmed.id]);
    assert.equal(conflicts.meetings[0].awayHostNames.length,1);
    assert.match(conflicts.meetings[0].awayHostNames[0],/other@example\.test/);
    assert.deepEqual((await ok(get(teamConflicts+'&guestEmail=absent%40example.test'))).meetings,[]);
    const organizer=await browser.newPage({viewport:{width:390,height:844}});
    const [ownerCookie,ownerValue]=headers.cookie.split('=');
    await organizer.context().addCookies([{name:ownerCookie,value:ownerValue,url:origin}]);
    await organizer.goto(origin+'/?view=meetings');
    await organizer.getByRole('button',{name:'Review team bookings during time off'}).click();
    await organizer.getByRole('heading',{name:'Team bookings during time off'}).waitFor();
    const conflict=organizer.locator('li').filter({has:organizer.getByText(/Host on leave · .*other@example\.test/)});
    await conflict.getByRole('button',{name:'Reschedule'}).click();
    await conflict.getByLabel(/New time in/).selectOption(at(end));
    await conflict.getByRole('button',{name:'Save new time'}).click();
    await organizer.getByText('No bookings overlap time off.',{exact:true}).waitFor();
    const moved=(await ok(get(memberPath,other))).meetings.find(m=>m.id===confirmed.id);
    assert.equal(moved.start,at(end));
    assert.deepEqual(moved.hostNames,conflicts.meetings[0].hostNames);
    assert.deepEqual((await ok(get(memberPath+'&duringTimeOff=1',other))).meetings,[]);
    await organizer.close();
    await page.getByRole('button',{name:'Show all upcoming bookings'}).click();
    await page.getByRole('heading',{name:'My upcoming bookings'}).waitFor();
    await change({action:'cancel',id:reassigned.id});
    await page.getByRole('button',{name:/Remove time off/}).click();
    await page.getByText('Time off removed.',{exact:true}).waitFor();
    assert.ok((await slots(collective)).includes(at(0)));
    assert.ok((await slots(memberOnly)).includes(at(9*60)));
  }finally{await browser.close();}
  await change({action:'cancel',id:confirmed.id});
  await change({action:'offer',windows:owner.windows,revision:owner.revision+1});
  await ok(post(memberPath,{action:'offer',windows:rep.windows,revision:(await ok(get(memberPath,other))).revision},other));
  const year=new Date().getUTCFullYear()+1;
  let revision=(await ok(get(memberPath,other))).revision;
  for(const [month,week,hours] of [[2,2,23],[10,1,25]]){
    const firstOfMonth=new Date(Date.UTC(year,month,1));
    const sunday=1+(7-firstOfMonth.getUTCDay())%7+7*(week-1);
    const date=new Date(Date.UTC(year,month,sunday)).toISOString().slice(0,10);
    const period={from:date,through:date,timeZone:'America/New_York'};
    await ok(post(memberPath,{action:'timeOff',operation:'add',period,revision:revision++},other));
    const [row]=await sql`SELECT (p->>'endMs')::bigint-(p->>'startMs')::bigint AS length
      FROM portable_team_availability o CROSS JOIN LATERAL jsonb_array_elements(o.time_off) p
      WHERE o.id=${memberOnly.hosts[0]} AND p->>'from'=${date}`;
    assert.equal(Number(row.length),hours*3600000);
    // Overnight time off ends at the selected clock time on the second date.
    const prior=new Date(Date.parse(date+'T12:00:00Z')-86400000).toISOString().slice(0,10);
    const overnight={...period,from:prior,startTime:'23:45',endTime:'00:15'};
    await ok(post(memberPath,{action:'timeOff',operation:'add',period:overnight,revision:revision++},other));
    const [night]=await sql`SELECT (p->>'endMs')::bigint-(p->>'startMs')::bigint AS length
      FROM portable_team_availability o CROSS JOIN LATERAL jsonb_array_elements(o.time_off) p
      WHERE o.id=${memberOnly.hosts[0]} AND p->>'from'=${prior}`;
    assert.equal(Number(night.length),30*60000);
    await ok(post(memberPath,{action:'timeOff',operation:'remove',period:overnight,revision:revision++},other));

    const timed={...period,startTime:hours===23?'02:10':'01:10',endTime:hours===23?'03:20':'01:20'};
    if(hours===23){
      for(const clocks of [{startTime:'12:00'},{endTime:'13:00'},{startTime:'13:00',endTime:'12:00'}]){
        assert.equal((await post(memberPath,{action:'timeOff',operation:'add',period:{...period,...clocks},revision},other)).status,400);
      }
      const rejected=await post(memberPath,{action:'timeOff',operation:'add',period:timed,revision},other);
      assert.equal(rejected.status,400);
      assert.match(await rejected.text(),/local time does not exist/);
    }else{
      await ok(post(memberPath,{action:'timeOff',operation:'add',period:timed,revision:revision++},other));
      const [repeat]=await sql`SELECT p->>'startMs' AS start,p->>'endMs' AS finish FROM portable_team_availability o
        CROSS JOIN LATERAL jsonb_array_elements(o.time_off) p WHERE o.id=${memberOnly.hosts[0]} AND p->>'startTime'='01:10'`;
      assert.equal(Number(repeat.start),Date.parse(date+'T01:10:00-04:00'));
      assert.equal(Number(repeat.finish),Date.parse(date+'T01:20:00-05:00'));
      await ok(post(memberPath,{action:'timeOff',operation:'remove',period:timed,revision:revision++},other));
    }
    await ok(post(memberPath,{action:'timeOff',operation:'remove',period,revision:revision++},other));
  }
}

async function verifyBookingHostPicker({sql,workspaceId,ownerPath,headers,post,get,ok,origin,date}){
  const available=[{start:date(0),end:date(120)}];
  const expired=[{start:'2020-01-01T10:00:00Z',end:'2020-01-01T12:00:00Z'}];
  const seeded=await sql`WITH people AS (
    INSERT INTO login_identities(id,google_subject,email,full_name,created_at,updated_at)
    SELECT 'booking-host-'||n,'booking-host-'||n,'rep'||lpad(n::text,2,'0')||'@example.test',
      CASE WHEN n=22 THEN 'Solutions Engineer' ELSE 'Demo team' END,0,0 FROM generate_series(1,23) n RETURNING id,email
  ), grants AS (
    INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role)
    SELECT ${workspaceId},id,gen_random_uuid(),'editor' FROM people RETURNING viewer_id,id
  ) INSERT INTO portable_team_availability(id,workspace_id,user_id,grant_id,windows,revision)
    SELECT gen_random_uuid(),${workspaceId},p.id,g.id,
      CASE WHEN p.email='rep23@example.test' THEN ${sql.json(expired)}::jsonb ELSE ${sql.json(available)}::jsonb END,1
    FROM people p JOIN grants g ON g.viewer_id=p.id RETURNING id,user_id`;
  const first=await ok(get(ownerPath));
  assert.equal(first.hosts.length,20);
  const next=new URLSearchParams({hostAfterEmail:first.nextHosts.email,hostAfterId:first.nextHosts.id});
  const last=await ok(get(ownerPath+'&'+next));
  assert.equal(last.nextHosts,null);
  assert.equal(new Set([...first.hosts,...last.hosts].map(h=>h.id)).size,23);
  assert.equal((await ok(get(ownerPath+'&hostSearch=rep23'))).hosts.length,0);
  const calendar={action:'create',mode:'collective',duration:30,title:'Cross-page demo',id:randomUUID()};
  const expiredId=seeded.find(h=>h.user_id==='booking-host-23').id;
  assert.equal((await post(ownerPath,{...calendar,hosts:[expiredId]})).status,409);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=meetings');
    await page.getByLabel('Calendar name').fill(calendar.title);
    await page.getByRole('checkbox',{name:/rep01@example.test/}).check();
    await page.getByRole('button',{name:'More hosts'}).click();
    await page.getByRole('checkbox',{name:/rep22@example.test/}).check();
    await page.getByLabel('Find available hosts').fill('solutions engineer');
    await page.getByRole('button',{name:'Find hosts',exact:true}).click();
    await page.getByRole('checkbox',{name:/rep21@example.test/}).waitFor({state:'hidden'});
    assert.equal(await page.getByRole('group',{name:'Hosts',exact:true}).getByRole('checkbox').count(),1);
    assert.equal(await page.getByRole('checkbox',{name:/rep22@example.test/}).isChecked(),true);
    const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('team=booking'));
    await page.getByRole('button',{name:'Create calendar'}).click();
    const response=await submitted;
    assert.equal(response.status(),200,await response.text());
    await page.getByText('Calendar created.',{exact:true}).waitFor();
    const created=(await ok(get(ownerPath))).pages.find(p=>p.title===calendar.title);
    assert.deepEqual(created.hosts.sort(),seeded.filter(h=>['booking-host-1','booking-host-22'].includes(h.user_id)).map(h=>h.id).sort());
    const slot=(await ok(get(ownerPath+'&page='+created.id))).slots[0];
    const id=randomUUID();
    await ok(post(ownerPath,{action:'book',id,pageId:created.id,start:slot.start,email:'demo-guest@example.test'}));
    const {meetings}=await ok(get(ownerPath+'&guestEmail=demo-guest%40example.test'));
    assert.deepEqual(meetings.find(m=>m.id===id).hostNames,['Demo team · rep01@example.test','Solutions Engineer · rep22@example.test']);
    await page.locator('li').filter({has:page.getByText(calendar.title,{exact:true})}).getByRole('button',{name:'Edit hosts'}).click();
    const editor=page.getByRole('heading',{name:'Edit hosts for '+calendar.title});
    await editor.waitFor();
    await page.getByRole('button',{name:/Remove Demo team · rep01@example.test/}).click();
    await page.getByRole('button',{name:'Save hosts',exact:true}).click();
    await page.getByText('Calendar hosts saved.',{exact:true}).waitFor();
    assert.deepEqual((await ok(get(ownerPath))).pages.find(p=>p.id===created.id).hosts,[seeded.find(h=>h.user_id==='booking-host-22').id]);
  }finally{await browser.close();}
}

async function verifyLaterTimeBooking({origin,headers,deep,firstTimes,laterTimes,readMail,ownerPath,get,post,ok}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const owner=await browser.newContext(),guest=await browser.newContext({timezoneId:'Asia/Kathmandu',viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await owner.addCookies([{name,value,url:origin}]);
    const staff=await owner.newPage();
    await staff.goto(origin+'/?view=meetings');
    await staff.locator('li').filter({has:staff.getByText(deep.title,{exact:true})}).getByRole('button',{name:'Find a time'}).click();
    await staff.getByRole('button',{name:'Later times'}).click();
    const select=staff.locator('select[name="slot"]');
    await select.selectOption(laterTimes.slots.at(-1).start);
    assert.equal(await select.locator('option').count(),35);
    await staff.getByRole('button',{name:'Earliest times'}).click();
    await select.selectOption(firstTimes.slots[0].start);
    const page=await guest.newPage();
    const firstUrl=origin+'/availability/'+deep.id;
    await page.goto(firstUrl);
    const zone=page.getByLabel('Display time zone'),meeting=page.getByLabel('Meeting time');
    await zone.selectOption('local');
    const chosen=firstTimes.slots[0].start;
    await meeting.selectOption(chosen);
    assert.match(await meeting.locator('option:checked').textContent(),/GMT\+5:45/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.getByRole('link',{name:'Later times'}).click();
    assert.equal(new URL(page.url()).searchParams.get('after'),firstTimes.next);
    await zone.locator('option[value="local"]:checked').waitFor({state:'attached'});
    await page.getByRole('link',{name:'Earliest times'}).click();
    assert.equal(page.url(),firstUrl);
    await page.getByRole('link',{name:'Later times'}).click();
    await page.getByLabel('Meeting time').selectOption(laterTimes.slots.at(-1).start);
    const address='later-time@example.test';
    await page.getByLabel('Email address').fill(address);
    await zone.selectOption('organizer');
    assert.equal(await meeting.inputValue(),laterTimes.slots.at(-1).start);
    assert.match(await meeting.locator('option:checked').textContent(),/\(GMT(?:\+0)?\)/);
    assert.equal(await page.getByLabel('Email address').inputValue(),address);
    await zone.selectOption('local');
    await page.getByRole('button',{name:'Email me a code'}).click();
    await page.getByLabel('Verification code').waitFor();
    const code=(await readMail()).find(message=>message.address===address)?.code;
    assert.ok(code,'The fictional delivery provider received a code for the later slot.');
    await page.getByLabel('Verification code').fill(code);
    await page.getByRole('button',{name:'Verify email'}).click();
    await page.getByRole('link',{name:'Open private status link'}).waitFor();

    // The organizer still has the original times open while a different booking takes the first one.
    const guestApi='/api/public/availability/'+deep.id;
    const contenders=await Promise.all(['first-visitor@example.test','second-visitor@example.test'].map(async email=>{
      const tab=await browser.newPage();
      await tab.goto(firstUrl);
      await tab.getByLabel('Meeting time').selectOption(chosen);
      await tab.getByLabel('Email address').fill(email);
      const sent=tab.waitForRequest(r=>r.method()==='POST'&&r.url()===origin+guestApi);
      await tab.getByRole('button',{name:'Email me a code'}).click();
      const {requestId}=(await sent).postDataJSON();
      await tab.getByLabel('Verification code').waitFor();
      const code=(await readMail()).find(message=>message.address===email)?.code;
      assert.ok(code);
      return {tab,email,proof:{action:'verify',requestId,code}};
    }));
    const proofs=contenders.map(visitor=>visitor.proof);
    const competing=await Promise.all(proofs.map(proof=>post(guestApi,proof,{})));
    assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
    const winner=competing.findIndex(response=>response.ok);
    const accepted=await competing[winner].json();
    assert.ok(accepted.receipt);
    assert.equal((await ok(post(guestApi,proofs[winner],{}))).receipt,accepted.receipt);
    const reservations=(await ok(get(ownerPath))).meetings.filter(m=>m.pageId===deep.id&&m.start===chosen);
    assert.deepEqual(reservations.map(m=>m.id),[proofs[winner].requestId]);
    const {tab:loser,email,proof}=contenders[1-winner];
    await loser.getByLabel('Verification code').fill(proof.code);
    await loser.getByRole('button',{name:'Verify email'}).click();
    const replacement=loser.getByLabel('New meeting time');
    await replacement.waitFor();
    assert.equal(await replacement.inputValue(),'');
    assert.equal(await replacement.locator('option[value="'+chosen+'"]').count(),0);
    const alternativeStart=firstTimes.slots[18].start;
    assert.equal((await post(guestApi,{...proof,code:'x'.repeat(43),alternativeStart},{})).status,400);
    const offGrid=new Date(Date.parse(alternativeStart)+1000).toISOString();
    assert.equal((await post(guestApi,{...proof,alternativeStart:offGrid},{})).status,409);
    const guestMeetings=async()=>(await ok(get(ownerPath+'&guestEmail='+encodeURIComponent(email)))).meetings;
    assert.equal((await guestMeetings()).length,0);
    await replacement.selectOption(alternativeStart);
    await loser.getByRole('button',{name:'Reserve new time'}).click();
    const statusLink=loser.getByRole('link',{name:'Open private status link'});
    await statusLink.waitFor();
    const receipt=new URLSearchParams(new URL(await statusLink.getAttribute('href'),origin).hash.slice(1)).get('receipt');
    const status=await ok(post('/api/public/booking-status',{receipt},{}));
    assert.equal(status.start,alternativeStart);
    assert.equal(status.calendar.id,proof.requestId);
    assert.equal((await ok(post(guestApi,proof,{}))).receipt,receipt);
    assert.deepEqual((await guestMeetings()).map(m=>m.start),[alternativeStart]);
    assert.equal((await readMail()).filter(m=>m.address===email).length,1);
    await ok(post(ownerPath,{action:'cancel',id:proof.requestId,expectedStart:alternativeStart}));
    const staffEmail='reschedule-check@example.test';
    await staff.locator('input[name="email"]').fill(staffEmail);
    await staff.getByRole('button',{name:'Reserve in Harbor'}).click();
    await staff.getByRole('alert').filter({hasText:'no longer available'}).waitFor();
    assert.equal(await select.inputValue(),'');
    assert.equal(await select.locator('option[value="'+chosen+'"]').count(),0);
    assert.equal(await staff.locator('input[name="email"]').inputValue(),staffEmail);
    const meetings=async()=>(await ok(get(ownerPath+'&guestEmail='+staffEmail))).meetings;
    assert.equal((await meetings()).length,0);
    const newTime=await select.locator('option:not([disabled])').first().getAttribute('value');
    await select.selectOption(newTime);
    await staff.getByRole('button',{name:'Reserve in Harbor'}).click();
    await staff.getByText('Meeting reserved in Harbor.',{exact:true}).waitFor();
    const [booked]=await meetings();
    assert.equal(booked.start,newTime);
    const movedTo=firstTimes.slots[10].start;
    await ok(post(ownerPath,{action:'reschedule',id:booked.id,expectedStart:newTime,start:movedTo}));
    const row=staff.locator('li').filter({hasText:staffEmail});
    await row.getByRole('button',{name:'Cancel booking'}).click();
    await staff.getByRole('alert').filter({hasText:'Review the current schedule'}).waitFor();
    assert.equal((await meetings())[0].start,movedTo);
    const freshCancel=staff.waitForRequest(r=>r.method()==='POST'&&r.postDataJSON()?.action==='cancel');
    await row.getByRole('button',{name:'Cancel booking'}).click();
    assert.equal((await freshCancel).postDataJSON().expectedStart,movedTo);
    await staff.getByText('Booking cancelled.',{exact:true}).waitFor();
    assert.equal((await meetings()).length,0);
    await ok(post(ownerPath,{action:'cancel',id:booked.id,expectedStart:movedTo}));
    await ok(post(ownerPath,{action:'cancel',id:proofs[winner].requestId,expectedStart:chosen}));

    const publishedId=randomUUID(),endpoint='/api/calendar/availability-page';
    const {start,end}=firstTimes.slots[0];
    await ok(post(endpoint,{action:'publish',id:publishedId,previousId:null,title:'Contact the organizer',timeZone:'America/New_York',
      slots:[{start,end}],allowGuestProof:false}));
    try{
      await page.goto(origin+'/availability/'+publishedId);
      const time=page.locator('li time');
      await zone.locator('option[value="local"]:checked').waitFor({state:'attached'});
      assert.match(await time.textContent(),/GMT\+5:45/);
      await zone.selectOption('organizer');
      assert.match(await time.textContent(),/GMT-5|GMT-4/);
      assert.equal(await time.getAttribute('datetime'),start);
      assert.equal(await page.getByLabel('Email address').count(),0);
    }finally{await ok(post(endpoint,{action:'unpublish',id:publishedId}));}
  }finally{await browser.close();}
}


async function verifyUpcomingBookingPages({sql,change,remaining,workspaceId,pageId,ownerPath,memberPath,headers,other,get,ok,origin}){
  // The hundredth and hundred-and-first meetings start together on different hosts.
  const start=Date.now()+86400000;
  await sql`WITH inserted AS (
    INSERT INTO portable_team_bookings(workspace_id,id,page_id,title,email,start_at,end_at)
    SELECT ${workspaceId},gen_random_uuid(),${pageId},
      CASE WHEN n=100 THEN 'Organizer booking' ELSE 'Rep booking' END,
      CASE WHEN n=100 THEN 'sales-guest@example.test' ELSE 'guest@example.test' END,
      ${start}::bigint+(CASE WHEN n=100 THEN 99 ELSE n END)*1800000,
      ${start}::bigint+(CASE WHEN n=100 THEN 99 ELSE n END)*1800000+900000
    FROM generate_series(0,105) n RETURNING workspace_id,id,title
  )
  INSERT INTO portable_team_booking_hosts(workspace_id,booking_id,user_id)
  SELECT workspace_id,inserted.id,i.id FROM inserted JOIN login_identities i
    ON i.email=CASE WHEN title='Organizer booking' THEN 'owner@example.test' ELSE 'other@example.test' END`;
  const next=cursor=>'&'+new URLSearchParams({bookingAfter:cursor.start,bookingId:cursor.id});
  for(const [path,identity,total] of [[ownerPath,headers,106],[memberPath,other,105]]){
    const first=await ok(get(path,identity));
    assert.equal(first.meetings.length,100);
    assert.deepEqual(first.nextBookings,{start:first.meetings[99].start,id:first.meetings[99].id});
    const tail=await ok(get(path+next(first.nextBookings),identity));
    assert.equal(tail.nextBookings,null);
    const rows=[...first.meetings,...tail.meetings];
    assert.equal(new Set(rows.map(row=>row.id)).size,total);
    assert.equal(rows.length,total);
    if(identity===headers)assert.equal(first.meetings[99].start,tail.meetings[0].start);
    else assert.ok(rows.every(meeting=>meeting.title==='Rep booking'));
  }
  const guestFilter='&guestEmail=SALES-GUEST%40example.test';
  assert.equal((await ok(get(ownerPath+guestFilter))).meetings.length,1);
  assert.equal((await ok(get(memberPath+guestFilter,other))).meetings.length,0);
  assert.equal((await get(ownerPath+'&guestEmail=invalid')).status,400);
  assert.equal((await get(ownerPath+'&bookingAfter='+new Date(start).toISOString())).status,400);
  assert.equal((await get(ownerPath+'&bookingId='+randomUUID())).status,400);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=meetings');
    await page.getByRole('button',{name:'Later bookings'}).click();
    const list=page.getByRole('button',{name:'Cancel booking',exact:true});
    await page.waitForFunction(()=>document.activeElement?.textContent==='Upcoming team bookings');
    assert.equal(await list.count(),6);
    await list.last().click();
    await page.getByText('Booking cancelled.',{exact:true}).waitFor();
    assert.equal(await list.count(),5);
    await page.getByRole('button',{name:'Earliest bookings'}).click();
    await page.getByRole('button',{name:'Later bookings'}).waitFor();
    assert.equal(await list.count(),100);
    const first=await ok(get(ownerPath));
    assert.equal((await ok(get(ownerPath+next(first.nextBookings)))).meetings.length,5);
    await page.getByLabel('Find bookings by guest email').fill('SALES-GUEST@example.test');
    await page.getByRole('button',{name:'Find bookings',exact:true}).click();
    await page.getByRole('button',{name:'Clear guest filter'}).waitFor();
    assert.equal(await list.count(),1);
    assert.match(await list.locator('..').innerText(),/Organizer booking/);
    await page.getByRole('button',{name:'Clear guest filter'}).click();
    await page.getByRole('button',{name:'Later bookings'}).waitFor();
    assert.equal(await list.count(),100);
    const calendar=first.pages.find(p=>p.id===pageId);
    const selected=[remaining.id];
    await change({action:'changeHosts',id:pageId,expectedHosts:calendar.hosts,hosts:selected});
    await page.getByRole('button',{name:'Review bookings with former hosts'}).click();
    await page.getByRole('heading',{name:'Bookings with former hosts'}).waitFor();
    assert.equal(await list.count(),1);
    assert.match(await list.locator('..').innerText(),/Former host · .*owner@example.test/);
    await change({action:'changeHosts',id:pageId,expectedHosts:selected,hosts:calendar.hosts});
    await page.getByRole('button',{name:'Find bookings',exact:true}).click();
    await page.getByText('All booked hosts are on their calendars.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Show all upcoming bookings'}).click();
    await page.getByRole('button',{name:'Later bookings'}).waitFor();
  }finally{await browser.close();}
}

async function verifyBookingHostChange({tab,origin,meetings,ownerPath,memberPath,other,collectiveId,rotation,hosts,book,change,post,get,ok,date,readMail}){
  // The collective meeting occupies 75–105. Both hosts still offer 30–60.
  const publicRotation={...rotation,id:randomUUID(),publicEnabled:true,title:'Guest demo with backup coverage'};
  await change(publicRotation);
  const saved={...book(publicRotation,30),email:'coverage@example.test'};
  const guestPath='/api/public/availability/'+publicRotation.id;
  await ok(post(guestPath,{action:'request',requestId:saved.id,email:saved.email,start:saved.start},{}));
  const code=(await readMail()).find(mail=>mail.address===saved.email)?.code;
  const {receipt}=await ok(post(guestPath,{action:'verify',requestId:saved.id,code},{}));
  const guestStatus=()=>ok(post('/api/public/booking-status',{receipt},{}));
  const confirmation=await guestStatus();
  assert.equal(confirmation.state,'reserved');
  const lookup=ownerPath+'&replaceHost='+saved.id;
  assert.equal((await get(ownerPath+'&replaceHost='+collectiveId)).status,409);
  assert.equal((await get(memberPath+'&replaceHost='+saved.id,other)).status,404);
  const options=await ok(get(lookup));
  assert.equal(options.start,saved.start);
  assert.equal(options.hosts.length,1);
  const [replacement]=options.hosts;
  const input={action:'replaceHost',id:saved.id,expectedStart:saved.start,expectedHost:options.expectedHost,host:replacement.id};
  assert.equal((await post(memberPath,input,other)).status,403);
  assert.equal((await post(ownerPath,{...input,expectedStart:date(45)})).status,409);
  assert.equal((await post(ownerPath,{...input,host:randomUUID()})).status,409);
  assert.equal((await post(ownerPath,{...input,id:collectiveId})).status,409);

  const ownerOnLeave=replacement.label.includes('other@example.test');
  const absencePath=ownerOnLeave?ownerPath:memberPath,actor=ownerOnLeave?undefined:other;
  const period={from:saved.start.slice(0,10),through:saved.start.slice(0,10),timeZone:'UTC'};
  async function absence(operation){
    const {revision}=await ok(get(absencePath,actor));
    await ok(post(absencePath,{action:'timeOff',operation,period,revision},actor));
  }
  await absence('add');
  const conflicts=async()=>(await ok(get(ownerPath+'&duringTimeOff=team'))).meetings;
  assert.ok((await conflicts()).some(m=>m.id===saved.id));
  const hostId=hosts.find(host=>host.label===replacement.label).id;
  const solo={...rotation,id:randomUUID(),title:'Coverage check',hosts:[hostId]};
  await change(solo);
  const competing=book(solo,30);
  const race=await Promise.all([post(ownerPath,input),post(ownerPath,competing)]);
  assert.deepEqual(race.map(result=>result.status).sort(),[200,409]);
  if(race[1].ok){
    assert.deepEqual((await ok(get(lookup))).hosts,[]);
    await change({action:'cancel',id:competing.id});
    await change(input);
  }
  await change(input); // Replaying the successful handoff keeps exactly one host.
  const find=async(path,actor)=>(await ok(get(path,actor))).meetings.find(row=>row.id===saved.id);
  const assigned=await find(ownerPath);
  assert.deepEqual(assigned.hostNames,[replacement.label]);
  assert.equal(assigned.email,saved.email);
  assert.equal(assigned.start,saved.start);
  assert.deepEqual(await guestStatus(),confirmation);
  assert.equal(Boolean(await find(memberPath,other)),replacement.label.includes('other@example.test'));

  assert.ok(!(await conflicts()).some(m=>m.id===saved.id));
  assert.deepEqual((await ok(get(lookup))).hosts,[]);
  await absence('remove');
  await tab.goto(origin+meetings);
  const row=tab.getByRole('listitem').filter({hasText:publicRotation.title}).filter({has:tab.getByRole('button',{name:'Change host',exact:true})});
  await row.getByRole('button',{name:'Change host',exact:true}).click();
  await row.getByLabel('Available host at this time').selectOption(options.expectedHost);
  await row.getByRole('button',{name:'Save new host'}).click();
  await tab.getByText('Booking host changed.',{exact:true}).waitFor();
  const original=await find(ownerPath);
  assert.equal(original.hostNames.length,1);
  assert.notDeepEqual(original.hostNames,assigned.hostNames);
  assert.equal(original.start,assigned.start);
  assert.equal(original.end,assigned.end);
  assert.equal(Boolean(await find(memberPath,other)),!replacement.label.includes('other@example.test'));
  await change({action:'cancel',id:saved.id});
  await change({action:'close',id:solo.id});
  await change({action:'close',id:publicRotation.id});
}

async function verifyRosterRescheduling({ownerPath,memberPath,other,origin,headers,meetings,calendar,hosts,date,ok,get,post,change,readMail,chromium}){
  const oldHost=hosts.find(host=>host.label.includes('owner@example.test')),newHost=hosts.find(host=>host.label.includes('other@example.test'));
  const ownerBefore=await ok(get(ownerPath)),memberBefore=await ok(get(memberPath,other));
  async function offer(path,actor,windows){
    const {revision}=await ok(get(path,actor));
    await ok(post(path,{action:'offer',revision,windows},actor));
  }
  const oldTime=date(180),newTime=date(240);
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    await offer(ownerPath,undefined,[{start:oldTime,end:date(210)}]);
    await offer(memberPath,other,[{start:newTime,end:date(270)}]);
    const tab=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await tab.context().addCookies([{name,value,url:origin}]);
    for(const mode of ['collective','rotation']){
      const page={...calendar(mode,true),hosts:[oldHost.id]};
      await change(page);
      const id=randomUUID(),email='roster-move-'+mode+'@example.test',publicPage='/api/public/availability/'+page.id;
      await ok(post(publicPage,{action:'request',requestId:id,email,start:oldTime},{}));
      const code=(await readMail()).find(m=>m.address===email)?.code;
      const {receipt}=await ok(post(publicPage,{action:'verify',requestId:id,code},{}));
      const guest=()=>ok(post('/api/public/booking-status',{receipt},{}));
      const original=await guest();
      const swap={action:'changeHosts',id:page.id,expectedHosts:[oldHost.id],hosts:[newHost.id]};
      await change(swap);
      const endpoint=ownerPath+'&move='+id;
      assert.deepEqual((await ok(get(endpoint))).slots,[]);
      const alternate=await ok(get(endpoint+'&useRoster=1'));
      assert.deepEqual(alternate.slots.map(slot=>slot.start),[newTime]);
      const move={action:'reschedule',id,expectedStart:oldTime,start:newTime,roster:alternate.roster};
      assert.equal((await get(memberPath+'&move='+id+'&useRoster=1',other)).status,404);
      assert.equal((await post(memberPath,move,other)).status,403);
      await change({...swap,expectedHosts:[newHost.id],hosts:[oldHost.id]});
      assert.equal((await post(ownerPath,move)).status,409);
      await change(swap);
      const competing={action:'book',id:randomUUID(),email:'competing@example.test',pageId:page.id,start:newTime};
      await change(competing);
      assert.equal((await post(ownerPath,move)).status,409);
      assert.deepEqual(await guest(),original);
      assert.deepEqual((await ok(get(ownerPath))).meetings.find(m=>m.id===id).hostNames,[oldHost.label]);
      await change({action:'cancel',id:competing.id});
      await tab.goto(origin+meetings);
      const row=tab.getByRole('listitem').filter({hasText:email});
      await row.getByRole('button',{name:'Reschedule',exact:true}).click();
      await row.getByLabel('Hosts for the new time').selectOption('roster');
      await row.getByLabel('New time in').selectOption(newTime);
      await row.getByRole('button',{name:'Save new time'}).click();
      await tab.getByText('Booking rescheduled.',{exact:true}).waitFor();
      await change(move);
      assert.deepEqual(await guest(),{...original,start:newTime,end:date(270)});
      assert.deepEqual((await ok(get(memberPath,other))).meetings.find(m=>m.id===id).hostNames,[newHost.label]);
      await change({action:'cancel',id});
      await change({action:'close',id:page.id});
    }
  }finally{
    await browser.close();
    await offer(ownerPath,undefined,ownerBefore.windows);
    await offer(memberPath,other,memberBefore.windows);
  }
}
