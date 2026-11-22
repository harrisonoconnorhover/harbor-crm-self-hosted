import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {CreateBucketCommand,DeleteBucketCommand} from '@aws-sdk/client-s3';
import {runMarketingCampaignPass,verifyMarketingContactJourney} from './portable-marketing-contact-journey-fixture.mjs';
import {localFileFixture} from './portable-files-fixture.mjs';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import test from 'node:test';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';
import {sendMarketingEmail} from '../lib/marketing-mail-transport.mjs';

const mailEnv={HARBOR_MARKETING_DELIVERY_ENABLED:'true',HARBOR_MARKETING_FROM:'news@example.test',
  HARBOR_MARKETING_POSTAL_ADDRESS:'1 Fictional Way, Test City',HARBOR_RESEND_API_KEY:'fictional-email-key',
  HARBOR_RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.from('fictional-signing-key').toString('base64'),
  HARBOR_LOGIN_ORIGIN:'https://marketing.example.test'};
const database=process.env.HARBOR_TEST_POSTGRES_URL;

test('email adapter sends to one address, requests idempotency and distinguishes throttling from uncertainty',async()=>{
  const input={to:'reader@example.test',subject:'Newsletter',text:'Hello',idempotencyKey:'fixture/123'};
  assert.deepEqual(await sendMarketingEmail(input,mailEnv,async(url,init)=>{
    assert.equal(url,'https://api.resend.com/emails');assert.equal(init.headers['idempotency-key'],input.idempotencyKey);
    assert.deepEqual(JSON.parse(init.body).to,[input.to]);return Response.json({id:'receipt'});
  }),{id:'receipt'});
  for(const [status,disposition] of [[429,'retry'],[500,'uncertain'],[422,'rejected']]){
    await assert.rejects(sendMarketingEmail(input,mailEnv,async()=>new Response(null,{status})),e=>e.disposition===disposition);
  }
  for(const [header,min,max] of [['120',120000,120000],['0',1000,1000],['-1',60000,60000],
    ['nonsense',60000,60000],[null,60000,60000],[new Date(Date.now()+300000).toUTCString(),297000,300000]]){
    await assert.rejects(sendMarketingEmail(input,mailEnv,async()=>new Response(null,{
      status:429,headers:header===null?{}:{'retry-after':header},
    })),error=>error.disposition==='retry'&&error.retryAfterMs>=min&&error.retryAfterMs<=max);
  }
  await assert.rejects(sendMarketingEmail(input,{...mailEnv,HARBOR_MARKETING_DELIVERY_ENABLED:''},()=>assert.fail()),/not configured/);
});

