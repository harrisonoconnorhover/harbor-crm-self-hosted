import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const database=process.env.HARBOR_TEST_POSTGRES_URL;

const volume=process.env.HARBOR_TEST_CAMPAIGN_REPLICAS==='true';
const population=volume?31000:67;

test('built campaign workers share disjoint rate slots and preserve receipts across process loss',
  {skip:!database,timeout:volume?1_500_000:100000},async t=>{
    const url=new URL(database);
    assert.ok(url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname));
    const admin=postgres(url.href,{max:1,onnotice:()=>{}});
    const name='harbor_operator_'+randomUUID().replaceAll('-','');
    const workspace=randomUUID(),campaign=randomUUID(),generation=randomUUID();
    const seen=[],inFlight=new Set();
    const received=Promise.withResolvers(),release=Promise.withResolvers();
    const rangeStarted=Promise.withResolvers(),peerStarted=Promise.withResolvers();
    const releaseRange=Promise.withResolvers(),releasePeer=Promise.withResolvers();
    const backlogStarted=Promise.withResolvers(),releaseBacklog=Promise.withResolvers();
    const scopedCalls=[],formCalls=[];
    let workspaceProbe=false,rejectNextSmall=false;
    const provider=createServer(async(request,response)=>{
      let body='';
      for await(const part of request)body+=part;
      const message=JSON.parse(body);
      const formKey=request.headers['idempotency-key'];
      if(formKey?.startsWith('harbor-form-')){
        formCalls.push({key:formKey,to:message.to,text:message.text,at:performance.now()});
        response.writeHead(200,{'content-type':'application/json'});
        response.end(JSON.stringify({id:'local-'+formKey}));return;
      }
      if(workspaceProbe){
        const key=request.headers['idempotency-key'];
        const target=key.split('/')[1];
        scopedCalls.push({workspace:target,to:message.to[0],key,from:message.from});
        if(target===workspace&&scopedCalls.length===1){backlogStarted.resolve();await releaseBacklog.promise;}
        if(target!==workspace&&rejectNextSmall){
          rejectNextSmall=false;
          response.writeHead(429,{'retry-after':'20'});response.end();return;
        }
      }
      seen.push(message.to[0]);
      if(seen.length===1){
        received.resolve();
        await release.promise;
      }else if(seen.length===4){
        rangeStarted.resolve();await releaseRange.promise;
      }else if(seen.length===5){
        peerStarted.resolve();await releasePeer.promise;
      }
      if(volume)await delay(120);
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({id:'local-'+message.tags[0].value}));
    });
    let sql,created=false;
    try{
      await admin`CREATE DATABASE ${admin(name)}`;
      created=true;
      url.pathname='/'+name;
      sql=postgres(url.href,{max:1,onnotice:()=>{}});
      assert.equal(await applyPortableMigrations(sql,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
      async function seedWorkspace(workspace,campaign,generation,email,size){
        await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
          VALUES(${workspace},${workspace},${email},0,0)`;
        await sql`INSERT INTO private_workspaces(id,owner_id) VALUES(${workspace},${workspace})`;
        await sql`INSERT INTO portable_marketing_audience_sync(workspace_id,generation,source_key,state,mapping,started_at,progressed_at,completed_at)
          VALUES(${workspace},${generation},'fixture','ready','{}',now(),now(),now())`;
        await sql`INSERT INTO portable_marketing_campaigns(workspace_id,id,name,filter,source_key,design_id,design_revision,subject,html,plain_text,created_at,audience_size)
          VALUES(${workspace},${campaign},'Fictional campaign','{}','fixture',${randomUUID()},1,'Update','<p>News</p>','News',0,${size})`;
        await sql`INSERT INTO portable_marketing_audience_contacts(workspace_id,generation,id,email,eligible)
          SELECT ${workspace},${generation},n::text,'member'||n||'@example.test',true FROM generate_series(1,${size}::int) n`;
        await sql`INSERT INTO portable_marketing_recipients(workspace_id,campaign_id,email)
          SELECT workspace_id,${campaign},email FROM portable_marketing_audience_contacts WHERE workspace_id=${workspace}`;
        await sql`INSERT INTO portable_marketing_campaign_activations VALUES (${workspace},${campaign})`;
      }
      await seedWorkspace(workspace,campaign,generation,'operator@example.test',3);
      provider.listen(0,'127.0.0.1');
      await once(provider,'listening');
      const endpoint='http://127.0.0.1:'+provider.address().port;
      const redirect=`const localFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{
        if(url!=='https://api.resend.com/emails')throw Error('Unexpected provider request in fixture');
        return localFetch(${JSON.stringify(endpoint)},options);
      };`;
      const preload='data:text/javascript;base64,'+Buffer.from(redirect).toString('base64');
      function start(args,target=workspace){
        const proc=spawn(process.execPath,['--import',preload,'scripts/portable-web.mjs','marketing',...args],{
          env:{PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:url.href,HARBOR_PORTABLE_MODE:'local',
            HARBOR_MARKETING_WORKSPACE_ID:target,HARBOR_MARKETING_FORM_RECIPIENTS:'sales@example.test',HARBOR_LOGIN_ORIGIN:'https://fictional.example.test',
            HARBOR_MARKETING_FROM:target===workspace?'news@example.test':'small@example.test',HARBOR_MARKETING_POSTAL_ADDRESS:'1 Fictional Way',
            HARBOR_MARKETING_DELIVERY_ENABLED:'true',HARBOR_RESEND_API_KEY:'fictional',HARBOR_RESEND_WEBHOOK_SECRET:'whsec_fixture'},
          stdio:['ignore','pipe','pipe']});
        const disconnected=Promise.withResolvers();
        let stdout='',stderr='';
        proc.stdout.on('data',chunk=>{stdout+=chunk;});
        proc.stderr.on('data',chunk=>{
          stderr+=chunk;
          if(stderr.includes('Marketing worker lost a database connection'))disconnected.resolve();
        });
        inFlight.add(proc);
        const done=once(proc,'close').then(([code,signal])=>{
          inFlight.delete(proc);
          return {code,signal,stdout,stderr};
        });
        return {proc,done,disconnected:disconnected.promise};
      }
      function observedDisconnect(worker){
        return Promise.race([worker.disconnected,
          worker.done.then(result=>{throw Error('Worker exited before it observed the slot loss: '+result.stderr);}),
          delay(3000,undefined,{ref:false}).then(()=>{throw Error('Worker did not observe lost slot');})]);
      }
      async function run(...args){
        const {code,stdout,stderr}=await start(args).done;
        assert.equal(code,0,stderr);
        return JSON.parse(stdout);
      }
      const invalid=await start(['drain','--rate','0']).done;
      assert.notEqual(invalid.code,0);
      const first=start(['drain','--concurrency','1']);
      await Promise.race([received.promise,first.done.then(result=>{throw Error('Exited before dispatch: '+result.stderr);})]);
      for(const action of ['deliver','forms-run','drain']){
        assert.deepEqual(await run(action),{started:0,stoppedBy:'operator_busy'});
      }
      assert.deepEqual(await run('drain','--rate-slots','1-2'),{started:0,stoppedBy:'operator_busy'});
      first.proc.kill('SIGKILL');
      assert.equal((await first.done).signal,'SIGKILL');
      release.resolve();
      assert.equal(seen.length,1);
      const [interrupted]=await sql`UPDATE portable_marketing_recipients SET due_at=0 WHERE state='sending' RETURNING email`;
      assert.equal(interrupted.email,seen[0]);
      const {issues}=await run('status');
      assert.deepEqual(issues.map(row=>[row.email,row.state]),[[interrupted.email,'sending']]);
      assert.match(issues[0].lastIssue,/Confirmation overdue/);
      assert.equal(seen.length,1,'Checking an interrupted campaign must not send mail.');
      const recovered=await run('drain');
      assert.equal(recovered.counts.uncertain,1);
      assert.equal(recovered.stoppedBy,'uncertain');
      assert.equal(seen.length,1);
      const resumed=await run('drain','--rate','20','--concurrency','3');
      assert.equal(resumed.counts.accepted,2);
      assert.equal(resumed.stoppedBy,'idle');
      assert.equal(seen.length,3);
      assert.equal(new Set(seen).size,3);
      const states=await sql`SELECT state,count(*)::int AS total,count(provider_id)::int AS receipts
        FROM portable_marketing_recipients GROUP BY state ORDER BY state`;
      assert.deepEqual([...states],[{state:'accepted',total:2,receipts:2},{state:'uncertain',total:1,receipts:0}]);
      // Two independent CLI processes drain one campaign with separate slices of the provider budget.
      await sql`WITH added AS (
        INSERT INTO portable_marketing_audience_contacts(workspace_id,generation,id,email,eligible)
        SELECT ${workspace},${generation},n::text,'member'||n||'@example.test',true FROM generate_series(4,${population}::int) n
        RETURNING workspace_id,email
      ) INSERT INTO portable_marketing_recipients(workspace_id,campaign_id,email) SELECT workspace_id,${campaign},email FROM added`;
      await sql`UPDATE portable_marketing_campaigns SET audience_size=${population} WHERE id=${campaign}`;
      for(const args of [['--rate-slots','2-1'],['--rate-slots','0-1'],['--rate-slots','1-101'],['--rate','5','--rate-slots','1-2']]){
        assert.notEqual((await start(['drain',...args]).done).code,0);
      }
      const lane=(range,limit)=>['drain','--rate-slots',range,'--limit',String(limit),'--concurrency','1'];
      const left=start(lane('4-8',1));
      await Promise.race([rangeStarted.promise,left.done.then(()=>{throw Error('First slot range did not dispatch');})]);
      for(const args of [['forms-run'],['deliver'],['drain'],lane('4-8',1),lane('1-4',1)]){
        assert.deepEqual(await run(...args),{started:0,stoppedBy:'operator_busy'});
      }
      // A failed 1–4 reservation must return 1–3 for another process immediately.
      const peer=start(lane('1-3',1));
      await Promise.race([peerStarted.promise,peer.done.then(()=>{throw Error('Disjoint peer did not dispatch');})]);
      left.proc.kill('SIGKILL');
      assert.equal((await left.done).signal,'SIGKILL');releaseRange.resolve();
      const [lost]=await sql`UPDATE portable_marketing_recipients SET due_at=0 WHERE email=${seen[3]} AND state='sending' RETURNING id`;
      assert.ok(lost.id);
      assert.equal((await run(...lane('4-8',1))).counts.uncertain,1);
      // This worker has already reached the provider. Losing its slot still lets it record the reply.
      const [peerGate]=await sql`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND locktype='advisory' AND classid=943157313 AND objid=1 AND objsubid=2 AND granted`;
      assert.ok(peerGate);
      assert.equal((await sql`SELECT pg_terminate_backend(${peerGate.pid},3000) AS lost`)[0].lost,true);
      await observedDisconnect(peer);
      releasePeer.resolve();
      const peerResult=await peer.done;
      assert.equal(peerResult.code,0,peerResult.stderr);
      assert.equal(JSON.parse(peerResult.stdout).counts.accepted,1);
      const [optOut]=await sql`SELECT email FROM portable_marketing_recipients WHERE state='queued' LIMIT 1`;
      await sql`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at)
        VALUES(${workspace},${randomUUID()},${optOut.email},now())`;
      const began=performance.now();
      const parallel=range=>run('drain','--rate-slots',range,'--concurrency','8','--seconds','1400','--limit',String(population));
      const final=await Promise.all([parallel('1-50'),parallel('51-100')]);
      const elapsedSeconds=(performance.now()-began)/1000;
      assert.ok(final.every(result=>result.counts.accepted>0&&result.stoppedBy==='idle'));
      assert.equal(final.reduce((sum,result)=>sum+result.counts.accepted,0),population-6);
      assert.equal(final.reduce((sum,result)=>sum+(result.counts.skipped??0),0),1);
      assert.ok(!seen.includes(optOut.email));
      await sql.end();sql=postgres(url.href,{max:1,onnotice:()=>{}});
      const [proof]=await sql`SELECT count(*) FILTER (WHERE state='uncertain' AND provider_id IS NULL)::int AS uncertain,
        count(*) FILTER (WHERE state='accepted' AND provider_id='local-'||id::text)::int AS confirmed,
        count(DISTINCT provider_id)::int AS receipts,count(*) FILTER (WHERE attempts=1)::int AS attempted_once
        FROM portable_marketing_recipients WHERE workspace_id=${workspace}`;
      assert.deepEqual({...proof},{uncertain:2,confirmed:population-3,receipts:population-3,attempted_once:population-1});
      assert.equal(seen.length,population-1);assert.equal(new Set(seen).size,seen.length);
      t.diagnostic(JSON.stringify({population,simulatedLatencyMs:volume?120:0,elapsedSeconds,
        parallelAccepted:final.map(result=>result.counts.accepted),skipped:1,...proof}));

      // Two workspaces share one provider account. The small campaign has its own
      // reserved slot and addresses in common with the large campaign.
      const small=randomUUID();
      await seedWorkspace(small,randomUUID(),randomUUID(),'small-owner@example.test',2);
      await sql`WITH added AS (
        INSERT INTO portable_marketing_audience_contacts(workspace_id,generation,id,email,eligible)
        SELECT ${workspace},${generation},'backlog'||n,'backlog'||n||'@example.test',true FROM generate_series(1,12) n
        RETURNING workspace_id,email
      ) INSERT INTO portable_marketing_recipients(workspace_id,campaign_id,email) SELECT workspace_id,${campaign},email FROM added`;
      await sql`UPDATE portable_marketing_campaigns SET audience_size=audience_size+12 WHERE workspace_id=${workspace} AND id=${campaign}`;
      const {prepareWorkerForm}=await import('./portable-form-worker-fixture.mjs');
      const form=await prepareWorkerForm(sql,workspace);
      workspaceProbe=true;
      const backlog=start(lane('1-4',12));
      await Promise.race([backlogStarted.promise,backlog.done.then(result=>{throw Error('Backlog did not dispatch: '+result.stderr);})]);
      async function smallPass(range){
        const result=await start(lane(range,1),small).done;
        assert.equal(result.code,0,result.stderr);
        return JSON.parse(result.stdout);
      }
      const inquiries=[await form.submit(),await form.submit()];
      assert.equal((await run('forms-run','2','--rate-slots','4-4')).stoppedBy,'operator_busy');
      assert.deepEqual(await run('forms-run','2','--rate-slots','6-6'),{succeeded:2});
      await form.verify(inquiries,formCalls);
      assert.ok(formCalls[1].at-formCalls[0].at>=990,'One reserved slot spaces out notification requests');
      assert.equal((await smallPass('4-5')).stoppedBy,'operator_busy');
      assert.equal((await smallPass('5-5')).counts.accepted,1);
      const [pending]=await sql`SELECT count(*)::int AS total FROM portable_marketing_recipients
        WHERE workspace_id=${workspace} AND state='queued'`;
      assert.equal(pending.total,11);
      rejectNextSmall=true;
      assert.equal((await smallPass('5-5')).counts.retry,1);
      releaseBacklog.resolve();
      const large=await backlog.done;
      assert.equal(large.code,0,large.stderr);
      assert.equal(JSON.parse(large.stdout).stoppedBy,'throttled');
      assert.equal((await smallPass('5-5')).stoppedBy,'throttled');
      inquiries.push(await form.submit());
      assert.deepEqual(await run('forms-run','1','--rate-slots','6-6'),{throttled:1});
      assert.equal(formCalls.length,2);
      assert.equal(scopedCalls.length,3);
      const [retry]=await sql`SELECT due_at,email FROM portable_marketing_recipients WHERE workspace_id=${small} AND state='retry'`;
      assert.equal(retry.email,scopedCalls[2].to);
      // Let both the provider cooldown and ordinary per-recipient backoff expire.
      await delay(Math.max(0,Number(retry.due_at)-Date.now())+50);
      assert.equal((await smallPass('5-5')).counts.accepted,1);
      assert.deepEqual(await run('forms-run','2','--rate-slots','6-6'),{succeeded:1,idle:1});
      await form.verify(inquiries,formCalls);
      assert.equal((await run(...lane('1-4',12))).counts.accepted,11);
      const [receipts]=await sql`SELECT count(*)::int AS accepted,count(DISTINCT provider_id)::int AS receipts,
        sum(attempts)::int AS attempts FROM portable_marketing_recipients WHERE workspace_id=${small} AND state='accepted'`;
      assert.deepEqual({...receipts},{accepted:2,receipts:2,attempts:3});
      assert.equal(new Set(scopedCalls.map(call=>call.key)).size,15);
      assert.ok(scopedCalls.every(call=>call.workspace===workspace?
        call.to.startsWith('backlog')&&call.from==='news@example.test':
        call.workspace===small&&['member1@example.test','member2@example.test'].includes(call.to)&&call.from==='small@example.test'));
      // Hold the claim at a real SQL statement, then close only the slot-owning connection.
      // The second connection can still commit the claim after the worker observes the loss.
      const takeover=randomUUID();
      await seedWorkspace(takeover,randomUUID(),randomUUID(),'takeover@example.test',1);
      await sql`UPDATE portable_marketing_recipients SET state='retry',attempts=7,due_at=123,last_issue='Fictional rate limit.'
        WHERE workspace_id=${takeover}`;
      const takeoverForm=await prepareWorkerForm(sql,takeover);
      const inquiry=await takeoverForm.submit();
      async function loseSlot(args,table){
        let worker;
        await sql.begin(async tx=>{
          await tx`LOCK TABLE ${tx(table)} IN ACCESS EXCLUSIVE MODE`;
          const [{pid:blocker}]=await tx`SELECT pg_backend_pid() AS pid`;
          worker=start(args,takeover);
          const deadline=Date.now()+8000;
          let holder;
          while(!holder&&Date.now()<deadline){
            [holder]=await admin`SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
              WHERE a.datname=${name} AND l.locktype='advisory' AND l.objid=943157313 AND l.objsubid=1
                AND l.granted AND EXISTS (SELECT 1 FROM pg_stat_activity w WHERE w.datname=a.datname
                AND ${blocker}::int=ANY(pg_blocking_pids(w.pid)))`;
            if(!holder)await delay(20);
          }
          assert.ok(holder,'The disposable worker must hold the sender lock and be waiting on its claim');
          assert.equal((await admin`SELECT pg_terminate_backend(${holder.pid},3000) AS lost`)[0].lost,true);
          await observedDisconnect(worker);
        });
        const result=await worker.done;
        assert.equal(result.code,0,result.stderr);
        return JSON.parse(result.stdout);
      }
      const beforeCampaign=seen.length,beforeForms=formCalls.length;
      const drain=lane('9-9',1);
      assert.equal((await loseSlot(drain,'portable_email_unsubscribe_tokens')).counts.stopped,1);
      assert.deepEqual(await loseSlot(['deliver','1'],'portable_email_unsubscribe_tokens'),{stopped:1});
      assert.equal(seen.length,beforeCampaign);
      const [unstarted]=await sql`SELECT state,attempts,due_at::int,last_issue,provider_id FROM portable_marketing_recipients WHERE workspace_id=${takeover}`;
      assert.deepEqual({...unstarted},{state:'retry',attempts:7,due_at:123,last_issue:'Fictional rate limit.',provider_id:null});
      const formArgs=['forms-run','1','--rate-slots','9-9'];
      assert.deepEqual(await loseSlot(formArgs,'portable_lead_inquiries'),{stopped:1});
      assert.equal(formCalls.length,beforeForms);
      const [pendingForm]=await sql`SELECT state,attempts,receipt FROM portable_marketing_form_deliveries WHERE workspace_id=${takeover}`;
      assert.deepEqual({...pendingForm},{state:'pending',attempts:0,receipt:null});
      for(const args of [drain,formArgs]){
        const result=await start(args,takeover).done;
        assert.equal(result.code,0,result.stderr);
      }
      assert.equal(seen.length,beforeCampaign+1);
      const [completed]=await sql`SELECT state,attempts,provider_id,id FROM portable_marketing_recipients WHERE workspace_id=${takeover}`;
      assert.equal(completed.state,'accepted');assert.equal(completed.attempts,8);
      assert.equal(scopedCalls.at(-1).key,'harbor-marketing/'+takeover+'/'+completed.id+'/8');
      assert.equal(completed.provider_id,'local-'+completed.id);
      await takeoverForm.verify([inquiry],formCalls.slice(beforeForms));
    }finally{
      release.resolve();releaseRange.resolve();releasePeer.resolve();releaseBacklog.resolve();
      for(const child of inFlight)child.kill('SIGKILL');
      if(provider.listening){
        const closed=once(provider,'close');
        provider.close();provider.closeAllConnections();await closed;
      }
      await sql?.end({timeout:2});
      try{if(created)await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;}finally{await admin.end({timeout:2});}
    }
  });
