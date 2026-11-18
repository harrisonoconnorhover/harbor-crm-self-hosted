import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const workflows='/api/workflows';
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;
const internalOnly=env=>({...env,HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_CODE_ENABLED:'false'});
const worker=env=>execute(process.execPath,[command,'worker','--once'],{env:internalOnly(env),cwd,timeout:6_000});
async function monitorSegments(env){
  const backupRoot=await mkdtemp(join(tmpdir(),'harbor-segment-capacity-'));
  try{
    const result=await execute(process.execPath,[command,'monitor-status',backupRoot,'--segments'],{
      env:internalOnly(env),cwd,timeout:6_000,
    }).catch(error=>{
      assert.equal(error.code,2,error.stderr); // The empty fixture backup root also needs attention.
      return error;
    });
    return JSON.parse(result.stdout).segments;
  }finally{await rm(backupRoot,{recursive:true,force:true});}
}
async function continuousWorker(env,done){
  const child=spawn(process.execPath,[command,'worker'],{env:internalOnly(env),cwd,stdio:'ignore'});
  const exit=once(child,'exit');
  try{
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){
      assert.equal(child.exitCode,null,'The continuous worker exited before reaching the checkpoint.');
      if(await done())return;
      await delay(150);
    }
    assert.fail('The continuous worker did not reach the checkpoint.');
  }finally{
    child.kill('SIGTERM');
    await exit;
  }
}
const write=(request,origin,headers,path,data)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)});
const progress=(sql,id)=>sql`SELECT baseline,cursor,waiting_for_capacity FROM portable_segment_workflow_scans WHERE workflow_id=${id}`;
const receipts=(sql,id)=>sql`SELECT r.id,r.contact_id,r.contact_revision,j.status,j.issue,j.attempts
  FROM portable_workflow_runs r JOIN portable_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
  WHERE r.workflow_id=${id} ORDER BY r.contact_revision,r.id`;
const tick=async(sql,id,env)=>{
  await sql`UPDATE portable_segment_workflow_scans SET next_at=0,retry_at=NULL WHERE workflow_id=${id} AND next_at IS NOT NULL`;
  await worker(env);
  return (await progress(sql,id))[0];
};
async function finishBaseline(sql,id,env){
  for(let page=0;page<20;page++){
    const state=await tick(sql,id,env);
    if(!state.baseline)return;
  }
  assert.fail('The fictional segment baseline did not finish.');
}
async function scanAllPages(sql,id,env){
  for(let page=0;page<20;page++){
    const state=await tick(sql,id,env);
    if(!state.cursor||state.waiting_for_capacity)return state;
  }
  assert.fail('The fictional segment scan did not finish.');
}

