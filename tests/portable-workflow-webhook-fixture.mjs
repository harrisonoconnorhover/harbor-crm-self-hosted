import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const workflows='/api/workflows';
const destination='operations';
const name='Fictional onboarding handoff';

async function expect(pending,status){
  const response=await pending;
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}

async function authorWorkflow(origin,headers){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  try{
    const page=await browser.newPage();
    const [cookie,value]=headers.cookie.split('=');
    await page.context().addCookies([{name:cookie,value,url:origin}]);
    page.setDefaultTimeout(10_000);
    await page.goto(origin+'/?view=workflows');
    await page.getByLabel('Workflow name',{exact:true}).fill(name);
    await page.getByLabel(/^Trigger/).selectOption('manual_contact');
    await page.getByLabel(/^Action/).selectOption('conditional_paths');
    const matched=page.getByRole('group',{name:'If',exact:true});
    await matched.getByLabel('Path name').fill('On customer entry');
    await matched.getByLabel(/^Property/).selectOption('city');
    await matched.getByLabel(/^Value/).fill('Boston');
    await matched.getByLabel(/^Then/).selectOption({label:'Send a webhook'});
    const select=matched.getByLabel(/^Destination/);
    const choices=await select.locator('option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean));
    assert.deepEqual(choices,[destination]);
    await select.selectOption(destination);
    await matched.getByLabel(/^Wait for lifecycle stage/).selectOption('Customer');
    await matched.getByLabel(/^Delay in minutes/).fill('2');
    const otherwise=page.getByRole('group',{name:'Otherwise',exact:true});
    await otherwise.getByLabel('Path name').fill('Immediate handoff');
    await otherwise.getByLabel(/^Then/).selectOption({label:'Send a webhook'});
    await otherwise.getByLabel(/^Destination/).selectOption(destination);
    const saved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===workflows);
    await page.getByRole('button',{name:'Save workflow',exact:true}).click();
    const response=await saved;
    assert.equal(response.status(),200);
    await page.getByText('Workflow saved.',{exact:true}).waitFor();
  }finally{await browser.close();}
}

