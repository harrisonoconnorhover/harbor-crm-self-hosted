import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {launchFault} from './portable-jobs-fixture.mjs';

const endpoint='/api/workflows';
const post=(request,origin,headers,body,path=endpoint)=>request(path,{
  method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body),
});
const worker=env=>execFileSync(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
  env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
});
const status=async (request,headers,id)=>{
  let cursor=null;
  do{
    const path=cursor?endpoint+'?'+new URLSearchParams(cursor):endpoint;
    const response=await request(path,{headers});
    assert.equal(response.status,200,await response.clone().text());
    const page=await response.json();
    const run=page.runs.find(run=>run.id===id);
    if(run)return run;
    cursor=page.next;
  }while(cursor);
};

async function verifyRunFilter({request,origin,headers,other,sql,sharing,runWorkflowId,contact,queued}){
  const {workspaceId,workflowId:otherWorkflowId}=sharing;
  const matching=Array.from({length:26},()=>randomUUID()).sort().reverse();
  const [automaticId,...manualIds]=matching;
  const automaticDecoys=Array.from({length:26},()=>randomUUID());
  const manualDecoys=Array.from({length:26},()=>randomUUID());
  const stamp=queued.createdAt+1;
  const filter=new URLSearchParams({runWorkflowId});
  const read=(query=filter,auth=headers)=>request(endpoint+'?'+query,{headers:auth});
  try{
    // Recent runs on other workflows fill each source's SQL limit unless it filters first.
    await sql`INSERT INTO contact_events(workspace_id,contact_id,revision,actor_id,data,occurred_at)
      SELECT workspace_id,contact_id,extra.revision,actor_id,data,occurred_at FROM contact_events
      CROSS JOIN generate_series(1001,1026) AS extra(revision)
      WHERE workspace_id=${workspaceId} AND contact_id=${contact.id} AND contact_events.revision=${contact.revision}`;
    await sql`INSERT INTO portable_workflow_runs(workspace_id,id,workflow_id,workflow_revision,workflow_name,contact_id,contact_revision,issue,created_at)
      VALUES (${workspaceId},${automaticId},${runWorkflowId},1,'Historical automatic run',${contact.id},${contact.revision},'queue_full',${stamp})`;
    await sql`INSERT INTO portable_workflow_runs(workspace_id,id,workflow_id,workflow_revision,workflow_name,contact_id,contact_revision,issue,created_at)
      SELECT ${workspaceId},runs.id,${otherWorkflowId},1,${queued.workflowName},${contact.id},1000+runs.position,'queue_full',${stamp+1}
      FROM unnest(${automaticDecoys}::uuid[]) WITH ORDINALITY AS runs(id,position)`;
    for(const [ids,workflowId,at] of [[manualIds,runWorkflowId,stamp],[manualDecoys,otherWorkflowId,stamp+1]]){
      await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at,status)
        SELECT w.id,runs.id,${contact.id},w.owner_id,'note','Run filter fixture',${at},${at},${at},'skipped'
        FROM private_workspaces w CROSS JOIN unnest(${ids}::uuid[]) AS runs(id) WHERE w.id=${workspaceId}`;
      await sql`INSERT INTO portable_manual_workflow_runs(workspace_id,id,workflow_id,workflow_revision,workflow_name,contact_id,contact_revision,created_at)
        SELECT ${workspaceId},runs.id,${workflowId},1,${queued.workflowName},${contact.id},${contact.revision},${at}
        FROM unnest(${ids}::uuid[]) AS runs(id)`;
    }
    const first=await read();
    assert.equal(first.status,200,await first.clone().text());
    const {runs,next,workflows}=await first.json();
    assert.deepEqual(runs.map(run=>run.id),matching.slice(0,25));
    assert.equal(runs[0].manual,false);
    assert.ok(runs.slice(1).every(run=>run.manual));
    assert.deepEqual(next,{at:stamp,id:matching.at(-2)});
    assert.ok(workflows.some(({id})=>id===otherWorkflowId),'Filtering runs keeps the workflow catalog intact.');
    const older=await (await read(new URLSearchParams({runWorkflowId,...next}))).json();
    assert.deepEqual(older.runs.map(run=>run.id),[matching.at(-1),queued.id]);
    assert.equal(older.next,null);
    assert.deepEqual((await (await read(filter,other)).json()).runs,[]);
    for(const query of ['runWorkflowId=invalid',filter+'&runWorkflowId='+runWorkflowId,filter+'&at='+stamp]){
      assert.equal((await read(query)).status,400);
    }
    const latest='/?'+new URLSearchParams({view:'workflows',runWorkflowId});
    const page=await request(latest,{headers});
    assert.equal(page.status,200);
    const html=(await page.text()).replaceAll('&amp;','&');
    assert.match(html,new RegExp(`<option value="${runWorkflowId}" selected="">`));
    assert.match(html,/Historical automatic run/);
    assert.ok(html.includes(`href="${latest}">Latest runs`));
    const link=html.match(/href="([^"]+)">Older runs/)?.[1];
    assert.ok(link);
    assert.deepEqual(Object.fromEntries(new URL(link,origin).searchParams),
      {view:'workflows',runWorkflowId,afterAt:String(next.at),afterId:next.id});
    const bookmark=await request(link,{headers:{},redirect:'manual'});
    assert.equal(bookmark.status,307);
    const returnTo=new URL(bookmark.headers.get('location'),origin).searchParams.get('return_to');
    assert.deepEqual(Object.fromEntries(new URL(returnTo,origin).searchParams),Object.fromEntries(new URL(link,origin).searchParams));
  }finally{
    await sql`DELETE FROM portable_manual_workflow_runs WHERE workspace_id=${workspaceId} AND id=ANY(${[...manualIds,...manualDecoys]}::uuid[])`;
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=ANY(${[...manualIds,...manualDecoys]}::uuid[])`;
    await sql`DELETE FROM portable_workflow_runs WHERE workspace_id=${workspaceId} AND id=ANY(${[automaticId,...automaticDecoys]}::uuid[])`;
    await sql`DELETE FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${contact.id} AND revision BETWEEN 1001 AND 1026`;
  }
}

