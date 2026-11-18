import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {launchFault} from './portable-jobs-fixture.mjs';

const path='/api/workflows';
const workerCommand=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const workerCwd=process.env.HARBOR_TEST_PORTABLE_CWD;
const runName='Fictional JavaScript action';
const guestLog='private guest log marker';
const guestError='private guest error marker';
const definition={
  name:runName,trigger:'manual_contact',actionKind:'code',delayMinutes:0,
  inputs:[{name:'contactName',field:'name'}],
  outputs:[{name:'normalized',type:'string'},{name:'length',type:'number'},{name:'isolated',type:'boolean'}],
  code:`console.log(${JSON.stringify(guestLog)});
const normalized = event.inputFields.contactName.trim().toLowerCase();
const isolated = typeof fetch === 'undefined' && typeof process === 'undefined' && typeof require === 'undefined'
  && typeof Date === 'undefined' && typeof performance === 'undefined' && typeof Math.random === 'undefined'
  && typeof Atomics === 'undefined' && typeof SharedArrayBuffer === 'undefined';
return { normalized, length: normalized.length, isolated };`,
};
const post=(request,origin,headers,body,target=path)=>request(target,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const worker=env=>{
  const {status,stdout,stderr,error}=spawnSync(process.execPath,[
    workerCommand,'worker','--once',
  ],{env,cwd:workerCwd,timeout:12_000,encoding:'utf8'});
  assert.equal(status,0,error?.message??stderr);
  assert.doesNotMatch(stdout+stderr,new RegExp(guestLog+'|'+guestError+'|Fictional Code Contact','i'));
};
const page=(request,headers)=>request(path,{headers}).then(response=>response.json());
const state=async(request,headers,id)=>(await page(request,headers)).runs.find(run=>run.id===id);
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

export async function verifyPortableCodeDisabled({request,origin,headers}){
  assert.equal((await post(request,origin,headers,{action:'save',id:randomUUID(),revision:0,definition})).status,403);
}

export async function verifyPortableCodeWorkflow({request,origin,headers,other,foreignContact,sql,env,workspaceId}){
  const send=(body,auth=headers,site=origin,target=path)=>post(request,site,auth,body,target);
  const id=randomUUID(),noteId=randomUUID(),otherNoteId=randomUUID(),runIds=[];
  let contact;
  const initial={action:'save',id,revision:0,definition};
  const runInput=(revision)=>{const runId=randomUUID();runIds.push(runId);
    return {action:'runContact',id:runId,workflowId:id,workflowRevision:revision,contactId:contact.id};};
  const update=(revision,code)=>send({action:'save',id,revision,definition:{...definition,code}});
  await resetBudget(sql);

  try{
    for(const invalid of [{...definition,trigger:'contact_lifecycle',lifecycle:'Customer'},
      {...definition,delayMinutes:1},{...definition,inputs:[{name:'secret',field:'custom:secret'}]},
      {...definition,outputs:[{name:'a',type:'string'},{name:'a',type:'number'}]}]){
      assert.equal((await send({...initial,definition:invalid})).status,400);
    }
    assert.equal((await send(initial,headers,'https://outside.example.test')).status,403);
    assert.equal((await send(initial,other,origin,path+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await send(initial)).status,200);
    assert.equal((await send(initial)).status,200,'Array-valued definitions replay with the same workflow ID.');
    const created=await send({action:'save',kind:'contacts',data:{name:'Fictional Code Contact',email:'not-mapped@example.test'}},
      headers,origin,'/api/crm');
    assert.equal(created.status,201);
    contact=(await created.json()).record;
    const input=runInput(2);
    assert.equal((await send({...input,workflowRevision:1})).status,409);
    assert.equal((await send({action:'setEnabled',id,revision:1,enabled:true})).status,200);
    assert.equal((await send({...input,workflowRevision:1})).status,409);
    assert.equal((await send(input,other)).status,404);
    assert.equal((await send({...input,contactId:foreignContact.id})).status,404);
    assert.equal((await send({action:'runContactBatch',id:randomUUID(),workflowId:id,workflowRevision:2,
      contactIds:[contact.id,foreignContact.id]})).status,409,'JavaScript stays on the single-contact path.');

    const admitted=await Promise.all([send(input),send(input)]);
    assert.deepEqual(admitted.map(response=>response.status).sort(),[200,201]);
    const [receipt,replay]=await Promise.all(admitted.map(response=>response.json()));
    assert.deepEqual(receipt,replay);
    assert.equal(receipt.run.contactRevision,1);
    assert.equal((await send({...input,id:randomUUID()})).status,409);
    const queued=await state(request,headers,input.id);
    assert.deepEqual([queued.jobKind,queued.jobStatus,queued.attempts,queued.codeOutput],['code','queued',0,undefined]);
    assert.equal(queued.scheduledFor,queued.createdAt);
    assert.equal(await state(request,other,input.id),undefined);

    const rename=await send({action:'save',kind:'contacts',id:contact.id,expectedRevision:1,
      data:{...contact.data,name:'Renamed after code admission'}},headers,origin,'/api/crm');
    assert.equal(rename.status,200);
    assert.equal((await update(2,'return { normalized:"Changed script", length:0, isolated:false };')).status,200);
    const [job]=await sql`SELECT kind,body,payload,result FROM portable_jobs j JOIN portable_code_jobs c
      ON c.workspace_id=j.workspace_id AND c.job_id=j.id WHERE j.workspace_id=${workspaceId} AND j.id=${input.id}`;
    assert.deepEqual(job.payload.inputFields,{contactName:'Fictional Code Contact'});
    assert.equal(job.body,'JavaScript action');
    assert.equal(job.result,null);
    const note=await send({id:noteId,body:'Fictional Note while JavaScript is paused',scheduledFor:0},
      headers,origin,'/api/background-jobs?recordId='+contact.id);
    assert.equal(note.status,202);
    worker({...env,HARBOR_PORTABLE_CODE_ENABLED:'false'});
    assert.equal((await sql`SELECT status FROM portable_jobs WHERE id=${noteId}`)[0].status,'succeeded');
    assert.deepEqual([(await state(request,headers,input.id)).jobStatus,(await state(request,headers,input.id)).attempts],['queued',0]);

    const abandoned=await launchFault(env,`
      const claim=await worker.claimPortableJob(worker.portableDb(),{code:true});
      process.send({id:claim.id,kind:claim.kind});
      setInterval(()=>{},1000);
    `);
    assert.deepEqual(abandoned,{id:input.id,kind:'code'});
    await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${input.id}`;
    worker(env);
    assert.equal((await state(request,headers,input.id)).jobIssue,'lease_expired');
    await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${input.id}`;
    worker(env);
    worker(env);
    const completed=await state(request,headers,input.id);
    const expected={normalized:'fictional code contact',length:22,isolated:true};
    assert.deepEqual(completed.codeOutput,expected);
    assert.deepEqual([completed.jobStatus,completed.attempts],['succeeded',2]);
    assert.deepEqual((await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${input.id} ORDER BY number`).map(row=>row.outcome),
      ['lease_expired','succeeded']);
    assert.deepEqual(await (await send(input)).json(),receipt);
    const html=await (await request('/?view=workflows',{headers})).text();
    assert.match(html,/JavaScript outputs/);
    assert.match(html,/fictional code contact/);
    assert.doesNotMatch(html,/not-mapped@example\.test/);

    const retry=runInput(3);
    assert.equal((await send(retry)).status,201);
    await sql`ALTER TABLE portable_code_jobs ADD CONSTRAINT fixture_code_write_fail CHECK (result IS NULL) NOT VALID`;
    try{
      worker(env);
      const failed=await state(request,headers,retry.id);
      assert.deepEqual([failed.jobStatus,failed.jobIssue,failed.codeOutput],['queued','processor_error',undefined]);
      assert.equal((await sql`SELECT result FROM portable_code_jobs WHERE job_id=${retry.id}`)[0].result,null);
    }finally{await sql`ALTER TABLE portable_code_jobs DROP CONSTRAINT fixture_code_write_fail`;}
    await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${retry.id}`;
    worker(env);
    assert.deepEqual((await state(request,headers,retry.id)).codeOutput,{normalized:'Changed script',length:0,isolated:false});

    assert.equal((await update(3,'return { normalized: true, length: 0, isolated: true };')).status,200);
    const mismatch=runInput(4);
    assert.equal((await send(mismatch)).status,201);
    worker(env);
    assert.equal((await state(request,headers,mismatch.id)).jobIssue,'code_output_invalid');
    assert.equal((await state(request,headers,mismatch.id)).codeOutput,undefined);

    assert.equal((await update(4,`throw new Error(${JSON.stringify(guestError)});`)).status,200);
    const broken=runInput(5);
    assert.equal((await send(broken)).status,201);
    worker(env);
    const failure=await state(request,headers,broken.id);
    assert.deepEqual([failure.jobStatus,failure.jobIssue,failure.attempts],['failed','code_action_failed',1]);
    assert.doesNotMatch(JSON.stringify(failure),new RegExp(guestError));
    assert.equal((await update(5,'while(true) {}')).status,200);
    const loop=runInput(6);
    assert.equal((await send(loop)).status,201);
    worker(env);
    assert.equal((await state(request,headers,loop.id)).jobIssue,'code_action_failed');

    const heavyScript=`const keys={};
for (let i=0; i<2000; i++) keys['key'+i]=i;
for (;;) JSON.stringify(keys);`;
    assert.equal((await update(6,heavyScript)).status,200);
    const heavy=runInput(7);
    assert.equal((await send(heavy)).status,201);
    const jobStatus=async jobId=>(await sql`SELECT status FROM portable_jobs WHERE id=${jobId}`)[0]?.status;
    const waitForStatus=async(jobId,status)=>{
      const deadline=Date.now()+10_000;
      while(await jobStatus(jobId)!==status){
        assert.ok(Date.now()<deadline,'Worker did not reach '+status+' within the local deadline.');
        await delay(30);
      }
    };
    const continuous=spawn(process.execPath,[workerCommand,'worker'],{env,cwd:workerCwd,stdio:['ignore','ignore','pipe']});
    const exited=once(continuous,'close');
    let diagnostics='';
    continuous.stderr.on('data',chunk=>{diagnostics+=chunk;});
    try{
      await waitForStatus(heavy.id,'running');
      const otherNote=await send({id:otherNoteId,body:'Independent workspace Note after a sandbox timeout',scheduledFor:0},
        other,origin,'/api/background-jobs?recordId='+foreignContact.id);
      assert.equal(otherNote.status,202);
      await waitForStatus(otherNoteId,'succeeded');
      const heavyReceipt=await state(request,headers,heavy.id);
      assert.deepEqual([heavyReceipt.jobStatus,heavyReceipt.jobIssue,heavyReceipt.attempts],
        ['failed','code_action_failed',1]);
      const [attempt]=await sql`SELECT ended_at-started_at AS duration FROM portable_job_attempts WHERE job_id=${heavy.id}`;
      assert.ok(Number(attempt.duration)>0&&Number(attempt.duration)<8_000,'Native guest work must not run until lease expiration.');
      assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${otherNoteId}`)[0].count,1);
      assert.equal(await state(request,other,heavy.id),undefined);
      assert.doesNotMatch(diagnostics,new RegExp(guestLog+'|'+guestError+'|keys=','i'));
    }finally{
      continuous.kill('SIGKILL');
      await exited;
    }

    const notes=await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=ANY(${runIds}::uuid[])`;
    assert.equal(notes[0].count,0);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE id=ANY(${runIds}::uuid[]) AND kind<>'code'`)[0].count,0);
  }finally{
    await sql`DELETE FROM portable_code_jobs WHERE job_id=ANY(${runIds}::uuid[])`;
    await sql`DELETE FROM portable_manual_workflow_runs WHERE id=ANY(${runIds}::uuid[])`;
    await sql`DELETE FROM portable_notes WHERE job_id=ANY(${[noteId,otherNoteId]}::uuid[])`;
    await sql`DELETE FROM portable_job_attempts WHERE job_id=ANY(${[...runIds,noteId,otherNoteId]}::uuid[])`;
    await sql`DELETE FROM portable_jobs WHERE id=ANY(${[...runIds,noteId,otherNoteId]}::uuid[])`;
    await sql`DELETE FROM portable_workflow_activations WHERE workflow_id=${id}`;
    await sql`DELETE FROM portable_deal_workflows WHERE id=${id}`;
    if(contact){
      await sql`DELETE FROM contact_events WHERE contact_id=${contact.id}`;
      await sql`DELETE FROM contacts WHERE id=${contact.id}`;
    }
    await resetBudget(sql);
  }
}
