import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {promisify} from 'node:util';

const workflowName='Fictional ordered account handoff',destination='ops';
const note=body=>({kind:'note',body,delayMinutes:0});
const next=action=>({id:randomUUID(),action});
const exec=promisify(execFile);

async function author(page){
  await page.getByLabel('Workflow name',{exact:true}).fill(workflowName);
  await page.getByLabel(/^Trigger/).selectOption('manual_contact');
  await page.getByRole('combobox',{name:/^Action/}).selectOption('conditional_paths');
  const match=page.getByRole('group',{name:'If',exact:true}),fallback=page.getByRole('group',{name:'Otherwise',exact:true});
  await match.getByLabel('Path name').fill('Sales');
  await match.getByLabel(/^Property/).selectOption('city');
  await match.getByLabel(/^Operator/).selectOption('eq');
  await match.getByLabel(/^Value/).fill('Boston');
  await match.getByLabel('Note text').fill('Initial conversation');

  async function add(path,position,kind){
    await path.getByRole('button',{name:'Add action',exact:true}).click();
    const group=path.getByRole('group',{name:'Action '+position,exact:true});
    await group.getByLabel(/^Then/).selectOption(kind);
    return group;
  }
  const task=await add(match,2,'task');
  await task.getByLabel('Task name').fill('Call the account');
  await task.getByLabel(/^Wait for lifecycle stage/).selectOption('Customer');
  await task.getByLabel(/^Delay in minutes/).fill('2');
  const hook=await add(match,3,'webhook');
  await hook.getByLabel(/^Destination/).selectOption(destination);
  await (await add(match,4,'note')).getByLabel('Note text').fill('Handoff confirmed');
  await fallback.getByLabel('Note text').fill('Review the inquiry');
  await (await add(fallback,2,'note')).getByLabel('Note text').fill('Review complete');

  const map=page.getByRole('region',{name:'Workflow map'});
  await map.getByRole('button',{name:'Test paths'}).click();
  const selected=map.getByRole('list',{name:'Selected actions'}).getByRole('listitem');
  assert.deepEqual(await selected.allTextContents(),['Create a Note · Review the inquiry','Create a Note · Review complete']);
  await map.getByLabel('Sample city').fill('Boston');
  assert.deepEqual(await selected.allTextContents(),['Create a Note · Initial conversation','Create a Task · Call the account',
    'Send a webhook · '+destination,'Create a Note · Handoff confirmed']);
  await map.getByRole('button',{name:'Edit Sales action 2',exact:true}).click();
  assert.ok(await task.getByLabel(/^Then/).evaluate(el=>el===document.activeElement));
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();
  await page.getByText('Workflow saved.',{exact:true}).waitFor();
}

