import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const tenant='11111111-1111-4111-8111-111111111111';
const client='22222222-2222-4222-8222-222222222222';
const scopes={'outlook-mail':'Mail.Read','outlook-calendar':'Calendars.ReadBasic'};
const mailboxId=email=>'id-'+email.split('@')[0];
export function outlookFixture(directory) {
  return {HARBOR_PORTABLE_OUTLOOK_ENABLED:'true',HARBOR_OUTLOOK_TENANT_ID:tenant,HARBOR_OUTLOOK_CLIENT_ID:client,
    HARBOR_OUTLOOK_CLIENT_SECRET:'fictional-outlook-secret',HARBOR_OUTLOOK_KEY:randomBytes(32).toString('base64url'),
    HARBOR_TEST_OUTLOOK_CODE:join(directory,'outlook-code.json')};
}
export async function outlookConnectionFetch(url,options) {
  if (url.href==='https://login.microsoftonline.com/'+tenant+'/oauth2/v2.0/token') {
    const form=options.body;
    assert.equal(form.get('client_id'),client);
    assert.equal(form.get('client_secret'),'fictional-outlook-secret');
    const provider=form.get('scope').includes('/Mail.Read')?'outlook-mail':'outlook-calendar';
    let email,generation=0,mode;
    if (form.get('grant_type')==='authorization_code') {
      const code=JSON.parse(await readFile(process.env.HARBOR_TEST_OUTLOOK_CODE,'utf8'));
      assert.equal(form.get('code'),code.code);
      assert.equal(form.get('redirect_uri'),code.redirectUri);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),code.challenge);
      email=code.email;
      mode=code.mode;
    } else {
      assert.equal(form.get('grant_type'),'refresh_token');
      const [prefix,source,owner,index]=form.get('refresh_token').split(':');
      assert.equal(prefix,'outlook-refresh');
      assert.equal(source,provider);
      email=owner;
      generation=Number(index)+1;
    }
    const optedIn=(process.env.HARBOR_OUTLOOK_CALENDAR_READ_EMAILS||'').toLowerCase().split(',');
    const scope=provider==='outlook-calendar'&&optedIn.includes(email)?'Calendars.Read':scopes[provider];
    assert.deepEqual(form.get('scope').split(' ').sort(),['offline_access','https://graph.microsoft.com/User.Read','https://graph.microsoft.com/'+scope].sort());
    return Response.json({token_type:'Bearer',access_token:'outlook-test:'+provider+':'+email,
      refresh_token:'outlook-refresh:'+provider+':'+email+':'+generation,
      scope:mode==='missing_scope'?'User.Read':'User.Read '+scope+(mode==='unexpected_scope'?' Calendars.ReadWrite':'')});
  }
  const auth=new Headers(options?.headers).get('authorization')||'';
  if (!auth.startsWith('Bearer outlook-test:')) return;
  assert.equal(url.origin,'https://graph.microsoft.com');
  const [,provider,email]=auth.split(':');
  if (url.pathname==='/v1.0/me') {
    assert.equal(url.searchParams.get('$select'),'id,mail,userPrincipalName');
    return Response.json({id:mailboxId(email),mail:email,userPrincipalName:email});
  }
  if (url.searchParams.get('$select')==='id') {
    assert.equal(url.pathname,provider==='outlook-mail'?'/v1.0/me/mailFolders/inbox/messages':'/v1.0/me/calendar/calendarView');
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(url.searchParams.get('$top'),'1');
    if(provider==='outlook-calendar')assert.equal(Date.parse(url.searchParams.get('endDateTime'))-Date.parse(url.searchParams.get('startDateTime')),60_000);
    if(process.env.HARBOR_TEST_OUTLOOK_DENY_RESOURCE===provider)return new Response(null,{status:403});
    return Response.json({value:provider==='outlook-calendar'?[]:[{id:'fictional-message-id'}]});
  }
  if (url.pathname==='/v1.0/me/calendarView' && url.searchParams.get('$select')==='isCancelled,showAs') {
    assert.equal(provider,'outlook-calendar');
    assert.equal(url.searchParams.get('$top'),'100');
    const hour=new Date(url.searchParams.get('startDateTime')).getUTCHours();
    if (hour===15) return Response.json({value:[{showAs:'free',isCancelled:false}],'@odata.nextLink':'https://graph.microsoft.com/synthetic-next'});
    return Response.json({value:[{showAs:'busy',isCancelled:hour===13},{showAs:'free',isCancelled:false}]});
  }
}

