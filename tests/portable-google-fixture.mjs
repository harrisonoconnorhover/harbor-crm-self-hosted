import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const scopes={
  gmail:['https://www.googleapis.com/auth/gmail.readonly'],
  calendar:['https://www.googleapis.com/auth/calendar.freebusy','https://www.googleapis.com/auth/userinfo.email'],
};
const personal=(provider)=>'personal-fixture-'+provider;
const email=(subject)=>subject+'@example.test';
const fixtureContact='personal-sender@example.test';
const slowCallbackStepMs=6_500;

export function personalGoogleFixture(directory){
  return {
    HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED:'true',
    HARBOR_PORTABLE_PERSONAL_GOOGLE_KEY:Buffer.alloc(32,53).toString('base64url'),
    HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID:personal('gmail'),
    HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_SECRET:'personal-fixture-gmail-secret',
    HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID:personal('calendar'),
    HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET:'personal-fixture-calendar-secret',
    HARBOR_TEST_PERSONAL_GOOGLE:join(directory,'personal-google.json'),
    HARBOR_TEST_PERSONAL_GOOGLE_CALLS:join(directory,'personal-google.jsonl'),
  };
}

export async function personalGoogleFetch(url,options){
  const client=options?.body instanceof URLSearchParams?options.body.get('client_id'):null;
  const auth=new Headers(options?.headers).get('authorization');
  const statePath=process.env.HARBOR_TEST_PERSONAL_GOOGLE;
  const fixtureState=async()=>JSON.parse(await readFile(statePath,'utf8'));
  const slowGmailRead=async(field,subject)=>{
    if((await fixtureState())[field]===subject)await delay(13_500,undefined,{signal:options.signal});
  };
  const slowCalendarRead=async()=>{
    if((await fixtureState()).slowCalendar)await delay(4_500,undefined,{signal:options?.signal});
  };
  const slowCallbackIdentity=async subject=>{
    if((await fixtureState()).slowCallbackIdentity===subject)
      await delay(slowCallbackStepMs,undefined,{signal:options.signal});
  };
  if(url.href==='https://oauth2.googleapis.com/token'&&['gmail','calendar'].some(provider=>personal(provider)===client)){
    const provider=client.slice('personal-fixture-'.length),body=options.body;
    const code=body.get('code'),refresh=body.get('refresh_token');
    await appendFile(process.env.HARBOR_TEST_PERSONAL_GOOGLE_CALLS,JSON.stringify({provider,operation:code?'code':'refresh'})+'\n');
    assert.equal(body.get('client_secret'),client+'-secret');
    let subject;
    if(code){
      const data=(await fixtureState())[code];
      assert.ok(data);
      assert.equal(provider,data.provider);
      assert.equal(body.get('redirect_uri'),process.env.HARBOR_LOGIN_ORIGIN+'/api/google/'+provider+'/callback');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),data.challenge);
      if(data.mode==='missing')return Response.json({access_token:'unusable',refresh_token:'unusable',expires_in:3600,token_type:'Bearer',scope:'openid'});
      subject=data.subject;
      if(data.mode==='slow_callback')await delay(slowCallbackStepMs,undefined,{signal:options.signal});
    }else{
      const prefix='personal-refresh-'+provider+'-';
      assert.ok(refresh.startsWith(prefix));
      subject=refresh.slice(prefix.length);
      if(subject==='revoked')return Response.json({error:'invalid_grant',error_description:'private fixture'},{status:400});
      if(provider==='gmail')await slowGmailRead('slowRefresh',subject);
      if(provider==='calendar')await slowCalendarRead();
    }
    return Response.json({access_token:'personal-access-'+provider+'-'+subject,refresh_token:'personal-refresh-'+provider+'-'+subject,
      expires_in:3600,token_type:'Bearer',scope:scopes[provider].join(' ')});
  }
  if(!auth?.startsWith('Bearer personal-access-'))return;
  const [provider,subject]=auth.slice('Bearer personal-access-'.length).split('-');
  await appendFile(process.env.HARBOR_TEST_PERSONAL_GOOGLE_CALLS,JSON.stringify({provider,operation:url.pathname,subject})+'\n');
  if(provider==='calendar'){
    await slowCalendarRead();
    if(url.href==='https://www.googleapis.com/oauth2/v2/userinfo'){
      await slowCallbackIdentity(subject);
      return Response.json({email:email(subject==='revoked'?'owner':subject),id:'fake-'+subject,verified_email:true});
    }
    assert.equal(url.href,'https://www.googleapis.com/calendar/v3/freeBusy');
    const {deniedFreeBusy,holdDeniedFreeBusy}=await fixtureState();
    if(deniedFreeBusy===subject){
      if(holdDeniedFreeBusy){
        await appendFile(process.env.HARBOR_TEST_PERSONAL_GOOGLE_CALLS,JSON.stringify({operation:'held_free_busy_auth'})+'\n');
        for(let attempt=0;attempt<300&&(await fixtureState()).holdDeniedFreeBusy;attempt++)
          await delay(10,undefined,{signal:options.signal});
      }
      return Response.json({error:'Fictional authorization failure'},{status:401});
    }
    const window=JSON.parse(options.body);
    assert.deepEqual(window.items,[{id:'primary'}]);
    return Response.json({calendars:{primary:{busy:subject==='owner'?[{start:window.timeMin,end:window.timeMax}]:[]}}});
  }
  assert.equal(url.origin,'https://gmail.googleapis.com');
  assert.equal(options?.method??'GET','GET');
  const path='/gmail/v1/users/me/';
  if(url.pathname===path+'profile'){
    await slowGmailRead('slowProfile',subject);
    await slowCallbackIdentity(subject);
    return Response.json({emailAddress:email(subject==='revoked'?'owner':subject)});
  }
  if(url.pathname===path+'messages'){
    assert.match(url.searchParams.get('q'),/from:"personal-sender@example\.test"/);
    const {gmailIndexFailure}=await fixtureState();
    if(gmailIndexFailure?.subject===subject)
      return Response.json({error:'Fictional mailbox failure'},{status:gmailIndexFailure.status});
    return Response.json({messages:[{id:subject+'-mail',threadId:subject+'-thread'}]});
  }
  assert.equal(url.pathname,path+'messages/'+subject+'-mail');
  const format=url.searchParams.get('format');
  if(format==='full'&&(await fixtureState()).pauseBody===subject){
    await appendFile(process.env.HARBOR_TEST_PERSONAL_GOOGLE_CALLS,JSON.stringify({operation:'held_full'})+'\n');
    for(let attempt=0;attempt<150;attempt++){
      if(!(await fixtureState()).pauseBody)break;
      await delay(10);
    }
  }
  return Response.json({id:subject+'-mail',threadId:subject+'-thread',internalDate:'1760000000000',labelIds:['INBOX'],
    payload:{mimeType:'text/plain',headers:[{name:'From',value:fixtureContact},{name:'Subject',value:subject+' private fixture'}],
      ...(format==='full'?{body:{data:Buffer.from(subject+' private body').toString('base64url')}}:{})}});
}

