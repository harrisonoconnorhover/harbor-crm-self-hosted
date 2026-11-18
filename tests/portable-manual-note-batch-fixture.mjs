import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {launchFault} from './portable-jobs-fixture.mjs';

const path='/api/workflows';
const note='Fictional manual Note batch output';
const workflowName='Fictional manual Contact batch';
const post=(request,origin,headers,body,target=path)=>request(target,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const batchPath=id=>path+'?batchId='+id;
const worker=env=>execFileSync(process.execPath,[
  process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once',
],{env,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:8_000});
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

function expectedId(workspaceId,batchId,contactId){
  const bytes=createHash('sha256').update('harbor.manual.note.batch.v1/'+workspaceId+'/'+batchId+'/'+contactId).digest();
  bytes[6]=bytes[6]&15|128;
  bytes[8]=bytes[8]&63|128;
  const hex=bytes.subarray(0,16).toString('hex');
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
}

export async function verifyPortableManualNoteBatch({request,origin,headers,other,foreignContact,sql,env,sharing}){
  const {workspaceId}=sharing;
  const workflowId=randomUUID(),contacts=[],caps=[];
  let retained;
  const definition={name:workflowName,trigger:'manual_contact',actionKind:'note',delayMinutes:0,body:note};
  const send=(body,auth=headers,site=origin,target=path)=>post(request,site,auth,body,target);
  const read=(id,auth=headers)=>request(batchPath(id),{headers:auth});
  const unchanged=async(input)=>{
    assert.equal((await read(input.id)).status,404);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}
      AND id=ANY(${input.contactIds.map(contactId=>expectedId(workspaceId,input.id,contactId))}::uuid[])`)[0].count,0);
  };
  await resetBudget(sql);

  try{
    assert.equal((await send({action:'save',id:workflowId,revision:0,definition})).status,200);
    for(const name of ['Ada','Ben','Cora','Drew']){
      const response=await send({action:'save',kind:'contacts',data:{name:'Fictional batch '+name}},headers,origin,'/api/crm');
      assert.equal(response.status,201);
      contacts.push((await response.json()).record);
    }
    const [ada,ben,cora,drew]=contacts;
    const first={action:'runContactBatch',id:randomUUID(),workflowId,workflowRevision:2,contactIds:[ben.id,ada.id]};
    const second={...first,id:randomUUID(),contactIds:[cora.id,drew.id]};
    assert.equal((await send(first,{})).status,401);
    assert.equal((await send(first,headers,'https://outside.example.test')).status,403);
    assert.equal((await send(first,other)).status,404);
    assert.equal((await send(first,other,origin,path+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await send({...first,contactIds:[ada.id,ada.id.toUpperCase()]})).status,400);
    assert.equal((await send({...first,contactIds:[ada.id]})).status,400);
    assert.equal((await send({...first,contactIds:Array.from({length:11},()=>randomUUID())})).status,400);
    assert.equal((await send({...first,workflowRevision:1})).status,409);
    assert.equal((await send({action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
    assert.equal((await send({...first,workflowRevision:1})).status,409);
    const foreign={...first,contactIds:[ada.id,foreignContact.id]};
    assert.equal((await send(foreign)).status,404);
    await unchanged(first);
    assert.equal((await send({...first,workflowId:sharing.manualWorkflow.input.workflowId,
      workflowRevision:sharing.manualWorkflow.input.workflowRevision})).status,409,'A delayed Note is not eligible for the immediate batch.');

    const single={action:'runContact',id:randomUUID(),workflowId,workflowRevision:2,contactId:ben.id};
    assert.equal((await send(single)).status,201);
    assert.equal((await send(first)).status,409);
    await unchanged(first);
    worker(env);
    assert.equal((await sql`SELECT body FROM portable_notes WHERE job_id=${single.id}`)[0].body,note);

    const [pending]=await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}
      AND status IN ('queued','running','dispatching')`;
    caps.push(...Array.from({length:99-pending.count},()=>randomUUID()));
    await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
      SELECT ${workspaceId},ids.id,${ada.id},identities.id,'note','Fictional batch capacity fixture',0,9999999999999,0
      FROM unnest(${caps}::uuid[]) AS ids(id) CROSS JOIN login_identities identities WHERE email='owner@example.test'`;
    assert.equal((await send(first)).status,409);
    await unchanged(first);
    await sql`DELETE FROM portable_jobs WHERE id=${caps[0]}`;

    await sql`ALTER TABLE portable_manual_workflow_runs ADD CONSTRAINT fixture_batch_run_failure CHECK (batch_id IS NULL) NOT VALID`;
    try{
      assert.equal((await send(first)).status,503);
      await unchanged(first);
    }finally{await sql`ALTER TABLE portable_manual_workflow_runs DROP CONSTRAINT fixture_batch_run_failure`;}

    const raced=await Promise.all([send(first),send(second)]);
    assert.deepEqual(raced.map(response=>response.status).sort(),[201,409]);
    const won=raced[0].ok?first:second,lost=raced[0].ok?second:first;
    const receipt=await raced.find(response=>response.ok).json();
    await unchanged(lost);
    await sql`DELETE FROM portable_jobs WHERE id=ANY(${caps}::uuid[])`;
    const replay={...won,id:won.id.toUpperCase(),contactIds:[...won.contactIds].reverse().map(id=>id.toUpperCase())};
    const repeats=await Promise.all([send(won),send(replay)]);
    assert.deepEqual(repeats.map(response=>response.status),[200,200]);
    for(const response of repeats)assert.deepEqual(await response.json(),receipt);
    assert.deepEqual(receipt.batch.runs.map(run=>[run.contactId,run.id,run.jobId,run.contactRevision]),
      [...won.contactIds].sort().map(contactId=>{
        const id=expectedId(workspaceId,won.id,contactId);
        return [contactId,id,id,1];
      }));
    assert.equal((await send({...won,workflowRevision:1})).status,409);
    assert.equal((await send({...won,contactIds:[...won.contactIds,foreignContact.id]})).status,409);
    assert.equal((await send({...single,id:receipt.batch.runs[0].id,contactId:receipt.batch.runs[0].contactId})).status,409);
    const overlap={...won,id:randomUUID(),contactIds:[won.contactIds[0],lost.contactIds[0]]};
    assert.equal((await send(overlap)).status,409);
    await unchanged(overlap);

    assert.equal((await read(won.id,other)).status,404);
    assert.equal((await request(batchPath(won.id)+'&batchId='+won.id,{headers})).status,400);
    assert.equal((await request(batchPath(won.id)+'&workspaceId='+workspaceId,{headers})).status,400);
    const queuedResponse=await read(won.id);
    assert.equal(queuedResponse.headers.get('cache-control'),'private, no-store');
    const queued=(await queuedResponse.json()).batch;
    assert.deepEqual(queued.runs.map(run=>[run.status,run.attempts]),[['queued',0],['queued',0]]);
    const renamed=contacts.find(item=>item.id===won.contactIds[0]);
    assert.equal((await send({action:'save',kind:'contacts',id:renamed.id,expectedRevision:1,
      data:{...renamed.data,name:'Renamed batch contact'}},headers,origin,'/api/crm')).status,200);

    const abandoned=await launchFault(env,`
      const claim=await worker.claimPortableJob(worker.portableDb());
      process.send({id:claim.id});
      setInterval(()=>{},1000);
    `);
    assert.ok(receipt.batch.runs.some(run=>run.id===abandoned.id));
    await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${abandoned.id}`;
    worker(env);
    await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${abandoned.id}`;
    worker(env);
    worker(env);
    const completed=(await (await read(won.id)).json()).batch;
    assert.ok(completed.runs.every(run=>run.status==='succeeded'));
    assert.equal(completed.runs.find(run=>run.contactId===renamed.id).contactName,renamed.data.name);
    assert.equal(completed.runs.find(run=>run.id===abandoned.id).attempts,2);
    const noteRows=await sql`SELECT body FROM portable_notes WHERE job_id=ANY(${completed.runs.map(run=>run.id)}::uuid[])`;
    assert.deepEqual(noteRows.map(row=>row.body),[note,note]);
    assert.match(await (await request('/?view=workflows',{headers})).text(),/Open batch receipt/);
    assert.equal((await send({action:'setEnabled',id:workflowId,revision:2,enabled:false})).status,200);
    assert.deepEqual(await (await send(won)).json(),receipt,'An accepted batch replays even after the workflow turns off.');
    retained={input:won,receipt,completed};
    return retained;
  }finally{
    const contactIds=contacts.map(contact=>contact.id);
    const keptContacts=retained?.input.contactIds??[];
    const keptJobs=retained?.completed.runs.map(run=>run.id)??[];
    const allJobs=await sql`SELECT id FROM portable_jobs WHERE contact_id=ANY(${contactIds}::uuid[])
      AND id<>ALL(${keptJobs}::uuid[])`;
    const ids=allJobs.map(job=>job.id);
    await sql`DELETE FROM portable_notes WHERE job_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM portable_manual_workflow_runs WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM portable_job_attempts WHERE job_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM portable_jobs WHERE id=ANY(${ids}::uuid[])`;
    const dropContacts=contactIds.filter(id=>!keptContacts.includes(id));
    await sql`DELETE FROM contact_events WHERE contact_id=ANY(${dropContacts}::uuid[])`;
    await sql`DELETE FROM contacts WHERE id=ANY(${dropContacts}::uuid[])`;
    if(!retained){
      await sql`DELETE FROM portable_manual_workflow_batches WHERE workflow_id=${workflowId}`;
      await sql`DELETE FROM portable_workflow_activations WHERE workflow_id=${workflowId}`;
      await sql`DELETE FROM portable_deal_workflows WHERE id=${workflowId}`;
    }
    await resetBudget(sql);
  }
}

export async function verifyRestoredManualNoteBatch({request,origin,owner,other,targetSql,batch}){
  const {input,receipt,completed}=batch;
  assert.deepEqual(await (await request(batchPath(input.id),{headers:owner})).json(),{batch:completed});
  assert.equal((await request(batchPath(input.id),{headers:other})).status,404);
  const replay=await post(request,origin,owner,input);
  assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),receipt);
  const rows=await targetSql`SELECT body FROM portable_notes WHERE job_id=ANY(${completed.runs.map(run=>run.id)}::uuid[])`;
  assert.deepEqual(rows.map(row=>row.body),[note,note]);
}
