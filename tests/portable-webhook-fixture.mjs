import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {promisify} from 'node:util';
import {recordReceiver} from './portable-webhook-receiver-fixture.mjs';
import {verifyWebhookCapture} from './portable-webhook-capture-fixture.mjs';

const execute=promisify(execFile);
const management='/api/webhook-subscriptions';
const destination='warehouse';
const kinds=['contacts','companies','deals','tasks','leads','tickets'];
const bearer=token=>({authorization:'Bearer '+token});
async function expectResponse(response,expected){
  assert.equal(response.status,expected,await response.clone().text());
  return expected===204?null:response.json();
}

export async function verifyPortableWebhooks({request,origin,headers,other,sql,env,configure}){
  await verifyWebhookCapture(sql);
  const post=(path,body,account=headers)=>request(path,{method:'POST',headers:{...account,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const manage=(body,account)=>post(management,body,account);
  const read=(account=headers,query)=>request(query?management+'?'+new URLSearchParams(query):management,{headers:account});
  const {record:first}=await expectResponse(await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Before subscription'}}),201);
  const {owned:workspaceId}=await expectResponse(await request('/api/workspaces',{headers}),200);
  const secret=randomBytes(32).toString('hex');
  const mirror=await recordReceiver(workspaceId,secret,origin);
  const received=[];
  let reply='ok',observed;
  const receiver=createServer({key:await readFile(process.env.HARBOR_TEST_TLS_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS)},async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    received.push({path:req.url,body:Buffer.concat(chunks).toString(),headers:req.headers});
    if(reply==='redirect'){res.writeHead(307,{location:'/unapproved'});res.end();return;}
    if(reply==='busy'){res.writeHead(429,{'retry-after':'1'});res.end();return;}
    const accepted=await mirror.accept(req.headers,Buffer.concat(chunks));
    if(accepted!==204){res.writeHead(accepted).end();return;}
    if(reply==='hold'){observed();return;}
    if(reply==='lost'){res.destroy();return;}
    if(reply==='accepted-with-error'){res.writeHead(503);res.end();return;}
    res.writeHead(204);res.end();
  });
  receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
  const url='https://127.0.0.1:'+receiver.address().port+'/incoming';
  const workerDestinations=JSON.stringify([{workspaceId,name:destination,url,secret}]);
  const makeToken=async()=>{
    const {token}=await expectResponse(await post('/api/api-tokens',{name:'Webhook source',days:30,permissions:Object.fromEntries(kinds.map(kind=>[kind,'read_write_archive']))}),201);
    return token;
  };
  const worker=(enabled,notesOnly=false)=>execute(process.execPath,['scripts/portable-web.mjs','worker','--once',...(notesOnly?['--notes-only']:[])],
    {env:{...env,HARBOR_WEBHOOK_DESTINATIONS:workerDestinations,HARBOR_PORTABLE_WORKER_ENABLED:'true',HARBOR_WEBHOOK_DELIVERY_ENABLED:String(enabled)},timeout:30000});
  const deliveries=async()=> (await read()).json().then(result=>result.deliveries);
  const subscribe={action:'subscribe',destination,objects:kinds};
  let browser;
  try{
    await configure({HARBOR_WEBHOOK_DESTINATIONS:JSON.stringify([{workspaceId,name:destination}])});
    const settings=await expectResponse(await read(),200);
    assert.deepEqual(settings.destinations,[destination]);
    assert.ok(!JSON.stringify(settings).includes(secret)&&!JSON.stringify(settings).includes(url));
    assert.equal((await read({})).status,401);
    assert.equal((await manage({...subscribe,destination:url})).ok,false);
    assert.equal((await manage(subscribe,other)).ok,false);
    let page;
    if(process.env.HARBOR_TEST_PLAYWRIGHT){
      const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
      browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
      const context=await browser.newContext({viewport:{width:1280,height:850}});
      const [name,value]=headers.cookie.split('=');await context.addCookies([{name,value,url:origin}]);
      page=await context.newPage();page.setDefaultTimeout(8500);
      await page.goto(origin+'/?view=api-access#record-webhooks');
      const panel=page.getByRole('region',{name:'Outbound webhooks'});
      await panel.getByRole('combobox',{name:/^Destination/}).selectOption(destination);
      for(const kind of kinds)await panel.getByRole('checkbox',{name:kind[0].toUpperCase()+kind.slice(1),exact:true}).check();
      await Promise.all([page.waitForResponse(r=>r.url().endsWith(management)&&r.request().method()==='POST'&&r.status()===201),panel.getByRole('button',{name:'Subscribe',exact:true}).click()]);
    }else await expectResponse(await manage(subscribe),201);
    const state=await expectResponse(await read(),200);
    assert.equal(state.subscriptions.length,1);assert.deepEqual(state.deliveries,[]);
    const {id:subscriptionId}=state.subscriptions[0];
    const token=await makeToken();
    const {token:readToken}=await expectResponse(await post('/api/api-tokens',{name:'Receiver reads',days:30,
      permissions:Object.fromEntries(kinds.map(kind=>[kind,'read_history']))}),201);
    const recordApi=(method,kind,id,body,etag)=>request('/api/v1/records/'+kind+(id?'/'+id:''),{
      method,headers:{...bearer(token),'content-type':'application/json',...(etag?{'if-match':etag}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const recordIds=new Map();
    for(const kind of kinds){
      const id=randomUUID();recordIds.set(id,kind);
      await expectResponse(await recordApi('POST',kind,null,{id,properties:{name:'Private fixture '+kind}}),201);
    }
    await expectResponse(await post('/api/crm',{action:'save',kind:'deals',data:{name:'Other tenant'}},other),201);
    assert.equal((await deliveries()).length,6);
    const otherSettings=await expectResponse(await read(other),200);assert.deepEqual(otherSettings.deliveries,[]);
    assert.equal((await read(bearer(token))).status,401);
    await worker(false);await worker(true,true);
    assert.equal(received.length,0);
    await Promise.all([worker(true),worker(true)]);
    for(let i=2;i<kinds.length;i++)await worker(true);
    assert.equal(received.length,6);
    function verifyReceipt(r){
      const timestamp=r.headers['x-harbor-timestamp'],signature=r.headers['x-harbor-signature'];
      assert.match(timestamp,/^\d+$/);
      assert.ok(Math.abs(Date.now()/1000-Number(timestamp))<120);
      assert.equal(signature,'sha256='+createHmac('sha256',secret).update(timestamp+'.'+r.body).digest('hex'));
      const event=JSON.parse(r.body);
      assert.equal(r.path,'/incoming');
      assert.equal(r.headers['x-harbor-event-id'],event.id);
      assert.equal(r.headers['idempotency-key'],event.id);
      assert.equal(event.subscriptionId,subscriptionId);
      assert.equal(event.workspaceId,workspaceId);
      assert.ok(Date.parse(event.occurredAt)>0);
      assert.deepEqual(Object.keys(event).sort(),['id','subscriptionId','workspaceId','recordId','object','occurredAt','action','revision'].sort());
      return event;
    }
    const events=received.map(verifyReceipt);
    const signed=received[0];
    assert.equal(await mirror.accept(signed.headers,signed.body+' '),401);
    assert.equal(await mirror.accept({...signed.headers,'idempotency-key':randomUUID()},signed.body),400);
    const expired=String(Math.floor(Date.now()/1000)-600);
    assert.equal(await mirror.accept({...signed.headers,'x-harbor-timestamp':expired,
      'x-harbor-signature':'sha256='+createHmac('sha256',secret).update(expired+'.'+signed.body).digest('hex')},signed.body),401);
    assert.equal(new Set(events.map(e=>e.recordId)).size,6);
    for(const e of events){assert.equal(e.action,'created');assert.equal(e.revision,1);assert.equal(e.object,recordIds.get(e.recordId));}
    assert.ok((await deliveries()).every(row=>row.status==='delivered'&&row.attempts===1));

    const edit=await expectResponse(await post('/api/crm',{action:'save',kind:'contacts',id:first.id,expectedRevision:first.revision,data:{name:'Edited privately'}}),200);
    reply='lost';await worker(true);
    const ambiguous=verifyReceipt(received.at(-1));
    assert.equal(ambiguous.action,'updated');assert.equal(ambiguous.recordId,first.id);
    let delivery=(await deliveries()).find(r=>r.id===ambiguous.id);
    assert.equal(delivery.status,'uncertain');
    const queued=mirror.record('contacts',first.id).pending;
    assert.ok(queued);
    await mirror.restart();
    assert.equal((await mirror.command(readToken,'receipt',ambiguous.id)).record,first.id);
    reply='ok';await worker(true);assert.equal(received.length,7,'Worker restart must leave an uncertain send alone');
    const retry={action:'retry',id:delivery.id,expectedAttempts:delivery.attempts,confirmed:true};
    assert.equal((await manage(retry,other)).ok,false);
    if(page){
      await page.getByRole('button',{name:'Refresh deliveries'}).click();
      const row=page.getByRole('listitem').filter({hasText:'Outcome unknown'});
      await row.getByText('Delivery details').click();
      await row.getByText(ambiguous.id,{exact:true}).waitFor();
      await row.getByRole('button',{name:'Review retry'}).click();
      const queue=row.getByRole('button',{name:'Queue retry'});
      assert.equal(await queue.isEnabled(),false);
      await row.getByRole('checkbox').check();
      await Promise.all([page.waitForResponse(r=>r.url().endsWith(management)&&r.request().method()==='POST'&&r.status()===200),queue.click()]);
    }else await expectResponse(await manage(retry),200);
    assert.equal((await manage(retry)).status,409);
    await worker(true);
    assert.equal(received.at(-1).body,received.at(-2).body);verifyReceipt(received.at(-1));
    delivery=(await deliveries()).find(r=>r.id===ambiguous.id);assert.equal(delivery.attempts,2);assert.equal(delivery.status,'delivered');

    assert.equal(mirror.record('contacts',first.id).pending,queued,'Replay after restart did not enqueue a second refresh');
    await assert.rejects(mirror.command('fictional-invalid-read-token','refresh'),/Harbor read failed/);
    assert.equal(mirror.record('contacts',first.id).pending,queued);
    assert.equal((await mirror.command(readToken,'refresh')).pending,0);
    assert.equal(mirror.record('contacts',first.id).name,'Edited privately');
    assert.equal(await mirror.accept(received.at(-1).headers,received.at(-1).body),204);
    assert.equal(mirror.record('contacts',first.id).pending,null);

    const detail=await expectResponse(await recordApi('GET','contacts',first.id),200);
    await expectResponse(await recordApi('DELETE','contacts',first.id,null,detail.etag),204);
    reply='busy';await worker(true);
    const archived=verifyReceipt(received.at(-1));assert.equal(archived.action,'archived');
    await sql`UPDATE portable_webhook_deliveries SET available_at=clock_timestamp() WHERE id=${archived.id} AND status='pending'`;
    reply='ok';await worker(true);
    assert.equal(received.at(-1).body,received.at(-2).body);
    await expectResponse(await post('/api/recycle-bin',{kind:'contacts',action:'restore',id:first.id,expectedRevision:edit.record.revision+1,requestId:randomUUID()}),200);
    reply='redirect';await worker(true);
    const restored=verifyReceipt(received.at(-1));assert.equal(restored.action,'restored');
    assert.ok(received.every(r=>r.path==='/incoming'));
    assert.equal((await deliveries()).find(r=>r.id===restored.id).status,'failed');
    if(page){
      await page.getByRole('button',{name:'Refresh deliveries'}).click();
      const row=page.getByRole('listitem').filter({hasText:'HTTP 307'});
      await row.getByText('Delivery details').click();
      await row.getByText(restored.id,{exact:true}).waitFor();
    }
    // Kill the worker after the app received the request but before it sent a response.
    // Advance the stored claim clock so this restart test does not wait out a real lease.
    reply='hold';
    const pending=Promise.withResolvers();
    observed=pending.resolve;
    await expectResponse(await post('/api/crm',{action:'save',kind:'deals',data:{name:'Warehouse restart proof'}}),201);
    const child=spawn(process.execPath,['scripts/portable-web.mjs','worker','--once'],{
      env:{...env,HARBOR_WEBHOOK_DESTINATIONS:workerDestinations,HARBOR_PORTABLE_WORKER_ENABLED:'true',HARBOR_WEBHOOK_DELIVERY_ENABLED:'true'},stdio:'ignore'});
    const closed=once(child,'close');
    let timer;
    try{
      await Promise.race([pending.promise,closed.then(()=>{throw Error('Worker exited before sending');}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Receiver did not get the event')),12000);})]);
    }finally{clearTimeout(timer);child.kill('SIGKILL');await closed;}
    const interrupted=verifyReceipt(received.at(-1));
    await sql`UPDATE portable_webhook_deliveries SET attempted_at=clock_timestamp()-interval '10 minutes'
      WHERE id=${interrupted.id} AND status='sending'`;
    const beforeRecovery=received.length;
    reply='ok';await worker(true);await worker(true);
    assert.equal((await deliveries()).find(r=>r.id===interrupted.id).status,'uncertain');
    assert.equal(received.length,beforeRecovery);
    const lookup=management+'?eventId='+interrupted.id;
    const receipt=async(identity=headers)=> (await expectResponse(await request(lookup,{headers:identity}),200)).deliveries;
    assert.deepEqual(await receipt(other),[]);
    const [unknown]=await receipt();
    assert.equal(unknown.id,interrupted.id);
    const confirm={action:'confirm_received',id:unknown.id,expectedAttempts:unknown.attempts,confirmed:true};
    assert.equal((await manage(confirm,other)).status,404);
    assert.equal((await manage({...confirm,confirmed:false})).status,400);
    assert.equal((await manage({...confirm,expectedAttempts:0})).status,409);
    // A retired destination can still confirm it had received the event.
    await configure({HARBOR_WEBHOOK_DESTINATIONS:'[]'});
    if(page){
      await page.reload();
      const panel=page.getByRole('region',{name:'Outbound webhooks'});
      await panel.getByRole('searchbox',{name:'Find event by ID'}).fill(interrupted.id);
      await panel.getByRole('button',{name:'Find event',exact:true}).click();
      await panel.getByRole('button',{name:'Clear event filter'}).waitFor();
      assert.equal(await panel.locator('.portable-webhook-receipt').count(),1);
      assert.equal(await panel.getByRole('button',{name:'Review retry'}).isEnabled(),false);
      await panel.getByRole('button',{name:'Already received'}).click();
      const button=panel.getByRole('button',{name:'Confirm receipt',exact:true});
      assert.equal(await button.isEnabled(),false);
      await panel.getByRole('checkbox',{name:'I verified that the receiver saved this event ID.'}).check();
      await button.click();
      await panel.getByText('Confirmed at receiver',{exact:true}).waitFor();
    }else await expectResponse(await manage(confirm),200);
    const [settled]=await receipt();
    assert.equal(settled.status,'delivered');assert.equal(settled.ownerConfirmed,true);
    assert.equal(settled.attempts,unknown.attempts);assert.equal(settled.httpStatus,null);
    assert.ok(Date.parse(settled.finishedAt));
    assert.equal((await manage(confirm)).status,409);
    await configure({HARBOR_WEBHOOK_DESTINATIONS:JSON.stringify([{workspaceId,name:destination}])});
    assert.equal((await manage({...confirm,action:'retry'})).status,409);
    assert.deepEqual((await expectResponse(await request(lookup+'&filter=attention',{headers}),200)).deliveries,[]);
    await worker(true);assert.equal(received.length,beforeRecovery);
    assert.equal((await sql`SELECT d.confirmed_by=w.owner_id AS owner FROM portable_webhook_deliveries d
      JOIN private_workspaces w ON w.id=d.workspace_id WHERE d.id=${interrupted.id}`)[0].owner,true);
    reply='accepted-with-error';
    await expectResponse(await post('/api/crm',{action:'save',kind:'deals',data:{name:'Stored before error'}}),201);
    await worker(true);
    const accepted=verifyReceipt(received.at(-1));
    assert.equal((await mirror.command(readToken,'receipt',accepted.id)).record,accepted.recordId);
    await expectResponse(await manage({...confirm,id:accepted.id,expectedAttempts:1}),200);
    const {deliveries:[afterError]}=await expectResponse(await request(management+'?eventId='+accepted.id,{headers}),200);
    assert.equal(afterError.ownerConfirmed,true);assert.equal(afterError.httpStatus,503);
    await worker(true);assert.equal(received.length,beforeRecovery+1);
    await verifyRecordHistory({request,manage,headers,other,sql,page,workspaceId,subscriptionId,recordId:first.id,restoredId:restored.id});
    reply='ok';
    await verifySubscriptionEdit({page,read,manage,post,other,worker,received,verifyReceipt,subscriptionId,existingId:accepted.id});
    await expectResponse(await manage({action:'remove',id:subscriptionId}),200);
    const retiredId=randomUUID();
    const since=new Date(Date.now()-1).toISOString();
    const {record:missed}=await expectResponse(await post('/api/crm',{action:'save',kind:'contacts',data:{name:'After removal'}}),201);
    const count=received.length;await worker(true);assert.equal(received.length,count);
    assert.equal(mirror.record('contacts',missed.id),undefined);
    const current=await expectResponse(await recordApi('GET','contacts',first.id),200);
    await expectResponse(await recordApi('DELETE','contacts',first.id,null,current.etag),204);
    // A previously archived fixture with no dependencies exercises the real deletion feed.
    await sql`INSERT INTO contacts(id,workspace_id,data,revision,created_at,updated_at,archived_at)
      VALUES(${retiredId},${workspaceId},'{"name":"Retired contact"}',2,now(),now(),now())`;
    await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=${retiredId} AND archived_at IS NOT NULL`;
    const extra=await sql`INSERT INTO contacts(id,workspace_id,data,revision,created_at,updated_at)
      SELECT gen_random_uuid(),${workspaceId},jsonb_build_object('name','Missed fixture '||n),1,now(),now()
      FROM generate_series(1,52) n RETURNING id,data`;
    const end=new Date(Date.now()+1).toISOString();
    for(let pass=0;pass<2;pass++){
      const recovered=await mirror.command(readToken,'catch-up','contacts',since,end);
      assert.equal(recovered.applied,50);
      assert.ok(recovered.pending>0,'Catch-up followed the second page of active records');
      assert.equal((await mirror.command(readToken,'refresh')).pending,0);
      for(const {id,data} of extra)assert.equal(mirror.record('contacts',id).name,data.name);
      assert.deepEqual({...mirror.record('contacts',first.id)},{pending:null,state:'archived',name:null});
      assert.deepEqual({...mirror.record('contacts',retiredId)},{pending:null,state:'unavailable',name:null});
      assert.deepEqual({...mirror.record('contacts',missed.id)},{pending:null,state:'active',name:'After removal'});
    }
    console.log('Verified the standalone receiver across restart, repeated delivery, and overlapping API catch-up.');
    console.log('Verified six record types, signed HTTPS delivery, scoped settings, Notes-only isolation, restart, uncertain replay and owner confirmation, rate limiting, archive/restore, redirects and removal.');
  }finally{
    await browser?.close();
    receiver.closeAllConnections();
    await new Promise(resolve=>receiver.close(resolve));
    await mirror.close();
  }
}

async function verifyRecordHistory({request,manage,headers,other,sql,page,workspaceId,subscriptionId,recordId,restoredId}){
  const params={object:'contacts',recordId};
  const read=(query,account=headers)=>request(management+'?'+new URLSearchParams(query),{headers:account});
  const history=await expectResponse(await read(params),200);
  assert.ok(history.deliveries.some(row=>row.action==='updated'));
  assert.ok(history.deliveries.some(row=>row.action==='archived'));
  assert.ok(history.deliveries.some(row=>row.id===restoredId&&row.action==='restored'));
  assert.deepEqual((await expectResponse(await read(params,other),200)).deliveries,[]);
  for(const invalid of [{recordId},{object:'contacts'},{...params,object:'unrecognized'},{...params,eventId:restoredId}]){
    assert.equal((await read(invalid)).status,400);
  }
  // Two types can have the same record UUID. Put more than one page at the same microsecond.
  const [{id:secondSubscription}]=await sql`INSERT INTO portable_webhook_subscriptions(workspace_id,destination,objects)
    VALUES (${workspaceId},'ledger',ARRAY['contacts','deals']) RETURNING id`;
  await sql`INSERT INTO portable_webhook_deliveries(workspace_id,subscription_id,object_kind,record_id,revision,action,status)
    SELECT ${workspaceId},${secondSubscription},'contacts',gen_random_uuid(),1,'created','delivered' FROM generate_series(1,12000)`;
  const inserted=await sql`INSERT INTO portable_webhook_deliveries(workspace_id,subscription_id,object_kind,record_id,
      revision,action,status,occurred_at)
    SELECT ${workspaceId},CASE WHEN n%2=0 THEN ${subscriptionId}::uuid ELSE ${secondSubscription}::uuid END,CASE WHEN n=29 THEN 'deals' ELSE 'contacts' END,${recordId},n,'updated',
      'delivered','2090-11-21T19:00:00.123456Z' FROM generate_series(1,29) n RETURNING id,object_kind`;
  await sql`ANALYZE portable_webhook_deliveries`;
  const scans=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='portable_webhook_record_history'`)[0].idx_scan);
  const before=await scans();
  const newest=await expectResponse(await read(params),200);
  const older=await expectResponse(await read({...params,...newest.next}),200);
  const ids=[...newest.deliveries,...older.deliveries].map(row=>row.id);
  assert.equal(newest.deliveries.length,25);
  assert.equal(newest.next.afterAt,'2090-11-21T19:00:00.123456Z');
  assert.equal(older.next,null);
  assert.deepEqual(ids,[...inserted.filter(row=>row.object_kind==='contacts').map(row=>row.id).sort().reverse(),
    ...history.deliveries.map(row=>row.id)]);
  assert.deepEqual(new Set(newest.deliveries.map(row=>row.destination)),new Set(['warehouse','ledger']));
  for(let i=0;i<12&&await scans()===before;i++){
    await new Promise(resolve=>setTimeout(resolve,200));
    await expectResponse(await read(params),200);
  }
  assert.ok(await scans()>before,'Record history uses its index among 12,000 unrelated deliveries');
  if(page){
    const panel=page.getByRole('region',{name:'Outbound webhooks'});
    await panel.getByLabel('Search deliveries by').selectOption('record');
    await panel.getByRole('combobox',{name:'Record type',exact:true}).selectOption('contacts');
    await panel.getByRole('searchbox',{name:'Find record by ID'}).fill(recordId);
    await panel.getByRole('button',{name:'Find record',exact:true}).click();
    await panel.getByRole('button',{name:'Clear record filter'}).waitFor();
    await panel.getByRole('button',{name:'Older deliveries'}).click();
    await panel.getByRole('button',{name:'Newest deliveries'}).waitFor();
    assert.equal(await panel.locator('.portable-webhook-receipt').count(),older.deliveries.length);
    await panel.getByLabel('Show deliveries').selectOption('attention');
    const failed=panel.locator('.portable-webhook-receipt').filter({hasText:'HTTP 307'});
    await failed.getByText('Delivery details').click();
    await failed.getByText(restoredId,{exact:true}).waitFor();
    await failed.getByRole('button',{name:'View deliveries for this record'}).click();
    await panel.getByRole('button',{name:'Older deliveries'}).waitFor();
    assert.equal(await panel.getByLabel('Show deliveries').inputValue(),'all');
  }
  await expectResponse(await manage({action:'remove',id:secondSubscription}),200);
}

async function verifySubscriptionEdit({page,read,manage,post,other,worker,received,verifyReceipt,subscriptionId,existingId}){
  const create=async(kind,name)=>(await expectResponse(await post('/api/crm',{action:'save',kind,data:{name}}),201)).record.id;
  const state=async query=>expectResponse(await read(undefined,query),200);
  const {subscriptions:before}=await state();
  const original=before.find(sub=>sub.id===subscriptionId);
  const change={action:'edit_objects',id:subscriptionId,objects:['deals'],expectedObjects:original.objects};
  assert.equal((await manage(change,other)).status,404);
  for(const objects of [[],['deals','deals'],['unknown']])assert.equal((await manage({...change,objects})).status,400);
  const queueBefore=await create('contacts','Queued before subscription edit');
  const [receipt]=(await state({object:'contacts',recordId:queueBefore})).deliveries;
  assert.equal(receipt.status,'pending');
  if(page){
    await page.reload();
    const panel=page.getByRole('region',{name:'Outbound webhooks'});
    await panel.getByRole('button',{name:'Edit record types for warehouse'}).click();
    const editor=panel.getByRole('form',{name:'Edit warehouse subscription'});
    for(const kind of kinds.filter(kind=>kind!=='deals')){
      await editor.getByRole('checkbox',{name:kind[0].toUpperCase()+kind.slice(1),exact:true}).uncheck();
    }
    await editor.getByRole('button',{name:'Save record types'}).click();
    await panel.getByText('Subscription updated.',{exact:true}).waitFor();
  }else await expectResponse(await manage(change),200);
  const narrowed=(await state()).subscriptions.find(sub=>sub.id===subscriptionId);
  assert.deepEqual(narrowed,{...original,objects:['deals']});
  assert.equal((await manage(change)).status,200,'Repeating a saved selection returns the same subscription');
  assert.equal((await manage({...change,objects:['tickets']})).status,409);
  const omitted=await create('contacts','Outside current subscription');
  const retained=await create('deals','Included after subscription edit');
  const firstSend=received.length;
  await worker(true);await worker(true);
  const sent=received.slice(firstSend).map(verifyReceipt);
  assert.deepEqual(sent.map(event=>event.recordId).sort(),[queueBefore,retained].sort());
  assert.equal(sent.find(event=>event.recordId===queueBefore).id,receipt.id);
  const expanded={...change,expectedObjects:['deals'],objects:['contacts','deals']};
  await expectResponse(await manage(expanded),200);
  const restored=await create('contacts','New contact after resubscribing to contacts');
  await worker(true);
  assert.equal(verifyReceipt(received.at(-1)).recordId,restored);
  assert.equal((await state({eventId:existingId})).deliveries[0].ownerConfirmed,true);
  assert.equal((await state({eventId:receipt.id})).deliveries[0].status,'delivered');
  assert.deepEqual((await state({object:'contacts',recordId:omitted})).deliveries,[]);
  const racing=await Promise.all([['tickets'],['tasks']].map(objects=>manage({...expanded,objects,expectedObjects:expanded.objects})));
  assert.deepEqual(racing.map(r=>r.status).sort(),[200,409]);
  const {subscription:winner}=await racing.find(r=>r.ok).json();
  assert.deepEqual((await state()).subscriptions.find(sub=>sub.id===subscriptionId).objects,winner.objects);
}
