import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const workflowName='Fictional inquiry routing';
const intake='New inquiries', sales='Sales handoff', fallback='General follow-up';
const noteBody='Review this fictional inquiry.', taskName='Call the fictional decision maker';

async function authorWorkflow(origin,headers,readState){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    page.setDefaultTimeout(10_000);
    await page.goto(origin+'/?view=workflows');
    await page.getByLabel('Workflow name',{exact:true}).fill(workflowName);
    await page.getByRole('combobox',{name:/^Trigger/}).selectOption('manual_contact');
    await page.getByRole('combobox',{name:/^Action/}).selectOption('conditional_paths');
    const group=legend=>page.getByRole('group',{name:legend,exact:true});
    const first=group('If'), second=group('Else if'), last=group('Otherwise');
    const label=(scope,name)=>scope.getByLabel(new RegExp('^'+name));
    await label(first,'Path name').fill(intake);
    await label(first,'Property').selectOption('name');
    await label(first,'Operator').selectOption('contains');
    await label(first,'Value').fill('INQUIRY');
    await label(first,'Note text').fill(noteBody);

    await page.getByRole('button',{name:'Add path',exact:true}).click();
    await label(second,'Path name').fill(sales);
    await label(second,'Match').selectOption('all');
    await label(second,'Property').selectOption('city');
    await label(second,'Operator').selectOption('eq');
    await label(second,'Value').fill('Boston');
    await second.getByRole('button',{name:'Add condition',exact:true}).click();
    await label(second,'Property').nth(1).selectOption('email');
    await label(second,'Operator').nth(1).selectOption('known');
    await label(second,'Then').selectOption('task');
    await label(second,'Task name').fill(taskName);
    await label(second,'Task type').selectOption('Call');
    await label(second,'Priority').selectOption('High');
    await label(second,'Wait for lifecycle stage').selectOption('Customer');
    await label(second,'Delay in minutes').fill('3');
    await label(last,'Path name').fill(fallback);
    await label(last,'Note text').fill('Triage the unmatched contact.');
    const map=page.getByRole('region',{name:'Workflow map',exact:true});
    await page.getByRole('combobox',{name:/^Trigger/}).selectOption('deal_stage');
    await page.getByLabel('When a deal moves to').selectOption('Qualified to buy');
    await map.getByText('Sales pipeline · Deal enters Qualified to buy',{exact:true}).waitFor();
    await label(first,'Property').selectOption('dealAmount');
    await label(first,'Operator').selectOption('gte');
    await label(first,'Value').fill('25000');
    await map.getByRole('button',{name:'Test paths',exact:true}).click();
    const amount=map.getByLabel('Sample deal amount',{exact:true});
    await amount.fill('9999');
    await map.getByText('Selected path: '+fallback,{exact:true}).waitFor();
    await amount.fill('25000');
    await map.getByText('Selected path: '+intake,{exact:true}).waitFor();
    await map.getByRole('button',{name:'Close test',exact:true}).click();
    await page.getByRole('combobox',{name:/^Trigger/}).selectOption('ticket_status');
    assert.equal(await label(first,'Property').evaluate(el=>el.validity.valueMissing),true);
    assert.equal(await label(first,'Property').locator('option[value="dealAmount"]').count(),0);
    await label(first,'Property').selectOption('ticketPriority');
    await label(first,'Value').selectOption('Urgent');
    await map.getByRole('button',{name:'Test paths',exact:true}).click();
    await map.getByLabel('Sample ticket priority',{exact:true}).selectOption('Urgent');
    await map.getByText('Selected path: '+intake,{exact:true}).waitFor();
    await map.getByRole('button',{name:'Close test',exact:true}).click();
    await label(first,'Property').selectOption('name');
    await label(first,'Operator').selectOption('contains');
    await label(first,'Value').fill('INQUIRY');
    await page.getByRole('combobox',{name:/^Trigger/}).selectOption('manual_contact');
    const testPaths=()=>map.getByRole('button',{name:'Test paths',exact:true}).click();
    const sample=(name,value)=>map.getByLabel('Sample '+name,{exact:true}).fill(value);
    const selected=name=>map.getByText('Selected path: '+name,{exact:true}).waitFor();
    await testPaths();
    await selected(fallback);
    await sample('city',' bOsToN ');
    await selected(fallback);
    await label(second,'Match').selectOption('any');
    await selected(sales);
    await label(second,'Match').selectOption('all');
    await selected(fallback);
    await sample('email','fictional@example.test');
    await selected(sales);
    await sample('contact name','An inquiry about Harbor');
    await selected(intake);
    await map.getByRole('button',{name:'Edit '+sales+' path',exact:true}).click();
    assert.ok(await label(second,'Path name').evaluate(el=>el===document.activeElement));
    await map.getByRole('button',{name:'Edit '+sales+' action',exact:true}).click();
    assert.ok(await label(second,'Then').evaluate(el=>el===document.activeElement));
    await second.getByRole('button',{name:'Add OR group',exact:true}).click();
    const alt=second.getByRole('group',{name:'OR group 2',exact:true});
    await label(alt,'Property').selectOption('city');
    await label(alt,'Value').fill('Denver');
    await alt.getByRole('button',{name:'Add condition',exact:true}).click();
    await label(alt,'Property').nth(1).selectOption('title');
    await label(alt,'Value').nth(1).fill('Director');
    await alt.getByRole('button',{name:'Add condition',exact:true}).click();
    await label(alt,'Property').nth(2).selectOption('name');
    await label(alt,'Operator').nth(2).selectOption('not_contains');
    await label(alt,'Value').nth(2).fill('training');
    await sample('contact name','Potential customer');
    await sample('email','');
    await sample('job title','Director');
    await selected(fallback); // Boston and Director alone do not satisfy either group.
    await sample('city','Denver');
    await selected(sales);
    await sample('contact name','TRAINING example');
    await selected(fallback);
    await sample('contact name','');
    await selected(fallback);
    await sample('contact name','Potential customer');
    await sample('job title','Analyst');
    await selected(fallback);
    await second.getByRole('button',{name:'Add OR group',exact:true}).click();
    await second.getByRole('group',{name:'OR group 3',exact:true}).getByRole('button',{name:'Remove group'}).click();
    const save=async()=>{
      const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/workflows');
      await page.getByRole('button',{name:'Save workflow',exact:true}).click();
      assert.equal((await response).status(),200);
      await page.getByText('Workflow saved.',{exact:true}).waitFor();
    };
    await save();
    const original=(await readState()).workflows.find(w=>w.definition.name===workflowName);
    assert.deepEqual(original.definition.paths.map(p=>p.name),[intake,sales]);
    await page.setViewportSize({width:390,height:830});
    await page.reload();
    await page.getByRole('button',{name:new RegExp('^'+workflowName+' · Off')}).click();
    await testPaths();
    await sample('city','Boston');
    await sample('contact name','Fictional inquiry');
    await sample('email','fictional@example.test');
    await map.getByLabel('Sample email',{exact:true}).press('Enter');
    assert.equal(await page.getByText('Unsaved workflow changes.',{exact:true}).count(),0);
    await selected(intake);
    assert.ok(await map.evaluate(el=>el.getBoundingClientRect().right<=window.innerWidth));
    await second.getByRole('button',{name:'Move path up',exact:true}).click();
    await selected(sales);
    const previewed=await readState();
    assert.equal(previewed.runs.length,0);
    assert.equal(previewed.workflows.find(w=>w.id===original.id).revision,original.revision);
    assert.equal(await label(first,'Path name').inputValue(),sales);
    assert.equal(await label(first,'Wait for lifecycle stage').inputValue(),'Customer');
    await save();
    const edited=(await readState()).workflows.find(w=>w.id===original.id);
    assert.deepEqual(edited.definition.paths.map(p=>p.id),original.definition.paths.map(p=>p.id).reverse());
    assert.equal(edited.definition.otherwise.id,original.definition.otherwise.id);
    return edited;
  }finally{await browser.close();}
}