test('built marketing journey: owner review, 31k queue, opt-out, signed outcomes and recovery without automatic replay',
  {skip:!database,timeout:120000},async t=>{
    const url=new URL(database);
    assert.ok(url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname));
    const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_campaign_'+randomUUID().replaceAll('-','');
    const ws=randomUUID(),owner=randomUUID(),other=randomUUID(),designId=randomUUID();
    let dbClient,server,exited;
    try{
      await admin.unsafe('CREATE DATABASE '+name);url.pathname='/'+name;
      dbClient=postgres(url.href,{max:5,onnotice:()=>{}});const db=drizzle(dbClient);
      const migration=readPortableMigrations(resolve('db/postgres/migrations'));
      assert.equal(await applyPortableMigrations(dbClient,migration),'ok');
      async function session(id,email){
        const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('base64url');
        await dbClient`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at) VALUES(${id},${id},${email},0,0)`;
        await dbClient`INSERT INTO login_sessions(token_hash,user_id,created_at,expires_at) VALUES(${hash},${id},${Date.now()},${Date.now()+3600000})`;
        return 'harbor-session='+token;
      }
      const cookie=await session(owner,'owner@example.test'),foreign=await session(other,'colleague@example.test');
      await dbClient`INSERT INTO private_workspaces(id,owner_id) VALUES(${ws},${owner})`;
      const gen=randomUUID();
      await dbClient`INSERT INTO portable_marketing_audience_sync(workspace_id,generation,source_key,state,mapping,started_at,progressed_at,completed_at,contact_count)
        VALUES(${ws},${gen},'fictional-source','ready',${JSON.stringify({consentField:'Consent__c',accountFields:[]})}::jsonb,now(),now(),now(),70000)`;
      await dbClient`INSERT INTO portable_marketing_audience_contacts(workspace_id,generation,id,email,eligible)
        SELECT ${ws},${gen},n::text,'reader'||n||'@example.test',n<=31000 FROM generate_series(1,70000) n`;
      const sock=createServer().listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;
      await new Promise(done=>sock.close(done));const origin='http://127.0.0.1:'+port;
      const env={PATH:process.env.PATH,HOME:process.env.HOME,HARBOR_LOGIN_ORIGIN:origin,HARBOR_PORTABLE_MODE:'local',PORT:String(port),
        HARBOR_LOGIN_ALLOWED_EMAILS:'owner@example.test,colleague@example.test',HARBOR_LOGIN_GOOGLE_CLIENT_ID:'fixture.googleusercontent.com',
        HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'fixture',DATABASE_URL:url.href,HARBOR_MARKETING_WORKSPACE_ID:ws,
        HARBOR_RESEND_WEBHOOK_SECRET:mailEnv.HARBOR_RESEND_WEBHOOK_SECRET,
        HARBOR_MARKETING_FORM_RECIPIENTS:'sales@example.test,support@example.test',HARBOR_SALESFORCE_ORIGIN:'https://fixture.my.salesforce.com',
        HARBOR_SALESFORCE_FORM_MAPPING:JSON.stringify({object:'Inquiry__c',externalIdField:'Harbor_Key__c',fields:{name:'Name',email:'Email__c'}})};
      server=spawn(process.execPath,['scripts/portable-web.mjs','start'],{env,stdio:['ignore','pipe','pipe']});
      exited=once(server,'exit');let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',x=>{log=(log+x).slice(-1000);});
      for(let i=0;i<150;i++){
        if(await fetch(origin+'/auth/sign-in').then(r=>r.ok,()=>false))break;
        assert.equal(server.exitCode,null,log);await sleep(50);
      }
      const home=async acting=>(await (await fetch(origin+'/',{headers:{cookie:acting}})).text()).replaceAll('<!-- -->','');
      assert.match(await home(cookie),/<a [^>]*href="\/\?view=marketing"[^>]*>Email marketing<\/a>/);
      assert.doesNotMatch(await home(foreign),/<a [^>]*href="\/\?view=marketing"/);
      const endpoint='/api/marketing/campaigns';
      async function api(body,acting=cookie){
        return fetch(origin+endpoint,{method:body?'POST':'GET',headers:{origin,cookie:acting,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      }
      assert.equal((await api(null,'')).status,401);assert.equal((await api(null,foreign)).status,403);
      const page=await fetch(origin+'/?view=marketing',{headers:{cookie}});assert.equal(page.status,200);
      assert.match(await page.text(),/Preview eligible recipients/);
      const campaignsPage=await fetch(origin+'/?view=campaigns',{headers:{cookie}});
      assert.equal(campaignsPage.status,200);
      const campaignHtml=await campaignsPage.text();
      assert.match(campaignHtml,/<h1>Campaigns<\/h1>/);
      assert.match(campaignHtml,/<h2>Recent campaigns<\/h2>/);
      assert.equal((await fetch(origin+'/?view=campaigns',{headers:{cookie:foreign}})).status,404);
      const {stdout}=await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','marketing','status'],{env});
      assert.equal(JSON.parse(stdout).audience.contacts,70000);
      const preview=await (await api({action:'preview',filter:{}})).json();
      assert.equal(preview.total,31000);assert.equal(preview.emails.length,25);
      const manager=(body,path='/api/lead-forms',authenticated=true)=>fetch(origin+path,{method:'POST',headers:{
        origin,'content-type':'application/json',...(authenticated?{cookie}:{})},body:JSON.stringify(body)});
      const designPath='/api/marketing/designs';
      const project={kind:'harbor-email',version:1,accent:'#005e62',preheader:'November updates',blocks:[
        {id:randomUUID(),type:'heading',text:'Hello & welcome'},
        {id:randomUUID(),type:'button',label:'See the details',url:'https://example.test/november'},
      ]};
      const design={action:'saveNative',id:designId,name:'Newsletter',subject:'Hello readers',project};
      const readDesign=async()=> (await (await fetch(origin+designPath+'?id='+designId,{headers:{cookie}})).json()).design;
      const designList=await (await fetch(origin+designPath,{headers:{cookie}})).json();
      assert.equal(designList.configured,false);
      assert.equal((await manager(design,designPath,false)).status,401);
      assert.equal((await fetch(origin+designPath,{method:'POST',headers:{origin,cookie:foreign,'content-type':'application/json'},body:JSON.stringify(design)})).status,403);
      assert.equal((await manager({...design,html:'A mismatched client rendering'},designPath)).status,400);
      const saved=await manager(design,designPath);assert.equal(saved.status,200,await saved.clone().text());
      assert.equal((await saved.json()).design.revision,1);
      assert.equal((await (await manager(design,designPath)).json()).design.revision,1);
      const original=await readDesign();
      assert.deepEqual(JSON.parse(original.project),project);assert.match(original.html,/Hello &amp; welcome/);
      assert.match(original.plainText,/Hello & welcome/);assert.ok(original.plainText.includes('https://example.test/november'));
      const form=randomUUID(),embed='https://fictional-site.example.test';
      assert.equal((await manager({action:'save',id:form,revision:0,definition:{title:'Sales inquiry',description:'',thankYou:'Thank you',embedOrigin:embed,captureContacts:false}})).status,200);
      assert.equal((await manager({action:'setEnabled',id:form,revision:1,enabled:true})).status,200);
      const routed={action:'configureForm',formId:form,recipients:['sales@example.test'],salesforce:true};
      assert.equal((await api({...routed,recipients:['visitor@example.test']})).status,400);
      assert.equal((await api(routed,foreign)).status,403);
      const formSettings=await api(routed);assert.equal(formSettings.status,200);
      assert.deepEqual((await formSettings.json()).forms[0].recipients,['sales@example.test']);
      const formPage=await fetch(origin+'/forms/'+form);assert.equal(formPage.status,200);
      assert.ok(formPage.headers.get('content-security-policy').includes('frame-ancestors '+embed));
      const inquiry={id:randomUUID(),revision:2,payload:{name:'Fictional Visitor',email:'visitor@example.test',message:'Please call me.'}};
      for(let i=0;i<2;i++)assert.equal((await manager(inquiry,'/api/public/forms/'+form,false)).status,200);
      const routes=(await (await api({action:'formSettings'})).json()).recent;
      assert.deepEqual(routes.map(row=>row.kind).sort(),['email','salesforce']);
      assert.ok(routes.every(row=>row.state==='pending'));

      const cmd={action:'queue',id:randomUUID(),name:'November news',designId,designRevision:1,expectedTotal:31000,
        snapshot:preview.status.generation,filter:{}};
      assert.equal((await api({...cmd,expectedTotal:999})).status,409);
      const started=performance.now();const queued=await api(cmd);assert.equal(queued.status,200,await queued.clone().text());
      assert.equal((await queued.json()).total,31000);t.diagnostic('31,000 recipients staged in '+Math.round(performance.now()-started)+' ms');
      assert.equal((await api(cmd)).status,200);assert.equal((await api({...cmd,name:'Other'})).status,409);
      const revised={...design,expectedRevision:1,subject:'December update',project:{...project,blocks:[
        {id:project.blocks[0].id,type:'heading',text:'A later draft'},
      ]}};
      assert.equal((await (await manager(revised,designPath)).json()).design.revision,2);
      assert.equal((await manager({...revised,subject:'Stale edit'},designPath)).status,409);
      const reloaded=await readDesign();assert.deepEqual(JSON.parse(reloaded.project),revised.project);
      assert.match(reloaded.html,/A later draft/);
      const stats=async()=>{const rows=await dbClient`SELECT state,count(*)::int AS n FROM portable_marketing_recipients WHERE workspace_id=${ws} GROUP BY state`;return Object.fromEntries(rows.map(r=>[r.state,r.n]));};
      assert.deepEqual(await stats(),{queued:31000});
      await api({action:'pause',id:cmd.id,paused:true});
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'idle');
      await api({action:'pause',id:cmd.id,paused:false});
      const [first]=await dbClient`SELECT email FROM portable_marketing_recipients WHERE workspace_id=${ws} ORDER BY id LIMIT 1`;
      await dbClient`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at) VALUES(${ws},${randomUUID()},${first.email},now())`;
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'skipped');
      const sent=[];const send=async m=>{sent.push(m);return {id:'local-'+m.tag};};
      assert.deepEqual(await Promise.all([runMarketingCampaignPass(db,ws,mailEnv,send),runMarketingCampaignPass(db,ws,mailEnv,send)]),['accepted','accepted']);
      assert.notEqual(sent[0].to,sent[1].to);assert.match(sent[0].html,/Unsubscribe<\/a>.*<\/body>/);assert.ok(sent[0].text.includes('Fictional Way'));
      assert.equal(sent[0].subject,'Hello readers');assert.match(sent[0].html,/Hello &amp; welcome/);
      assert.ok(sent[0].text.includes('https://example.test/november'));assert.doesNotMatch(sent[0].text,/A later draft/);
      const click=new URL(sent[0].headers['List-Unsubscribe'].slice(1,-1)),unsubscribe=origin+click.pathname+click.search;
      assert.equal((await fetch(unsubscribe,{redirect:'manual'})).status,303);
      for(let i=0;i<2;i++)assert.equal((await fetch(unsubscribe,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'})).status,204);
      async function feedback(type,m,signature=true){
        const body=JSON.stringify({type,data:{email_id:'local-'+m.tag,to:[m.to],tags:{harbor_delivery:m.tag},
          ...(type==='email.suppressed'?{suppressed:{type:'OnAccountSuppressionList',message:'Recipient on suppression list'}}:{})}});
        const id='test_event',stamp=String(Math.floor(Date.now()/1000));
        const sig=createHmac('sha256','fictional-signing-key').update(id+'.'+stamp+'.'+body).digest('base64');
        return fetch(origin+'/api/marketing/feedback',{method:'POST',headers:{'svix-id':id,'svix-timestamp':stamp,'svix-signature':'v1,'+(signature?sig:'bad')},body});
      }
      assert.equal((await feedback('email.complained',sent[1],false)).status,401);
      assert.equal((await feedback('email.complained',sent[1])).status,204);
      assert.equal((await feedback('email.delivered',sent[1])).status,204);
      assert.equal((await stats()).complained,1);
      // Reap an expired claim while the original provider request is still in flight.
      const expire=async id=>{
        await dbClient`UPDATE portable_marketing_recipients SET due_at=0 WHERE workspace_id=${ws} AND id=${id}`;
        assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail('Expired sends must not replay.')),'uncertain');
      };
      let lateId;
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,async m=>{
        lateId=m.tag;
        await expire(m.tag);
        return {id:'late-'+m.tag};
      }),'accepted');
      const [reconciled]=await dbClient`SELECT state,attempts,provider_id FROM portable_marketing_recipients WHERE id=${lateId}`;
      assert.deepEqual({...reconciled},{state:'accepted',attempts:1,provider_id:'late-'+lateId});
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,async m=>{
        const close={action:'resolve',id:m.tag,resolution:'skip',expectedAttempt:1};
        const issues=async()=>(await (await api()).json()).issues.filter(issue=>issue.id===m.tag);
        assert.deepEqual(await issues(),[]);
        assert.equal((await api(close)).status,409);
        await dbClient`UPDATE portable_marketing_recipients SET due_at=0 WHERE id=${m.tag}`;
        const [overdue]=await issues();
        assert.equal(overdue.state,'sending');
        assert.match(overdue.lastIssue,/Confirmation overdue/);
        assert.equal(overdue.attempts,1);
        assert.equal((await api({...close,expectedAttempt:0})).status,409);
        assert.equal((await api({...close,expectedAttempt:undefined})).status,409);
        assert.equal((await api(close,foreign)).status,403);
        assert.equal((await api(close)).status,200);
        assert.deepEqual(await issues(),[]);
        assert.equal((await api(close)).status,409);
        return {id:'late-'+m.tag};
      }),'skipped');
      // Signed feedback can beat either the successful response or a transport timeout.
      for(const [event,outcome,timeout] of [['email.delivered','delivered',true],['email.suppressed','suppressed',false]]){
        const result=await runMarketingCampaignPass(db,ws,mailEnv,async m=>{
          await dbClient`UPDATE portable_marketing_recipients SET due_at=0 WHERE id=${m.tag}`;
          assert.equal((await feedback(event,m)).status,204);
          assert.equal((await api({action:'resolve',id:m.tag,resolution:'skip'})).status,409);
          if(timeout)throw Error('Connection closed before acknowledgment.');
          return {id:'local-'+m.tag};
        });
        assert.equal(result,outcome);
      }
      await verifyRecipientHistory({api,foreign,recipient:sent[1],campaignId:cmd.id,ws,designId,dbClient,cookie,origin});
      // A second in-flight request can report a shorter limit after the longer one.
      const inFlight=Promise.withResolvers(),release=Promise.withResolvers();
      const earliestLongRetry=Date.now()+300000;
      const shortLimit=runMarketingCampaignPass(db,ws,mailEnv,(m,env)=>sendMarketingEmail(m,env,async()=>{
        inFlight.resolve();
        await release.promise;
        return new Response(null,{status:429,headers:{'retry-after':'2'}});
      }));
      await Promise.race([inFlight.promise,shortLimit.then(()=>assert.fail('Expected an in-flight request.'))]);
      try{
        const longLimit=await runMarketingCampaignPass(db,ws,mailEnv,(m,env)=>sendMarketingEmail(m,env,async()=>
          new Response(null,{status:429,headers:{'retry-after':'300'}})));
        assert.equal(longLimit,'retry');
      }finally{release.resolve();}
      assert.equal(await shortLimit,'retry');
      const beforePause=await stats();
      const [gate]=await dbClient`SELECT until_ms::float AS deadline FROM portable_marketing_mail_cooldown WHERE provider='resend'`;
      assert.ok(gate.deadline>=earliestLongRetry);
      assert.equal((await (await api()).json()).providerRetryAtMs,gate.deadline);
      if(process.env.HARBOR_TEST_PLAYWRIGHT){
        const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
        const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
        try{
          const page=await browser.newPage({locale:'en-US',timezoneId:'UTC'});
          const [name,value]=cookie.split('=');
          await page.context().addCookies([{name,value,url:origin}]);
          const defaults={name:'Campaign rehearsal',language:'de',timeZone:'America/Los_Angeles',numberFormat:'de-DE',dateFormat:'ymd',currency:'EUR'};
          const saved=await page.request.post(origin+'/api/workspace-settings',{headers:{origin},data:{...defaults,revision:0}});
          assert.equal(saved.status(),200,await saved.text());
          await page.goto(origin+'/?view=marketing');
          await page.getByText('70.000',{exact:true}).waitFor();
          await page.getByRole('button',{name:'Delivery activity',exact:true}).click();
          const message=page.getByRole('status').filter({hasText:'The email provider requested a pause'});
          await message.waitFor();
          const deadline=new Date(gate.deadline);
          assert.equal(await message.locator('time').getAttribute('datetime'),deadline.toISOString());
          const zone={timeZone:defaults.timeZone};
          const day=new Intl.DateTimeFormat('sv-SE',{...zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(deadline);
          const time=new Intl.DateTimeFormat('de',{...zone,timeStyle:'short'}).format(deadline);
          assert.equal(await message.locator('time').innerText(),day+' · '+time);
        }finally{await browser.close();}
      }
      const [retry]=await dbClient`SELECT attempts,due_at::float AS due FROM portable_marketing_recipients WHERE state='retry' ORDER BY due_at DESC LIMIT 1`;
      assert.equal(retry.attempts,1);assert.ok(retry.due>=earliestLongRetry);
      const restarted=postgres(url.href,{max:1,onnotice:()=>{}});
      try{
        assert.equal(await runMarketingCampaignPass(drizzle(restarted),ws,mailEnv,()=>assert.fail()),'throttled');
      }finally{await restarted.end();}
      assert.deepEqual(await stats(),beforePause);
      await dbClient`UPDATE portable_marketing_mail_cooldown SET until_ms=0 WHERE provider='resend'`;
      assert.equal((await (await api()).json()).providerRetryAtMs,null);
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,async()=>{throw Error('No acknowledgment.');}),'uncertain');
      const [held]=await dbClient`SELECT id FROM portable_marketing_recipients WHERE workspace_id=${ws} AND state='uncertain'`;
      assert.equal((await api({action:'resolve',id:held.id,resolution:'skip'})).status,200);
      await dbClient`UPDATE portable_marketing_recipients SET state='sending',due_at=0 WHERE id=(SELECT id FROM portable_marketing_recipients WHERE workspace_id=${ws} AND state='queued' LIMIT 1)`;
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'uncertain');
      await dbClient`UPDATE portable_marketing_audience_sync SET source_key='replacement-org' WHERE workspace_id=${ws}`;
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'idle');
      assert.equal((await (await api()).json()).campaigns[0].sourceChanged,true);
      await dbClient`UPDATE portable_marketing_audience_sync SET source_key='fictional-source' WHERE workspace_id=${ws}`;
      await dbClient`DELETE FROM portable_marketing_campaign_activations WHERE workspace_id=${ws}`;
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'idle');
      const also=await (await api({action:'preview',filter:{}})).json();
      assert.equal(also.total,30997);
      const sendAfter=Date.now()+86400000;
      const scheduled=await api({...cmd,id:randomUUID(),name:'Next issue',designRevision:2,expectedTotal:also.total,sendAfter});
      assert.equal(scheduled.status,200);
      assert.equal(await runMarketingCampaignPass(db,ws,mailEnv,()=>assert.fail()),'idle');
      // Exercise the real archive/restore commands with a live campaign and a configured form.
      const bucket=localFileFixture();
      if(bucket){
        const dir=await mkdtemp(join(tmpdir(),'harbor-marketing-recovery-')),targetName=name+'_restore';
        let restored;
        try{
          await bucket.storage.send(new CreateBucketCommand({Bucket:bucket.bucket}));
          await admin.unsafe('CREATE DATABASE '+targetName);
          const target=new URL(url);target.pathname='/'+targetName;
          await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','backup',join(dir,'backup')],{env});
          await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','restore',join(dir,'backup')],
            {env:{...env,...bucket.env,DATABASE_URL:target.href}});
          restored=postgres(target.href,{max:2,onnotice:()=>{}});
          const [copy]=await restored`SELECT (SELECT count(*)::int FROM portable_marketing_campaigns) AS campaigns,
            (SELECT count(*)::int FROM portable_marketing_recipients) AS recipients,
            (SELECT count(*)::int FROM portable_marketing_form_deliveries) AS routed,
            (SELECT count(*)::int FROM portable_marketing_form_routes) AS routes,
            (SELECT count(*)::int FROM portable_marketing_campaign_activations) AS armed`;
          assert.deepEqual({...copy},{campaigns:2,recipients:61997,routed:2,routes:0,armed:0});
          assert.equal(await runMarketingCampaignPass(drizzle(restored),ws,mailEnv,()=>assert.fail()),'idle');
        }finally{
          if(restored)await restored.end();
          await admin.unsafe('DROP DATABASE IF EXISTS '+targetName+' WITH (FORCE)');
          try{await bucket.storage.send(new DeleteBucketCommand({Bucket:bucket.bucket}));}finally{bucket.storage.destroy();await rm(dir,{recursive:true,force:true});}
        }
      }
      await verifyMarketingContactJourney({db,ws,env,mailEnv,api,manager,form,inquiry,origin,cookie,designId,feedback});
      t.diagnostic('Local form-to-campaign rehearsal: replayed submissions with one ID, one Sales notification, one Salesforce inquiry, one opt-out, only the control received campaign two. Provider suppression verified.');
    }finally{
      if(server&&server.exitCode===null){server.kill('SIGTERM');await exited;}
      if(dbClient)await dbClient.end({timeout:5});
      await admin.unsafe('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.end({timeout:5});
    }
});

