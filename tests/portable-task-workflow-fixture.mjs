import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {launchFault} from './portable-jobs-fixture.mjs';

const endpoint='/api/workflows';
const worker=env=>execFileSync(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
  env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
});
const post=(request,origin,headers,body,path=endpoint)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});

export async function verifyPortableTaskWorkflow({request,origin,headers,other,otherRecord,sql,env,sharing}){
  const send=(body,auth=headers,site=origin,path=endpoint)=>post(request,site,auth,body,path);
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_write','api_read') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const created=await send({action:'save',kind:'contacts',data:{name:'Fictional Task workflow Contact'}},headers,origin,'/api/crm');
  assert.equal(created.status,201);
  const contact=(await created.json()).record;
  const workflowId=randomUUID();
  const definition={name:'Fictional delayed Task',trigger:'manual_contact',actionKind:'task',delayMinutes:1440,
    task:{name:'Fictional proposal follow-up',taskType:'Call',priority:'High',dueDate:'2026-12-01',notes:'Review fictional proposal'}};
  assert.equal((await send({action:'save',id:workflowId,revision:0,definition:{...definition,task:{...definition.task,status:'Completed'}}})).status,400);
  assert.equal((await send({action:'save',id:workflowId,revision:0,definition})).status,200);
  const input={action:'runContact',id:randomUUID(),workflowId,workflowRevision:2,contactId:contact.id};
  assert.equal((await send(input)).status,409);
  assert.equal((await send({action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
  assert.equal((await send(input,{})).status,401);
  assert.equal((await send(input,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(input,other)).status,404);
  assert.equal((await send({...input,contactId:otherRecord.id})).status,404);
  const replies=await Promise.all([send(input),send({...input,id:input.id.toUpperCase()})]);
  assert.deepEqual(replies.map(response=>response.status).sort(),[200,201]);
  const [receipt,repeated]=await Promise.all(replies.map(response=>response.json()));
  assert.deepEqual(receipt,repeated);
  const [job]=await sql`SELECT kind,status,(scheduled_for-created_at)::float8 AS delay FROM portable_jobs WHERE id=${input.id}`;
  assert.deepEqual({...job},{kind:'task',status:'queued',delay:86_400_000});
  worker(env);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${input.id}`)[0].n,0);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${input.id}`;
  const claim=await launchFault(env,'const claim=await worker.claimPortableJob(worker.portableDb());process.send(claim);setInterval(()=>{},1000);');
  assert.equal(claim.id,input.id);
  await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${input.id}`;
  worker(env);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${input.id}`;
  worker(env);
  worker(env);
  const readTask=(id,auth=headers)=>request('/api/crm?'+new URLSearchParams({kind:'tasks',id}),{headers:auth});
  const task=await readTask(input.id);
  assert.equal(task.status,200);
  const record=await task.json();
  assert.equal(record.contactId,contact.id);
  assert.equal(record.assigneeId,claim.actorId);
  assert.deepEqual(record.data,{...definition.task,status:'Not started'});
  assert.equal((await readTask(input.id,other)).status,404);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_task_events WHERE task_id=${input.id}`)[0].n,1);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_notes WHERE job_id=${input.id}`)[0].n,0);
  assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${input.id} ORDER BY number`).map(row=>row.outcome),['lease_expired','succeeded']);
  assert.deepEqual(await (await send(input)).json(),receipt);
  const page=await request('/?view=workflows',{headers});
  assert.match((await page.text()).replaceAll('<!-- -->',''),/Open created Task/);
  const jobDetail='/?view=job-queue&jobId='+input.id;
  const taskLink='/?kind=tasks&record='+input.id;
  const completedJob=await request(jobDetail,{headers});
  assert.equal(completedJob.status,200);
  assert.ok((await completedJob.text()).includes('href="'+taskLink.replace('&','&amp;')+'">Open created Task'));
  assert.equal((await request(taskLink,{headers})).status,200);
  assert.equal((await request(jobDetail,{headers:other})).status,404);

  const cancelled={...input,id:randomUUID()};
  assert.equal((await send(cancelled)).status,201);
  const cancelPath='/api/background-jobs?recordId='+contact.id;
  assert.equal((await send({action:'cancelTask',id:cancelled.id},other,origin,cancelPath)).status,404);
  assert.equal((await send({action:'cancelTask',id:cancelled.id},headers,origin,cancelPath)).status,200);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${cancelled.id}`;
  worker(env);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${cancelled.id}`)[0].n,0);

  const rollback={...input,id:randomUUID()};
  assert.equal((await send(rollback)).status,201);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${rollback.id}`;
  await sql.unsafe(`ALTER TABLE portable_task_events ADD CONSTRAINT fixture_task_creation_failure CHECK (task_id <> '${rollback.id}'::uuid) NOT VALID`);
  try{
    for(let attempt=1;attempt<=5;attempt++){
      await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${rollback.id}`;
      worker(env);
    }
    assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${rollback.id}`)[0].n,0);
    const [failure]=await sql`SELECT status,attempts,issue FROM portable_jobs WHERE id=${rollback.id}`;
    assert.deepEqual({...failure},{status:'failed',attempts:5,issue:'processor_error'});
  }finally{await sql`ALTER TABLE portable_task_events DROP CONSTRAINT fixture_task_creation_failure`;}
  const failedJob=await request('/?view=job-queue&jobId='+rollback.id,{headers});
  assert.equal(failedJob.status,200);
  assert.match(await failedJob.text(),/>Retry Task<\/button>/);
  const retry={action:'retryTask',id:rollback.id};
  assert.equal((await send(retry,other,origin,cancelPath)).status,404);
  assert.equal((await send({...retry,action:'retryNote'},headers,origin,cancelPath)).status,409);
  assert.equal((await send({...retry,id:input.id},headers,origin,cancelPath)).status,409);
  const retries=await Promise.all([send(retry,headers,origin,cancelPath),send(retry,headers,origin,cancelPath)]);
  assert.ok(retries.every(reply=>reply.status===202));
  assert.deepEqual((await Promise.all(retries.map(reply=>reply.json()))).map(body=>body.result).sort(),['already','queued']);
  const committed=await launchFault(env,`const claim=await worker.claimPortableJob(worker.portableDb());
    if(claim.id!==${JSON.stringify(rollback.id)})throw Error('Unexpected claim');
    await worker.finishTask(worker.portableDb(),claim);process.send({id:claim.id});setInterval(()=>{},1000);`);
  assert.equal(committed.id,rollback.id);
  worker(env);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_tasks WHERE id=${rollback.id}`)[0].n,1);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_task_events WHERE task_id=${rollback.id}`)[0].n,1);
  const after=await send(retry,headers,origin,cancelPath);
  assert.equal(after.status,202);
  assert.equal((await after.json()).result,'already');
  assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${rollback.id} ORDER BY number`)
    .map(row=>row.outcome),[...Array(5).fill('processor_error'),'succeeded']);

  const pending={...input,id:randomUUID()};
  assert.equal((await send(pending)).status,201);
  const edited={...definition,task:{...definition.task,name:'Later workflow version'}};
  assert.equal((await send({action:'save',id:workflowId,revision:2,definition:edited})).status,200);
  const [payload]=await sql`SELECT payload FROM portable_task_jobs WHERE job_id=${pending.id}`;
  assert.deepEqual(payload.payload,definition.task);
  const automatic=await verifyAutomaticTaskWorkflow({request,send,origin,headers,other,sql,env,sharing});
  return {completedId:input.id,pendingId:pending.id,contactId:contact.id,task:definition.task,automatic};
}

async function verifyAutomaticTaskWorkflow({request,send,origin,headers,other,sql,env,sharing}){
  const [workspace]=await sql`SELECT w.owner_id,v.viewer_id FROM private_workspaces w
    JOIN portable_workspace_viewers v ON v.workspace_id=w.id WHERE w.id=${sharing.workspaceId} AND v.id=${sharing.grantId}`;
  const creationId=randomUUID(),assignmentId=randomUUID();
  const task={name:'Review the new Contact',taskType:'To-do',priority:'Medium'};
  const definition={name:'Fictional automatic creation Task',trigger:'contact_created',actionKind:'task',delayMinutes:1440,task};
  const assignment={...definition,name:'Fictional automatic assignment Task',trigger:'contact_owner_assigned',
    task:{...task,name:'Review the Contact handoff'}};
  const toggle=(id,revision,enabled)=>send({action:'setEnabled',id,revision,enabled});
  for(const [id,rule] of [[creationId,definition],[assignmentId,assignment]]){
    assert.equal((await send({action:'save',id,revision:0,definition:rule})).status,200);
    assert.equal((await toggle(id,1,true)).status,200);
  }

  const crm='/api/crm',shared=crm+'?'+new URLSearchParams({workspaceId:sharing.workspaceId,grantId:sharing.grantId});
  const first=await send({action:'save',kind:'contacts',data:{name:'Fictional automatic follow-up'},
    assigneeId:workspace.owner_id},headers,origin,crm);
  assert.equal(first.status,201,await first.clone().text());
  const contact=(await first.json()).record;
  const edit={action:'save',kind:'contacts',id:contact.id,expectedRevision:contact.revision,
    data:{name:contact.data.name},assigneeId:workspace.viewer_id};
  assert.equal((await send(edit,other,origin,crm)).status,404);
  const saved=await send(edit,other,origin,shared);
  assert.equal(saved.status,200,await saved.clone().text());
  const reassigned=(await saved.json()).record;
  assert.equal((await send(edit,other,origin,shared)).status,409);
  assert.equal((await send({...edit,expectedRevision:reassigned.revision},other,origin,shared)).status,200);

  const jobs=await sql`SELECT r.workflow_id,r.contact_revision,r.job_id,j.actor_id,j.authorized_owner_id,j.status,
    (j.scheduled_for-j.created_at)::float8 AS delay,p.payload FROM portable_workflow_runs r
    JOIN portable_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
    JOIN portable_task_jobs p ON p.workspace_id=j.workspace_id AND p.job_id=j.id
    WHERE r.workspace_id=${sharing.workspaceId} AND r.contact_id=${contact.id} ORDER BY r.contact_revision`;
  assert.deepEqual(jobs.map(job=>[job.workflow_id,job.contact_revision,job.actor_id,job.authorized_owner_id,job.status,job.delay,job.payload]),[
    [creationId,contact.revision,workspace.owner_id,workspace.owner_id,'queued',86_400_000,task],
    [assignmentId,reassigned.revision,workspace.viewer_id,workspace.owner_id,'queued',86_400_000,assignment.task],
  ]);
  const [created,pending]=jobs;
  const otherHistory=await request(endpoint,{headers:other});
  assert.equal(otherHistory.status,200);
  assert.ok(!(await otherHistory.json()).runs.some(run=>run.jobId===created.job_id||run.jobId===pending.job_id));
  assert.equal((await toggle(creationId,2,false)).status,200);
  assert.equal((await toggle(assignmentId,2,false)).status,200);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${created.job_id}`;
  worker(env);
  const [result]=await sql`SELECT contact_id,assignee_id,data FROM portable_tasks WHERE id=${created.job_id}`;
  assert.deepEqual({...result},{contact_id:contact.id,assignee_id:workspace.owner_id,data:{...task,dueDate:'',status:'Not started'}});
  return {completedId:created.job_id,pendingId:pending.job_id,contactId:contact.id,task:assignment.task,
    actorId:workspace.viewer_id,assigneeId:workspace.owner_id};
}