export async function verifyConditionalPaths({request,origin,headers,other,sql,env,restart}){
  const workflows='/api/workflows',crm='/api/crm';
  const post=(path,input,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(input)});
  const expect=async(pending,status)=>{
    const response=await pending;
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  };
  const state=(id='',auth=headers)=>expect(request(workflows+(id?'?runWorkflowId='+id:''),{headers:auth}),200);
  const save=(id,revision,definition,status=200)=>expect(post(workflows,{action:'save',id,revision,definition}),status);
  const toggle=(id,revision,enabled)=>expect(post(workflows,{action:'setEnabled',id,revision,enabled}),200);
  const contact=async(data,auth=headers)=>(await expect(post(crm,{action:'save',kind:'contacts',data,assigneeId:null},auth),201)).record;
  const editContact=async(record,changes,auth=headers)=>(await expect(post(crm,{action:'save',kind:'contacts',id:record.id,
    expectedRevision:record.revision,data:{...record.data,...changes}},auth),200)).record;
  const one=()=>execFileSync(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],
    {env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:10_000});
  const manual=await authorWorkflow(origin,headers,state);
  const {paths,otherwise}=manual.definition;
  const [specific,broad]=paths;
  assert.equal(specific.action.waitForLifecycle,'Customer');
  assert.deepEqual(specific.orGroups,[{mode:'all',conditions:[{field:'city',operator:'eq',value:'Denver'},{field:'title',operator:'eq',value:'Director'},{field:'name',operator:'not_contains',value:'training'}]}]);
  const invalid=[
    {paths:[]},
    {paths:[specific,{...broad,id:specific.id}]},
    {otherwise:{...otherwise,id:specific.id}},
    {paths:[{...specific,conditions:[]}]},
    {paths:[{...specific,conditions:[{field:'city',operator:'neq',value:''}]}]},
    {paths:[{...specific,orGroups:[{mode:'all',conditions:[]}]}]},
    {paths:[{...specific,orGroups:Array(3).fill(specific.orGroups[0])}]},
    {paths:[{...specific,conditions:[{field:'city',operator:'known',value:'unexpected'}]}]},
    {paths:[{...specific,action:{kind:'gmail',subject:'unsupported'}}]},
    {paths:[{...specific,action:{...specific.action,waitForLifecycle:'Fictional unknown stage'}}]},
    {paths:Array.from({length:6},(_,i)=>({...specific,id:randomUUID(),name:'Extra '+i}))},
  ];
  for(const overrides of invalid)await save(randomUUID(),0,{...manual.definition,...overrides},400);
  await toggle(manual.id,manual.revision,true);
  let overlapping=await contact({name:'FICTIONAL inquiry',city:'Denver',title:'Director',lifecycle:'Customer'});
  const foreign=await contact({name:'Foreign inquiry'},other);
  const input={action:'runContact',id:randomUUID(),workflowId:manual.id,workflowRevision:manual.revision+1,contactId:overlapping.id};
  await expect(post(workflows,{...input,contactId:foreign.id}),404);
  await expect(post(workflows,input,other),404);
  const receipt=await expect(post(workflows,input),201);
  const [matched]=(await state(manual.id)).runs;
  assert.deepEqual([matched.pathId,matched.pathName,matched.jobId,matched.jobKind,matched.waitForLifecycle],
    [specific.id,sales,input.id,'task','Customer']);

  const runByJob=async(id)=>(await state(manual.id)).runs.find(run=>run.jobId===id);
  const stopped=await contact({name:'Cancelled handoff',city:'Boston',email:'cancelled@example.test',lifecycle:'Lead'});
  const cancelled={...input,id:randomUUID(),contactId:stopped.id};
  await expect(post(workflows,{...input,id:randomUUID()}),409);
  // A waiting task occupies the last slot in the ordinary 100-job workspace limit.
  const filler=Array.from({length:99},()=>randomUUID());
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT j.workspace_id,ids.id,j.contact_id,j.actor_id,'note','Capacity fixture',0,9999999999999,0
    FROM portable_jobs j CROSS JOIN unnest(${filler}::uuid[]) AS ids(id) WHERE j.id=${input.id}`;
  try{
    const full=await expect(post(workflows,cancelled),409);
    assert.match(full.error,/queue is full/i);
  }finally{await sql`DELETE FROM portable_jobs WHERE id=ANY(${filler}::uuid[])`;}
  await expect(post(workflows,cancelled),201);
  const cancelPath='/api/background-jobs?recordId='+stopped.id;
  const cancel={action:'cancelTask',id:cancelled.id};
  await expect(post(cancelPath,cancel,other),404);
  await expect(post(cancelPath,cancel),200);
  await editContact(stopped,{lifecycle:'Customer'});

  // Both the contact and rule now say something else. Replaying the original request must use its receipt.
  overlapping=await editContact(overlapping,{city:'Austin'});
  await save(manual.id,input.workflowRevision,{...manual.definition,paths:[broad,{...specific,name:'Changed handoff',
    action:{kind:'note',body:'This later edit must not run.',delayMinutes:0}}]});
  assert.deepEqual(await expect(post(workflows,input),200),receipt);
  assert.deepEqual((await state(manual.id,other)).runs,[]);
  // Contact IDs are workspace-local. Give the second fixture workspace the same ID to test that boundary.
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    SELECT workspace_id,${overlapping.id},1,data,created_at,updated_at FROM contacts WHERE id=${foreign.id}`;
  const otherCopy=await expect(request(crm+'?kind=contacts&id='+overlapping.id,{headers:other}),200);
  await editContact(otherCopy,{lifecycle:'Customer'},other);
  overlapping=await editContact(overlapping,{lifecycle:'Opportunity'});
  await restart();
  one();
  const waiting=await runByJob(input.id);
  assert.deepEqual([waiting.pathId,waiting.pathName,waiting.waitForLifecycle,waiting.attempts],[specific.id,sales,'Customer',0]);
  const contactJobs=await expect(request('/api/background-jobs?recordId='+overlapping.id,{headers}),200);
  assert.equal(contactJobs.items.find(job=>job.id===input.id).waitForLifecycle,'Customer');
  for(const path of ['/?view=workflows&runWorkflowId='+manual.id,'/?view=job-queue&jobId='+input.id]){
    const display=await request(path,{headers});
    assert.equal(display.status,200);
    assert.match((await display.text()).replaceAll('<!-- -->',''),/Waiting for Customer/);
  }

  const dbTime=async()=>(await sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS at`)[0].at;
  // A later failure writing the Contact history must roll back the event and its job release together.
  await sql`ALTER TABLE contact_events ADD CONSTRAINT fixture_reject_wait_transition
    CHECK (data->>'name' <> 'Rejected stage transition')`;
  try{
    await expect(post(crm,{action:'save',kind:'contacts',id:overlapping.id,expectedRevision:overlapping.revision,
      data:{...overlapping.data,lifecycle:'Customer',name:'Rejected stage transition'}}),500);
    assert.equal((await runByJob(input.id)).waitForLifecycle,'Customer');
  }finally{await sql`ALTER TABLE contact_events DROP CONSTRAINT fixture_reject_wait_transition`;}
  const beforeEntry=await dbTime();
  overlapping=await editContact(overlapping,{lifecycle:'Customer'});
  const afterEntry=await dbTime();
  const eligible=await runByJob(input.id);
  assert.ok(!eligible.waitForLifecycle);
  assert.ok(eligible.scheduledFor>=beforeEntry+180_000&&eligible.scheduledFor<=afterEntry+180_000,
    'the original three-minute delay starts at Customer entry');
  overlapping=await editContact(overlapping,{title:'Buyer'});
  overlapping=await editContact(overlapping,{lifecycle:'Lead'});
  await editContact(overlapping,{lifecycle:'Customer'});
  assert.equal((await runByJob(input.id)).scheduledFor,eligible.scheduledFor);
  one();
  assert.equal((await runByJob(input.id)).attempts,0);

  // Automatic enrollment also covers the ANY and missing-value cases with an overlapping first path.
  const autoId=randomUUID();
  const auto={...manual.definition,name:'Fictional contact intake',trigger:'contact_created',paths:[{...specific,orGroups:specific.orGroups.map(g=>({...g,conditions:[...g.conditions,{field:'lifecycle',operator:'neq',value:'Customer'}]}))},{...broad,mode:'any',
    conditions:[...broad.conditions,{field:'title',operator:'unknown',value:''}]}]};
  await save(autoId,0,{...auto,otherwise:{...otherwise,action:{...otherwise.action,waitForLifecycle:'Opportunity'}}});
  await toggle(autoId,1,true);
  const unknownTitle=await contact({name:'Fictional intake',city:'Boston'});
  let general=await contact({name:'Fictional returning buyer',title:'Manager',lifecycle:'Opportunity'});
  const byName=await contact({name:'Follow-up InQuIrY',title:'Manager'});
  const director=await contact({name:'Fictional regional buyer',city:'Denver',title:'Director',lifecycle:'Lead'});
  const existingCustomer=await contact({name:'Fictional customer renewal',city:'Denver',title:'Director',lifecycle:'Customer'});
  const created=await state(autoId);
  assert.equal(created.runs.length,5);
  const selected=(contactId)=>created.runs.find(r=>r.contactId===contactId);
  assert.deepEqual([unknownTitle,general,byName].map(c=>selected(c.id).pathId),[broad.id,otherwise.id,broad.id]);
  assert.deepEqual([selected(director.id).pathId,selected(director.id).jobKind],[specific.id,'task']);
  assert.equal(selected(existingCustomer.id).pathId,otherwise.id);
  const automaticNote=selected(general.id);
  assert.equal(automaticNote.waitForLifecycle,'Opportunity');
  // Drain the immediately eligible Notes. A zero-delay wait still needs a later entry.
  for(let i=0;i<3;i++)one();
  assert.equal((await sql`SELECT count(*)::int n FROM portable_notes WHERE job_id=${automaticNote.jobId}`)[0].n,0);
  general=await editContact(general,{lifecycle:'Lead'});
  const bulkEdit=await expect(post(crm,{action:'editProperty',kind:'contacts',field:'lifecycle',mode:'replace',value:'Opportunity',
    records:[{id:general.id,expectedRevision:general.revision}]}),200);
  assert.equal(bulkEdit.changed,1);
  general=await expect(request(crm+'?kind=contacts&id='+general.id,{headers}),200);
  one();
  const released=(await state(autoId)).runs.find(r=>r.jobId===automaticNote.jobId);
  assert.deepEqual([released.jobStatus,!!released.waitForLifecycle],['succeeded',false]);
  await toggle(autoId,2,false);

  // Assigning an existing contact and moving a deal linked to it both evaluate the contact's properties.
  const ownerRule=randomUUID(),dealRule=randomUUID();
  await save(ownerRule,0,{...auto,name:'Fictional assignment',trigger:'contact_owner_assigned'});
  await toggle(ownerRule,1,true);
  const [owner]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  await expect(post(crm,{action:'save',kind:'contacts',id:general.id,expectedRevision:general.revision,
    data:general.data,assigneeId:owner.id}),200);
  const [assignment]=(await state(ownerRule)).runs;
  assert.equal(assignment.pathId,otherwise.id);
  await save(dealRule,0,{...auto,name:'Fictional stage change',trigger:'deal_stage',pipelineId:'default',stageId:'Qualified to buy'});
  await toggle(dealRule,1,true);
  const newDeal={action:'save',kind:'deals',primaryContactId:byName.id,
    data:{name:'Fictional renewal',stage:'Appointment scheduled'}};
  const deal=(await expect(post(crm,newDeal),201)).record;
  await expect(post(crm,{...newDeal,id:deal.id,expectedRevision:deal.revision,data:{...newDeal.data,stage:'Qualified to buy'}}),200);
  const [stageChange]=(await state(dealRule)).runs;
  assert.deepEqual([stageChange.dealId,stageChange.pathId],[deal.id,broad.id]);

  const expectedNotes=[[selected(unknownTitle.id),unknownTitle,broad],[selected(general.id),general,otherwise],
    [selected(byName.id),byName,broad],[assignment,general,otherwise],[stageChange,byName,broad]];
  // Advance this eligible job's clock to observe the delayed Task without sleeping three minutes.
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${input.id}`;
  for(let i=0;i<expectedNotes.length+2;i++)one();
  for(const [run,record,path] of expectedNotes){
    const notes=await sql`SELECT j.contact_id,n.body FROM portable_notes n JOIN portable_jobs j
      ON j.workspace_id=n.workspace_id AND j.id=n.job_id WHERE n.job_id=${run.jobId}`;
    assert.deepEqual(Array.from(notes),[{contact_id:record.id,body:path.action.body}]);
    assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${run.jobId}`)[0].n,0);
  }
  const task=await expect(request(crm+'?kind=tasks&id='+input.id,{headers}),200);
  assert.deepEqual([task.contactId,task.data.name,task.data.taskType,task.data.priority],[overlapping.id,taskName,'Call','High']);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_task_events WHERE task_id=${input.id}`)[0].n,1);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_notes WHERE job_id=${input.id}`)[0].n,0);
  assert.deepEqual((await state(manual.id)).runs.map(r=>[r.pathId,r.pathName,r.jobStatus]),
    [[specific.id,sales,'skipped'],[specific.id,sales,'succeeded']]);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${cancelled.id}`)[0].n,0);
  const html=await (await request('/?view=workflows&runWorkflowId='+manual.id,{headers})).text();
  assert.match(html,/Path taken/);
  assert.ok(html.includes(sales));
  await verifySourceConditions({post:(path,data)=>post(path,data,other),state:id=>state(id,other),expect,one,sql,origin,headers:other,
    manual,broad,otherwise});

  // A complete branch editor draft can contain thirty Tasks. Exercise worst-case JSON escaping
  // at each text field's limit, then reload through the ordinary owner API.
  const escaped='\u0001';
  const taskAction={kind:'task',delayMinutes:43200,waitForLifecycle:'Customer',
    task:{name:escaped.repeat(160),notes:escaped.repeat(2000),taskType:'Call',priority:'High',dueDate:'2030-12-31'}};
  const outcome=()=>({id:randomUUID(),name:escaped.repeat(80),action:taskAction,
    then:Array.from({length:4},()=>({id:randomUUID(),action:taskAction}))});
  const fullGroup=()=>({mode:'all',conditions:Array.from({length:4},()=>({field:'city',operator:'eq',value:escaped.repeat(240)}))});
  const largePlan={name:escaped.repeat(80),trigger:'manual_contact',actionKind:'conditional_paths',
    paths:Array.from({length:5},()=>({...outcome(),...fullGroup(),orGroups:[fullGroup(),fullGroup()]})),otherwise:outcome()};
  const largeSave={action:'save',id:randomUUID(),revision:0,definition:largePlan};
  assert.ok(Buffer.byteLength(JSON.stringify(largeSave))>420_000);
  await expect(post(workflows,largeSave,other),200);
  assert.deepEqual((await state('',other)).workflows.find(w=>w.id===largeSave.id).definition,largePlan);

  const oversized=(input,padding)=>request(workflows,{method:'POST',headers:{...other,origin,'content-type':'application/json'},
    body:JSON.stringify(input)+' '.repeat(padding)});
  await expect(oversized({action:'setEnabled',id:largeSave.id,revision:1,enabled:true},32_001),413);
  await expect(oversized(largeSave,512*1024),413);

}