export async function verifyPortableSegmentWorkflow({request,origin,headers,other,sql,env}){
  const id=randomUUID(),segmentId=randomUUID(),marker='Segment workflow '+id.slice(0,8);
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudgets();
  const post=(path,data,auth=headers)=>write(request,origin,auth,path,data);
  const saveContact=async(name,lifecycle,record,auth)=>{
    const data={name,lifecycle};
    const response=await post('/api/crm',{action:'save',kind:'contacts',id:record?.id,expectedRevision:record?.revision,data},auth);
    assert.equal(response.status,record?200:201,await response.clone().text());
    return (await response.json()).record;
  };
  const criteria={groups:[[{field:'name',operator:'contains',value:marker},{field:'lifecycle',operator:'eq',value:'Other'}]]};
  const segment={id:segmentId,revision:0,name:marker,kind:'contacts',mode:'active',criteria};
  assert.equal((await post('/api/segments',{action:'save',segment})).status,201);
  const definition={name:marker,trigger:'contact_segment',segmentId,delayMinutes:5,body:'Review this fictional segment entry.'};
  const draft={action:'save',id,revision:0,definition};
  assert.equal((await post(workflows,draft,other)).status,404);
  assert.equal((await post(workflows,draft)).status,200);
  const savedPage=await request('/?view=workflows',{headers});
  assert.equal(savedPage.status,200);
  assert.match(await savedPage.text(),/Contact joins an active segment/);
  for(let index=0;index<26;index++)await saveContact(marker+' existing '+index,'Other');
  const entrant=await saveContact(marker+' entrant','Lead');
  await saveContact(marker+' foreign','Other',undefined,other);
  await worker(env);
  assert.equal((await progress(sql,id)).length,0);
  assert.equal((await receipts(sql,id)).length,0);
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:1,enabled:true},other)).status,404);
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:1,enabled:true})).status,200);
  const baselinePage=await request('/?view=workflows',{headers});
  assert.match(await baselinePage.text(),/Building segment baseline/);
  const overdueAt=Date.now()-6*60_000;
  await sql`UPDATE portable_segment_workflow_scans SET next_at=${overdueAt} WHERE workflow_id=${id}`;
  await worker(env);
  const [firstPage]=await progress(sql,id);
  assert.equal(firstPage.baseline,true);
  assert.ok(firstPage.cursor);
  const [partialTiming]=await sql`SELECT next_at,cycle_due_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`;
  assert.ok(Number(partialTiming.next_at)>overdueAt+5*60_000,'The next page has a fresh deadline.');
  assert.equal(Number(partialTiming.cycle_due_at),overdueAt,'The unfinished cycle retains its original deadline.');
  assert.deepEqual(await monitorSegments(env),{result:'attention',overdue:true});
  assert.match(await (await request('/?view=workflows',{headers})).text(),/Segment check overdue/);
  const [pageBound]=await sql`SELECT count(*)::int AS count FROM contacts WHERE workspace_id=(
    SELECT workspace_id FROM portable_segment_workflow_scans WHERE workflow_id=${id}) AND id<=${firstPage.cursor}`;
  assert.equal(pageBound.count,25);
  await finishBaseline(sql,id,env);
  const [finishedTiming]=await sql`SELECT cycle_due_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`;
  assert.equal(finishedTiming.cycle_due_at,null);
  assert.deepEqual(await monitorSegments(env),{result:'ok',overdue:false});
  assert.doesNotMatch(await (await request('/?view=workflows',{headers})).text(),/Segment check overdue/);
  assert.equal((await receipts(sql,id)).length,0);

  const scanCycle=()=>scanAllPages(sql,id,env);
  const joined=await saveContact(entrant.data.name,'Other',entrant);
  const capacityJobs=Array.from({length:100},()=>randomUUID());
  const [ordinaryJob]=capacityJobs;
  const scanTiming=async()=>(await sql`SELECT next_at,retry_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0];
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT s.workspace_id,j.id,${entrant.id},s.owner_id,'note','Fictional queue capacity',0,9999999999999,0
    FROM portable_segment_workflow_scans s CROSS JOIN unnest(${capacityJobs}::uuid[]) AS j(id) WHERE s.workflow_id=${id}`;
  try{
    const full=await scanCycle();
    assert.equal(full.waiting_for_capacity,true);
    assert.equal((await receipts(sql,id)).length,0);
    const blocked=await scanTiming();
    assert.equal(Number(blocked.next_at),0,'Capacity preserves the original overdue time.');
    assert.ok(Number(blocked.retry_at)>Date.now());
    await worker(env);
    assert.deepEqual(await scanTiming(),blocked,'A poll before the retry deadline leaves the capacity hold untouched.');
    assert.deepEqual(await monitorSegments(env),{result:'attention',overdue:true});
    const capacityPage=await (await request('/?view=workflows',{headers})).text();
    assert.match(capacityPage,/Waiting for job queue capacity/);
    assert.match(capacityPage,/Segment check overdue/);
    assert.doesNotMatch(capacityPage,/Retrying failed segment check/);
    await sql`UPDATE portable_segment_workflow_scans SET retry_at=0 WHERE workflow_id=${id}`;
    await worker(env);
    const blockedAgain=await scanTiming();
    assert.equal(blockedAgain.next_at,blocked.next_at);
    assert.ok(Number(blockedAgain.retry_at)>Date.now());
    assert.deepEqual(await monitorSegments(env),{result:'attention',overdue:true});
    const [beforeRename]=await sql`SELECT * FROM portable_segment_workflow_scans WHERE workflow_id=${id}`;
    assert.equal((await post('/api/segments',{action:'save',segment:{...segment,revision:1,name:marker+' renamed'}})).status,200);
    const [afterRename]=await sql`SELECT * FROM portable_segment_workflow_scans WHERE workflow_id=${id}`;
    assert.deepEqual({...afterRename},{...beforeRename,segment_revision:2},
      'Renaming a segment keeps the pending admission, cursor and retry deadline.');
    await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${ordinaryJob}`;
    await worker(env);
    assert.equal((await progress(sql,id))[0].waiting_for_capacity,true);
    assert.equal((await sql`SELECT status FROM portable_jobs WHERE id=${ordinaryJob}`)[0].status,'succeeded');
    assert.equal((await receipts(sql,id)).length,0);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE id=ANY(${capacityJobs.slice(1)}::uuid[])`;
  }
  await sql`UPDATE portable_segment_workflow_scans SET retry_at=0 WHERE workflow_id=${id}`;
  await continuousWorker(env,async()=>(await receipts(sql,id)).length===1);
  await scanCycle();
  assert.equal((await receipts(sql,id)).length,1);
  assert.equal((await scanTiming()).retry_at,null);
  assert.equal((await progress(sql,id))[0].waiting_for_capacity,false);
  assert.deepEqual(await monitorSegments(env),{result:'ok',overdue:false});
  const left=await saveContact(joined.data.name,'Lead',joined);
  await scanCycle();
  const returned=await saveContact(left.data.name,'Other',left);
  await scanCycle();
  const accepted=await receipts(sql,id);
  assert.deepEqual(accepted.map(row=>[row.contact_id,row.contact_revision]),[[joined.id,joined.revision],[returned.id,returned.revision]]);
  const ids=accepted.map(row=>row.id);
  assert.equal(new Set(ids).size,2);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=ANY(${ids}::uuid[])`;
  await continuousWorker(env,async()=>(await receipts(sql,id)).every(row=>row.status==='succeeded'||row.status==='skipped'));
  await worker(env);
  const completed=await receipts(sql,id);
  assert.deepEqual(completed.map(row=>[row.status,row.issue,row.attempts]),[['skipped','segment_left',1],['succeeded',null,1]]);
  assert.deepEqual((await sql`SELECT job_id FROM portable_notes WHERE job_id=ANY(${ids}::uuid[])`).map(row=>row.job_id),[ids[1]]);
  assert.equal((await post('/api/segments',{action:'delete',id:segmentId,revision:2})).status,409);

  async function recycle(contact,action){
    const response=await post('/api/recycle-bin',{id:contact.id,expectedRevision:contact.revision,action,requestId:randomUUID()});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).receipt;
  }
  const archived=await recycle(returned,'archive');
  await scanCycle();
  await recycle(archived,'restore');
  await scanCycle();
  assert.deepEqual(await receipts(sql,id),completed,'Restoring a previously observed member should not queue another Note.');

  const unseen=await saveContact(marker+' restored before discovery','Other');
  const restored=await recycle(await recycle(unseen,'archive'),'restore');
  const edit=await post('/api/crm',{action:'save',kind:'contacts',id:unseen.id,expectedRevision:restored.revision,
    data:{name:unseen.data.name,phone:'555-0100'}});
  assert.equal(edit.status,200,await edit.clone().text());
  const edited=(await edit.json()).record;
  await scanCycle();
  assert.deepEqual(await receipts(sql,id),completed,'Silent restore membership should survive an unrelated edit before discovery.');
  const changed=await saveContact(unseen.data.name,'Lead',edited);
  await scanCycle();
  const reentered=await saveContact(unseen.data.name,'Other',changed);
  await scanCycle();
  const [newRun]= (await receipts(sql,id)).filter(row=>row.contact_id===unseen.id);
  assert.equal(newRun?.contact_revision,reentered.revision,'Later ordinary re-entry should still enroll.');
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${newRun.id}`;
  await worker(env);
  const finalReceipts=await receipts(sql,id);
  assert.equal(finalReceipts.find(row=>row.id===newRun.id).status,'succeeded');

  const changedSegment={...segment,revision:2,criteria:{groups:[]}};
  assert.equal((await post('/api/segments',{action:'save',segment:changedSegment})).status,200);
  assert.equal((await post('/api/segments',{action:'save',segment:{...changedSegment,revision:3,description:'Fictional description'}})).status,200);
  assert.equal((await sql`SELECT segment_revision FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0].segment_revision,2,
    'An unapplied criteria change still needs its baseline after a metadata edit.');
  await finishBaseline(sql,id,env);
  assert.equal((await sql`SELECT segment_revision FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0].segment_revision,4);
  assert.deepEqual(await receipts(sql,id),finalReceipts);

  // An earlier-due scan must not block another tenant while its workspace is locked.
  const otherSegmentId=randomUUID(),otherWorkflowId=randomUUID();
  assert.equal((await post('/api/segments',{action:'save',segment:{...segment,id:otherSegmentId}},other)).status,201);
  assert.equal((await post(workflows,{...draft,id:otherWorkflowId,definition:{...definition,segmentId:otherSegmentId}},other)).status,200);
  assert.equal((await post(workflows,{action:'setEnabled',id:otherWorkflowId,revision:1,enabled:true},other)).status,200);
  await sql`UPDATE portable_segment_workflow_scans SET next_at=0 WHERE workflow_id=${id}`;
  await sql.begin(async tx=>{
    await tx`SELECT id FROM private_workspaces WHERE id=(
      SELECT workspace_id FROM portable_segment_workflow_scans WHERE workflow_id=${id}) FOR NO KEY UPDATE`;
    await finishBaseline(sql,otherWorkflowId,env);
    assert.equal(Number((await tx`SELECT next_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0].next_at),0);
  });
  assert.equal((await receipts(sql,otherWorkflowId)).length,0);
  await tick(sql,id,env);
  assert.ok(Number((await sql`SELECT next_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0].next_at)>0);

  // Stall the cursor update after the page has attempted admission.
  const faultContact=await saveContact(marker+' interrupted admission','Other');
  const independentNote={id:randomUUID(),body:'Fictional Note due during a slow segment page',scheduledFor:0};
  await sql`UPDATE portable_segment_workflow_scans s SET next_at=0,waiting_for_capacity=true,cursor=(
    SELECT c.id FROM contacts c WHERE c.workspace_id=s.workspace_id AND c.id<${faultContact.id}
    ORDER BY c.id DESC LIMIT 1) WHERE s.workflow_id=${id}`;
  await sql`UPDATE portable_segment_workflow_scans SET next_at=1 WHERE workflow_id=${otherWorkflowId}`;
  const beforeFailure=(await progress(sql,id))[0];
  await sql.unsafe(`CREATE FUNCTION harbor_fixture_segment_page_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(7); RETURN NEW; END $$;
    CREATE TRIGGER harbor_fixture_segment_page_failure BEFORE UPDATE ON portable_segment_workflow_scans
    FOR EACH ROW WHEN (NEW.workflow_id='${id}'::uuid AND NEW.next_at IS DISTINCT FROM OLD.next_at)
    EXECUTE FUNCTION harbor_fixture_segment_page_failure()`).simple();
  try{
    assert.equal((await post('/api/background-jobs?recordId='+joined.id,independentNote)).status,202);
    await worker(env);
    assert.deepEqual((await progress(sql,id))[0],{...beforeFailure,waiting_for_capacity:false});
    assert.deepEqual(await receipts(sql,id),finalReceipts);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE contact_id=${faultContact.id}`)[0].count,0);
    assert.deepEqual(Array.from(await sql`SELECT body FROM portable_notes WHERE job_id=${independentNote.id}`),
      [{body:independentNote.body}],'The same worker pass completes the ordinary Note.');
    assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${independentNote.id}`),
      [{number:1,outcome:'succeeded'}]);
    const retry=await scanTiming();
    assert.equal(Number(retry.next_at),0,'The original overdue deadline stays visible.');
    assert.ok(Number(retry.retry_at)>Date.now());
    await sql`UPDATE portable_segment_workflow_scans SET retry_at=2 WHERE workflow_id=${id}`;
    await worker(env);
    assert.ok(Number((await sql`SELECT next_at FROM portable_segment_workflow_scans WHERE workflow_id=${otherWorkflowId}`)[0].next_at)>1,
      'The healthy workspace ready before this expired retry takes the next turn.');
    assert.equal(Number((await scanTiming()).retry_at),2,'The failed page has not been retried ahead of healthy work.');
    const retryPage=await (await request('/?view=workflows',{headers})).text();
    assert.match(retryPage,/Retrying failed segment check/);
    assert.doesNotMatch(retryPage,/Waiting for job queue capacity/);
  }finally{
    await sql.unsafe('DROP TRIGGER harbor_fixture_segment_page_failure ON portable_segment_workflow_scans; DROP FUNCTION harbor_fixture_segment_page_failure()').simple();
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_notes WHERE job_id=${independentNote.id}`;
      await tx`DELETE FROM portable_job_attempts WHERE job_id=${independentNote.id}`;
      await tx`DELETE FROM portable_jobs WHERE id=${independentNote.id}`;
    });
  }
  await sql`UPDATE portable_segment_workflow_scans SET retry_at=0 WHERE workflow_id=${id}`;
  await worker(env);
  assert.equal((await sql`SELECT retry_at FROM portable_segment_workflow_scans WHERE workflow_id=${id}`)[0].retry_at,null);
  const [retried]= (await receipts(sql,id)).filter(row=>row.contact_id===faultContact.id);
  assert.equal(retried?.status,'queued');
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${retried.id}`;
  await worker(env);
  await worker(env);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${retried.id}`)[0].count,1);
  const recoveredReceipts=await receipts(sql,id);
  assert.equal(recoveredReceipts.length,finalReceipts.length+1);
  assert.equal(recoveredReceipts.find(row=>row.id===retried.id).status,'succeeded');
  assert.doesNotMatch(await (await request('/?view=workflows',{headers})).text(),/Retrying failed segment check/);
  assert.equal((await post(workflows,{action:'setEnabled',id:otherWorkflowId,revision:2,enabled:false},other)).status,200);

  // An owner can revise the workflow without erasing its prior admissions.
  await resetBudgets();
  assert.equal((await post('/api/segments',{action:'save',segment:{...segment,revision:4}})).status,200);
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:2,enabled:false})).status,200);
  const {name,body,delayMinutes}=definition;
  assert.equal((await post(workflows,{action:'save',id,revision:3,
    definition:{name,body,delayMinutes,trigger:'manual_contact'}})).status,200);
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:4,enabled:true})).status,200);
  let manualContact=await saveContact(marker+' manual admission','Other');
  const manualRunId=randomUUID();
  assert.equal((await post(workflows,{action:'runContact',id:manualRunId,workflowId:id,workflowRevision:5,
    contactId:manualContact.id})).status,201);
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:5,enabled:false})).status,200);
  assert.equal((await post(workflows,{action:'save',id,revision:6,definition:{...definition,enrollment:'when_matching'}})).status,400);
  assert.equal((await post(workflows,{action:'save',id,revision:6,definition:{...definition,enrollment:'once'}})).status,200);
  const savedOnce=(await (await request(workflows,{headers})).json()).workflows.find(row=>row.id===id);
  assert.equal(savedOnce.definition.enrollment,'once');
  let newMember=await saveContact(marker+' once baseline member','Other');
  assert.equal((await post(workflows,{action:'setEnabled',id,revision:7,enabled:true})).status,200);
  await finishBaseline(sql,id,env);
  assert.deepEqual(await receipts(sql,id),recoveredReceipts,'The quiet baseline should not consume once-only enrollment.');

  const priorMember=await saveContact(faultContact.data.name,'Lead',faultContact);
  manualContact=await saveContact(manualContact.data.name,'Lead',manualContact);
  newMember=await saveContact(newMember.data.name,'Lead',newMember);
  await scanCycle();
  await saveContact(priorMember.data.name,'Other',priorMember);
  await saveContact(manualContact.data.name,'Other',manualContact);
  newMember=await saveContact(newMember.data.name,'Other',newMember);
  await scanCycle();
  const onceReceipts=await receipts(sql,id);
  assert.deepEqual(onceReceipts.filter(row=>row.contact_id!==newMember.id),Array.from(recoveredReceipts));
  const [onceReceipt]=onceReceipts.filter(row=>row.contact_id===newMember.id);
  assert.equal(onceReceipt?.contact_revision,newMember.revision);
  assert.equal(onceReceipt?.status,'queued');
  newMember=await saveContact(newMember.data.name,'Lead',newMember);
  await scanCycle();
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id IN (${onceReceipt.id},${manualRunId})`;
  await worker(env);
  await worker(env);
  newMember=await saveContact(newMember.data.name,'Other',newMember);
  await scanCycle();
  const onceCompleted=await receipts(sql,id);
  assert.deepEqual(onceCompleted.filter(row=>row.contact_id===newMember.id),
    [{...onceReceipt,status:'skipped',issue:'segment_left',attempts:1}],
    'A skipped Note still has a prior admission and must not be queued again.');

  await resetBudgets();
  const exit=await verifyPortableSegmentExit({post,saveContact,recycle,sql,env,definition,marker,other});
  await resetBudgets();
  const task=await verifySegmentTaskWorkflow({request,origin,headers,other,sql,env});
  return {id,completed:onceCompleted,completedNoteId:ids[1],onceMember:newMember,exit,task};
}

async function verifyPortableSegmentExit({post,saveContact,recycle,sql,env,definition,marker,other}){
  const id=randomUUID();
  const exitRule={...definition,name:marker+' exits',segmentEvent:'left',enrollment:'every_event',
    body:'Review this fictional segment exit.'};
  const draft={action:'save',id,revision:0,definition:exitRule};
  const enable=(revision,enabled)=>post(workflows,{action:'setEnabled',id,revision,enabled});
  const scan=()=>scanAllPages(sql,id,env);
  assert.equal((await post(workflows,draft,other)).status,404);
  assert.equal((await post(workflows,{...draft,definition:{...exitRule,segmentEvent:'invalid'}})).status,400);
  assert.equal((await post(workflows,draft)).status,200);
  let member=await saveContact(marker+' exit member','Other');
  const quiet=await saveContact(marker+' archive while matching','Other');
  const quietExit=await saveContact(marker+' archive before exit observed','Other');
  assert.equal((await enable(1,true)).status,200);
  await finishBaseline(sql,id,env);
  assert.equal((await receipts(sql,id)).length,0);

  const archived=await recycle(quiet,'archive');
  await scan();
  await recycle(archived,'restore');
  const changed=await saveContact(quietExit.data.name,'Lead',quietExit);
  await recycle(await recycle(changed,'archive'),'restore');
  await scan();
  assert.equal((await receipts(sql,id)).length,0,'Archive and restore must stay quiet even before an exit scan.');

  member=await saveContact(member.data.name,'Lead',member);
  const capacity=Array.from({length:100},()=>randomUUID());
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT s.workspace_id,j.id,${member.id},s.owner_id,'note','Fictional exit capacity',0,9999999999999,0
    FROM portable_segment_workflow_scans s CROSS JOIN unnest(${capacity}::uuid[]) AS j(id) WHERE s.workflow_id=${id}`;
  try{
    assert.equal((await scan()).waiting_for_capacity,true);
    assert.equal((await receipts(sql,id)).length,0);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_segment_workflow_members
      WHERE workflow_id=${id} AND contact_id=${member.id}`)[0].count,1,'A full queue retains the exit for retry.');
  }finally{await sql`DELETE FROM portable_jobs WHERE id=ANY(${capacity}::uuid[])`;}
  await scan();
  const [first]=await receipts(sql,id);
  assert.equal(first.contact_revision,member.revision);
  assert.equal(first.status,'queued');
  member=await saveContact(member.data.name,'Other',member);
  await scan();
  assert.deepEqual(Array.from(await receipts(sql,id)),[first]);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${first.id}`;
  await worker(env);
  assert.equal((await receipts(sql,id))[0].status,'succeeded','A recorded exit still runs if the Contact rejoins.');
  member=await saveContact(member.data.name,'Lead',member);
  await scan();
  const repeated=await receipts(sql,id);
  assert.deepEqual(repeated.map(row=>row.contact_revision),[first.contact_revision,member.revision]);
  const second=repeated[1];
  assert.notEqual(second.id,first.id);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${second.id}`;
  await worker(env);
  await worker(env);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id IN (${first.id},${second.id})`)[0].count,2);

  assert.equal((await enable(2,false)).status,200);
  assert.equal((await post(workflows,{...draft,revision:3,definition:{...exitRule,enrollment:'once'}})).status,200);
  member=await saveContact(member.data.name,'Other',member);
  assert.equal((await enable(4,true)).status,200);
  await finishBaseline(sql,id,env);
  member=await saveContact(member.data.name,'Lead',member);
  await scan();
  const completed=await receipts(sql,id);
  assert.deepEqual(completed.map(row=>row.id),[first.id,second.id]);
  return {id,member,completed};
}

async function verifySegmentTaskWorkflow({request,origin,headers,other,sql,env}){
  const segmentId=randomUUID(),entryId=randomUUID(),exitId=randomUUID();
  const name='Segment Task '+segmentId.slice(0,8);
  const post=(path,data,auth=headers)=>write(request,origin,auth,path,data);
  const toggle=(id,revision,enabled)=>post(workflows,{action:'setEnabled',id,revision,enabled});
  const criteria={groups:[[{field:'name',operator:'contains',value:name},{field:'lifecycle',operator:'eq',value:'Other'}]]};
  const created=await post('/api/segments',{action:'save',segment:{
    id:segmentId,revision:0,name,kind:'contacts',mode:'active',criteria,
  }});
  assert.equal(created.status,201,await created.clone().text());
  const task={name:'Review segment transition',taskType:'To-do',priority:'High',notes:'Fictional pilot follow-up'};
  const definition={name,trigger:'contact_segment',segmentId,enrollment:'once',actionKind:'task',delayMinutes:1440,task};
  const entry={action:'save',id:entryId,revision:0,definition};
  assert.equal((await post(workflows,entry,other)).status,404);
  assert.equal((await post(workflows,entry)).status,200);
  const exit={...entry,id:exitId,definition:{...definition,segmentEvent:'left',task:{...task,name:'Review segment exit'}}};
  assert.equal((await post(workflows,exit)).status,200);

  let contact;
  async function save(lifecycle){
    const response=await post('/api/crm',{action:'save',kind:'contacts',id:contact?.id,expectedRevision:contact?.revision,
      data:{name,lifecycle}});
    assert.equal(response.status,contact?200:201,await response.clone().text());
    contact=(await response.json()).record;
  }
  await save('Other');
  assert.equal((await toggle(entryId,1,true)).status,200);
  await finishBaseline(sql,entryId,env);
  assert.deepEqual(Array.from(await receipts(sql,entryId)),[]);
  await save('Lead');
  await scanAllPages(sql,entryId,env);
  await save('Other');
  await scanAllPages(sql,entryId,env);
  const [joined]=await receipts(sql,entryId);
  assert.equal(joined.contact_revision,contact.revision);
  assert.equal(joined.status,'queued');

  assert.equal((await toggle(exitId,1,true)).status,200);
  await finishBaseline(sql,exitId,env);
  assert.deepEqual(Array.from(await receipts(sql,exitId)),[]);
  await save('Lead');
  await scanAllPages(sql,entryId,env);
  await scanAllPages(sql,exitId,env);
  const [left]=await receipts(sql,exitId);
  assert.equal(left.contact_revision,contact.revision);
  assert.equal(left.status,'queued');
  await save('Other');
  await scanAllPages(sql,entryId,env);
  await scanAllPages(sql,exitId,env);
  assert.deepEqual(Array.from(await receipts(sql,entryId)),[joined]);
  assert.deepEqual(Array.from(await receipts(sql,exitId)),[left]);
  const jobs=await sql`SELECT j.id,j.kind,j.actor_id,(j.scheduled_for-j.created_at)::float8 AS delay,p.payload
    FROM portable_jobs j JOIN portable_task_jobs p ON p.workspace_id=j.workspace_id AND p.job_id=j.id
    WHERE j.id IN (${joined.id},${left.id})`;
  const [scope]=await sql`SELECT owner_id FROM portable_segment_workflow_scans WHERE workflow_id=${entryId}`;
  assert.deepEqual(Array.from(jobs).sort((a,b)=>a.id.localeCompare(b.id)),[
    {id:joined.id,kind:'task',actor_id:scope.owner_id,delay:86_400_000,payload:task},
    {id:left.id,kind:'task',actor_id:scope.owner_id,delay:86_400_000,payload:exit.definition.task},
  ].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal((await toggle(entryId,2,false)).status,200);
  assert.equal((await toggle(exitId,2,false)).status,200);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${joined.id}`;
  await worker(env);
  const [skipped]=await receipts(sql,entryId);
  assert.deepEqual([skipped.status,skipped.issue],['skipped','segment_left']);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_tasks WHERE id IN (${joined.id},${left.id})`)[0].count,0);
  return {contactId:contact.id,skippedId:joined.id,pendingId:left.id,fields:exit.definition.task,ownerId:scope.owner_id};
}

export async function verifyRestoredSegmentWorkflow({request,origin,owner,sql,env,fixture}){
  const {id,completed,completedNoteId,onceMember}=fixture;
  const restored=await request(workflows,{headers:owner});
  assert.equal(restored.status,200,await restored.clone().text());
  const state=await restored.json();
  const rule=state.workflows.find(workflow=>workflow.id===id);
  assert.equal(rule.enabled,false);
  assert.equal(rule.definition.enrollment,'once');
  assert.deepEqual(await receipts(sql,id),completed);
  assert.equal((await progress(sql,id)).length,0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_segment_workflow_members WHERE workflow_id=${id}`)[0].count,0);
  const response=await write(request,origin,owner,workflows,{action:'setEnabled',id,revision:rule.revision,enabled:true});
  assert.equal(response.status,200,await response.clone().text());
  await finishBaseline(sql,id,env);
  assert.deepEqual(await receipts(sql,id),completed);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${completedNoteId}`)[0].count,1);

  async function changeLifecycle(expectedRevision,lifecycle){
    const result=await write(request,origin,owner,'/api/crm',{action:'save',kind:'contacts',id:onceMember.id,expectedRevision,
      data:{name:onceMember.data.name,lifecycle}});
    assert.equal(result.status,200,await result.clone().text());
    return (await result.json()).record;
  }
  const left=await changeLifecycle(onceMember.revision,'Lead');
  await scanAllPages(sql,id,env);
  await changeLifecycle(left.revision,'Other');
  await scanAllPages(sql,id,env);
  assert.deepEqual(await receipts(sql,id),completed,'Restored receipts must prevent a second enrollment.');

  const {exit}=fixture;
  const exitRule=state.workflows.find(workflow=>workflow.id===exit.id);
  assert.equal(exitRule.enabled,false);
  assert.equal(exitRule.definition.segmentEvent,'left');
  assert.equal(exitRule.definition.enrollment,'once');
  assert.deepEqual(await receipts(sql,exit.id),exit.completed);
  const rejoined=await write(request,origin,owner,'/api/crm',{action:'save',kind:'contacts',id:exit.member.id,
    expectedRevision:exit.member.revision,data:{name:exit.member.data.name,lifecycle:'Other'}});
  assert.equal(rejoined.status,200,await rejoined.clone().text());
  const current=(await rejoined.json()).record;
  const enabled=await write(request,origin,owner,workflows,{action:'setEnabled',id:exit.id,revision:exitRule.revision,enabled:true});
  assert.equal(enabled.status,200,await enabled.clone().text());
  await finishBaseline(sql,exit.id,env);
  const exited=await write(request,origin,owner,'/api/crm',{action:'save',kind:'contacts',id:current.id,
    expectedRevision:current.revision,data:{name:current.data.name,lifecycle:'Lead'}});
  assert.equal(exited.status,200,await exited.clone().text());
  await scanAllPages(sql,exit.id,env);
  assert.deepEqual(await receipts(sql,exit.id),exit.completed,'Restored exit receipts must prevent another once-only run.');

  const task=fixture.task;
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${task.pendingId}`;
  await worker(env);
  await worker(env);
  const [restoredTask]=await sql`SELECT contact_id,assignee_id,data FROM portable_tasks WHERE id=${task.pendingId}`;
  assert.deepEqual({...restoredTask},{contact_id:task.contactId,assignee_id:task.ownerId,
    data:{...task.fields,dueDate:'',status:'Not started'}});
  assert.deepEqual(Array.from(await sql`SELECT actor_id FROM portable_task_events WHERE task_id=${task.pendingId}`),[{actor_id:task.ownerId}]);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_tasks WHERE id=${task.skippedId}`)[0].count,0);
}