export async function verifyRestoredTaskWorkflow({request,headers,other,sql,env,fixture}){
  const path=id=>'/api/crm?'+new URLSearchParams({kind:'tasks',id});
  assert.equal((await request(path(fixture.completedId),{headers})).status,200);
  assert.equal((await request(path(fixture.completedId),{headers:other})).status,404);
  assert.deepEqual((await sql`SELECT payload FROM portable_task_jobs WHERE job_id=${fixture.pendingId}`)[0].payload,fixture.task);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${fixture.pendingId}`;
  worker(env);
  worker(env);
  const response=await request(path(fixture.pendingId),{headers});
  assert.equal(response.status,200);
  const record=await response.json();
  assert.equal(record.contactId,fixture.contactId);
  assert.equal(record.data.name,fixture.task.name);
  assert.equal((await sql`SELECT count(*)::int n FROM portable_task_events WHERE task_id=${fixture.pendingId}`)[0].n,1);

  const automatic=fixture.automatic;
  assert.equal((await request(path(automatic.completedId),{headers})).status,200);
  assert.deepEqual((await sql`SELECT payload FROM portable_task_jobs WHERE job_id=${automatic.pendingId}`)[0].payload,automatic.task);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${automatic.pendingId}`;
  worker(env);
  worker(env);
  const restored=await request(path(automatic.pendingId),{headers});
  assert.equal(restored.status,200);
  const task=await restored.json();
  assert.deepEqual([task.contactId,task.assigneeId,task.data.name],[automatic.contactId,automatic.assigneeId,automatic.task.name]);
  assert.deepEqual(Array.from(await sql`SELECT actor_id FROM portable_task_events WHERE task_id=${automatic.pendingId}`),[{actor_id:automatic.actorId}]);
  assert.equal((await request(path(automatic.pendingId),{headers:other})).status,404);
}