async function verifySourceConditions({post,state,expect,one,sql,origin,headers,manual,broad,otherwise}){
  const crm='/api/crm';
  const save=(id,revision,definition,status=200)=>expect(post('/api/workflows',{action:'save',id,revision,definition}),status);
  const toggle=(id,revision,enabled)=>expect(post('/api/workflows',{action:'setEnabled',id,revision,enabled}),200);
  // Use multiple deals and tickets on the same contact. Only the triggering record can pick the path.
  const buyer=(await expect(post(crm,{action:'save',kind:'contacts',data:{name:'Fictional purchasing lead',city:'Boston'}}),201)).record;
  const highValue={...broad,name:'Large Boston deal',mode:'all',conditions:[
    {field:'dealAmount',operator:'gte',value:'25000.50'},{field:'city',operator:'eq',value:'Boston'},
    {field:'dealCloseDate',operator:'lte',value:'2028-03-31'}]};
  const stageRule={...manual.definition,name:'Fictional contract qualification',trigger:'deal_stage',pipelineId:'default',stageId:'Contract sent',paths:[highValue]};
  const newId=randomUUID();
  await save(newId,0,{...stageRule,trigger:'manual_contact',pipelineId:undefined,stageId:undefined},400);
  for(const invalid of [{field:'dealCloseDate',operator:'gte',value:'2027-02-29'},
    {field:'dealCloseDate',operator:'contains',value:'2028'},{field:'dealAmount',operator:'contains',value:'25'},
    {field:'dealAmount',operator:'gte',value:'incorrect'},{field:'city',operator:'lte',value:'5'},
    {field:'ticketPriority',operator:'eq',value:'High'}]){
    await save(newId,0,{...stageRule,paths:[{...highValue,orGroups:[{mode:'all',conditions:[invalid]}]}]},400);
  }
  await save(newId,0,stageRule);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=workflows');
    await page.getByRole('button',{name:/^Fictional contract qualification · Off/}).click();
    const threshold=page.getByRole('group',{name:'If',exact:true}).getByRole('spinbutton',{name:'Value',exact:true});
    assert.equal(await threshold.inputValue(),'25000.50');
    await threshold.fill('25000.5');
    const closeRule=page.getByRole('group',{name:'If',exact:true}).getByRole('group',{name:'Condition 3',exact:true});
    assert.equal(await closeRule.getByLabel(/^Value/).inputValue(),'2028-03-31');
    const map=page.getByRole('region',{name:'Workflow map',exact:true});
    await map.getByRole('button',{name:'Test paths',exact:true}).click();
    await map.getByLabel('Sample deal amount',{exact:true}).fill('25000.5');
    await map.getByLabel('Sample city',{exact:true}).fill('Boston');
    const date=map.getByLabel('Sample deal close date',{exact:true});
    for(const [operator,early,late] of [['is on or after',otherwise,highValue],['is on or before',highValue,otherwise]]){
      await closeRule.getByLabel(/^Operator/).selectOption({label:operator});
      for(const [value,path] of [['',otherwise],['2028-02-29',early],['2028-03-31',highValue],['2028-04-01',late]]){
        await date.fill(value);
        await map.getByText('Selected path: '+path.name,{exact:true}).waitFor();
      }
    }
    await page.getByRole('button',{name:'Save workflow',exact:true}).click();
    await page.getByText('Workflow saved.',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:/^Fictional contract qualification · Off/}).click();
    assert.equal(await threshold.inputValue(),'25000.5');
  }finally{await browser.close();}
  await toggle(newId,2,true);
  const expected=new Map();
  for(const [amount,closeDate,path] of [[9999,'2028-03-31',otherwise],[25000.5,'2028-03-31',highValue],
    [25000.5,'2028-02-29',highValue],[25000.5,'2028-04-01',otherwise],[25000.5,'',otherwise]]){
    const data={name:'Fictional contract',amount:0,stage:'Appointment scheduled'};
    const record=(await expect(post(crm,{action:'save',kind:'deals',primaryContactId:buyer.id,data}),201)).record;
    const update={action:'save',kind:'deals',id:record.id,primaryContactId:buyer.id};
    const moved=(await expect(post(crm,{...update,expectedRevision:record.revision,data:{...data,amount,closeDate,stage:'Contract sent'}}),200)).record;
    await expect(post(crm,{...update,expectedRevision:moved.revision,data:{...data,amount:100,stage:'Contract sent'}}),200);
    expected.set(record.id,path);
  }
  const fast={...broad,name:'Urgent billing review',mode:'all',conditions:[
    {field:'ticketPriority',operator:'eq',value:'Urgent'},{field:'ticketCategory',operator:'eq',value:'Billing'}]};
  const ticketRule=randomUUID();
  await save(ticketRule,0,{...manual.definition,trigger:'ticket_status',ticketStatus:'Closed',paths:[fast]});
  await toggle(ticketRule,1,true);
  for(const [ticketPriority,path] of [['Low',otherwise],['Urgent',fast]]){
    const record=(await expect(post('/api/tickets',{action:'save',contactId:buyer.id,
      data:{name:'Fictional renewal question',ticketStatus:'Closed',ticketCategory:'Billing',ticketPriority}}),201)).record;
    expected.set(record.id,path);
  }
  for(let pass=0;pass<expected.size;pass++)one();
  for(const id of [newId,ticketRule]){
    const {runs}=await state(id);
    assert.equal(runs.length,id===ticketRule?2:5);
    for(const run of runs){
      const path=expected.get(run.dealId??run.ticketId);
      assert.deepEqual([run.pathId,run.jobStatus],[path.id,'succeeded']);
      const notes=await sql`SELECT body FROM portable_notes WHERE job_id=${run.jobId}`;
      assert.deepEqual(Array.from(notes),[{body:path.action.body}]);
    }
  }
}