async function verifyRecipientHistory({api,foreign,recipient,campaignId,ws,designId,dbClient,cookie,origin}){
  const lookup={action:'recipientHistory',email:recipient.to.toUpperCase()};
  assert.equal((await api(lookup,foreign)).status,403);
  assert.equal((await api({...lookup,email:'person'})).status,400);
  const empty=await (await api({...lookup,email:'never-queued@example.test'})).json();
  assert.deepEqual(empty,{items:[],next:null});
  const current=(await (await api(lookup)).json()).items;
  assert.equal(current.length,1);
  assert.deepEqual([current[0].id,current[0].state,current[0].attempts,current[0].providerId],
    [campaignId,'complained',1,'local-'+recipient.tag]);
  // A contact can have receipts in campaigns older than the recent-campaign list.
  const olderIds=Array.from({length:26},()=>randomUUID());
  await dbClient`INSERT INTO portable_marketing_campaigns(workspace_id,id,name,filter,source_key,design_id,design_revision,subject,html,plain_text,created_at,audience_size)
    SELECT ${ws},id,'Fictional earlier campaign','{}','fixture',${designId},1,'Receipt lookup','<p>Earlier</p>','Earlier',1,1
    FROM unnest(${dbClient.array(olderIds)}::uuid[]) id`;
  await dbClient`INSERT INTO portable_marketing_recipients(workspace_id,campaign_id,email,state)
    SELECT ${ws},id,${recipient.to},'skipped' FROM unnest(${dbClient.array(olderIds)}::uuid[]) id`;
  try{
    const [earliest]=olderIds.slice().sort();
    await dbClient`UPDATE portable_marketing_campaigns SET created_at=0,name='Fictional first campaign' WHERE workspace_id=${ws} AND id=${earliest}`;
    await dbClient`UPDATE portable_marketing_recipients SET state='sending',due_at=0,attempts=1 WHERE workspace_id=${ws} AND campaign_id=${earliest}`;
    const activity=await (await api()).json();
    assert.ok(!activity.campaigns.some(row=>row.id===earliest));
    assert.equal(activity.issues.find(issue=>issue.campaignId===earliest).campaignName,'Fictional first campaign');
    const recent=await (await api(lookup)).json();
    const past=await (await api({...lookup,after:recent.next})).json();
    assert.equal(recent.items.length,25);assert.equal(past.items.length,2);assert.equal(past.next,null);
    assert.deepEqual([...recent.items,...past.items].map(item=>item.id),[campaignId,...olderIds.sort().reverse()]);
    // Give the oldest campaign an active dispatch and enough simultaneous issues to span pages.
    await dbClient`UPDATE portable_marketing_campaigns SET source_key='fictional-source' WHERE workspace_id=${ws} AND id=${earliest}`;
    await dbClient`INSERT INTO portable_marketing_campaign_activations(workspace_id,campaign_id) VALUES (${ws},${earliest})`;
    await dbClient`UPDATE portable_marketing_recipients SET state='uncertain',attempts=1,due_at=2
      WHERE workspace_id=${ws} AND campaign_id IN ${dbClient(olderIds)} AND campaign_id<>${earliest}`;
    const activityPage=(params,acting=cookie)=>fetch(origin+'/api/marketing/campaigns?'+new URLSearchParams(params),{headers:{cookie:acting}});
    const first=await (await activityPage({})).json();
    assert.equal(first.issues.length,25);
    const cursors={campaignAfter:first.campaignNext,issueAfter:first.issueNext};
    assert.equal((await activityPage(cursors,foreign)).status,403);
    assert.equal((await activityPage({issueAfter:'bad'})).status,400);
    const second=await (await activityPage(cursors)).json();
    assert.equal(second.campaignNext,null);assert.equal(second.issueNext,null);
    assert.deepEqual([...first.campaigns,...second.campaigns].map(row=>row.id),[campaignId,...olderIds.slice().sort().reverse()]);
    const wantedIssues=await dbClient`SELECT id FROM portable_marketing_recipients WHERE workspace_id=${ws}
      AND (state IN ('uncertain','failed') OR (state='sending' AND due_at=0)) ORDER BY due_at DESC,id`;
    assert.deepEqual([...first.issues,...second.issues].map(row=>row.id),wantedIssues.map(row=>row.id));
    assert.ok(second.issues.some(row=>row.campaignId===earliest));
    if(process.env.HARBOR_TEST_PLAYWRIGHT){
      const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
      const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
      try{
        const tab=await browser.newPage({viewport:{width:390,height:844}});
        const [name,value]=cookie.split('=');
        await tab.context().addCookies([{name,value,url:origin}]);await tab.goto(origin+'/?view=campaigns');
        await tab.getByRole('button',{name:'Older campaigns'}).click();
        const old=tab.locator('li').filter({has:tab.getByText('Fictional first campaign',{exact:true})});
        await old.getByRole('button',{name:'Pause',exact:true}).click();
        await old.getByRole('button',{name:'Resume',exact:true}).waitFor();
        await tab.getByRole('button',{name:'More delivery issues'}).click();
        const issue=tab.locator('li').filter({has:tab.getByText(/Fictional first campaign · Awaiting confirmation/)});
        await issue.getByRole('button',{name:'Verify receipt'}).click();
        await issue.getByLabel('Verified provider message ID').fill('fictional-confirmed-receipt');
        await issue.getByRole('button',{name:'Record receipt'}).click();
        await issue.waitFor({state:'detached'});
        const [verified]=await dbClient`SELECT state,attempts,provider_id FROM portable_marketing_recipients
          WHERE workspace_id=${ws} AND campaign_id=${earliest}`;
        assert.deepEqual({...verified},{state:'accepted',attempts:1,provider_id:'fictional-confirmed-receipt'});
        await tab.getByRole('button',{name:'First delivery issues'}).click();
        await old.getByRole('button',{name:'Resume',exact:true}).waitFor();
        await tab.getByRole('button',{name:'Most recent campaigns'}).click();
        await old.waitFor({state:'detached'});
        const history=tab.locator('section').filter({has:tab.getByRole('heading',{name:'Recipient history',exact:true})}).last();
        await history.getByLabel('Recipient email').fill(recipient.to);
        await history.getByRole('button',{name:'Find deliveries'}).click();
        await history.getByText('Provider message ID: local-'+recipient.tag,{exact:true}).waitFor();
        await history.getByRole('button',{name:'Older deliveries'}).click();
        await history.getByText('Showing 2 campaigns for '+recipient.to+'.',{exact:true}).waitFor();
        await history.getByRole('button',{name:'Most recent deliveries'}).click();
        await history.getByText('Showing 25 campaigns for '+recipient.to+'.',{exact:true}).waitFor();
      }finally{await browser.close();}
    }
  }finally{
    await dbClient`DELETE FROM portable_marketing_campaign_activations WHERE workspace_id=${ws} AND campaign_id IN ${dbClient(olderIds)}`;
    await dbClient`DELETE FROM portable_marketing_recipients WHERE workspace_id=${ws} AND campaign_id IN ${dbClient(olderIds)}`;
    await dbClient`DELETE FROM portable_marketing_campaigns WHERE workspace_id=${ws} AND id IN ${dbClient(olderIds)}`;
  }
}
