import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function portableCalendarFixture(directory){
  const path=join(directory,'calendar-fetch.mjs'),settings=join(directory,'calendar-mode'),log=join(directory,'calendar-calls');
  await writeFile(settings,'free');
  await writeFile(log,'');
  await writeFile(path,`
    import assert from 'node:assert/strict';
    import {appendFile,readdir,readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {setTimeout as delay} from 'node:timers/promises';
    export async function calendarFetch(url,options){
      const settings=${JSON.stringify(settings)},log=${JSON.stringify(log)};
      const mode=await readFile(settings,'utf8');
      async function waitForPreflight(){
        try{await delay(6_500,undefined,{signal:options.signal});}
        catch(error){
          if(options.signal?.aborted)await appendFile(log,'preflight_cancelled\\n');
          throw error;
        }
      }
      if(url.href==='https://oauth2.googleapis.com/token'&&options.body.get('grant_type')==='refresh_token'){
        assert.equal(options.body.get('client_id'),'fixture-calendar-client');
        assert.equal(options.body.get('client_secret'),'fixture-calendar-secret');
        assert.equal(options.body.get('refresh_token'),'fixture-calendar-refresh');
        await appendFile(log,'token\\n');
        if(mode==='slow_preflight')await waitForPreflight();
        if(mode==='reauth')return Response.json({error:'invalid_grant',error_description:'Private provider error'},{status:400});
        let scope=mode==='insufficient'?'https://www.googleapis.com/auth/userinfo.email':
          'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.freebusy';
        if(!['insufficient','availability_only'].includes(mode)&&process.env.HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED==='true'){
          scope+=' https://www.googleapis.com/auth/calendar.events.owned';
        }
        return Response.json({access_token:'fictional-calendar-access',expires_in:3600,token_type:'Bearer',scope});
      }
      if(url.href==='https://www.googleapis.com/oauth2/v2/userinfo'){
        assert.equal(new Headers(options.headers).get('authorization'),'Bearer fictional-calendar-access');
        await appendFile(log,'identity\\n');
        if(mode==='slow_preflight')await waitForPreflight();
        return Response.json({id:'fictional-provider-id',email:mode==='wrong_owner'?'other@example.test':'owner@example.test',verified_email:true});
      }
      if(url.href==='https://www.googleapis.com/calendar/v3/freeBusy'){
        assert.equal(options.method,'POST');
        assert.equal(new Headers(options.headers).get('authorization'),'Bearer fictional-calendar-access');
        const window=JSON.parse(options.body);
        assert.deepEqual(Object.keys(window).sort(),['items','timeMax','timeMin']);
        if(window.items[0]?.id!=='primary'){
          const calendars={};
          for(const {id} of window.items){
            assert.ok(['owner@example.test','other@example.test'].includes(id));
            calendars[id]=mode==='team_no_access'?{errors:[{reason:'notFound'}]}:
              {busy:mode==='team_busy'?[{start:window.timeMin,end:window.timeMax}]:[]};
          }
          return Response.json({timeMin:window.timeMin,timeMax:window.timeMax,calendars});
        }
        assert.deepEqual(window.items,[{id:'primary'}]);
        assert.ok(Date.parse(window.timeMax)>Date.parse(window.timeMin));
        await appendFile(log,'availability\\n');
        if(mode==='hold'){
          for(let poll=0;poll<100&&await readFile(settings,'utf8')==='hold';poll++)await delay(20);
          assert.equal(await readFile(settings,'utf8'),'free');
        }
        if(mode==='unavailable')return Response.json({message:'Private provider error'}, {status:503});
        if(mode==='partial')return Response.json({calendars:{primary:{errors:[{reason:'internalError'}]}}});
        const busy=mode==='busy'?[{start:window.timeMin,end:window.timeMax,summary:'Private event title'}]:[];
        return Response.json({calendars:{primary:{busy}}});
      }
      const events='https://www.googleapis.com/calendar/v3/calendars/primary/events';
      if(url.origin+url.pathname===events){
        if((options.method??'GET')==='GET'){
          assert.equal(url.searchParams.get('maxResults'),'250');
          await appendFile(log,'reschedule_availability\\n');
          if(mode==='slow_reschedule_pages'){
            await waitForPreflight();
            return Response.json(url.searchParams.has('pageToken')?{items:[]}:{items:[],nextPageToken:'fixture-next-page'});
          }
          const files=await readdir(${JSON.stringify(directory)});
          const items=await Promise.all(files.filter(file=>file.startsWith('event-')).map(async file=>
            JSON.parse(await readFile(join(${JSON.stringify(directory)},file),'utf8'))));
          if(mode==='reschedule_busy')items.push({id:'separate-provider-event',status:'confirmed',
            start:{dateTime:url.searchParams.get('timeMin')},end:{dateTime:url.searchParams.get('timeMax')}});
          return Response.json({items});
        }
        assert.equal(options.method,'POST');
        assert.equal(url.searchParams.get('sendUpdates'),'all');
        const payload=JSON.parse(options.body);
        assert.match(payload.id,/^[0-9a-f]{32}$/);
        assert.equal(payload.attendees.length,1);
        assert.match(payload.attendees[0].email,/@example\\.test$/);
        await appendFile(log,'invite\\n');
        if(mode==='validation_rejection')return Response.json({error:{code:400,
          errors:[{domain:'calendar',reason:'timeRangeEmpty',message:'Private provider detail'}]}},{status:400});
        const event={...payload,status:'confirmed',etag:'"fixture-etag"',organizer:{email:'owner@example.test',self:true},
          htmlLink:'https://calendar.google.com/calendar/event?eid=fixture'};
        await writeFile(join(${JSON.stringify(directory)},'event-'+payload.id+'.json'),JSON.stringify(event),{flag:'wx'});
        if(mode==='lost')throw Error('Fictional lost response');
        if(mode==='opaque_rejection')return Response.json({error:'Unrecognized provider response'},{status:400});
        return Response.json(event);
      }
      if(url.href.startsWith(events+'/')){
        const id=url.pathname.split('/').at(-1);
        assert.match(id,/^[0-9a-f]{32}$/);
        const file=join(${JSON.stringify(directory)},'event-'+id+'.json');
        const saved=await readFile(file,'utf8').catch(()=>null);
        if(options.method==='DELETE'){
          assert.equal(url.searchParams.get('sendUpdates'),'all');
          const event=JSON.parse(saved),etag=new Headers(options.headers).get('if-match');
          assert.equal(event.status,'confirmed');
          if(mode==='cancel_conflict'){
            assert.equal(etag,'"fixture-stale-etag"');
            assert.notEqual(etag,event.etag);
            await appendFile(log,'cancel\\n');
            return new Response(null,{status:412});
          }
          assert.equal(etag,event.etag);
          await appendFile(log,'cancel\\n');
          await writeFile(file,JSON.stringify({id,status:'cancelled'}));
          if(mode==='cancel_lost')throw Error('Fictional lost cancellation response');
          if(mode==='cancel_missing_check_conflict')return new Response(null,{status:404});
          return new Response(null,{status:204});
        }
        if(options.method==='PATCH'){
          const old=JSON.parse(saved),payload=JSON.parse(options.body);
          assert.equal(url.searchParams.get('sendUpdates'),'all');
          assert.equal(new Headers(options.headers).get('if-match'),old.etag);
          assert.deepEqual(Object.keys(payload).sort(),['end','extendedProperties','start']);
          assert.equal(payload.extendedProperties.private.harborMeetingId,old.extendedProperties.private.harborMeetingId);
          assert.match(payload.extendedProperties.private.harborChangeId,/^[0-9a-f-]{36}$/);
          await appendFile(log,'reschedule\\n');
          if(mode==='reschedule_conflict')return new Response(null,{status:412});
          if(mode==='reschedule_not_applied')return new Response(null,{status:503});
          const changed={...old,...payload,etag:'"fixture-'+payload.extendedProperties.private.harborChangeId+'"'};
          await writeFile(file,JSON.stringify(changed));
          if(mode==='reschedule_lost')throw Error('Fictional lost reschedule response');
          return Response.json(changed);
        }
        assert.equal(options.method??'GET','GET');
        await appendFile(log,'check\\n');
        if(mode==='hold_check'){
          for(let poll=0;poll<250&&await readFile(settings,'utf8')!=='free';poll++)await delay(20);
          assert.equal(await readFile(settings,'utf8'),'free');
        }
        if(!saved||mode==='missing')return new Response(null,{status:404});
        const event=JSON.parse(saved);
        if(mode==='cancel_missing_check_conflict'&&event.status==='cancelled')return new Response(null,{status:412});
        if(mode==='cancel_conflict')return Response.json({...event,etag:'"fixture-stale-etag"'});
        if(mode==='cancel_wildcard')return Response.json({...event,etag:'*'});
        return Response.json(mode==='edited'?{...event,summary:'Changed in Google'}:event);
      }
      return null;
    }
  `);
  return {path,env:{HARBOR_PORTABLE_CALENDAR_ENABLED:'true',HARBOR_PORTABLE_CALENDAR_OWNER:'owner@example.test',
    HARBOR_PORTABLE_CALENDAR_CLIENT_ID:'fixture-calendar-client',HARBOR_PORTABLE_CALENDAR_CLIENT_SECRET:'fixture-calendar-secret',
    HARBOR_PORTABLE_CALENDAR_REFRESH_TOKEN:'fixture-calendar-refresh'},
    async editEvent(id,update){
      const file=join(directory,'event-'+id.replaceAll('-','')+'.json');
      const event=JSON.parse(await readFile(file,'utf8'));
      if(update)await writeFile(file,JSON.stringify(update(event)));
      return event;
    },
    mode:value=>writeFile(settings,value),calls:async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean)};
}