export async function verifyPersonalGoogle({request,origin,headers,other,signIn,sql,fixture,ownerContact,otherContact}){
  const endpoints=provider=>'/api/google/connections?provider='+provider;
  const status=async(provider,session)=> (await request(endpoints(provider),{headers:session})).json();
  const data={};
  let codeCount=0;
  const calls=async()=>String(await readFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE_CALLS)).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE_CALLS,'');
  const start=async(provider,session,subject,mode)=>{
    const response=await request(endpoints(provider),{method:'POST',headers:{...session,origin}});
    assert.equal(response.status,303,await response.clone().text());
    assert.match(response.headers.get('cache-control'),/no-store/);
    const location=new URL(response.headers.get('location'));
    assert.equal(location.origin,'https://accounts.google.com');
    assert.equal(location.searchParams.get('scope'),scopes[provider].join(' '));
    assert.equal(location.searchParams.get('code_challenge_method'),'S256');
    assert.equal(location.searchParams.get('access_type'),'offline');
    assert.equal(location.searchParams.get('redirect_uri'),origin+'/api/google/'+provider+'/callback');
    const code='personal-code-'+codeCount++;
    data[code]={challenge:location.searchParams.get('code_challenge'),provider,subject,mode};
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
    return '/api/google/'+provider+'/callback?'+new URLSearchParams({state:location.searchParams.get('state'),code});
  };
  const finish=async(path,session,options={})=>{
    const response=await request(path,{headers:session,...options});
    assert.equal(response.status,303,await response.clone().text());
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    return new URL(response.headers.get('location'),origin).searchParams.get('google');
  };
  const post=(path,session,payload,options)=>request(path,{method:'POST',
    headers:{...session,origin,'content-type':'application/json'},body:JSON.stringify(payload),...options});
  const end=(provider,session,id)=>request(endpoints(provider),{method:'DELETE',
    headers:{...session,origin,'content-type':'application/json'},body:JSON.stringify({id})});
  const logout=session=>request('/auth/logout',{method:'POST',headers:{...session,origin},
    body:new URLSearchParams({scope:'current'})});

  assert.equal((await request(endpoints('gmail'))).status,401);
  assert.equal((await post(endpoints('gmail')+'&action=check',{},{})).status,401);
  assert.equal((await request(endpoints('gmail'),{method:'POST',headers:{...headers,origin:'https://other.example.test'}})).status,403);
  const html=async (path,session)=>(await (await request(path,{headers:session})).text()).replace(/<!--.*?-->/g,'');
  async function guide(session){
    const before=(await calls()).length;
    const response=await request('/?view=getting-started',{headers:session});
    assert.equal(response.status,200);
    const page=(await response.text()).replace(/<!--.*?-->/g,'');
    assert.equal((await calls()).length,before,'Reading the guide must not contact Google.');
    for(const [name,value] of Object.entries(fixture))if(/_(KEY|CLIENT_ID|CLIENT_SECRET)$/.test(name))
      assert.ok(!page.includes(value),name+' is not rendered.');
    assert.doesNotMatch(page,/personal-(?:refresh|access)-/);
    return page;
  }
  assert.ok((await html('/?view=email-settings',headers)).includes('Connect Gmail'),'Gmail connect button is visible.');
  assert.ok((await html('/?view=calendar',other)).includes('Connect Google Calendar'),'Calendar connect button is visible.');
  const initialGuide=await guide(headers);
  assert.match(initialGuide,/<h2 id="personal-google-title">Connect Gmail and Calendar<\/h2>/);
  assert.ok(initialGuide.includes('<a href="/?view=email-settings">Open Email settings</a>'),'Guide links to Gmail consent.');
  assert.ok(initialGuide.includes('<a href="/?view=calendar">Open Calendar</a>'),'Guide links to Calendar consent.');
  assert.match(initialGuide,/Connect Google Calendar/);
  assert.doesNotMatch(initialGuide,/Unavailable:|Check Gmail connection|Check Google Calendar connection/);
  const first=await start('gmail',headers,'owner');
  const otherSession=await signIn('owner@example.test');
  assert.equal(await finish(first,other),'expired');
  assert.equal(await finish(first,otherSession),'expired');
  assert.equal((await logout(otherSession)).status,303);
  assert.equal(await finish(first.replace('/gmail/','/calendar/'),headers),'expired');
  assert.equal((await calls()).length,0);
  const completed=await Promise.all([finish(first,headers),finish(first,headers)]);
  assert.deepEqual(completed.sort(),['connected','expired']);
  assert.equal((await calls()).filter(call=>call.operation==='code').length,1);
  const ownerGmail=(await status('gmail',headers)).connection;
  assert.equal(ownerGmail.email,email('owner'));
  assert.deepEqual(await status('gmail',other),{connection:null});
  const ownerGmailGuide=await guide(headers);
  assert.match(ownerGmailGuide,/Check Gmail connection/);
  assert.match(ownerGmailGuide,/Connect Google Calendar/);
  assert.doesNotMatch(await guide(other),/Check Gmail connection|Check Google Calendar connection/);
  assert.equal(await finish(await start('gmail',other,'owner'),other),'wrong_account');
  assert.equal(await finish(await start('gmail',other,'other','missing'),other),'permissions');
  assert.deepEqual(await status('gmail',other),{connection:null});
  assert.equal(await finish(await start('gmail',other,'other'),other),'connected');

  const priorGmail=await status('gmail',other);
  assert.deepEqual(await status('calendar',other),{connection:null});
  const slowGmailCallback=await start('gmail',other,'other','slow_callback');
  const slowCalendarCallback=await start('calendar',other,'other','slow_callback');
  const beforeSlowCallbacks=(await calls()).length;
  data.slowCallbackIdentity='other';
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  try{
    const providerWait={signal:AbortSignal.timeout(20_000)};
    const outcomes=await Promise.all([
      finish(slowGmailCallback,other,providerWait),finish(slowCalendarCallback,other,providerWait),
    ]);
    assert.deepEqual(outcomes,['provider_unavailable','provider_unavailable'],
      'Each callback shares one deadline across its token exchange and identity request.');
    const retryNotice=/Google took too long to complete this connection\. Start a new connection and try again\./;
    assert.match(await html('/?view=email-settings&google=provider_unavailable',other),retryNotice);
    assert.match(await html('/?view=calendar&google=provider_unavailable',other),retryNotice);
    assert.deepEqual(await status('gmail',other),priorGmail,'A slow reconnect preserves the existing Gmail grant.');
    assert.deepEqual(await status('calendar',other),{connection:null},'A slow callback does not save a Calendar grant.');
    const afterSlowCallbacks=await calls();
    const recorded=afterSlowCallbacks.slice(beforeSlowCallbacks);
    assert.deepEqual(recorded.filter(call=>call.provider==='gmail').map(call=>call.operation),
      ['code','/gmail/v1/users/me/profile']);
    assert.deepEqual(recorded.filter(call=>call.provider==='calendar').map(call=>call.operation),
      ['code','/oauth2/v2/userinfo']);
    assert.deepEqual(await Promise.all([finish(slowGmailCallback,other),finish(slowCalendarCallback,other)]),['expired','expired']);
    assert.deepEqual(await calls(),afterSlowCallbacks,'Replayed callbacks must not contact Google.');
  }finally{
    delete data.slowCallbackIdentity;
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  }
  assert.equal(await finish(await start('gmail',other,'other'),other),'connected');
  assert.notEqual((await status('gmail',other)).connection.id,priorGmail.connection.id);
  assert.equal(await finish(await start('calendar',other,'other'),other),'connected');
  assert.equal((await status('calendar',other)).connection.email,email('other'));

  const search=(session,recordId)=>post('/api/email/inbox',session,{recordId});
  const checkGmail=endpoints('gmail')+'&action=check';
  data.slowRefresh='owner';
  data.slowProfile='other';
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  try{
    const providerWait={signal:AbortSignal.timeout(18_000)};
    const [slowSearch,slowCheck]=await Promise.all([
      post('/api/email/inbox',headers,{recordId:ownerContact},providerWait),
      post(checkGmail,other,{},providerWait),
    ]);
    assert.equal(slowSearch.status,503,'The inbox deadline also bounds token refresh.');
    assert.equal(slowCheck.status,503,'The personal Gmail check deadline also bounds mailbox identity.');
    assert.equal((await status('gmail',headers)).connection.needsReconnect,false);
    assert.equal((await status('gmail',other)).connection.needsReconnect,false);
  }finally{
    delete data.slowRefresh;
    delete data.slowProfile;
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  }

  assert.equal((await search(other,ownerContact)).status,404);
  const results=await search(headers,ownerContact);
  assert.equal(results.status,200,await results.clone().text());
  const [item]=(await results.json()).items;
  assert.equal(item.subject,'owner private fixture');
  const preview=await post('/api/email/inbox',headers,{recordId:ownerContact,preview:item.selection});
  assert.deepEqual(await preview.json(),{body:'owner private body',truncated:false});
  assert.equal((await post('/api/email/inbox',other,{recordId:otherContact,preview:item.selection})).status,409);
  const [otherItem]=(await (await search(other,otherContact)).json()).items;
  assert.equal(otherItem.subject,'other private fixture');
  const save=(session,recordId,selection)=>request('/api/email/inbox',{method:'PUT',
    headers:{...session,origin,'content-type':'application/json'},body:JSON.stringify({recordId,selection})});
  assert.equal((await save(other,ownerContact,item.selection)).status,404);
  assert.equal((await end('gmail',other,ownerGmail.id)).status,409);
  data.pauseBody='owner';
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  const pendingSave=save(headers,ownerContact,item.selection);
  try{
    let holding=false;
    for(let attempt=0;attempt<100&&!holding;attempt++){
      holding=(await calls()).some(call=>call.operation==='held_full');
      if(!holding)await delay(10);
    }
    assert.ok(holding,'The email body read should be in flight before disconnect.');
    assert.equal((await end('gmail',headers,ownerGmail.id)).status,200);
  }finally{
    delete data.pauseBody;
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  }
  assert.equal((await pendingSave).status,409);
  assert.equal((await sql`SELECT id FROM portable_contact_activities WHERE contact_id=${ownerContact}`).length,0);
  assert.equal((await search(headers,ownerContact)).status,409);
  assert.equal((await search(other,otherContact)).status,200);
  const disconnectedGuide=await guide(headers);
  assert.match(disconnectedGuide,/>Connect Gmail</);
  assert.doesNotMatch(disconnectedGuide,/Check Gmail connection|Reconnect Gmail/);
  assert.match(await guide(other),/Check Gmail connection/);
  assert.equal(await finish(await start('gmail',headers,'owner'),headers),'connected');
  assert.equal((await post('/api/email/inbox',headers,{recordId:ownerContact,preview:item.selection})).status,409);
  assert.equal((await end('gmail',headers,ownerGmail.id)).status,409);
  const [fresh]=(await (await search(headers,ownerContact)).json()).items;
  const logged=await save(headers,ownerContact,fresh.selection);
  assert.equal(logged.status,200,await logged.clone().text());
  const receipt=await logged.json();
  assert.equal(receipt.alreadyLogged,false);
  assert.deepEqual(await (await save(headers,ownerContact,fresh.selection)).json(),{...receipt,alreadyLogged:true});
  const timeline=await (await request('/api/logged-activities?contactId='+ownerContact,{headers})).json();
  assert.equal(timeline.lastContacted,Date.parse(fresh.receivedAt));
  assert.equal(timeline.items.filter(activity=>activity.id===receipt.activityId).length,1);

  for(const upstream of [503,401]){
    data.gmailIndexFailure={subject:'owner',status:upstream};
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
    const failed=await search(headers,ownerContact);
    assert.equal(failed.status,upstream===401?409:503);
    if(upstream===401){
      const result=await failed.json();
      assert.equal(result.code,'mailbox_authorization');
      assert.match(result.error,/^Reconnect your Google account/);
    }
    assert.equal((await status('gmail',headers)).connection.needsReconnect,upstream===401);
    assert.equal((await search(other,otherContact)).status,200);
  }
  delete data.gmailIndexFailure;
  assert.equal(await finish(await start('gmail',headers,'owner'),headers),'connected');
  assert.equal((await search(headers,ownerContact)).status,200);

  const current=(await status('gmail',headers)).connection;
  const otherGmail=(await status('gmail',other)).connection;
  const [differentCredential]=await sql`SELECT refresh_token FROM portable_google_grants WHERE id=${otherGmail.id}`;
  // A ciphertext bound to the other grant cannot open under the current grant's associated data.
  await sql`UPDATE portable_google_grants SET refresh_token=${differentCredential.refresh_token} WHERE id=${current.id}`;
  const beforeMismatch=(await calls()).length;
  const invalid=await post(checkGmail,headers,{});
  assert.equal(invalid.status,409);
  assert.match((await invalid.json()).error,/^Reconnect your Google account/);
  assert.equal((await calls()).length,beforeMismatch,'Invalid ciphertext must not reach Google.');
  assert.equal((await status('gmail',headers)).connection.needsReconnect,true);
  assert.equal((await status('gmail',other)).connection.needsReconnect,false);
  const gmailReconnectGuide=await guide(headers);
  assert.match(gmailReconnectGuide,/Reconnect Gmail/);
  assert.doesNotMatch(gmailReconnectGuide,/Check Gmail connection/);
  assert.match(await guide(other),/Check Gmail connection/);
  assert.deepEqual(await (await search(headers,ownerContact)).json(),{
    code:'mailbox_authorization',error:'Reconnect your Gmail account in Email settings.',
  });
  assert.equal(await finish(await start('gmail',headers,'owner'),headers),'connected');
  assert.notEqual((await status('gmail',headers)).connection.id,current.id);
  assert.equal((await post(checkGmail,headers,{})).status,200);

  const checkCalendar=endpoints('calendar')+'&action=check';
  const availability='/api/calendar/availability';
  assert.equal(await finish(await start('calendar',headers,'revoked'),headers),'connected');
  assert.equal((await post(availability,headers,{action:'check_connection'})).status,409);
  assert.equal((await status('calendar',headers)).connection.needsReconnect,true);
  assert.equal(await finish(await start('calendar',headers,'owner'),headers),'connected');
  data.deniedFreeBusy='owner';
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  const deniedPanel=await post(checkCalendar,headers,{});
  assert.equal(deniedPanel.status,409,'A revoked Calendar read after successful token refresh needs reconnection.');
  assert.match((await deniedPanel.json()).error,/^Reconnect your Google account/);
  assert.equal((await status('calendar',headers)).connection.needsReconnect,true);
  assert.equal((await status('calendar',other)).connection.needsReconnect,false);
  const calendarReconnectGuide=await guide(headers);
  assert.match(calendarReconnectGuide,/Reconnect Google Calendar/);
  assert.match(calendarReconnectGuide,/Check Gmail connection/);
  assert.doesNotMatch(calendarReconnectGuide,/Check Google Calendar connection/);
  assert.doesNotMatch(await guide(other),/Reconnect Google Calendar/);
  delete data.deniedFreeBusy;
  assert.equal(await finish(await start('calendar',headers,'owner'),headers),'connected');
  const windowStart=Date.now()+86_400_000,window={start:new Date(windowStart).toISOString(),
    end:new Date(windowStart+900_000).toISOString(),timeZone:'UTC'};
  const beforeSlowCalendar=(await calls()).length;
  data.slowCalendar=true;
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  try{
    const providerWait={signal:AbortSignal.timeout(20_000)};
    const [slowCheck,slowAvailability]=await Promise.all([
      post(checkCalendar,headers,{},providerWait),
      post(availability,other,window,providerWait),
    ]);
    assert.equal(slowCheck.status,503,'The connection check shares a deadline across Calendar operations.');
    assert.equal(slowAvailability.status,503,'The availability check shares a deadline across Calendar operations.');
    const calendarCalls=(await calls()).slice(beforeSlowCalendar).filter(call=>call.provider==='calendar');
    assert.equal(calendarCalls.filter(call=>call.operation==='refresh').length,2);
    for(const operation of ['/oauth2/v2/userinfo','/calendar/v3/freeBusy'])
      assert.deepEqual(calendarCalls.filter(call=>call.operation===operation).map(call=>call.subject).sort(),['other','owner']);
    assert.equal((await status('calendar',headers)).connection.needsReconnect,false);
    assert.equal((await status('calendar',other)).connection.needsReconnect,false);
  }finally{
    delete data.slowCalendar;
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  }
  const healthyCheck=await post(checkCalendar,headers,{});
  assert.equal(healthyCheck.status,200);
  assert.deepEqual(await healthyCheck.json(),{connection:'ok'});
  const connectedGuide=await guide(headers);
  assert.match(connectedGuide,/Check Gmail connection/);
  assert.match(connectedGuide,/Check Google Calendar connection/);
  assert.doesNotMatch(connectedGuide,/Reconnect Gmail|Reconnect Google Calendar/);
  assert.equal((await (await post(availability,headers,window)).json()).availability,'busy');
  assert.equal((await (await post(availability,other,window)).json()).availability,'free');
  data.deniedFreeBusy='owner';
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  const deniedAvailability=await post(availability,headers,window);
  assert.equal(deniedAvailability.status,409);
  assert.match((await deniedAvailability.json()).error,/^Reconnect your Google account/);
  assert.equal((await status('calendar',headers)).connection.needsReconnect,true);
  assert.equal((await (await post(availability,other,window)).json()).availability,'free');
  delete data.deniedFreeBusy;
  assert.equal(await finish(await start('calendar',headers,'owner'),headers),'connected');
  const beforeRotation=(await status('calendar',headers)).connection.id;
  data.deniedFreeBusy='owner';
  data.holdDeniedFreeBusy=true;
  await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  const staleRead=post(availability,headers,window);
  try{
    let held=false;
    for(let attempt=0;attempt<100&&!held;attempt++){
      held=(await calls()).some(call=>call.operation==='held_free_busy_auth');
      if(!held)await delay(10);
    }
    assert.ok(held,'An older Calendar read should be in flight when the grant changes.');
    assert.equal(await finish(await start('calendar',headers,'owner'),headers),'connected');
  }finally{
    delete data.deniedFreeBusy;
    delete data.holdDeniedFreeBusy;
    await writeFile(fixture.HARBOR_TEST_PERSONAL_GOOGLE,JSON.stringify(data));
  }
  const staleResult=await staleRead;
  assert.equal(staleResult.status,409);
  assert.match((await staleResult.json()).error,/^This Google connection changed/);
  const replacement=(await status('calendar',headers)).connection;
  assert.notEqual(replacement.id,beforeRotation);
  assert.equal(replacement.needsReconnect,false);
  assert.equal((await (await post(availability,headers,window)).json()).availability,'busy');
  assert.equal((await post('/api/calendar/meetings',headers,{})).status,403);

  const stale=await start('calendar',other,'other');
  await start('calendar',other,'other');
  assert.equal(await finish(stale,other),'expired');
  const short=await signIn('other@example.test'),duringLogout=await start('gmail',short,'other');
  assert.equal((await logout(short)).status,303);
  assert.equal((await request(duringLogout,{headers:short})).status,401);
  const grants=await sql`SELECT provider,refresh_token FROM portable_google_grants`;
  assert.equal(grants.length,4);
  assert.ok(grants.every(row=>/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.refresh_token)));
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_google_attempts`)[0].count,1);
}
