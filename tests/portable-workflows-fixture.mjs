import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Keep the fixture event loop available to notice when the local web server closes idle sockets.
const execute=promisify(execFile);

export async function verifyPortableWorkflowCapacityReview({request,origin,headers,other,env,receipt}){
  const endpoint='/api/workflows', query='runIssue=queue_full';
  const review=auth=>request(endpoint,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'reviewQueueFullRun',id:receipt.id})});
  const get=async(path,auth=headers)=>{
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200);
    return response;
  };
  const directory=await mkdtemp(join(tmpdir(),'harbor-workflow-capacity-'));
  const status=async(flags=[])=>{
    const args=['monitor-status',directory,'--worker-off','--workflow-capacity',...flags];
    const result=await execute(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs',...args],{
      env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6500,
    }).catch(error=>{
      assert.equal(error.code,2,error.stderr); // This fixture has no backup bundle.
      return error;
    });
    assert.ok(!result.stdout.includes(receipt.id));
    return flags.includes('--prometheus')?result.stdout:JSON.parse(result.stdout).workflowCapacity;
  };
  try{
    const page=await request('/?view=workflows&'+query,{headers:{}});
    assert.equal(page.status,307);
    const location=new URL(page.headers.get('location'),origin);
    assert.match(location.searchParams.get('return_to'),/runIssue=queue_full/);
    const {runs}=await (await get(endpoint+'?'+query)).json();
    assert.equal(runs.find(run=>run.id===receipt.id)?.jobId,null);
    assert.ok(runs.every(run=>run.issue==='queue_full'&&run.operatorReviewedAt===undefined));
    const foreign=await (await get(endpoint+'?'+query,other)).json();
    assert.ok(foreign.runs.every(run=>run.id!==receipt.id));
    assert.equal((await review(other)).status,404);
    assert.equal((await review({})).status,401);
    const reviewHtml=await (await get('/?view=workflows&'+query)).text();
    assert.match(reviewHtml,/Mark reviewed/);
    assert.match(await (await get('/?view=job-queue')).text(),/Review workflows skipped by a full queue/);
    assert.doesNotMatch(await (await get('/?view=job-queue',other)).text(),/Review workflows skipped by a full queue/);
    assert.deepEqual(await status(),{result:'attention',capacitySkipped:true});
    assert.match(await status(['--prometheus']),/^harbor_monitor_section_status\{section="workflowCapacity",status="attention"\} 1$/m);

    const stamps=await Promise.all([review(headers),review(headers)].map(async pending=>{
      const response=await pending;
      assert.equal(response.status,200,await response.clone().text());
      return (await response.json()).receipt;
    }));
    assert.deepEqual(stamps[0],stamps[1]);
    assert.equal(stamps[0].id,receipt.id);
    assert.ok(stamps[0].operatorReviewedAt>0);
    const all=await (await get(endpoint)).json();
    assert.deepEqual(all.runs.find(run=>run.id===receipt.id),{...receipt,operatorReviewedAt:stamps[0].operatorReviewedAt});
    assert.deepEqual((await (await get(endpoint+'?'+query)).json()).runs,[]);
    assert.doesNotMatch(await (await get('/?view=job-queue')).text(),/Review workflows skipped by a full queue/);
    assert.deepEqual(await status(),{result:'ok',capacitySkipped:false});
  }finally{await rm(directory,{recursive:true,force:true});}
}