export async function verifyPortableManualWorkflow({request,origin,headers,other,otherRecord,sql,env,sharing}){
  const id=randomUUID();
  const definition={name:'Fictional manual contact follow-up',trigger:'manual_contact',actionKind:'note',
    delayMinutes:10,body:'Fictional Note from a manually selected contact workflow'};
  const send=(body,auth=headers,site=origin,path=endpoint)=>post(request,site,auth,body,path);
  const runId=randomUUID();
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_write','api_read') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const contactResponse=await send({action:'save',kind:'contacts',data:{name:'Fictional workflow contact',lifecycle:'Lead'}},
    headers,origin,'/api/crm');
  assert.equal(contactResponse.status,201);
  const contact=(await contactResponse.json()).record;
  const input={action:'runContact',id:runId,workflowId:id,workflowRevision:2,contactId:contact.id};
  assert.equal((await send(input,{})).status,401);
  assert.equal((await send(input,headers,'https://outside.example.test')).status,403);
  assert.equal((await send({action:'save',id,revision:0,definition:{...definition,actionKind:'gmail'}})).status,400);
  assert.equal((await send({action:'save',id,revision:0,definition})).status,200);
  assert.equal((await send({...input,workflowRevision:1})).status,409);
  assert.equal((await send({action:'setEnabled',id,revision:1,enabled:true})).status,200);
  assert.equal((await send({...input,workflowRevision:1})).status,409);
  assert.equal((await send({...input,workflowId:sharing.workflowId})).status,409);
  assert.equal((await send(input,other)).status,404);
  assert.equal((await send(input,other,origin,endpoint+'?workspaceId='+sharing.workspaceId)).status,403);
  assert.equal((await send({...input,contactId:otherRecord.id})).status,404);
  assert.equal((await send({...input,contactId:undefined})).status,400);
  assert.equal((await send({action:'save',id,revision:2,definition:{name:definition.name,trigger:'contact_lifecycle',
    lifecycle:'Customer',delayMinutes:0,body:definition.body}})).status,409);
  assert.equal((await status(request,headers,runId)),undefined);

  const duplicates=await Promise.all([send(input),send({...input,id:input.id.toUpperCase()})]);
  assert.deepEqual(duplicates.map(response=>response.status).sort(),[200,201]);
  const receipts=await Promise.all(duplicates.map(response=>response.json()));
  assert.deepEqual(receipts[0],receipts[1]);
  const receipt=receipts[0];
  assert.equal(receipt.run.id,runId);
  assert.equal(receipt.run.jobId,runId);
  assert.equal(receipt.run.workflowRevision,2);
  assert.equal(receipt.run.contactRevision,contact.revision);
  assert.equal((await send({...input,id:randomUUID()})).status,409);
  assert.equal((await send({...input,contactId:otherRecord.id})).status,409);
  const queued=await status(request,headers,runId);
  assert.equal(queued.manual,true);
  assert.equal(queued.contactName,contact.data.name);
  assert.equal(queued.jobStatus,'queued');
  assert.equal(queued.scheduledFor-queued.createdAt,600_000);
  assert.equal(await status(request,other,runId),undefined);
  await verifyRunFilter({request,origin,headers,other,sql,sharing,runWorkflowId:id,contact,queued});
  const page=await request('/?view=workflows',{headers});
  assert.match((await page.text()).replaceAll('<!-- -->',''),/Fictional manual contact follow-up[\s\S]+Manual · Queued/);

  const renamed=await send({action:'save',kind:'contacts',id:contact.id,expectedRevision:contact.revision,
    data:{...contact.data,name:'Fictional renamed workflow contact',lifecycle:'Customer'}},headers,origin,'/api/crm');
  assert.equal(renamed.status,200);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_manual_workflow_runs WHERE contact_id=${contact.id}`)[0].count,1);
  assert.equal((await status(request,headers,runId)).contactName,contact.data.name);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${runId}`;
  const abandoned=await launchFault(env,`
    const claim=await worker.claimPortableJob(worker.portableDb());
    process.send(claim);
    setInterval(()=>{},1000);
  `);
  assert.equal(abandoned.id,runId);
  assert.equal((await status(request,headers,runId)).jobStatus,'running');
  await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${runId}`;
  worker(env);
  assert.equal((await status(request,headers,runId)).jobIssue,'lease_expired');
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${runId}`;
  worker(env);
  worker(env);
  const completed=await status(request,headers,runId);
  assert.deepEqual([completed.jobStatus,completed.attempts],['succeeded',2]);
  assert.deepEqual(Array.from(await sql`SELECT body FROM portable_notes WHERE job_id=${runId}`),[{body:definition.body}]);
  assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${runId} ORDER BY number`).map(row=>row.outcome),
    ['lease_expired','succeeded']);
  assert.deepEqual(await (await send(input)).json(),receipt);

  const caps=Array.from({length:100},()=>randomUUID());
  const queuedForRestore={...input,id:randomUUID()};
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT ${sharing.workspaceId},ids.id,${contact.id},identities.id,'note','Fictional queue cap',0,9999999999999,0
    FROM unnest(${caps}::uuid[]) AS ids(id) CROSS JOIN login_identities identities WHERE email='owner@example.test'`;
  try{
    assert.equal((await send(queuedForRestore)).status,409);
    assert.equal(await status(request,headers,queuedForRestore.id),undefined);
  }finally{await sql`DELETE FROM portable_jobs WHERE id=ANY(${caps}::uuid[])`;}
  const queuedResponse=await send(queuedForRestore);
  assert.equal(queuedResponse.status,201);
  const queuedReceipt=await queuedResponse.json();
  const sequence=await verifyNoteSequence({request,origin,headers,other,sql,env,send,contact,workspaceId:sharing.workspaceId});
  const branch=await verifyNoteBranch({request,headers,other,otherRecord,sql,env,send,workspaceId:sharing.workspaceId});
  return {input,completed,receipt,queuedForRestore,queuedReceipt,body:definition.body,sequence,branch};
}