export async function verifyWorkflowWebhooks({request,origin,headers,other,sql,env,configure}){
  const post=(path,input,actor=headers)=>request(path,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(input)});
  const state=(workflowId='',actor=headers)=>expect(request(workflows+(workflowId?'?runWorkflowId='+workflowId:''),{headers:actor}),200);
  const createContact=async(data,actor=headers)=>(await expect(post('/api/crm',{action:'save',kind:'contacts',data},actor),201)).record;
  const save=(id,definition,actor=headers)=>post(workflows,{action:'save',id,revision:0,definition},actor);
  const toggle=(id,revision,enabled)=>expect(post(workflows,{action:'setEnabled',id,revision,enabled}),200);
  const run=async(workflowId,jobId)=>{
    const selected=(await state(workflowId)).runs.find(r=>r.jobId===jobId);
    assert.ok(selected,'Expected a persisted workflow run for '+jobId);
    return selected;
  };
  const waiting=await createContact({name:'Fictional Boston contact',city:'Boston',lifecycle:'Lead'});
  await createContact({name:'Fictional other workspace contact'},other);
  const {owned:workspaceId}=await expect(request('/api/workspaces',{headers}),200);
  const {owned:otherId}=await expect(request('/api/workspaces',{headers:other}),200);
  assert.ok(workspaceId&&otherId&&workspaceId!==otherId);
  const secret=randomBytes(32).toString('hex'),received=[];
  let reply='ok';
  const receiver=createServer({key:await readFile(process.env.HARBOR_TEST_TLS_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS)},async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    received.push({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()});
    if(reply==='lost'){res.destroy();return;}
    res.writeHead(reply==='busy'?429:204,reply==='busy'?{'retry-after':'60'}:{});
    res.end();
  });
  receiver.listen(0,'127.0.0.1');
  await once(receiver,'listening');
  try{
    const url='https://127.0.0.1:'+receiver.address().port+'/handoff';
    const destinations=[{workspaceId,name:destination},{workspaceId:otherId,name:'foreign-handoff'}];
    await configure({HARBOR_WEBHOOK_DESTINATIONS:JSON.stringify(destinations)});
    const routes=JSON.stringify([{...destinations[0],url,secret},{...destinations[1],url:url+'/other',secret:randomBytes(32).toString('hex')}]);
    const worker=({enabled=true,notesOnly=false,workerRoutes=routes}={})=>execute(process.execPath,[
      process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once',...(notesOnly?['--notes-only']:[]),
    ],{cwd:process.env.HARBOR_TEST_PORTABLE_CWD,env:{...env,HARBOR_PORTABLE_WORKER_ENABLED:'true',
      HARBOR_WEBHOOK_DESTINATIONS:workerRoutes,HARBOR_WEBHOOK_DELIVERY_ENABLED:String(enabled)},timeout:30_000});
    const verifyEvent=(receivedEvent,fields)=>{
      const {body,headers:sent}=receivedEvent;
      assert.equal(receivedEvent.method,'POST');
      assert.equal(receivedEvent.path,'/handoff');
      const timestamp=sent['x-harbor-timestamp'];
      assert.match(timestamp,/^\d+$/);
      assert.ok(Math.abs(Date.now()/1000-Number(timestamp))<120);
      assert.equal(sent['x-harbor-signature'],'sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex'));
      const eventId=workspaceId+'/'+fields.id;
      assert.equal(sent['x-harbor-event-id'],eventId);
      assert.equal(sent['idempotency-key'],eventId);
      const event=JSON.parse(body);
      assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
      assert.deepEqual(event,{type:'workflow.action',workspaceId,...fields,id:eventId,jobId:fields.id,occurredAt:event.occurredAt});
    };

    await authorWorkflow(origin,headers);
    const manual=(await state()).workflows.find(w=>w.definition.name===name);
    assert.ok(manual,'Expected the workflow saved in Chrome');
    const {definition}=manual;
    const path=definition.paths[0],fallback=definition.otherwise;
    assert.deepEqual(path.action,{kind:'webhook',destination,delayMinutes:2,waitForLifecycle:'Customer'});
    assert.deepEqual(fallback.action,{kind:'webhook',destination,delayMinutes:0});
    // The other workspace has its own configured destination, but cannot save this one.
    const foreignWorkflow=randomUUID();
    const denied=await save(foreignWorkflow,definition,other);
    assert.ok([400,403,404].includes(denied.status),'Unexpected foreign destination response: '+denied.status);
    assert.ok(!(await state('',other)).workflows.some(w=>w.id===foreignWorkflow));
    await toggle(manual.id,manual.revision,true);
    const revision=manual.revision+1;
    await expect(post(workflows,{action:'save',id:manual.id,revision,definition}),409);
    const manualInput=record=>({action:'runContact',id:randomUUID(),workflowId:manual.id,workflowRevision:revision,contactId:record.id});
    const fields=(input,record,pathId)=>({id:input.id,workflowId:input.workflowId,workflowRevision:input.workflowRevision,
      pathId,object:'contacts',recordId:record.id,revision:record.revision,contactId:record.id});

    const delayed=manualInput(waiting);
    const receipt=await expect(post(workflows,delayed),201);
    assert.equal((await run(manual.id,delayed.id)).waitForLifecycle,'Customer');
    await worker();
    assert.equal(received.length,0);
    const before=Date.now();
    await expect(post('/api/crm',{action:'save',kind:'contacts',id:waiting.id,expectedRevision:waiting.revision,
      data:{...waiting.data,lifecycle:'Customer'}}),200);
    const released=await run(manual.id,delayed.id);
    assert.ok(!released.waitForLifecycle);
    assert.ok(released.scheduledFor>=before+120_000&&released.scheduledFor<=Date.now()+120_000);
    await worker();
    assert.equal(received.length,0,'A released wait must still respect the two-minute delay');
    const makeDue=id=>sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${id} AND status='queued'`;
    await makeDue(delayed.id);
    await worker({enabled:false});
    await worker({notesOnly:true});
    const untouched=await run(manual.id,delayed.id);
    assert.deepEqual([untouched.jobKind,untouched.jobStatus,untouched.attempts,received.length],['external','queued',0,0]);
    await Promise.all([worker(),worker()]);
    assert.equal(received.length,1);
    verifyEvent(received[0],fields(delayed,waiting,path.id));
    assert.equal((await run(manual.id,delayed.id)).jobStatus,'succeeded');
    assert.deepEqual(await expect(post(workflows,delayed),200),receipt);

    const immediate=await createContact({name:'Fictional Vermont contact'});
    const unknown=manualInput(immediate);
    const unknownReceipt=await expect(post(workflows,unknown),201);
    reply='lost';
    await worker();
    assert.equal(received.length,2);
    verifyEvent(received[1],fields(unknown,immediate,fallback.id));
    const ambiguous=await run(manual.id,unknown.id);
    assert.deepEqual([ambiguous.jobStatus,ambiguous.jobIssue,ambiguous.attempts],['attention','external_outcome_unknown',1]);
    const history=await request('/?view=workflows&runWorkflowId='+manual.id,{headers});
    assert.equal(history.status,200);
    const html=(await history.text()).replaceAll('<!-- -->','');
    assert.match(html,/Webhook · Delivery unconfirmed/);
    assert.match(html,/Webhook · Accepted by destination/);
    assert.deepEqual((await state(manual.id,other)).runs,[]);
    reply='ok';
    assert.deepEqual(await expect(post(workflows,unknown),200),unknownReceipt);
    await worker();
    assert.equal(received.length,2,'A replay or worker restart must leave an unknown outcome alone');

    assert.equal(ambiguous.webhookEventId,workspaceId+'/'+unknown.id);
    assert.ok(html.includes(ambiguous.webhookEventId));
    await expect(post(workflows,manualInput(immediate)),409);
    await expect(post('/api/background-jobs?recordId='+immediate.id,{action:'reviewExternal',id:unknown.id}),200);
    const limited=manualInput(immediate);
    await expect(post(workflows,limited),201);
    reply='busy';
    await worker();
    assert.equal(received.length,3);
    const retriable=await run(manual.id,limited.id);
    assert.deepEqual([retriable.jobStatus,retriable.attempts],['queued',1]);
    reply='ok';
    await worker();
    assert.equal(received.length,3,'Do not immediately retry a rate-limited webhook');
    await makeDue(limited.id);
    await worker();
    assert.equal(received.length,4);
    verifyEvent(received[2],fields(limited,immediate,fallback.id));
    verifyEvent(received[3],fields(limited,immediate,fallback.id));
    assert.equal(received[2].body,received[3].body);
    const succeeded=await run(manual.id,limited.id);
    assert.deepEqual([succeeded.jobStatus,succeeded.attempts],['succeeded',2]);

    const cancelled=manualInput(immediate);
    await expect(post(workflows,cancelled),201);
    await toggle(manual.id,revision,false);
    await toggle(manual.id,revision+1,true);
    await worker();
    assert.equal(received.length,4);
    const skipped=await run(manual.id,cancelled.id);
    assert.deepEqual([skipped.jobStatus,skipped.jobIssue,skipped.attempts],['skipped','workflow_disabled',0]);

    const dealWorkflow=randomUUID();
    await expect(save(dealWorkflow,{...definition,name:'Fictional deal handoff',trigger:'deal_stage',pipelineId:'default',stageId:'Qualified to buy'}),200);
    await toggle(dealWorkflow,1,true);
    const initial={action:'save',kind:'deals',primaryContactId:immediate.id,data:{name:'Fictional renewal',stage:'Appointment scheduled'}};
    const {record:deal}=await expect(post('/api/crm',initial),201);
    const {record:moved}=await expect(post('/api/crm',{...initial,id:deal.id,expectedRevision:deal.revision,data:{...initial.data,stage:'Qualified to buy'}}),200);
    const [enrolled]=(await state(dealWorkflow)).runs;
    assert.equal(enrolled.dealId,deal.id);
    await worker();
    assert.equal(received.length,5);
    verifyEvent(received[4],{id:enrolled.jobId,workflowId:dealWorkflow,workflowRevision:2,pathId:fallback.id,
      object:'deals',recordId:deal.id,revision:moved.revision,contactId:immediate.id});
    assert.equal((await run(dealWorkflow,enrolled.jobId)).jobStatus,'succeeded');

    const ticketWorkflow=randomUUID();
    await expect(save(ticketWorkflow,{...definition,name:'Fictional ticket handoff',trigger:'ticket_status',ticketStatus:'Closed'}),200);
    await toggle(ticketWorkflow,1,true);
    const {record:ticket}=await expect(post('/api/tickets',{action:'save',contactId:immediate.id,data:{name:'Example support request',ticketStatus:'Closed'}}),201);
    const [ticketRun]=(await state(ticketWorkflow)).runs;
    await worker();
    assert.equal(received.length,6);
    verifyEvent(received[5],{id:ticketRun.jobId,workflowId:ticketWorkflow,workflowRevision:2,pathId:fallback.id,
      object:'tickets',recordId:ticket.id,revision:ticket.revision,contactId:immediate.id});
    assert.equal((await run(ticketWorkflow,ticketRun.jobId)).jobStatus,'succeeded');

    const unavailable={...manualInput(immediate),workflowRevision:revision+2};
    await expect(post(workflows,unavailable),201);
    await worker({workerRoutes:'[]'});
    const missingDestination=await run(manual.id,unavailable.id);
    assert.deepEqual([missingDestination.jobStatus,missingDestination.jobIssue],['failed','webhook_destination_unavailable']);
    assert.equal(received.length,6);
    await toggle(manual.id,revision+2,false);
    await configure({HARBOR_WEBHOOK_DESTINATIONS:'[]'});
    await expect(post(workflows,{action:'setEnabled',id:manual.id,revision:revision+3,enabled:true}),400);
  }finally{
    receiver.closeAllConnections();
    await new Promise(resolve=>receiver.close(resolve));
  }
}