export async function verifyBranchSteps({request,origin,headers,other,sql,env,configure}){
  const path='/api/workflows',crm='/api/crm';
  const post=(url,data,auth=headers)=>request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  async function ok(pending){const r=await pending;assert.ok(r.ok,await r.clone().text());return r.json();}
  const state=(rule='',auth=headers)=>ok(request(path+(rule?'?runWorkflowId='+rule:''),{headers:auth}));
  const toggle=(id,revision,enabled)=>ok(post(path,{action:'setEnabled',id,revision,enabled}));
  const create=async(data,auth=headers)=>(await ok(post(crm,{action:'save',kind:'contacts',data},auth))).record;
  const lifecycle=async(record,value)=>(await ok(post(crm,{action:'save',kind:'contacts',id:record.id,expectedRevision:record.revision,
    data:{...record.data,lifecycle:value}}))).record;
  let customer=await create({name:'Fictional path customer',city:'Boston',lifecycle:'Lead'});
  const foreign=await create({name:'Foreign account'},other);
  const {owned:workspaceId}=await ok(request('/api/workspaces',{headers}));
  const sent=[],secret=randomBytes(32).toString('hex');
  let loseReply=false;
  const receiver=createServer({key:await readFile(process.env.HARBOR_TEST_TLS_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS)},async(req,res)=>{
    const body=[];for await(const chunk of req)body.push(chunk);
    sent.push({body:Buffer.concat(body).toString(),headers:req.headers});
    if(loseReply)res.destroy();else res.writeHead(204).end();
  });
  receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
  let browser;
  try{
    await configure({HARBOR_WEBHOOK_DESTINATIONS:JSON.stringify([{workspaceId,name:destination}])});
    const routes=JSON.stringify([{workspaceId,name:destination,secret,url:'https://127.0.0.1:'+receiver.address().port+'/events'}]);
    const worker=()=>exec(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
      cwd:process.env.HARBOR_TEST_PORTABLE_CWD,env:{...env,HARBOR_PORTABLE_WORKER_ENABLED:'true',HARBOR_WEBHOOK_DESTINATIONS:routes,HARBOR_WEBHOOK_DELIVERY_ENABLED:'true'},timeout:30_000});
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    const page=await browser.newPage();page.setDefaultTimeout(10000);
    const [name,value]=headers.cookie.split('=');await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=workflows');await author(page);
    const rule=(await state()).workflows.find(w=>w.definition.name===workflowName);
    assert.ok(rule);
    const [chosen]=rule.definition.paths;
    const ids=[chosen.id,...chosen.then.map(s=>s.id)];
    assert.equal(new Set(ids).size,4);
    assert.deepEqual(chosen.then.map(s=>s.action.kind),['task','webhook','note']);
    assert.equal(rule.definition.otherwise.then.length,1);
    await page.reload();
    await page.getByRole('button',{name:new RegExp('^'+workflowName+' · Off')}).click();
    const step3=page.getByRole('group',{name:'If',exact:true}).getByRole('group',{name:'Action 3',exact:true});
    assert.equal(await step3.getByLabel(/^Destination/).inputValue(),destination);

    const reject=async(first)=>assert.equal((await post(path,{action:'save',id:randomUUID(),revision:0,definition:{...rule.definition,paths:[first]}})).status,400);
    await reject({...chosen,then:[{id:chosen.id,action:note('Duplicate identity')}]});
    await reject({...chosen,then:Array.from({length:5},()=>next(note('Overflow')))});
    const noDestination=await post(path,{action:'save',id:randomUUID(),revision:0,definition:{...rule.definition,
      paths:[{...chosen,then:[next({kind:'webhook',destination:'unconfigured',delayMinutes:0})]}]}});
    assert.ok([400,403,404].includes(noDestination.status));
    await toggle(rule.id,rule.revision,true);
    const input=(record,rev=rule.revision+1)=>({action:'runContact',id:randomUUID(),workflowId:rule.id,workflowRevision:rev,contactId:record.id});
    const runs=async(id)=>(await state(id)).runs;
    const history=async(id,root)=>(await runs(id)).find(r=>r.id===root);
    const steps=async(run)=>(await history(run.workflowId,run.id)).pathSteps;
    const run=input(customer);
    assert.equal((await post(path,{...run,contactId:foreign.id})).status,404);
    const admitted=await Promise.all([post(path,run),post(path,run)]);
    assert.deepEqual(admitted.map(r=>r.status).sort(),[200,201]);
    assert.deepEqual((await state(rule.id,other)).runs,[]);
    const initial=await steps(run);
    assert.deepEqual(initial.map(s=>s.id),ids);
    assert.deepEqual(initial.map(s=>s.jobId),[run.id,null,null,null]);
    // Entry before the Task becomes current cannot release its wait.
    customer=await lifecycle(customer,'Customer');
    await worker();await configure({});await worker();
    const afterNote=await steps(run);
    assert.deepEqual(afterNote.map(s=>s.status),['succeeded','queued',null,null]);
    assert.deepEqual(afterNote.map(s=>s.id),ids);
    const taskId=afterNote[1].jobId;
    assert.equal(sent.length,0);
    const makeDue=id=>sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${id} AND status='queued'`;
    customer=await lifecycle(customer,'Lead');
    const before=Date.now();customer=await lifecycle(customer,'Customer');
    const due=(await steps(run))[1].scheduledFor;
    assert.ok(due>=before+120000&&due<=Date.now()+120000,'Delay starts on the later stage entry');
    await worker();assert.equal((await steps(run))[2].jobId,null);
    await makeDue(taskId);
    await worker();
    const hookId=(await steps(run))[2].jobId;
    assert.ok(hookId);
    await Promise.all([worker(),worker()]);await worker();
    const completed=await steps(run);
    assert.deepEqual(completed.map(s=>s.status),Array(4).fill('succeeded'));
    assert.equal(new Set(completed.map(s=>s.jobId)).size,4);
    const taskRecord=await ok(request(crm+'?kind=tasks&id='+taskId,{headers}));
    assert.deepEqual([taskRecord.contactId,taskRecord.data.name],[customer.id,'Call the account']);
    const notes=await sql`SELECT body FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=ANY(${completed.map(s=>s.jobId)}::uuid[]) ORDER BY created_at,job_id`;
    assert.deepEqual(notes.map(n=>n.body),['Initial conversation','Handoff confirmed']);
    assert.equal(sent.length,1);
    const [delivery]=sent,evt=JSON.parse(delivery.body);
    assert.deepEqual([evt.jobId,evt.workflowId,evt.pathId,evt.recordId],[hookId,rule.id,chosen.id,customer.id]);
    assert.equal(delivery.headers['idempotency-key'],workspaceId+'/'+hookId);
    assert.equal(delivery.headers['x-harbor-signature'],'sha256='+createHmac('sha256',secret).update(delivery.headers['x-harbor-timestamp']+'.'+delivery.body).digest('hex'));
    assert.equal((await post(path,run)).status,200);
    assert.deepEqual((await steps(run)).map(s=>s.jobId),completed.map(s=>s.jobId));

    const elsewhere=await create({name:'Fictional fallback',city:'Portland'});
    const cancelled=input(elsewhere);
    await ok(post(path,cancelled));
    await ok(post('/api/background-jobs?recordId='+elsewhere.id,{action:'cancelNote',id:cancelled.id}));
    await worker();
    assert.deepEqual((await steps(cancelled)).map(s=>[s.status,s.jobId]),[['skipped',cancelled.id],[null,null]]);
    // If the DB refuses to attach the next job, neither the predecessor Note nor
    // a partially admitted successor may survive the rolled-back transaction.
    const retried=input(elsewhere);
    await ok(post(path,retried));
    await sql.unsafe("ALTER TABLE portable_workflow_path_steps ADD CONSTRAINT fixture_admit_step CHECK (run_id<>'"+retried.id+"'::uuid OR position<>1 OR job_id IS NULL) NOT VALID");
    try{
      await worker();
      const stopped=await steps(retried);
      assert.deepEqual([stopped[0].status,stopped[0].issue,stopped[1].jobId],['queued','processor_error',null]);
      assert.equal((await sql`SELECT 1 FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=${retried.id}`).length,0);
    }finally{await sql`ALTER TABLE portable_workflow_path_steps DROP CONSTRAINT fixture_admit_step`;}
    await makeDue(retried.id);
    await worker();await worker();
    assert.deepEqual((await steps(retried)).map(step=>[step.status,step.attempts]),[['succeeded',2],['succeeded',1]]);

    // Future work is blocked after an uncertain webhook, even if the run is replayed.
    const conditional=(name,act,then)=>({id:randomUUID(),name,mode:'all',conditions:[{field:'name',operator:'known',value:''}],action:act,then});
    const hook={kind:'webhook',destination,delayMinutes:0};
    const auto=randomUUID();
    const plan={...rule.definition,name:'Fictional confirmed handoff',trigger:'contact_created',
      paths:[conditional('Winning match',note('First action'),[next(hook),next(note('After delivery'))]),
        conditional('Later overlapping match',note('Must not run'),[next(note('Wrong successor'))])]};
    await ok(post(path,{action:'save',id:auto,revision:0,definition:plan}));await toggle(auto,1,true);
    const ambiguous=await create({name:'Uncertain webhook customer'});
    await worker();loseReply=true;await worker();await worker();
    const [held]=await runs(auto);
    assert.deepEqual([held.contactId,held.pathName,held.pathSteps[1].status,held.pathSteps[1].issue,held.pathSteps[2].jobId],
      [ambiguous.id,'Winning match','attention','external_outcome_unknown',null]);
    assert.equal(sent.length,2);
    loseReply=false;
    const stale=await create({name:'Activation fence'});
    await toggle(auto,2,false);await toggle(auto,3,true);
    await worker();await worker();await worker();
    const fence=(await runs(auto)).find(r=>r.contactId===stale.id);
    assert.equal(fence.pathSteps[1].status,'skipped');
    assert.equal(fence.pathSteps[2].jobId,null);
    assert.equal(sent.length,2,'An obsolete activation or uncertain outcome must never send again');
    const waitRule=randomUUID();
    const waitingHook={...hook,waitForLifecycle:'Opportunity',delayMinutes:60};
    await ok(post(path,{action:'save',id:waitRule,revision:0,definition:{...rule.definition,name:'Hold handoff for opportunity',
      paths:[conditional('Opportunity handoff',waitingHook,[next(note('After the handoff'))])]}}));
    await toggle(waitRule,1,true);
    const enrollWait=async record=>{
      const run={action:'runContact',id:randomUUID(),workflowId:waitRule,workflowRevision:2,contactId:record.id};
      await ok(post(path,run));return run;
    };
    const cancelWait=(run,auth=headers)=>post('/api/background-jobs?recordId='+run.contactId,{action:'cancelEventWait',id:run.id},auth);
    const stop=await enrollWait(customer),release=await enrollWait(elsewhere);
    assert.equal((await cancelWait(stop,other)).status,404);
    assert.equal((await cancelWait({id:held.pathSteps[1].jobId,contactId:ambiguous.id})).status,409);
    await lifecycle(elsewhere,'Opportunity');
    assert.equal((await cancelWait(release)).status,409,'A released webhook must reject a stale waiting-action cancellation.');
    await page.goto(origin+'/?view=job-queue');
    await page.getByRole('link',{name:'Waiting for stage',exact:true}).click();
    const waitingRow=page.getByRole('row').filter({has:page.getByRole('link',{name:customer.data.name,exact:true})});
    await waitingRow.getByText('Waiting for Opportunity',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:elsewhere.data.name,exact:true}).count(),0);
    page.once('dialog',dialog=>dialog.accept());
    await waitingRow.getByRole('button',{name:'Cancel waiting action',exact:true}).click();
    await waitingRow.waitFor({state:'detached'});
    await ok(cancelWait(stop));
    await lifecycle(customer,'Opportunity');
    await worker();
    assert.deepEqual((await steps(stop)).map(step=>[step.status,step.issue,step.jobId]),[
      ['skipped','event_wait_cancelled',stop.id],[null,null,null]]);
    assert.equal((await steps(stop))[0].attempts,0);
    assert.equal(sent.length,2);

  }finally{await browser?.close();await new Promise(resolve=>receiver.close(resolve));}
}