async function verifyNoteSequence({request,origin,headers,other,sql,env,send,contact,workspaceId}){
  const id=randomUUID(),runId=randomUUID();
  const steps=[
    {id:randomUUID(),name:'Start the review',body:'Fictional sequence first Note',delayMinutes:0},
    {id:randomUUID(),name:'Check the review',body:'Fictional sequence delayed Note',delayMinutes:9},
    {id:randomUUID(),name:'Close the review',body:'Fictional sequence final Note',delayMinutes:0},
  ];
  const definition={name:'Fictional review sequence',trigger:'manual_contact',actionKind:'note_sequence',steps};
  const save={action:'save',id,revision:0,definition};
  const activate={action:'setEnabled',id,revision:1,enabled:true};
  const input={action:'runContact',id:runId,workflowId:id,workflowRevision:2,contactId:contact.id};
  const jobRoute='/api/background-jobs?recordId='+contact.id;
  const getRun=()=>status(request,headers,runId);
  assert.equal((await send({...save,definition:{...definition,steps:[steps[0],steps[0]]}})).status,400);
  assert.equal((await send(save)).status,200);
  assert.equal((await send(activate)).status,200);
  assert.equal((await send({action:'runContactBatch',id:randomUUID(),workflowId:id,workflowRevision:2,
    contactIds:[contact.id,randomUUID()]})).status,409);
  assert.equal((await send(input,other)).status,404);
  const submissions=await Promise.all([send(input),send(input)]);
  assert.deepEqual(submissions.map(result=>result.status).sort(),[200,201]);
  const [receipt,replayed]=await Promise.all(submissions.map(result=>result.json()));
  assert.deepEqual(replayed,receipt);
  assert.equal((await send({...input,workflowRevision:1})).status,409);
  const initial=await getRun();
  assert.deepEqual(initial.sequence.map(step=>[step.id,step.status,step.jobId]),[
    [steps[0].id,'queued',runId],[steps[1].id,null,null],[steps[2].id,null,null],
  ]);
  assert.equal(await status(request,other,runId),undefined);

  // If successor insertion fails, the Note and success receipt must both roll back.
  await sql`ALTER TABLE portable_jobs ADD CONSTRAINT fixture_sequence_successor_failure
    CHECK (body<>'Fictional sequence delayed Note') NOT VALID`;
  try{
    worker(env);
    const failed=await getRun();
    assert.equal(failed.sequence[0].issue,'processor_error');
    assert.equal(failed.sequence[1].jobId,null);
    assert.equal((await sql`SELECT 1 FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=${runId}`).length,0);
  }finally{await sql`ALTER TABLE portable_jobs DROP CONSTRAINT fixture_sequence_successor_failure`;}
  await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${runId}`;
  const claim=await launchFault(env,`
    const claim=await worker.claimPortableJob(worker.portableDb());
    process.send({id:claim.id});
    setInterval(()=>{},1000);
  `);
  assert.equal(claim.id,runId);
  await sql`UPDATE portable_jobs SET lease_until=0 WHERE workspace_id=${workspaceId} AND id=${runId}`;
  worker(env);
  assert.equal((await getRun()).sequence[0].issue,'lease_expired');
  await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${runId}`;
  worker(env);
  worker(env); // A restarted poll cannot claim the delayed second step yet.
  const waiting=await getRun(),[first,second,third]=waiting.sequence;
  assert.equal(waiting.jobStatus,'queued');
  assert.equal(first.status,'succeeded');
  assert.equal(first.attempts,3);
  assert.deepEqual([second.status,second.attempts,third.jobId],['queued',0,null]);
  assert.equal(second.scheduledFor-first.finishedAt,9*60_000);
  const historyPage=await request('/?view=workflows',{headers});
  assert.equal(historyPage.status,200);
  const historyHtml=await historyPage.text();
  for(const step of [first,second]){
    assert.ok(historyHtml.includes('/?view=job-queue&amp;jobId='+step.jobId+'">View step job</a>'));
  }
  assert.ok(historyHtml.includes('/?view=job-queue&amp;jobId='+second.jobId+'">View job</a>'));
  assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE workspace_id=${workspaceId} AND job_id=${runId}
    ORDER BY number`).map(row=>row.outcome),['processor_error','lease_expired','succeeded']);
  assert.equal((await send({...input,id:randomUUID()})).status,409,'Run is pending beyond first job');
  assert.equal((await sql`SELECT 1 FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=${second.jobId}`).length,0);

  const differentContactResponse=await send({action:'save',kind:'contacts',data:{name:'Fictional stopped sequence contact'}},headers,origin,'/api/crm');
  assert.equal(differentContactResponse.status,201);
  const {record:differentContact}=await differentContactResponse.json();
  const failedRun={...input,id:randomUUID(),contactId:differentContact.id};
  assert.equal((await send(failedRun)).status,201);
  await sql`UPDATE portable_jobs SET status='failed',attempts=5,issue='processor_error',finished_at=created_at
    WHERE workspace_id=${workspaceId} AND id=${failedRun.id}`;
  const otherJobRoute='/api/background-jobs?recordId='+differentContact.id;
  assert.equal((await send({action:'retryNote',id:failedRun.id},headers,origin,otherJobRoute)).status,409);
  assert.equal((await status(request,headers,failedRun.id)).sequence[1].jobId,null);
  const cancelledRun={...failedRun,id:randomUUID()};
  assert.equal((await send(cancelledRun)).status,201);
  assert.equal((await send({action:'cancelNote',id:cancelledRun.id},headers,origin,otherJobRoute)).status,200);
  const stopped=await status(request,headers,cancelledRun.id);
  assert.deepEqual(stopped.sequence.map(step=>step.status),['skipped',null,null]);
  assert.equal((await send({action:'retryNote',id:runId},headers,origin,jobRoute)).status,409);

  const edited={...definition,steps:steps.map(step=>({...step,body:'Fictional updated definition'}))};
  assert.equal((await send({...save,revision:2,definition:edited})).status,200);
  assert.equal((await send({...activate,revision:3,enabled:false})).status,200);
  assert.deepEqual(await (await send(input)).json(),receipt);
  assert.equal((await send({...input,id:randomUUID(),workflowRevision:4})).status,409);
  const page=(await (await request('/?view=workflows',{headers})).text()).replaceAll('<!-- -->','');
  assert.match(page,/Fictional review sequence[\s\S]+Start the review[\s\S]+Check the review[\s\S]+Waiting for earlier Notes/);
  assert.match(page,/Fictional stopped sequence contact<\/a> · Manual · Cancelled/);
  const planned=await sql`SELECT planned_job_id FROM portable_manual_workflow_run_actions
    WHERE workspace_id=${workspaceId} AND run_id=${runId} ORDER BY position`;
  return {input,receipt,waiting,steps,jobIds:planned.map(row=>row.planned_job_id)};
}

async function verifyNoteBranch({request,headers,other,otherRecord,sql,env,send,workspaceId}){
  const id=randomUUID();
  const definition={name:'Fictional lifecycle branch',trigger:'manual_contact',actionKind:'note_branch',lifecycle:'Customer',
    match:{body:'Fictional customer path Note',delayMinutes:6},otherwise:{body:'Fictional other path Note',delayMinutes:13}};
  const save={action:'save',id,revision:0,definition};
  const contact=async lifecycle=>{
    const response=await send({action:'save',kind:'contacts',data:{name:'Fictional branch '+lifecycle,lifecycle}},
      headers,undefined,'/api/crm');
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_write','api_read') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const customer=await contact('Customer'),lead=await contact('Lead');
  assert.equal((await send({...save,definition:{...definition,lifecycle:'Not a lifecycle stage'}})).status,400);
  assert.equal((await send(save)).status,200);
  assert.equal((await send({action:'setEnabled',id,revision:1,enabled:true})).status,200);
  assert.equal((await send({action:'runContactBatch',id:randomUUID(),workflowId:id,workflowRevision:2,
    contactIds:[customer.id,lead.id]})).status,409);

  const cases=[];
  for(const [target,path,label,newLifecycle,retryRequired] of [
    [customer,definition.match,'Lifecycle matches','Lead',true],
    [lead,definition.otherwise,'Otherwise','Customer',false],
  ]){
    const input={action:'runContact',id:randomUUID(),workflowId:id,workflowRevision:2,contactId:target.id};
    assert.equal((await send({...input,workflowRevision:1})).status,409);
    assert.equal((await send({...input,contactId:otherRecord.id})).status,404);
    assert.equal((await send(input,other)).status,404);
    const first=await send(input);
    assert.equal(first.status,201,await first.clone().text());
    const receipt=await first.json();
    const queued=await status(request,headers,input.id);
    assert.equal(queued.contactRevision,target.revision);
    assert.equal(queued.jobKind,'note');
    assert.deepEqual(queued.sequence.map(step=>[step.name,step.status,step.jobId]),[[label,'queued',input.id]]);
    assert.equal(queued.scheduledFor-queued.createdAt,path.delayMinutes*60_000);
    assert.equal(await status(request,other,input.id),undefined);

    const edited=await send({action:'save',kind:'contacts',id:target.id,expectedRevision:target.revision,
      data:{...target.data,lifecycle:newLifecycle}},headers,undefined,'/api/crm');
    assert.equal(edited.status,200,await edited.clone().text());
    const replay=await send(input);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),receipt);
    assert.deepEqual(await status(request,headers,input.id),queued);

    if(retryRequired){
      await sql`UPDATE portable_jobs SET status='failed',attempts=5,issue='processor_error',finished_at=created_at
        WHERE workspace_id=${workspaceId} AND id=${input.id}`;
      await sql`INSERT INTO portable_job_attempts ${sql(Array.from({length:5},(_,index)=>({
        workspace_id:workspaceId,job_id:input.id,number:index+1,started_at:queued.createdAt,ended_at:queued.createdAt,
        outcome:'processor_error',
      })))}`;
      const retryPath='/api/background-jobs?recordId='+target.id;
      const retry=await send({action:'retryNote',id:input.id},headers,undefined,retryPath);
      assert.equal(retry.status,202,await retry.clone().text());
      assert.deepEqual(await retry.json(),{id:input.id,result:'queued'});
      const retried=await status(request,headers,input.id);
      assert.deepEqual(retried.sequence.map(step=>[step.name,step.status,step.attempts]),[[label,'queued',5]]);
    }else{
      await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${input.id}`;
    }
    worker(env);
    worker(env);
    const completed=await status(request,headers,input.id);
    assert.deepEqual(completed.sequence.map(step=>[step.name,step.status,step.attempts]),[[label,'succeeded',retryRequired?6:1]]);
    if(retryRequired){
      const attempts=await sql`SELECT number,outcome FROM portable_job_attempts
        WHERE workspace_id=${workspaceId} AND job_id=${input.id} ORDER BY number`;
      assert.deepEqual(attempts.map(attempt=>[attempt.number,attempt.outcome]),[
        ...Array.from({length:5},(_,index)=>[index+1,'processor_error']),[6,'succeeded'],
      ]);
    }
    assert.deepEqual(Array.from(await sql`SELECT body FROM portable_notes WHERE workspace_id=${workspaceId}
      AND job_id=${input.id}`),[{body:path.body}]);
    assert.equal((await sql`SELECT 1 FROM portable_scheduled_gmail WHERE workspace_id=${workspaceId}
      AND job_id=${input.id}`).length,0);
    assert.equal((await sql`SELECT 1 FROM portable_code_jobs WHERE workspace_id=${workspaceId}
      AND job_id=${input.id}`).length,0);
    assert.deepEqual(await (await send(input)).json(),receipt);
    cases.push({input,receipt,completed,body:path.body});
  }
  return cases;
}