export async function verifyPortableCalendar({request,origin,headers,other,calendar,enabled}){
  const start=new Date(Date.now()+3_600_000),end=new Date(start.getTime()+1_800_000);
  const window={start:start.toISOString(),end:end.toISOString(),timeZone:'UTC'};
  const path='/api/calendar/availability';
  const post=(auth=headers,body=window,site=origin,signal)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body),...(signal?{signal}:{})});
  const disabledView=await request('/?view=calendar',{headers:enabled?other:headers});
  assert.equal(disabledView.status,404);
  assert.equal((await post(enabled?other:headers)).status,403);
  if(!enabled){assert.deepEqual(await calendar.calls(),[]);return;}

  assert.equal((await post({})).status,401);
  assert.equal((await post(headers,window,'https://outside.example.test')).status,403);
  assert.equal((await post(headers,{...window,calendarId:'someone-else@example.test'})).status,400);
  assert.equal((await post(headers,{...window,start:end.toISOString()})).status,400);
  assert.equal((await request(path,{headers})).status,404);
  assert.equal((await request('/api/calendar/meetings',{headers,origin,method:'POST'})).status,403);
  for(const route of ['/api/calendar/changes','/api/calendar/connection']){
    assert.equal((await request(route,{headers,method:'POST'})).status,404);
  }
  const home=await (await request('/',{headers})).text();
  assert.match(home,/href="\/\?view=calendar"/);
  const page=await request('/?view=calendar',{headers});
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Calendar availability/);
  assert.match(html,/Find open meeting times/);
  assert.match(html,/Check Calendar connection/);
  assert.doesNotMatch(html,/fixture-calendar-secret|fixture-calendar-refresh/);
  assert.deepEqual(await calendar.calls(),[]);
  const connectionCheck={action:'check_connection'};
  assert.equal((await post({},connectionCheck)).status,401);
  assert.equal((await post(other,connectionCheck)).status,403);
  assert.equal((await post(headers,connectionCheck,'https://outside.example.test')).status,403);
  assert.equal((await post(headers,{...connectionCheck,calendarId:'other@example.test'})).status,400);
  assert.deepEqual(await calendar.calls(),[]);
  await calendar.mode('slow_preflight');
  try{
    const responses=await Promise.all([connectionCheck,window].map(body=>post(headers,body,origin,AbortSignal.timeout(20_000))));
    for(const response of responses){
      assert.equal(response.status,503);
      assert.match(response.headers.get('cache-control'),/no-store/);
      assert.deepEqual(await response.json(),{error:'Calendar availability could not be confirmed. Try again shortly.'});
    }
    assert.deepEqual((await calendar.calls()).sort(),
      ['identity','identity','preflight_cancelled','preflight_cancelled','token','token']);
  }finally{await calendar.mode('free');}
  for(const [mode,expectedStatus,expectedBody,calls] of [
    ['busy',200,{connection:'ok'},['token','identity','availability']],
    ['reauth',503,{error:'Ask the operator to reconnect Google Calendar.'},['token']],
    ['wrong_owner',503,{error:'Ask the operator to reconnect Google Calendar.'},['token','identity']],
    ['unavailable',503,{error:'Calendar availability could not be confirmed. Try again shortly.'},['token','identity','availability']],
    ['free',200,{connection:'ok'},['token','identity','availability']],
  ]){
    await calendar.mode(mode);
    const before=(await calendar.calls()).length;
    const response=await post(headers,connectionCheck);
    assert.equal(response.status,expectedStatus);
    assert.match(response.headers.get('cache-control'),/no-store/);
    assert.deepEqual(await response.json(),expectedBody);
    assert.deepEqual((await calendar.calls()).slice(before),calls);
  }

  for(const [mode,expectedStatus,expectedCalls] of [
    ['wrong_owner',403,['token','identity']],
    ['insufficient',503,['token']],
    ['unavailable',503,['token','identity','availability']],
    ['partial',503,['token','identity','availability']],
    ['free',200,['token','identity','availability']],
    ['busy',200,['token','identity','availability']],
  ]){
    const before=(await calendar.calls()).length;
    await calendar.mode(mode);
    const response=await post();
    assert.equal(response.status,expectedStatus);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const data=await response.json();
    assert.deepEqual((await calendar.calls()).slice(before),expectedCalls);
    assert.doesNotMatch(JSON.stringify(data),/fictional-provider-id|fictional-calendar-access|Private provider error|Private event title/);
    if(expectedStatus===200){
      assert.deepEqual(Object.keys(data).sort(),['availability','checkedAt']);
      assert.equal(data.availability,mode);
      assert.ok(Number.isFinite(Date.parse(data.checkedAt)));
    }else assert.equal(data.availability,undefined);
  }
  const day=new Date(Date.now()+3*86_400_000).toISOString().slice(0,10);
  const suggestion={mode:'suggest',timeZone:'UTC',durationMinutes:30,startLocal:day+'T09:00',endLocal:day+'T10:00'};
  const before=(await calendar.calls()).length;
  await calendar.mode('free');
  const result=await (await post(headers,suggestion)).json();
  assert.deepEqual(Object.keys(result).sort(),['checkedAt','slots']);
  assert.deepEqual(result.slots.map(slot=>slot.start),['09:00','09:15','09:30'].map(time=>day+'T'+time+':00.000Z'));
  assert.deepEqual((await calendar.calls()).slice(before),['token','identity','availability']);
  await calendar.mode('busy');
  assert.deepEqual((await (await post(headers,suggestion)).json()).slots,[]);
}