export async function verifyPortableStageWorkflows({request,origin,headers,other,sql,sharing,record,env}){
  // Give this synthetic operator scenario a fresh write window after intake.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write'
    AND subject=(SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId})`;
  const endpoint='/api/workflows';
  const [stage,taskStage,initial]=sharing.pipeline.stages;
  const id=randomUUID();
  const definition={name:'Expansion follow-up',pipelineId:sharing.pipeline.id,stageId:stage.id,
    delayMinutes:5,body:'Review the next expansion step.'};
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const post=(path,auth,body)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body)});
  const save={action:'save',id,revision:0,definition};
  const toggle=(revision,enabled)=>post(endpoint,headers,{action:'setEnabled',id,revision,enabled});
  const state=async()=>await (await get(endpoint)).json();
  const dealUrl='/api/crm';
  const sharedUrl=dealUrl+'?workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId;
  const dealInput={action:'save',kind:'deals',pipelineId:sharing.pipeline.id,data:{name:'Workflow fixture deal'}};
  const create=async(stageId,primaryContactId)=>{
    const result=await post(dealUrl,headers,{...dealInput,stageId,primaryContactId});
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).record;
  };
  const move=(deal,stageId,primaryContactId)=>post(sharedUrl,other,{...dealInput,id:deal.id,
    expectedRevision:deal.revision,stageId,primaryContactId});
  const one=()=>execute(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
    env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
  });

  assert.equal((await get(endpoint,{})).status,401);
  assert.equal((await post(endpoint,headers,{...save,definition:{...definition,stageId:randomUUID()}})).status,404);
  assert.equal((await post(endpoint,headers,save)).status,200);
  assert.equal((await post(endpoint,headers,save)).status,200);
  assert.equal((await state()).workflows[0].enabled,false);
  assert.equal((await post(endpoint,other,{action:'setEnabled',id,revision:1,enabled:true})).status,404);
  assert.equal((await post(endpoint+'?workspaceId='+sharing.workspaceId,other,save)).status,403);
  assert.deepEqual(await (await get(endpoint,other)).json(),{workflows:[],runs:[],next:null});
  const offDeal=await create(initial.id,record.id);
  assert.equal((await move(offDeal,stage.id)).status,200);
  assert.deepEqual((await state()).runs,[]);
  assert.equal((await toggle(1,true)).status,200);
  assert.equal((await toggle(1,false)).status,409);

  await create(stage.id,record.id);
  assert.deepEqual((await state()).runs,[]);
  const deal=await create(initial.id,record.id);
  await sql`ALTER TABLE portable_workflow_runs ADD CONSTRAINT fixture_reject_run CHECK (deal_revision<2)`;
  try{
    assert.equal((await move(deal,stage.id)).status,500);
    const current=await (await get('/api/crm?kind=deals&id='+deal.id)).json();
    assert.equal(current.revision,1);
    assert.equal(current.stageId,initial.id);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE body=${definition.body}`)[0].count,0);
  }finally{await sql`ALTER TABLE portable_workflow_runs DROP CONSTRAINT fixture_reject_run`;}
  const response=await move(deal,stage.id);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await move(deal,stage.id)).status,409);
  const {record:updated}=await response.json();
  assert.equal((await move(updated,stage.id)).status,200);
  const [{jobId,jobStatus,scheduledFor,createdAt}]= (await state()).runs;
  assert.equal((await state()).runs.length,1);
  assert.equal(jobStatus,'queued');
  assert.equal(scheduledFor-createdAt,300_000);
  const [authority]=await sql`SELECT j.contact_id,a.email AS author,o.email AS owner FROM portable_jobs j
    JOIN login_identities a ON a.id=j.actor_id JOIN login_identities o ON o.id=j.authorized_owner_id WHERE j.id=${jobId}`;
  assert.deepEqual({...authority},{contact_id:record.id,author:'other@example.test',owner:'owner@example.test'});
  await one();
  assert.equal((await state()).runs[0].jobStatus,'queued');

  const noContact=await create(initial.id,null);
  assert.equal((await move(noContact,stage.id)).status,200);
  assert.equal((await state()).runs.find(run=>run.dealId===noContact.id).issue,'missing_contact');
  const capDeal=await create(initial.id,record.id);
  let skippedRun;
  const caps=Array.from({length:100},()=>randomUUID());
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT ${sharing.workspaceId}, ids.id,${record.id},i.id,'note','Workflow cap fixture',0,9999999999999,0
    FROM unnest(${caps}::uuid[]) AS ids(id) CROSS JOIN login_identities i WHERE i.email='owner@example.test'`;
  try{
    assert.equal((await move(capDeal,stage.id)).status,200);
    skippedRun=(await state()).runs.find(run=>run.dealId===capDeal.id);
    assert.equal(skippedRun.issue,'queue_full');
  }finally{await sql`DELETE FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${caps}::uuid[])`;}
  await verifyPortableWorkflowCapacityReview({request,origin,headers,other,env,receipt:skippedRun});

  assert.equal((await toggle(2,false)).status,200);
  const disabled=await create(initial.id,record.id);
  assert.equal((await move(disabled,stage.id)).status,200);
  assert.equal((await state()).runs.length,3);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${jobId}`;
  await one();
  await one();
  const completed=(await state()).runs.find(run=>run.jobId===jobId);
  assert.deepEqual([completed.jobStatus,completed.attempts],['succeeded',1]);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${jobId}`)[0].count,1);
  assert.equal((await toggle(3,true)).status,200);
  sharing.workflowId=id;
  sharing.workflowJobId=jobId;

  const taskDefinition={name:'Review deal progress',trigger:'deal_stage',actionKind:'task',
    pipelineId:sharing.pipeline.id,stageId:taskStage.id,delayMinutes:15,
    task:{name:'Review fictional deal next steps',taskType:'Call',priority:'High',dueDate:'2026-12-01',notes:'Confirm owner follow-up.'}};
  const saveTask={action:'save',id,revision:4,definition:taskDefinition};
  assert.equal((await post(endpoint,headers,{...saveTask,definition:{...taskDefinition,stageId:randomUUID()}})).status,404);
  assert.equal((await post(endpoint,headers,saveTask)).status,200);
  assert.equal((await state()).workflows.find(workflow=>workflow.id===id).definition.actionKind,'task');
  const history=await get('/?view=workflows');
  assert.equal(history.status,200);
  assert.match(await history.text(),/<option value="task">Create a Task<\/option>/);
  const currentDeal=async id=>(await get('/api/crm?kind=deals&id='+id)).json().then(result=>result.record??result);
  const forTask=await currentDeal(deal.id);
  assert.equal((await move(forTask,taskStage.id)).status,200);
  assert.equal((await move(forTask,taskStage.id)).status,409);
  assert.equal((await move(await currentDeal(noContact.id),taskStage.id)).status,200);
  const taskRuns=(await state()).runs.filter(run=>run.workflowName===taskDefinition.name);
  assert.equal(taskRuns.length,2);
  assert.equal(taskRuns.find(run=>run.dealId===noContact.id).issue,'missing_contact');
  const admitted=taskRuns.find(run=>run.dealId===deal.id);
  assert.deepEqual([admitted.jobKind,admitted.jobStatus,admitted.scheduledFor-admitted.createdAt],['task','queued',900_000]);
  const [saved]=await sql`SELECT j.contact_id,i.email AS author,t.payload FROM portable_jobs j
    JOIN login_identities i ON i.id=j.actor_id JOIN portable_task_jobs t ON t.workspace_id=j.workspace_id AND t.job_id=j.id
    WHERE j.workspace_id=${sharing.workspaceId} AND j.id=${admitted.jobId}`;
  assert.deepEqual({...saved},{contact_id:record.id,author:'other@example.test',payload:taskDefinition.task});
  await one();
  assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${admitted.jobId}`)[0].n,0);
  assert.equal((await toggle(5,false)).status,200);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${sharing.workspaceId} AND id=${admitted.jobId}`;
  await one();
  await one();
  const taskPath='/api/crm?kind=tasks&id='+admitted.jobId;
  const task=await get(taskPath);
  assert.equal(task.status,200);
  const result=await task.json();
  assert.equal(result.contactId,record.id);
  assert.equal(result.assigneeId,(await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`)[0].owner_id);
  assert.deepEqual(result.data,{...taskDefinition.task,status:'Not started'});
  assert.equal((await get(taskPath,other)).status,404);
  const taskRun=(await state()).runs.find(run=>run.jobId===admitted.jobId);
  assert.deepEqual([taskRun.jobStatus,taskRun.attempts],['succeeded',1]);
  sharing.dealStageTask={jobId:admitted.jobId,contactId:record.id,dealId:deal.id,data:result.data};

  const branch={name:'Deal stage customer follow-up',trigger:'deal_stage',actionKind:'note_branch',
    pipelineId:sharing.pipeline.id,stageId:taskStage.id,lifecycle:'Customer',
    match:{body:'Review the customer’s expansion plan.',delayMinutes:3},
    otherwise:{body:'Confirm the lead’s next step.',delayMinutes:8}};
  const saveBranch={action:'save',id,revision:6,definition:branch};
  assert.equal((await post(endpoint,headers,{...saveBranch,definition:{...branch,stageId:randomUUID()}})).status,404);
  assert.equal((await post(endpoint,headers,saveBranch)).status,200);
  assert.equal((await toggle(7,true)).status,200);
  const createContact=async lifecycle=>{
    const response=await post(dealUrl,headers,{action:'save',kind:'contacts',data:{name:'Deal branch '+lifecycle,lifecycle}});
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const customer=await createContact('Customer'),lead=await createContact('Lead');
  const customerDeal=await currentDeal(offDeal.id),leadDeal=await currentDeal(capDeal.id);
  assert.equal((await move(customerDeal,taskStage.id,customer.id)).status,200);
  assert.equal((await move(customerDeal,taskStage.id,customer.id)).status,409);
  assert.equal((await move(leadDeal,taskStage.id,lead.id)).status,200);
  assert.equal((await move(await currentDeal(noContact.id),initial.id)).status,200);
  assert.equal((await move(await currentDeal(noContact.id),taskStage.id)).status,200);
  const runs=(await state()).runs.filter(run=>run.workflowName===branch.name);
  assert.equal(runs.length,3);
  assert.equal(runs.find(run=>run.dealId===noContact.id).issue,'missing_contact');
  const branchJobs=[[customerDeal,customer,branch.match],[leadDeal,lead,branch.otherwise]].map(([deal,contact,note])=>{
    const run=runs.find(run=>run.dealId===deal.id);
    assert.deepEqual([run.dealRevision,run.jobKind,run.jobStatus,run.scheduledFor-run.createdAt],
      [deal.revision+1,'note','queued',note.delayMinutes*60_000]);
    return {id:run.jobId,dealId:deal.id,contactId:contact.id,body:note.body};
  });
  assert.equal((await post(dealUrl,headers,{action:'save',kind:'contacts',id:customer.id,expectedRevision:customer.revision,
    data:{...customer.data,lifecycle:'Lead'}})).status,200);
  assert.equal((await toggle(8,false)).status,200);
  assert.equal((await post(endpoint,headers,{...save,revision:9})).status,200);
  assert.equal((await toggle(10,true)).status,200);
  const branchJobIds=branchJobs.map(job=>job.id);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${branchJobIds}::uuid[])`;
  for(let attempt=0;attempt<3;attempt++)await one();
  const completedBranch=(await state()).runs;
  for(const job of branchJobs){
    const notes=await sql`SELECT j.contact_id AS "contactId",n.body FROM portable_notes n JOIN portable_jobs j
      ON j.workspace_id=n.workspace_id AND j.id=n.job_id WHERE n.job_id=${job.id}`;
    assert.deepEqual(Array.from(notes),[{contactId:job.contactId,body:job.body}]);
    const run=completedBranch.find(run=>run.jobId===job.id);
    assert.deepEqual([run.jobStatus,run.attempts],['succeeded',1]);
  }
  sharing.dealStageBranchJobs=branchJobs;
}

export async function verifyPortableLifecycleWorkflow({request,origin,headers,other,sql,sharing,env}){
  // Begin a new operator scenario after the form and Deal workflow fixtures.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const endpoint='/api/workflows',id=randomUUID();
  const definition={name:'Customer follow-up',trigger:'contact_lifecycle',lifecycle:'Customer',
    delayMinutes:5,body:'Review the customer’s onboarding.'};
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const post=(path,auth,body)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body)});
  const save={action:'save',id,revision:0,definition};
  const state=async()=>await (await get(endpoint)).json();
  const history=async()=>(await state()).runs.filter(run=>run.workflowName===definition.name);
  const recordUrl='/api/crm';
  const sharedUrl=recordUrl+'?workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId;
  const create=async(name,lifecycle)=>{
    const response=await post(recordUrl,headers,{action:'save',kind:'contacts',data:{name,lifecycle}});
    assert.equal(response.status,201);
    return (await response.json()).record;
  };
  const update=(record,changes)=>post(sharedUrl,other,{action:'save',kind:'contacts',id:record.id,
    expectedRevision:record.revision,data:{...record.data,...changes}});
  const edit=async(record,changes)=>{
    const response=await update(record,changes);
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).record;
  };
  const run=(command,...args)=>execute(process.execPath,
    [process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs',command,...args],{
      env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
    });
  const failure=async()=>{
    try{return JSON.parse((await run('worker-status')).stdout).latestFailureAt;}
    catch(error){assert.equal(error.code,2);return JSON.parse(error.stdout).latestFailureAt;}
  };

  assert.equal((await post(endpoint,headers,{...save,definition:{...definition,lifecycle:'Unknown'}})).status,400);
  assert.equal((await post(endpoint,headers,save)).status,200);
  const original=await create('Lifecycle workflow fixture','Lead');
  assert.equal((await post(endpoint,headers,{action:'setEnabled',id,revision:1,enabled:true})).status,200);
  await create('Created as customer fixture','Customer');
  assert.deepEqual(await history(),[]);
  const first=await edit(original,{lifecycle:'Customer'});
  assert.equal((await update(original,{lifecycle:'Customer'})).status,409);
  const renamed=await edit(first,{name:'Lifecycle fixture updated'});
  assert.equal((await history()).length,1);
  const left=await edit(renamed,{lifecycle:'Lead'});
  const reentered=await edit(left,{lifecycle:'Customer'});
  const [oldRun,newRun]=(await history()).sort((a,b)=>a.contactRevision-b.contactRevision);
  assert.equal((await history()).length,2);
  assert.deepEqual([oldRun.contactRevision,newRun.contactRevision],[first.revision,reentered.revision]);
  assert.equal(oldRun.contactName,original.data.name);
  assert.equal(newRun.contactName,renamed.data.name);
  assert.notEqual(oldRun.jobId,newRun.jobId);
  assert.ok([oldRun,newRun].every(run=>run.jobStatus==='queued'&&run.scheduledFor-run.createdAt===300_000));
  await run('worker','--once');
  assert.ok((await history()).every(run=>run.jobStatus==='queued'));
  const previousFailure=await failure();
  const ids=[oldRun.jobId,newRun.jobId];
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${ids}::uuid[])`;
  await run('worker','--once');
  await run('worker','--once');
  await run('worker','--once');
  const runs=await history();
  assert.deepEqual(runs.find(run=>run.jobId===oldRun.jobId).jobStatus,'skipped');
  assert.equal(runs.find(run=>run.jobId===oldRun.jobId).jobIssue,'segment_left');
  assert.equal(runs.find(run=>run.jobId===newRun.jobId).jobStatus,'succeeded');
  assert.ok(runs.every(run=>run.attempts===1));
  assert.equal(await failure(),previousFailure);
  const notes=await sql`SELECT job_id,body FROM portable_notes WHERE job_id=ANY(${ids}::uuid[])`;
  assert.deepEqual(notes.map(note=>[note.job_id,note.body]),[[newRun.jobId,definition.body]]);
  const sources=await sql`SELECT j.segment_entry_revision,a.email FROM portable_jobs j
    JOIN login_identities a ON a.id=j.actor_id WHERE j.id=ANY(${ids}::uuid[]) ORDER BY j.segment_entry_revision`;
  assert.deepEqual(sources.map(row=>[row.segment_entry_revision,row.email]),
    [[first.revision,'other@example.test'],[reentered.revision,'other@example.test']]);
  assert.equal((await get('/api/background-jobs?recordId='+original.id,other)).status,404);
  const contactJobsResponse=await get('/api/background-jobs?recordId='+original.id);
  assert.equal(contactJobsResponse.status,200,await contactJobsResponse.clone().text());
  const contactJobs=await contactJobsResponse.json();
  assert.equal(contactJobs.items.find(job=>job.id===oldRun.jobId).receipts[0].outcome,'segment_left');
  assert.deepEqual((await (await get(endpoint,other)).json()).runs,[]);
  const task={name:'Review customer onboarding',taskType:'To-do',priority:'High',dueDate:'',notes:'Check the handoff.'};
  const taskRule={name:'Customer lifecycle Task',trigger:'contact_lifecycle',lifecycle:'Customer',
    actionKind:'task',delayMinutes:5,task};
  const saveTask={action:'save',id,revision:2,definition:taskRule};
  assert.equal((await post(endpoint,headers,{...saveTask,definition:{...taskRule,lifecycle:'Unknown'}})).status,400);
  assert.equal((await post(endpoint,headers,saveTask)).status,200);
  assert.deepEqual((await state()).workflows.find(workflow=>workflow.id===id).definition,taskRule);
  const staleEntry=await edit(await edit(reentered,{lifecycle:'Lead'}),{lifecycle:'Customer'});
  const currentEntry=await edit(await edit(staleEntry,{lifecycle:'Lead'}),{lifecycle:'Customer'});
  await edit(currentEntry,{name:'Customer handoff fixture'});
  const taskRuns=async()=>(await state()).runs.filter(run=>run.workflowName===taskRule.name)
    .sort((a,b)=>a.contactRevision-b.contactRevision);
  const pending=await taskRuns();
  assert.deepEqual(pending.map(run=>[run.contactRevision,run.jobKind,run.jobStatus,run.scheduledFor-run.createdAt]),
    [[staleEntry.revision,'task','queued',300_000],[currentEntry.revision,'task','queued',300_000]]);
  assert.deepEqual((await (await get(endpoint,other)).json()).runs,[]);
  await run('worker','--once');
  assert.ok((await taskRuns()).every(item=>item.jobStatus==='queued'));
  const taskIds=pending.map(item=>item.jobId);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${taskIds}::uuid[])`;
  await run('worker','--once');
  await run('worker','--once');
  await run('worker','--once');
  assert.deepEqual((await taskRuns()).map(item=>[item.jobStatus,item.jobIssue,item.attempts]),
    [['skipped','segment_left',1],['succeeded',null,1]]);
  const completed=await sql`SELECT t.id,t.contact_id,t.data,a.email AS actor
    FROM portable_tasks t JOIN portable_task_events e ON e.workspace_id=t.workspace_id AND e.task_id=t.id
    JOIN login_identities a ON a.id=e.actor_id WHERE t.id=ANY(${taskIds}::uuid[])`;
  assert.deepEqual(completed.map(item=>[item.id,item.contact_id,item.data,item.actor]),
    [[taskIds[1],original.id,{...task,status:'Not started'},'other@example.test']]);
  sharing.lifecycleWorkflowId=id;
  sharing.lifecycleSkippedJobId=oldRun.jobId;
}

export async function verifyPortableContactCreatedWorkflow({request,origin,headers,other,sql,sharing,env}){
  const endpoint='/api/workflows',crm='/api/crm',id=randomUUID();
  const definition={name:'New contact follow-up',trigger:'contact_created',delayMinutes:5,body:'Review the new contact.'};
  const save={action:'save',id,revision:0,definition};
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body)});
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const state=async(auth=headers)=>(await get(endpoint,auth)).json();
  const history=async(auth=headers)=>(await state(auth)).runs.filter(run=>run.workflowName===definition.name);
  const create=async(name,auth=headers,path=crm,lifecycle='Lead')=>{
    const response=await post(path,{action:'save',kind:'contacts',data:{name,lifecycle}},auth);
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const toggle=(revision,enabled,auth=headers)=>post(endpoint,{action:'setEnabled',id,revision,enabled},auth);
  const one=()=>execute(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
    env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
  });
  const shared=crm+'?'+new URLSearchParams({workspaceId:sharing.workspaceId,grantId:sharing.grantId});
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

  for(const extra of [{actionKind:'gmail',subject:'Fictional subject'},{lifecycle:'Lead'}]){
    assert.equal((await post(endpoint,{...save,definition:{...definition,...extra}})).status,400);
  }
  assert.equal((await post(endpoint,save)).status,200);
  assert.equal((await state()).workflows.find(workflow=>workflow.id===id).enabled,false);
  assert.equal((await toggle(1,true,other)).status,404);
  const off=await create('Created before workflow activation');
  assert.deepEqual(await history(),[]);
  assert.equal((await toggle(1,true)).status,200);
  const edit={action:'save',kind:'contacts',id:off.id,expectedRevision:off.revision,
    data:{...off.data,lifecycle:'Subscriber'}};
  assert.equal((await post(crm,edit)).status,200);
  assert.equal((await post(crm,edit)).status,409);
  await create('Created in a different workspace',other);
  assert.deepEqual(await history(),[]);

  const personal=await create('Created by workflow workspace owner');
  const teammate=await create('Created by workflow workspace editor',other,shared);
  const runs=await history();
  assert.deepEqual(runs.map(run=>run.contactId).sort(),[personal.id,teammate.id].sort());
  assert.ok(runs.every(run=>run.contactRevision===1&&run.jobStatus==='queued'&&
    run.scheduledFor-run.createdAt===300_000));
  assert.deepEqual(await history(other),[]);
  const [ownerJob,sharedJob]=[personal,teammate].map(contact=>runs.find(run=>run.contactId===contact.id).jobId);
  assert.notEqual(ownerJob,sharedJob);
  const jobIds=[ownerJob,sharedJob];
  const authority=await sql`SELECT j.id,j.workspace_id,j.kind,a.email AS author,o.email AS owner
    FROM portable_jobs j JOIN login_identities a ON a.id=j.actor_id
    JOIN login_identities o ON o.id=j.authorized_owner_id WHERE j.id=ANY(${jobIds}::uuid[])`;
  assert.equal(authority.length,2);
  for(const job of authority){
    assert.deepEqual([job.workspace_id,job.kind,job.author,job.owner],
      [sharing.workspaceId,'note',job.id===ownerJob?'owner@example.test':'other@example.test','owner@example.test']);
  }

  const csv='Full name,Email address\nFictional imported contact,contact-created-import@example.test';
  const preview=await post('/api/crm/import',{action:'preview',csv});
  assert.equal(preview.status,200);
  const imported=await post('/api/crm/import',{action:'import',csv,review:(await preview.json()).review,requestId:randomUUID()});
  assert.equal(imported.status,201,await imported.clone().text());
  const formId=randomUUID(),forms='/api/lead-forms';
  assert.equal((await post(forms,{action:'save',id:formId,revision:0,definition:{
    title:'Fictional created-contact form',captureContacts:true,
  }})).status,200);
  assert.equal((await post(forms,{action:'setEnabled',id:formId,revision:1,enabled:true})).status,200);
  const inquiry=await post('/api/public/forms/'+formId,{id:randomUUID(),revision:2,payload:{
    name:'Fictional form contact',email:'contact-created-form@example.test',
  }},{});
  assert.equal(inquiry.status,200,await inquiry.clone().text());
  assert.equal((await post(forms,{action:'setEnabled',id:formId,revision:2,enabled:false})).status,200);
  assert.equal((await sql`SELECT count(*)::int AS count FROM contacts WHERE workspace_id=${sharing.workspaceId}
    AND data->>'email' IN ('contact-created-form@example.test','contact-created-import@example.test')`)[0].count,2);
  assert.deepEqual(await history(),runs);

  await one();
  assert.deepEqual(await history(),runs);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${jobIds}::uuid[])`;
  for(let attempt=0;attempt<3;attempt++)await one();
  const completed=await history();
  assert.equal(completed.length,2);
  assert.ok(completed.every(run=>run.jobStatus==='succeeded'&&run.attempts===1));
  const notes=await sql`SELECT job_id,body FROM portable_notes WHERE job_id=ANY(${jobIds}::uuid[])`;
  assert.deepEqual(notes.map(note=>note.job_id).sort(),jobIds.toSorted());
  assert.ok(notes.every(note=>note.body===definition.body));

  const archive=await post('/api/recycle-bin',{action:'archive',id:personal.id,
    expectedRevision:personal.revision,requestId:randomUUID()});
  assert.equal(archive.status,200,await archive.clone().text());
  const {receipt}=await archive.json();
  const restored=await post('/api/recycle-bin',{action:'restore',id:personal.id,
    expectedRevision:receipt.revision,requestId:randomUUID()});
  assert.equal(restored.status,200,await restored.clone().text());
  assert.deepEqual(await history(),completed);
  assert.equal((await toggle(2,false)).status,200);
  await create('Created after workflow paused');
  assert.deepEqual(await history(),completed);
  const branch={name:'Fictional new Contact lifecycle branch',trigger:'contact_created',actionKind:'note_branch',
    lifecycle:'Customer',match:{body:'Send the customer welcome checklist.',delayMinutes:2},
    otherwise:{body:'Review the new inquiry.',delayMinutes:7}};
  const branchHistory=async(auth=headers)=>(await state(auth)).runs.filter(run=>run.workflowName===branch.name);
  assert.equal((await post(endpoint,{action:'save',id,revision:3,definition:branch})).status,200);
  assert.equal((await toggle(4,true)).status,200);
  const customer=await create('Fictional new customer',headers,crm,'Customer');
  const lead=await create('Fictional new shared lead',other,shared);
  const branched=await branchHistory();
  assert.equal(branched.length,2);
  assert.deepEqual(await branchHistory(other),[]);
  const branchJobs=[{contact:customer,note:branch.match},{contact:lead,note:branch.otherwise}].map(({contact,note})=>{
    const run=branched.find(item=>item.contactId===contact.id);
    assert.equal(run.contactRevision,1);
    assert.equal(run.jobStatus,'queued');
    assert.equal(run.scheduledFor-run.createdAt,note.delayMinutes*60_000);
    return {id:run.jobId,body:note.body};
  });
  assert.equal((await post(crm,{action:'save',kind:'contacts',id:customer.id,expectedRevision:1,
    data:{...customer.data,lifecycle:'Lead'}})).status,200);
  assert.equal((await toggle(5,false)).status,200);
  const branchIds=branchJobs.map(job=>job.id);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${branchIds}::uuid[])`;
  for(let attempt=0;attempt<3;attempt++)await one();
  const branchCompleted=await branchHistory();
  assert.ok(branchCompleted.every(run=>run.jobStatus==='succeeded'&&run.attempts===1));
  const branchNotes=await sql`SELECT job_id AS id,body FROM portable_notes WHERE job_id=ANY(${branchIds}::uuid[]) ORDER BY job_id`;
  assert.deepEqual(Array.from(branchNotes),branchJobs.toSorted((a,b)=>a.id.localeCompare(b.id)));
  sharing.contactCreatedWorkflow={id,jobIds:[...jobIds,...branchIds],branchJobs};
}

export async function verifyPortableContactOwnerWorkflow({request,origin,headers,other,sql,sharing,env}){
  const endpoint='/api/workflows',crm='/api/crm',id=randomUUID();
  const definition={name:'Contact ownership handoff',trigger:'contact_owner_assigned',actionKind:'note_branch',
    lifecycle:'Opportunity',match:{body:'Review this opportunity’s handoff.',delayMinutes:2},
    otherwise:{body:'Review the assigned lead.',delayMinutes:5}};
  const save={action:'save',id,revision:0,definition};
  const shared=crm+'?'+new URLSearchParams({workspaceId:sharing.workspaceId,grantId:sharing.grantId});
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body)});
  const history=async(auth=headers)=>{
    const response=await request(endpoint,{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).runs.filter(run=>run.workflowName===definition.name);
  };
  const owners=await sql`SELECT id,email FROM login_identities WHERE email IN ('owner@example.test','other@example.test')`;
  const owner=owners.find(member=>member.email==='owner@example.test');
  const editor=owners.find(member=>member.email==='other@example.test');
  const record=(data,extra={})=>({action:'save',kind:'contacts',data,...extra});
  const edit=(current,assigneeId,lifecycle=current.data.lifecycle)=>record({name:current.data.name,lifecycle},
    {id:current.id,expectedRevision:current.revision,assigneeId});
  const saved=async(response,status)=>{
    assert.equal(response.status,status,await response.clone().text());
    return (await response.json()).record;
  };
  const toggle=(revision,enabled)=>post(endpoint,{action:'setEnabled',id,revision,enabled});
  const one=()=>execute(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
    env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
  });
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudgets();

  assert.equal((await post(endpoint,{...save,definition:{name:definition.name,trigger:definition.trigger,
    actionKind:'gmail',subject:'Fictional subject',body:'Fictional body',delayMinutes:0}})).status,400);
  assert.equal((await post(endpoint,{...save,definition:{...definition,otherwise:{...definition.otherwise,delayMinutes:-1}}})).status,400);
  assert.equal((await post(endpoint,save)).status,200);
  assert.equal((await toggle(1,true)).status,200);
  const initial=await saved(await post(crm,record({name:'Fictional Contact owner workflow',lifecycle:'Lead'},
    {assigneeId:owner.id})),201);
  const unchanged=await saved(await post(crm,edit(initial,owner.id)),200);
  const cleared=await saved(await post(crm,edit(unchanged,null)),200);
  const foreign=await saved(await post(crm,record({name:'Fictional foreign Contact owner workflow',lifecycle:'Lead'}),other),201);
  await saved(await post(crm,edit(foreign,editor.id),other),200);
  assert.equal((await post(crm,edit(cleared,editor.id),other)).status,404);
  assert.equal((await post(crm,edit(cleared,randomUUID()))).status,409);
  assert.deepEqual(await history(),[]);
  assert.deepEqual(await history(other),[]);

  const assigned=await saved(await post(crm,edit(cleared,owner.id)),200);
  const reassigned=await saved(await post(shared,edit(assigned,editor.id,'Opportunity'),other),200);
  assert.equal((await post(shared,edit(assigned,editor.id),other)).status,409);
  const lifecycleEdited=await saved(await post(shared,edit(reassigned,editor.id,'Lead'),other),200);
  const runs=(await history()).sort((a,b)=>a.contactRevision-b.contactRevision);
  assert.deepEqual(runs.map(run=>[run.contactId,run.contactRevision]),[[initial.id,assigned.revision],[initial.id,reassigned.revision]]);
  const branchJobs=runs.map((run,index)=>{
    const action=index===0?definition.otherwise:definition.match;
    assert.equal(run.jobStatus,'queued');
    assert.equal(run.scheduledFor-run.createdAt,action.delayMinutes*60_000);
    return {id:run.jobId,body:action.body};
  });
  assert.deepEqual(await history(other),[]);
  const jobIds=branchJobs.map(job=>job.id);
  assert.equal(new Set(jobIds).size,2);
  const authors=await sql`SELECT j.id,j.workspace_id,j.kind,a.email AS actor,o.email AS owner FROM portable_jobs j
    JOIN login_identities a ON a.id=j.actor_id JOIN login_identities o ON o.id=j.authorized_owner_id
    WHERE j.id=ANY(${jobIds}::uuid[])`;
  assert.deepEqual(jobIds.map(jobId=>{
    const job=authors.find(item=>item.id===jobId);
    return [job.workspace_id,job.kind,job.actor,job.owner];
  }),[[sharing.workspaceId,'note',owner.email,owner.email],[sharing.workspaceId,'note',editor.email,owner.email]]);

  await one();
  assert.ok((await history()).every(run=>run.jobStatus==='queued'));
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${jobIds}::uuid[])`;
  for(let attempt=0;attempt<3;attempt++)await one();
  const completed=await history();
  assert.equal(completed.length,2);
  assert.ok(completed.every(run=>run.jobStatus==='succeeded'&&run.attempts===1));
  const notes=await sql`SELECT job_id AS id,body FROM portable_notes WHERE job_id=ANY(${jobIds}::uuid[]) ORDER BY job_id`;
  assert.deepEqual(Array.from(notes),branchJobs.toSorted((a,b)=>a.id.localeCompare(b.id)));

  assert.equal((await toggle(2,false)).status,200);
  await saved(await post(crm,edit(lifecycleEdited,owner.id)),200);
  assert.deepEqual(await history(),completed);
  sharing.contactOwnerBranch={id,definition,branchJobs};
  await resetBudgets();
}