export async function verifyRestoredManualWorkflow({request,origin,owner,other,targetSql,targetEnv,sourceSql,manual}){
  const {input,completed,receipt,queuedForRestore,queuedReceipt,body}=manual;
  assert.deepEqual(await status(request,owner,input.id),completed);
  assert.deepEqual(await (await post(request,origin,owner,input)).json(),receipt);
  assert.equal(await status(request,other,input.id),undefined);
  assert.equal((await status(request,owner,queuedForRestore.id)).jobStatus,'queued');
  assert.deepEqual(await (await post(request,origin,owner,queuedForRestore)).json(),queuedReceipt);
  const fresh=await post(request,origin,owner,{...queuedForRestore,id:randomUUID()});
  assert.equal(fresh.status,409,'Restored workflow activation stays off');
  await targetSql`UPDATE portable_jobs SET available_at=0 WHERE id=${queuedForRestore.id}`;
  worker(targetEnv);
  worker(targetEnv);
  assert.equal((await status(request,owner,queuedForRestore.id)).jobStatus,'succeeded');
  assert.deepEqual(Array.from(await targetSql`SELECT body FROM portable_notes WHERE job_id=${queuedForRestore.id}`),[{body}]);
  assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${input.id}`)[0].count,1);
  assert.equal((await sourceSql`SELECT status FROM portable_jobs WHERE id=${queuedForRestore.id}`)[0].status,'queued');
  for(const branch of manual.branch){
    assert.deepEqual(await status(request,owner,branch.input.id),branch.completed);
    assert.equal(await status(request,other,branch.input.id),undefined);
    assert.deepEqual(await (await post(request,origin,owner,branch.input)).json(),branch.receipt);
    assert.deepEqual(Array.from(await targetSql`SELECT body FROM portable_notes WHERE job_id=${branch.input.id}`),
      [{body:branch.body}]);
  }
  const sequence=manual.sequence;
  assert.deepEqual(await status(request,owner,sequence.input.id),sequence.waiting);
  assert.deepEqual(await (await post(request,origin,owner,sequence.input)).json(),sequence.receipt);
  assert.equal(await status(request,other,sequence.input.id),undefined);
  const secondId=sequence.waiting.sequence[1].jobId;
  await targetSql`UPDATE portable_jobs SET available_at=0 WHERE id=${secondId}`;
  worker(targetEnv);
  worker(targetEnv);
  worker(targetEnv);
  const finished=await status(request,owner,sequence.input.id);
  assert.equal(finished.jobStatus,'succeeded');
  assert.deepEqual(finished.sequence.map(step=>step.status),['succeeded','succeeded','succeeded']);
  assert.deepEqual(finished.sequence.map(step=>step.id),sequence.steps.map(step=>step.id));
  assert.deepEqual(finished.sequence.map(step=>step.jobId),sequence.jobIds);
  const receipts=await targetSql`SELECT n.body FROM portable_manual_workflow_run_actions a
    JOIN portable_notes n ON n.workspace_id=a.workspace_id AND n.job_id=a.job_id
    WHERE a.run_id=${sequence.input.id} ORDER BY a.position`;
  assert.deepEqual(receipts.map(row=>row.body),sequence.steps.map(step=>step.body));
  assert.equal((await sourceSql`SELECT status FROM portable_jobs WHERE id=${secondId}`)[0].status,'queued');

}