async function calendarActionAfterSignOut({request,origin,signIn,sql,submit}){
  const session=await signIn('owner@example.test');
  let pending;
  try{
    await sql.begin(async tx=>{
      const [workspace]=await tx`SELECT id FROM private_workspaces
        WHERE owner_id=(SELECT id FROM login_identities WHERE email='owner@example.test') FOR NO KEY UPDATE`;
      assert.ok(workspace);
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      pending=submit(session,AbortSignal.timeout(10_000));
      void pending.catch(()=>{});
      let waiting=false;
      for(let poll=0;poll<100&&!waiting;poll++){
        [{waiting}]=await sql`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND ${pid}::int=ANY(pg_blocking_pids(pid))
          AND query LIKE 'select %"private_workspaces"%for no key update%') AS waiting`;
        if(!waiting)await delay(20);
      }
      assert.ok(waiting,'The Calendar request reached the workspace reservation.');
      const logout=await request('/auth/logout',{method:'POST',headers:{...session,origin},
        body:new URLSearchParams({scope:'current'})});
      assert.equal(logout.status,303);
    });
    return await pending;
  }finally{await Promise.allSettled([pending]);}
}

async function expectPreflightTimeout(calendar,mode,submit,expectedCalls){
  const before=(await calendar.calls()).length;
  await calendar.mode(mode);
  try{
    const response=await submit(AbortSignal.timeout(20_000));
    assert.equal(response.status,503,await response.clone().text());
    const body=await response.json();
    assert.equal(body.code,'calendar_preflight_timeout');
    assert.ok(body.error);
    assert.deepEqual((await calendar.calls()).slice(before),expectedCalls);
  }finally{await calendar.mode('free');}
}