export function outlookClient({request,origin,fixture}) {
  const endpoint=provider=>'/api/outlook/connections?provider='+provider;
  const call=(auth,provider,method='GET',suffix='',data)=>request(endpoint(provider)+suffix,{method,
    headers:{...auth,origin,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const status=async(auth,provider)=>{
    const res=await call(auth,provider);
    assert.equal(res.status,200,await res.clone().text());
    return (await res.json()).connection;
  };
  const begin=async(auth,provider,expectedScope=scopes[provider])=>{
    const res=await call(auth,provider,'POST');
    assert.equal(res.status,303,await res.clone().text());
    const url=new URL(res.headers.get('location'));
    assert.equal(url.origin,'https://login.microsoftonline.com');
    assert.equal(url.pathname,'/'+tenant+'/oauth2/v2.0/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    assert.equal(url.searchParams.get('client_id'),client);
    assert.deepEqual(url.searchParams.get('scope').split(' ').sort(),['https://graph.microsoft.com/User.Read','https://graph.microsoft.com/'+expectedScope,'offline_access'].sort());
    return {state:url.searchParams.get('state'),challenge:url.searchParams.get('code_challenge'),redirectUri:url.searchParams.get('redirect_uri')};
  };
  const finish=async(auth,attempt,code)=>{
    const res=await request(new URL(attempt.redirectUri).pathname+'?'+new URLSearchParams({state:attempt.state,code}),{headers:auth});
    assert.equal(res.status,303);
    assert.match(res.headers.get('cache-control'),/no-store/);
    return new URL(res.headers.get('location'),origin).searchParams.get('outlook');
  };
  const connect=async(auth,provider,email,expected='connected',mode,expectedScope=scopes[provider])=>{
    const attempt=await begin(auth,provider,expectedScope);
    const code=randomBytes(16).toString('hex');
    await writeFile(fixture.HARBOR_TEST_OUTLOOK_CODE,JSON.stringify({...attempt,code,email,mode}));
    assert.equal(await finish(auth,attempt,code),expected);
    assert.equal(await finish(auth,attempt,code),'expired');
  };
  return {endpoint,call,status,begin,finish,connect};
}

export async function verifyOutlookConnections({request,origin,headers,other,sql,fixture,verifyRecords}) {
  const {endpoint,call,status,begin,finish,connect}=outlookClient({request,origin,fixture});
  assert.equal((await request(endpoint('outlook-mail'))).status,401);
  assert.equal((await request(endpoint('outlook-mail'),{method:'POST',headers:{...headers,origin:'https://different.example.test'}})).status,403);
  for (const [view,name] of [['email-settings','Outlook Mail'],['calendar','Outlook Calendar']]) {
    const res=await request('/?view='+view,{headers});
    assert.equal(res.status,200);
    assert.ok((await res.text()).replaceAll('<!-- -->','').includes('Connect '+name));
  }
  const attempt=await begin(headers,'outlook-mail');
  assert.equal(await finish(other,attempt,'wrong-session'),'expired');
  assert.equal(await finish(headers,{...attempt,redirectUri:origin+'/api/outlook/calendar/callback'},'wrong-provider'),'expired');
  await connect(headers,'outlook-mail','other@example.test','wrong_account');
  await connect(headers,'outlook-calendar','owner@example.test','permissions','missing_scope');
  assert.equal(await status(headers,'outlook-mail'),null);
  assert.equal(await status(headers,'outlook-calendar'),null);
  for (const [auth,email] of [[headers,'owner@example.test'],[other,'other@example.test']]) {
    for (const provider of Object.keys(scopes)) {
      await connect(auth,provider,email);
      const row=await status(auth,provider);
      assert.deepEqual(Object.keys(row).sort(),['id','email','needsReconnect'].sort());
      assert.equal(row.email,email);
      const before=await sql`SELECT refresh_token FROM portable_google_grants WHERE id=${row.id}`;
      assert.match(before[0].refresh_token,/^v1\./);
      assert.equal((await call(auth,provider,'POST','&action=check')).status,200);
      const after=await sql`SELECT refresh_token FROM portable_google_grants WHERE id=${row.id}`;
      assert.notEqual(before[0].refresh_token,after[0].refresh_token);
    }
  }
  for (const [hour,result] of [[13,'free'],[14,'busy'],[15,'unknown']]) {
    const response=await request('/api/outlook/availability',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({start:'2026-11-18T'+hour+':00:00Z',end:'2026-11-18T'+hour+':30:00Z'})});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).availability,result);
  }
  await verifyRecords({request,origin,headers,other,sql});
  const {id}=await status(headers,'outlook-mail');
  assert.equal((await call(other,'outlook-mail','DELETE','',{id})).status,409);
  assert.equal((await call(headers,'outlook-mail','DELETE','',{id})).status,200);
  assert.equal(await status(headers,'outlook-mail'),null);
  assert.ok(await status(headers,'outlook-calendar'));
  assert.ok(await status(other,'outlook-mail'));
  for (const [auth,provider] of [[headers,'outlook-calendar'],[other,'outlook-mail'],[other,'outlook-calendar']]) {
    const row=await status(auth,provider);
    assert.equal((await call(auth,provider,'DELETE','',{id:row.id})).status,200);
  }
}
