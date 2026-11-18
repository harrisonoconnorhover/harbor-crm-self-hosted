import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import postgres from 'postgres';
import {outlookFixture,outlookClient} from './portable-outlook-connection-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const preload=fileURLToPath(new URL('./portable-microsoft-provider-fixture.mjs',import.meta.url));
const run=promisify(execFile),database=process.env.HARBOR_TEST_POSTGRES_URL;
const owner='ms-owner@example.test',guest='ms-guest@example.test',legacy='legacy@example.test';
const consumerTenant='9188040d-6c67-4c5b-b112-36a304b66dad';
const client=crypto.randomUUID(),tenant=crypto.randomUUID(),obj=crypto.randomUUID(),guestObj=crypto.randomUUID();

test('Portable Microsoft sign-in through the built app, including pinned identities, invited access and Google coexistence',
  {skip:!database,timeout:160000},async()=>{
    const url=new URL(database);
    assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname),
      'Use the disposable loopback Harbor test database.');
    const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_ms_identity_'+crypto.randomUUID().replaceAll('-','');
    const dir=await mkdtemp(join(tmpdir(),'harbor-ms-identity-')),file=join(dir,'identity.json');
    const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');
    const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const origin='http://127.0.0.1:'+port;
    const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:dir,PORT:String(port),HARBOR_LOGIN_ORIGIN:origin,HARBOR_PORTABLE_MODE:'local',
      HARBOR_LOGIN_ALLOWED_EMAILS:[owner,legacy].join(','),HARBOR_LOGIN_MICROSOFT_TENANT_ID:tenant,HARBOR_LOGIN_MICROSOFT_CLIENT_ID:client,
      HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET:'fixture-identity-secret',HARBOR_LOGIN_MICROSOFT_BINDINGS:JSON.stringify({[obj]:owner,[guestObj]:guest}),
      HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED:'true',HARBOR_TEST_MICROSOFT_IDENTITY_FIXTURE:file};
    const outlookSettings=outlookFixture(dir);
    Object.assign(env,outlookSettings);
    const pairs={google:await generateKeyPair('RS256'),microsoft:await generateKeyPair('RS256')};
    const keys={};for(const [p,k] of Object.entries(pairs))keys[p]={...await exportJWK(k.publicKey),kid:p,alg:'RS256',use:'sig'};
    let child,exited,logs='',created=false,sql;
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(8000),...options});
    const json=(path,body,cookie)=>request(path,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const protectedRead=cookie=>request('/api/crm',{headers:{cookie}});
    async function stop(){
      if(!child)return;
      if(child.exitCode===null&&child.signalCode===null)child.kill();
      await exited;child=undefined;
    }
    async function restart(expected=200){
      await stop();logs='';
      child=spawn(process.execPath,['--import',preload,'scripts/portable-web.mjs','start'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
      exited=once(child,'exit');for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-4000);});
      for(let i=0;i<130;i++){
        if(child.exitCode!==null)break;
        const response=await request('/auth/sign-in').catch(()=>null);
        if(response){assert.equal(response.status,expected,logs);return (await response.text()).replaceAll('<!-- -->','');}
        await delay(65);
      }
      assert.fail('Local portable web did not start. '+logs);
    }
    async function prepare(provider='microsoft',claims={},signer=provider){
      const path='/auth/'+provider+'/start?return_to='+encodeURIComponent('/?view=workspaces');
      const start=await request(path);assert.equal(start.status,303);
      const to=new URL(start.headers.get('location')),q=to.searchParams,isMS=provider==='microsoft';
      const tid=env.HARBOR_LOGIN_MICROSOFT_TENANT_ID;
      if(isMS){
        const authority=tid===consumerTenant?'consumers':tid;
        assert.equal(to.origin+to.pathname,'https://login.microsoftonline.com/'+authority+'/oauth2/v2.0/authorize');
      }else assert.equal(to.origin,'https://accounts.google.com');
      assert.equal(q.get('scope'),isMS?'openid profile email':'openid email profile');
      assert.equal(q.get('redirect_uri'),origin+'/auth/'+provider+'/callback');
      assert.equal(q.get('code_challenge_method'),'S256');
      assert.equal(q.get('response_type'),'code');
      const common={sub:'local-subject',name:'Fictional Harbor user',nonce:q.get('nonce')};
      const profile=isMS?{ver:'2.0',tid,oid:obj,preferred_username:'irrelevant@example.test'}:{email:legacy,email_verified:true};
      const token=await new SignJWT({...common,...profile,...claims}).setProtectedHeader({alg:'RS256',kid:provider})
        .setIssuer(claims.iss??(isMS?'https://login.microsoftonline.com/'+tid+'/v2.0':'https://accounts.google.com'))
        .setAudience(claims.aud??(isMS?client:env.HARBOR_LOGIN_GOOGLE_CLIENT_ID)).setIssuedAt().setExpirationTime(claims.exp??'5m').sign(pairs[signer].privateKey);
      const code=crypto.randomUUID(),state=q.get('state');
      await writeFile(file,JSON.stringify({keys,code,token,challenge:q.get('code_challenge')}),{mode:0o600});
      const cookie=start.headers.getSetCookie()[0].split(';')[0];
      return (overrides={})=>request('/auth/'+provider+'/callback?'+new URLSearchParams({code,state,...overrides}),{headers:{cookie}});
    }
    async function login(provider='microsoft',claims={}){
      const response=await (await prepare(provider,claims))();
      assert.equal(response.status,303);assert.equal(response.headers.get('location'),origin+'/?view=workspaces',logs);
      return response.headers.getSetCookie().find(value=>value.startsWith('harbor-session=')).split(';')[0];
    }
    async function rejected(callback,reason='sign_in_failed'){
      const response=await callback();const dest=new URL(response.headers.get('location'));
      assert.equal(dest.pathname,'/auth/sign-in');assert.equal(dest.searchParams.get('error'),reason);
      assert.ok(!response.headers.getSetCookie().some(value=>value.startsWith('harbor-session=')));
    }
    try{
      await admin`CREATE DATABASE ${admin(name)}`;created=true;url.pathname='/'+name;
      env.DATABASE_URL=url.href;sql=postgres(url.href,{max:1,onnotice:()=>{}});
      await run(process.execPath,['scripts/portable-web.mjs','migrate'],{cwd:root,env});
      env.HARBOR_LOGIN_MICROSOFT_TENANT_ID='common';
      const incomplete=await restart(503);
      assert.match(incomplete,/Setting up Microsoft sign-in/);assert.doesNotMatch(incomplete,/Continue with Microsoft/);
      assert.ok(incomplete.includes(origin+'/auth/microsoft/callback'));
      env.HARBOR_LOGIN_MICROSOFT_TENANT_ID=tenant;
      const html=await restart();assert.match(html,/Continue with Microsoft/);assert.doesNotMatch(html,/Continue with Google/);
      assert.equal((await request('/healthz')).status,200);
      const doctor=JSON.parse((await run(process.execPath,['scripts/portable-web.mjs','doctor','web'],{cwd:root,env})).stdout);
      assert.equal(doctor.result,'ready');assert.equal(doctor.checks.microsoftSignIn,'ok');assert.equal(doctor.checks.googleSignIn,'disabled');
      assert.equal(doctor.checks.personalOutlook,'ok');
      assert.equal(doctor.microsoftCallbackUrl,origin+'/auth/microsoft/callback');
      assert.equal((await request('/auth/google/start')).status,404);
      assert.equal((await request('/auth/microsoft/start',{method:'POST'})).status,405);
      for(const invalid of [{tid:crypto.randomUUID()},{iss:'https://example.test'},{aud:crypto.randomUUID()},{nonce:'other-attempt'},
        {oid:crypto.randomUUID(),email:owner},{exp:Math.floor(Date.now()/1000)-300}]){
        await rejected(await prepare('microsoft',invalid));
      }
      await rejected(await prepare('microsoft',{},'google'));
      const exchanged=await prepare('microsoft');
      await rejected(()=>exchanged({state:'different'}));
      const permitted=await exchanged();assert.equal(permitted.headers.get('location'),origin+'/?view=workspaces');
      await rejected(exchanged);
      const active=await login('microsoft',{email:'different@example.test'});
      const initial=await sql`SELECT id,email,microsoft_subject,google_subject FROM login_identities WHERE email=${owner}`;
      assert.equal(initial.length,1);assert.equal(initial[0].google_subject,null);assert.equal(initial[0].microsoft_subject,tenant+':'+obj);
      assert.equal((await protectedRead(active)).status,200);
      const wrongOrigin=await request('/api/crm',{method:'POST',headers:{cookie:active,origin:'https://other.example.test','content-type':'application/json'},
        body:JSON.stringify({action:'save',kind:'contacts',data:{name:'Declined fixture'}})});
      assert.equal(wrongOrigin.status,403);
      const outlook=outlookClient({request,origin,fixture:outlookSettings});
      const msHeaders={cookie:active};
      assert.equal(await outlook.status(msHeaders,'outlook-mail'),null);
      const outlookContact=await json('/api/crm',{action:'save',kind:'contacts',
        data:{name:'Fictional Outlook contact',email:'outlook-record@example.test'}},active);
      assert.equal(outlookContact.status,201);
      const linked=(await outlookContact.json()).record;
      const through=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
      for(const provider of ['outlook-mail','outlook-calendar']){
        await outlook.connect(msHeaders,provider,owner);
        assert.deepEqual(await (await outlook.call(msHeaders,provider,'POST','&action=check')).json(),{connection:'ok'});
        const query={recordId:linked.id,provider,through,days:1};
        const preview=await json('/api/outlook-records',query,active);
        assert.equal(preview.status,200,await preview.clone().text());
        const [item]=(await preview.json()).items;
        assert.ok(item);
        const log=await request('/api/outlook-records',{method:'PUT',headers:{cookie:active,origin,'content-type':'application/json'},
          body:JSON.stringify({...query,selection:item.selection,...(provider==='outlook-calendar'?{attended:true}:{})})});
        assert.equal(log.status,200,await log.clone().text());
        assert.equal((await log.json()).logged,true);
      }
      const activity=await request('/api/logged-activities?contactId='+linked.id,{headers:msHeaders});
      assert.deepEqual((await activity.json()).items.map(row=>row.kind).sort(),['Email','Meeting']);
      env.HARBOR_OUTLOOK_CALENDAR_READ_EMAILS=owner.toUpperCase();
      env.HARBOR_TEST_OUTLOOK_DENY_RESOURCE='outlook-calendar';
      await restart();
      const check=(provider)=>outlook.call(msHeaders,provider,'POST','&action=check');
      assert.equal((await check('outlook-calendar')).status,409);
      assert.equal((await outlook.status(msHeaders,'outlook-calendar')).needsReconnect,true);
      assert.equal((await check('outlook-mail')).status,200);
      await outlook.connect(msHeaders,'outlook-calendar',owner,'permissions','unexpected_scope','Calendars.Read');
      await outlook.connect(msHeaders,'outlook-calendar',owner,'connected',undefined,'Calendars.Read');
      const deniedCalendar=await check('outlook-calendar');
      assert.equal(deniedCalendar.status,409);
      assert.match((await deniedCalendar.json()).error,/denied access to your Outlook Calendar/);
      delete env.HARBOR_TEST_OUTLOOK_DENY_RESOURCE;
      await restart();
      assert.equal((await check('outlook-calendar')).status,200);
      const reread=await json('/api/outlook-records',{recordId:linked.id,provider:'outlook-calendar',through,days:1},active);
      assert.equal(reread.status,200);
      assert.equal((await reread.json()).items[0].logged,true);
      const {record}=await (await json('/api/crm',{action:'save',kind:'contacts',data:{name:'Microsoft fixture record'}},active)).json();
      assert.ok(record.id);
      const invite=await json('/api/workspaces',{action:'invite',email:guest,role:'viewer'},active);
      assert.equal(invite.status,200);const [{id:inviteId}]=(await invite.json()).sent;
      await rejected(await prepare('microsoft',{oid:crypto.randomUUID(),email:guest}));
      const invited=await login('microsoft',{oid:guestObj,email:owner,preferred_username:owner});
      const acceptance=await json('/api/workspaces',{action:'accept_invite',id:inviteId},invited);
      assert.equal(acceptance.status,200);const [{id:workspace,grantId}]=(await acceptance.json()).shared;
      assert.equal((await request('/api/crm?workspaceId='+workspace+'&id='+record.id,{headers:{cookie:invited}})).status,200);
      assert.equal((await json('/api/crm?workspaceId='+workspace,{action:'save',kind:'contacts',data:{name:'Viewer write'}},invited)).status,403);
      const removed=await json('/api/workspaces',{action:'revoke',id:grantId},active);
      assert.equal(removed.status,200);
      assert.equal((await request('/api/crm?workspaceId='+workspace+'&id='+record.id,{headers:{cookie:invited}})).status,401);
      const signOut=await request('/auth/logout',{method:'POST',headers:{origin,cookie:invited},body:new URLSearchParams({scope:'all'})});
      assert.equal(signOut.status,303);assert.equal((await protectedRead(invited)).status,401);

      env.HARBOR_LOGIN_GOOGLE_CLIENT_ID='google-fixture';env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET='google-fixture-secret';
      const dual=await restart();assert.match(dual,/Continue with Microsoft/);assert.match(dual,/Continue with Google/);
      assert.equal((await protectedRead(active)).status,200);
      const google=await login('google');assert.equal((await request('/api/crm?id='+record.id,{headers:{cookie:google}})).status,404);
      await outlook.connect({cookie:google},'outlook-calendar',legacy);
      await rejected(await prepare('google',{sub:'different-google',email:owner}),'account_conflict');
      const collision=crypto.randomUUID();
      env.HARBOR_LOGIN_MICROSOFT_BINDINGS=JSON.stringify({[obj]:owner,[collision]:legacy});
      await restart();await rejected(await prepare('microsoft',{oid:collision}),'account_conflict');
      assert.equal((await protectedRead(await login('google'))).status,200);
      const [{count}]=await sql`SELECT count(*)::int AS count FROM login_identities WHERE email=${legacy}`;assert.equal(count,1);
      env.HARBOR_LOGIN_MICROSOFT_BINDINGS=JSON.stringify({[collision]:legacy});await restart();
      assert.equal((await protectedRead(active)).status,401);
      env.HARBOR_LOGIN_MICROSOFT_TENANT_ID=consumerTenant;
      env.HARBOR_LOGIN_MICROSOFT_BINDINGS=JSON.stringify({[obj]:'personal@example.test'});env.HARBOR_LOGIN_ALLOWED_EMAILS='personal@example.test';
      await restart();assert.equal((await protectedRead(await login('microsoft'))).status,200);
    }finally{
      await stop();await sql?.end({timeout:3});
      if(created)await admin`DROP DATABASE ${admin(name)}`;
      await admin.end({timeout:3});await rm(dir,{recursive:true,force:true});
    }
  });