export async function verifyPortableInvites({request,origin,headers,other,signIn,calendar,sql}){
  // Isolate the invitation probe from the writes made by earlier fixtures in the same minute.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write'
    AND subject IN (SELECT id FROM login_identities WHERE email='owner@example.test')`;
  const post=(path,body,auth=headers,signal)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body),...(signal?{signal}:{})});
  const create=await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Calendar invitation fixture',email:'calendar-guest@example.test'}});
  assert.equal(create.status,201);
  const contact=(await create.json()).record;
  const path='/api/calendar/meetings';
  const invite=(input,auth=headers,signal)=>post(path,{action:'invite',input},auth,signal);
  const at=Date.now()+86_400_000;
  const make=(hour,extra={})=>({id:randomUUID(),contactId:contact.id,recipient:contact.data.email,title:'Fictional appointment',
    start:new Date(at+hour*3_600_000).toISOString(),end:new Date(at+hour*3_600_000+1_800_000).toISOString(),timeZone:'UTC',...extra});
  const writes=async()=>(await calendar.calls()).filter(call=>call==='invite').length;
  const first=make(1);
  assert.equal((await invite(first,other)).status,403);
  assert.equal((await invite({...first,contactId:randomUUID()})).status,404);
  assert.equal((await invite({...first,recipient:'different@example.test'})).status,409);
  await calendar.mode('busy');
  assert.equal((await invite(first)).status,409);
  await calendar.mode('insufficient');
  assert.equal((await invite(first)).status,503);
  assert.equal(await writes(),0);
  await expectPreflightTimeout(calendar,'slow_preflight',signal=>invite(first,headers,signal),
    ['token','identity','preflight_cancelled']);
  assert.equal((await sql`SELECT id FROM portable_calendar_meetings WHERE id=${first.id}`).length,0);
  assert.equal(await writes(),0);
  // Retry the same request from two clients to retain the concurrent reservation check.
  const replies=await Promise.all([invite(first),invite(first)]);
  assert.ok(replies.every(response=>[200,202].includes(response.status)));
  const receipts=await Promise.all(replies.map(response=>response.json()));
  assert.ok(receipts.some(receipt=>receipt.status==='scheduled'));
  assert.equal(await writes(),1);
  const same=await invite({...first,id:first.id.toUpperCase()});
  assert.equal(same.status,200);
  assert.equal((await same.json()).status,'scheduled');
  assert.equal((await invite({...first,title:'Changed'})).status,409);
  assert.equal((await invite({...first,id:randomUUID()})).status,409);
  assert.equal(await writes(),1);
  assert.equal((await post('/api/email/suppressions',{id:randomUUID(),email:contact.data.email})).status,200);
  assert.equal((await invite(make(2))).status,409);
  assert.equal(await writes(),1);
  const opt=await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Calendar receipt fixture',email:'calendar-receipt@example.test'}});
  assert.equal(opt.status,201);
  const second=(await opt.json()).record;
  const loss=make(3,{contactId:second.id,recipient:second.data.email});
  await calendar.mode('lost');
  const uncertain=await invite(loss);
  assert.equal(uncertain.status,202);
  assert.equal((await uncertain.json()).status,'attention');
  const repeated=await (await invite(loss)).json();
  assert.equal(repeated.status,'attention',JSON.stringify(repeated));
  assert.equal((await invite({...loss,id:randomUUID()})).status,409);
  assert.equal(await writes(),2);
  const reviewSession=await signIn('owner@example.test'),beforeReview=(await calendar.calls()).length;
  await calendar.mode('hold_check');
  const pendingReview=post(path,{action:'check',id:loss.id},reviewSession,AbortSignal.timeout(10_000));
  void pendingReview.catch(()=>{});
  try{
    let started=false;
    for(let attempt=0;attempt<100&&!started;attempt++){
      started=(await calendar.calls()).slice(beforeReview).includes('check');
      if(!started)await delay(10);
    }
    assert.ok(started,'Google was already reading the invitation before sign-out.');
    const logout=await request('/auth/logout',{method:'POST',headers:{...reviewSession,origin},
      body:new URLSearchParams({scope:'current'})});
    assert.equal(logout.status,303);
  }finally{await calendar.mode('free');}
  const revokedReview=await pendingReview;
  assert.equal(revokedReview.status,403,await revokedReview.clone().text());
  assert.deepEqual(await revokedReview.json(),{error:'Calendar invitations are unavailable for this account.'});
  assert.deepEqual((await calendar.calls()).slice(beforeReview),['token','identity','check']);
  const [unresolved]=await sql`SELECT status,event_url FROM portable_calendar_meetings WHERE id=${loss.id}`;
  assert.deepEqual(unresolved,{status:'attention',event_url:null});
  const checked=await post(path,{action:'check',id:loss.id});
  assert.equal(checked.status,200);
  assert.equal((await checked.json()).status,'scheduled');
  assert.equal(await writes(),2);
  const check=id=>post(path,{action:'check',id});
  const rejected=make(6,{contactId:second.id,recipient:second.data.email});
  await calendar.mode('validation_rejection');
  const rejectedResponse=await invite(rejected);
  assert.equal(rejectedResponse.status,202);
  const receipt=await rejectedResponse.json();
  assert.equal(receipt.status,'rejected');
  assert.equal(receipt.eventUrl,null);
  assert.equal(receipt.canCancel,false);
  assert.doesNotMatch(JSON.stringify(receipt),/Private provider detail/);
  const beforeReplay=await calendar.calls();
  assert.deepEqual(await (await invite(rejected)).json(),receipt);
  assert.deepEqual(await (await check(rejected.id)).json(),receipt);
  assert.deepEqual(await calendar.calls(),beforeReplay);
  const corrected={...rejected,id:randomUUID(),title:'Corrected fictional appointment'};
  await calendar.mode('busy');
  assert.equal((await invite(corrected)).status,409);
  assert.equal(await writes(),3);
  await calendar.mode('free');
  assert.equal((await (await invite(corrected)).json()).status,'scheduled');
  assert.equal(await writes(),4);

  const opaque=make(7,{contactId:second.id,recipient:second.data.email});
  await calendar.mode('opaque_rejection');
  assert.equal((await (await invite(opaque)).json()).status,'attention');
  await calendar.mode('missing');
  assert.equal((await check(opaque.id)).status,409);
  assert.equal((await invite({...opaque,id:randomUUID()})).status,409);
  assert.equal(await writes(),5);
  await calendar.mode('free');
  assert.equal((await (await check(opaque.id)).json()).status,'scheduled');

  const pending=make(4,{contactId:second.id,recipient:second.data.email});
  await calendar.mode('lost');
  const interrupted=await (await invite(pending)).json();
  assert.equal(interrupted.status,'attention',JSON.stringify(interrupted));
  await sql`UPDATE portable_calendar_meetings SET status='submitting' WHERE id=${pending.id}`;
  await calendar.mode('hold');
  const beforeRace=(await calendar.calls()).length;
  const racing=invite(make(5,{contactId:second.id,recipient:second.data.email}));
  try{
    let waiting=false;
    for(let poll=0;poll<100&&!waiting;poll++){
      waiting=(await calendar.calls()).slice(beforeRace).includes('availability');
      if(!waiting)await delay(20);
    }
    assert.ok(waiting);
    assert.equal((await post('/api/crm',{action:'save',kind:'contacts',id:second.id,expectedRevision:second.revision,
      data:{...second.data,email:'calendar-updated@example.test'}})).status,200);
  }finally{await calendar.mode('free');}
  assert.equal((await racing).status,409);
  assert.equal(await writes(),6);
  const page=await (await request('/?view=calendar',{headers})).text();
  assert.match(page,/calendar-receipt@example.test/);
  assert.match(page,/Check invitation/);
  assert.match(page,/Invitation not sent/);
  assert.doesNotMatch(page,/Reschedule meeting/);
  const reviewPath='/?view=calendar&filter=needs_review';
  const signedOut=await request(reviewPath);
  assert.equal(signedOut.status,307);
  assert.equal(new URL(signedOut.headers.get('location'),origin).searchParams.get('return_to'),reviewPath);
  assert.equal((await request(reviewPath,{headers:other})).status,404);
  const completedIds=Array.from({length:26},()=>randomUUID());
  await sql`UPDATE portable_calendar_meetings SET created_at=0 WHERE id=${pending.id}`;
  await sql`INSERT INTO portable_calendar_meetings (workspace_id,id,contact_id,owner_id,account_id,input,start_at,end_at,created_at,status)
    SELECT workspace_id, fixture.id, contact_id, owner_id, account_id,
      input || '{"title":"Newer completed fixture"}'::jsonb,start_at,end_at,1,'cancelled'
    FROM portable_calendar_meetings CROSS JOIN unnest(${completedIds}::uuid[]) AS fixture(id) WHERE portable_calendar_meetings.id=${pending.id}`;
  try{
    const reviewed=await request(reviewPath,{headers});
    assert.equal(reviewed.status,200);
    const reviewHtml=await reviewed.text();
    assert.match(reviewHtml,/Check invitation/);
    assert.doesNotMatch(reviewHtml,/Newer completed fixture|Invitation not sent/);
  }finally{await sql`DELETE FROM portable_calendar_meetings WHERE id=ANY(${completedIds}::uuid[])`;}
  assert.equal((await post(path,{action:'reschedule',input:{id:randomUUID(),meetingId:first.id,revision:0,
    start:first.start,end:first.end,timeZone:first.timeZone}})).status,403);
  assert.doesNotMatch(page,/fixture-calendar-secret|fixture-calendar-refresh|fictional-provider-id/);
  assert.equal((await post(path,{action:'cancel',id:first.id})).status,403);
  const signedOutInvite=make(8,{contactId:second.id,recipient:'calendar-updated@example.test'});
  const beforeSignOut=await writes();
  const denied=await calendarActionAfterSignOut({request,origin,signIn,sql,
    submit:(session,signal)=>invite(signedOutInvite,session,signal)});
  assert.equal(denied.status,403);
  assert.equal(await writes(),beforeSignOut);
  const [stopped]=await sql`SELECT status,event_url FROM portable_calendar_meetings WHERE id=${signedOutInvite.id}`;
  assert.deepEqual(stopped,{status:'rejected',event_url:null});
  const replay=await invite(signedOutInvite);
  assert.equal(replay.status,200);
  assert.equal((await replay.json()).status,'rejected');
  assert.equal(await writes(),beforeSignOut);
  const replacementId=randomUUID();
  const replacement=await invite({...signedOutInvite,id:replacementId});
  assert.equal(replacement.status,202);
  assert.equal((await replacement.json()).status,'scheduled');
  assert.equal(await writes(),beforeSignOut+1);
  return {pendingId:pending.id,contactId:second.id,scheduledId:first.id,lossId:loss.id,rejectedId:rejected.id,replacementId};
}

export async function verifyPortableCancellations({request,origin,headers,other,signIn,calendar,sql,meetings}){
  const post=(action,id,auth=headers,signal)=>request('/api/calendar/meetings',{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify({action,id}),...(signal?{signal}:{})});
  const writes=async()=>(await calendar.calls()).filter(call=>call==='cancel').length;
  assert.equal((await post('cancel',meetings.scheduledId,other)).status,403);
  assert.equal((await post('cancel',randomUUID())).status,404);
  await calendar.mode('edited');
  assert.equal((await post('cancel',meetings.scheduledId)).status,409);
  assert.equal(await writes(),0);
  await calendar.mode('free');
  const readCancellation=async()=>(await sql`SELECT status,cancellation_started_at,event_url,start_at,end_at
    FROM portable_calendar_meetings WHERE id=${meetings.scheduledId}`)[0];
  const beforeSignOut=await readCancellation();
  assert.equal(beforeSignOut.status,'scheduled');
  assert.equal(beforeSignOut.cancellation_started_at,null);
  const denied=await calendarActionAfterSignOut({request,origin,signIn,sql,
    submit:(session,signal)=>post('cancel',meetings.scheduledId,session,signal)});
  assert.equal(denied.status,403);
  assert.deepEqual(await readCancellation(),beforeSignOut);
  assert.equal(await writes(),0);
  await calendar.mode('cancel_wildcard');
  assert.equal((await post('cancel',meetings.scheduledId)).status,409);
  assert.equal(await writes(),0);

  const providerEvent=await calendar.editEvent(meetings.scheduledId);
  await calendar.mode('cancel_conflict');
  const rejected=await post('cancel',meetings.scheduledId);
  assert.equal(rejected.status,409);
  assert.match((await rejected.json()).error,/event changed in Google Calendar.*Review/i);
  assert.deepEqual(await readCancellation(),beforeSignOut);
  assert.deepEqual(await calendar.editEvent(meetings.scheduledId),providerEvent);
  assert.equal((await (await post('check',meetings.scheduledId)).json()).status,'scheduled');
  assert.equal(await writes(),1);

  await calendar.mode('free');
  const responses=await Promise.all([post('cancel',meetings.scheduledId),post('cancel',meetings.scheduledId)]);
  const receipts=await Promise.all(responses.map(response=>response.json()));
  assert.ok(receipts.some(receipt=>receipt.status==='cancelled'));
  assert.equal(await writes(),2);
  assert.equal((await (await post('cancel',meetings.scheduledId)).json()).status,'cancelled');
  await calendar.mode('cancel_lost');
  const uncertain=await post('cancel',meetings.lossId);
  assert.equal(uncertain.status,202);
  assert.equal((await uncertain.json()).status,'cancel_attention');
  assert.equal((await (await post('cancel',meetings.lossId)).json()).status,'cancel_attention');
  await calendar.mode('missing');
  assert.equal((await post('check',meetings.lossId)).status,409);
  await calendar.mode('free');
  assert.equal((await (await post('check',meetings.lossId)).json()).status,'cancelled');
  assert.equal(await writes(),3);

  await calendar.mode('cancel_missing_check_conflict');
  const incomplete=await post('cancel',meetings.replacementId);
  assert.equal(incomplete.status,202,await incomplete.clone().text());
  assert.equal((await incomplete.json()).status,'cancel_attention');
  assert.equal((await (await post('cancel',meetings.replacementId)).json()).status,'cancel_attention');
  assert.equal((await calendar.editEvent(meetings.replacementId)).status,'cancelled');
  assert.equal(await writes(),4);
  await calendar.mode('free');
  assert.equal((await (await post('check',meetings.replacementId)).json()).status,'cancelled');
  assert.equal(await writes(),4);

  await sql`UPDATE portable_calendar_meetings SET status='cancelling' WHERE id=${meetings.lossId}`;
  assert.equal((await post('check',meetings.lossId)).status,409);
  const html=await (await request('/?view=calendar',{headers})).text();
  assert.match(html,/Check cancellation/);
  assert.match(html,/Cancelled/);
}

export async function verifyPortableReschedules({request,origin,headers,other,calendar,sql}){
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write'
    AND subject IN (SELECT id FROM login_identities WHERE email='owner@example.test')`;
  const post=(path,body,auth=headers,signal)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body),...(signal?{signal}:{})});
  const path='/api/calendar/meetings';
  const create=await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Calendar change fixture',email:'change-guest@example.test'}});
  assert.equal(create.status,201);
  const contact=(await create.json()).record;
  const at=Date.now()+3*86_400_000;
  const slot=(offset)=>({start:new Date(at+offset*60_000).toISOString(),end:new Date(at+(offset+30)*60_000).toISOString(),timeZone:'UTC'});
  const invitation={id:randomUUID(),contactId:contact.id,recipient:contact.data.email,title:'Fictional change',...slot(0)};
  const submit=(input,auth,signal)=>post(path,{action:'reschedule',input},auth,signal);
  const check=()=>post(path,{action:'check',id:invitation.id});
  const writes=async()=>(await calendar.calls()).filter(call=>call==='reschedule').length;
  await calendar.mode('free');
  assert.equal((await (await post(path,{action:'invite',input:invitation})).json()).status,'scheduled');
  assert.match(await (await request('/?view=calendar',{headers})).text(),/Reschedule meeting/);

  // Overlap with the meeting's original interval is valid; a different busy event is not.
  const change={id:randomUUID(),meetingId:invitation.id,revision:0,...slot(15)};
  assert.equal((await submit(change,other)).status,403);
  assert.equal((await submit({...change,meetingId:randomUUID()})).status,404);
  await calendar.mode('edited');
  assert.equal((await submit(change)).status,409);
  await calendar.mode('reschedule_busy');
  assert.equal((await submit(change)).status,409);
  assert.equal(await writes(),0);
  await expectPreflightTimeout(calendar,'slow_reschedule_pages',signal=>submit(change,headers,signal),
    ['token','identity','check','reschedule_availability','reschedule_availability','preflight_cancelled']);
  assert.equal((await sql`SELECT id FROM portable_calendar_reschedules WHERE id=${change.id}`).length,0);
  assert.equal(await writes(),0);
  const responses=await Promise.all([submit(change),submit(change)]);
  const receipts=await Promise.all(responses.map(response=>response.json()));
  assert.ok(responses.every(response=>[200,202].includes(response.status)),JSON.stringify(receipts));
  const applied=receipts.find(receipt=>receipt.reschedule?.status==='applied');
  assert.equal(applied?.start,change.start);
  assert.equal(applied.revision,1);
  assert.equal(await writes(),1);
  assert.deepEqual(await (await submit(change)).json(),applied);
  assert.equal((await submit({...change,...slot(90)})).status,409);
  assert.equal((await submit({...change,id:randomUUID()})).status,409);
  const inviteReplay=await (await post(path,{action:'invite',input:invitation})).json();
  assert.equal(inviteReplay.start,change.start);
  assert.equal(await writes(),1);

  const rejected={...change,id:randomUUID(),revision:1,...slot(90)};
  await calendar.mode('reschedule_conflict');
  const rejectedReceipt=await (await submit(rejected)).json();
  assert.equal(rejectedReceipt.reschedule.status,'rejected');
  assert.equal(rejectedReceipt.start,change.start);
  assert.equal(rejectedReceipt.canReschedule,true);
  assert.deepEqual(await (await submit(rejected)).json(),rejectedReceipt);
  assert.equal(await writes(),2);

  const uncertain={...rejected,id:randomUUID()};
  await calendar.mode('reschedule_lost');
  const lost=await (await submit(uncertain)).json();
  assert.equal(lost.reschedule.status,'attention');
  assert.equal(lost.start,change.start);
  assert.equal(lost.canCancel,false);
  assert.equal(lost.canReschedule,false);
  assert.deepEqual(await (await submit(uncertain)).json(),lost);
  assert.equal((await submit({...uncertain,id:randomUUID()})).status,409);
  assert.equal((await post(path,{action:'cancel',id:invitation.id})).status,409);
  const page=await (await request('/?view=calendar',{headers})).text();
  assert.match(page,/Reschedule needs attention/);
  assert.match(page,/Check reschedule/);
  const reviewPage=()=>request('/?view=calendar&filter=needs_review',{headers}).then(response=>response.text());
  assert.match(await reviewPage(),/Check reschedule/);
  const availability=time=>post('/api/calendar/availability',time);
  for(const time of [slot(15),slot(90)]){
    const response=await availability(time);
    assert.equal(response.status,200);
    const {checkedAt,...result}=await response.json();
    assert.ok(Number.isFinite(Date.parse(checkedAt)));
    assert.deepEqual(result,{availability:'busy',held:true});
    assert.equal((await post(path,{action:'invite',input:{...invitation,...time,id:randomUUID()}})).status,409);
  }
  const suggestions=await (await availability({mode:'suggest',timeZone:'UTC',durationMinutes:15,
    startLocal:slot(0).start.slice(0,16),endLocal:slot(150).end.slice(0,16)})).json();
  assert.ok(suggestions.slots.length>0);
  for(const candidate of suggestions.slots){
    assert.ok([slot(15),slot(90)].every(held=>Date.parse(candidate.end)<=Date.parse(held.start)||Date.parse(candidate.start)>=Date.parse(held.end)));
  }
  await calendar.mode('missing');
  assert.equal((await check()).status,409);
  await calendar.mode('free');
  const reconciled=await (await check()).json();
  assert.equal(reconciled.start,uncertain.start);
  assert.equal(reconciled.reschedule.status,'applied');
  assert.doesNotMatch(await reviewPage(),/Check reschedule/);
  assert.equal(await writes(),3);
  const oldSlot=await (await availability(slot(15))).json();
  assert.equal(oldSlot.availability,'free');
  assert.equal(oldSlot.held,undefined);
  assert.equal((await (await availability(slot(90))).json()).held,true);

  const fenced={...uncertain,id:randomUUID(),revision:2,...slot(210)};
  await calendar.mode('reschedule_not_applied');
  assert.equal((await (await submit(fenced)).json()).reschedule.status,'attention');
  const original=await calendar.editEvent(invitation.id);
  const [recorded]=await sql`SELECT original_etag FROM portable_calendar_reschedules WHERE id=${fenced.id}`;
  assert.equal(recorded.original_etag,original.etag);
  await sql`UPDATE portable_calendar_reschedules SET created_at=0 WHERE id=${fenced.id}`;
  const unchanged=await check();
  assert.equal(unchanged.status,409);
  assert.match((await unchanged.json()).error,/original event version.*description change.*guest notification/);
  const reserve=(offset)=>post(path,{action:'invite',input:{...invitation,...slot(offset),id:randomUUID()}});
  assert.equal((await reserve(90)).status,409);
  assert.equal((await reserve(210)).status,409);
  assert.equal((await post(path,{action:'cancel',id:invitation.id})).status,409);

  const edited={...original,etag:'"fixture-manual-version"',description:'Fictional description edit'};
  const wrongTime=slot(95);
  for(const providerEvent of [
    {...edited,etag:'W/"fixture-manual-version"'},
    {...edited,start:{dateTime:wrongTime.start,timeZone:'UTC'},end:{dateTime:wrongTime.end,timeZone:'UTC'}},
    {...edited,start:{...edited.start,timeZone:'Etc/UTC'}},
    {...edited,extendedProperties:{private:{...edited.extendedProperties.private,harborChangeId:fenced.id}}},
  ]){
    await calendar.editEvent(invitation.id,()=>providerEvent);
    assert.equal((await check()).status,409);
  }
  await calendar.editEvent(invitation.id,()=>edited);
  await sql`UPDATE portable_calendar_reschedules SET original_etag=NULL WHERE id=${fenced.id}`;
  const legacy=await check();
  assert.equal(legacy.status,409);
  assert.match((await legacy.json()).error,/no saved Google event version/);
  await sql`UPDATE portable_calendar_reschedules SET original_etag=${recorded.original_etag} WHERE id=${fenced.id}`;
  assert.equal((await reserve(210)).status,409);
  const fenceCheck=await check();
  assert.equal(fenceCheck.status,200);
  const released=await fenceCheck.json();
  assert.equal(released.reschedule.status,'rejected');
  assert.equal(released.start,uncertain.start);
  assert.equal(released.revision,2);
  assert.equal(released.canCancel,true);
  assert.equal(released.canReschedule,true);
  assert.deepEqual(await (await submit(fenced)).json(),released);
  assert.equal(await writes(),4,'Checking and replaying a fenced PATCH do not write an event');
  await calendar.mode('free');
  assert.equal((await reserve(90)).status,409);
  assert.equal((await (await reserve(210)).json()).status,'scheduled');

  const pending={...uncertain,id:randomUUID(),revision:2,...slot(150)};
  await calendar.mode('reschedule_lost');
  assert.equal((await (await submit(pending)).json()).reschedule.status,'attention');
  await sql`UPDATE portable_calendar_reschedules SET status='submitting' WHERE id=${pending.id}`;
  assert.equal((await check()).status,409);
  assert.equal(await writes(),5);
  await calendar.mode('free');
  return {appliedId:uncertain.id,pendingId:pending.id,pendingEtag:edited.etag,fencedId:fenced.id,
    fencedEtag:recorded.original_etag,meetingId:invitation.id,start:Date.parse(uncertain.start)};
}

export async function verifyPortableCalendarMonitor({sql,meetings,reschedules,env,directory}){
  const backupRoot=join(directory,'monitor-backups');
  const run=()=>{
    const result=spawnSync(process.execPath,['scripts/portable-web.mjs','monitor-status',backupRoot,'--calendar'],
      {env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,encoding:'utf8',timeout:6000});
    assert.equal(result.status,2,result.stderr||result.stdout);
    assert.equal(result.stderr,'');
    assert.doesNotMatch(result.stdout,/example\.test|Fictional appointment|fictional-provider-id/);
    return JSON.parse(result.stdout).calendar;
  };
  const [invite]=await sql`SELECT created_at FROM portable_calendar_meetings WHERE id=${meetings.pendingId}`;
  const [cancel]=await sql`SELECT cancellation_started_at FROM portable_calendar_meetings WHERE id=${meetings.lossId}`;
  const [reschedule]=await sql`SELECT created_at FROM portable_calendar_reschedules WHERE id=${reschedules.pendingId}`;
  try{
    await sql`UPDATE portable_calendar_meetings SET created_at=floor(extract(epoch from clock_timestamp())*1000)
      WHERE id=${meetings.pendingId}`;
    await sql`UPDATE portable_calendar_meetings SET cancellation_started_at=floor(extract(epoch from clock_timestamp())*1000)
      WHERE id=${meetings.lossId}`;
    await sql`UPDATE portable_calendar_reschedules SET created_at=floor(extract(epoch from clock_timestamp())*1000)
      WHERE id=${reschedules.pendingId}`;
    assert.deepEqual(run(),{result:'ok',uncertainInvitation:false,staleInvitation:false,uncertainCancellation:false,staleCancellation:false,
      uncertainReschedule:false,staleReschedule:false});
    await sql`UPDATE portable_calendar_meetings SET created_at=0 WHERE id=${meetings.pendingId}`;
    await sql`UPDATE portable_calendar_meetings SET cancellation_started_at=0 WHERE id=${meetings.lossId}`;
    await sql`UPDATE portable_calendar_reschedules SET created_at=0 WHERE id=${reschedules.pendingId}`;
    assert.deepEqual(run(),{result:'attention',uncertainInvitation:false,staleInvitation:true,uncertainCancellation:false,staleCancellation:true,
      uncertainReschedule:false,staleReschedule:true});
    await sql`UPDATE portable_calendar_meetings SET status='attention' WHERE id=${meetings.pendingId}`;
    await sql`UPDATE portable_calendar_meetings SET status='cancel_attention' WHERE id=${meetings.lossId}`;
    await sql`UPDATE portable_calendar_reschedules SET status='attention' WHERE id=${reschedules.pendingId}`;
    assert.deepEqual(run(),{result:'attention',uncertainInvitation:true,staleInvitation:false,uncertainCancellation:true,staleCancellation:false,
      uncertainReschedule:true,staleReschedule:false});
  }finally{
    await sql`UPDATE portable_calendar_meetings SET status='submitting',created_at=${invite.created_at} WHERE id=${meetings.pendingId}`;
    await sql`UPDATE portable_calendar_meetings SET status='cancelling',cancellation_started_at=${cancel.cancellation_started_at}
      WHERE id=${meetings.lossId}`;
    await sql`UPDATE portable_calendar_reschedules SET status='submitting',created_at=${reschedule.created_at}
      WHERE id=${reschedules.pendingId}`;
  }
}
