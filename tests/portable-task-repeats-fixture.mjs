import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const api='/api/crm',bin='/api/recycle-bin';
const read=(request,id,headers,workspaceId)=>request(api+'?'+new URLSearchParams({kind:'tasks',id,...(workspaceId?{workspaceId}:{})}),{headers});
const post=(request,path,origin,headers,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const repeat={every:1,unit:'months',timeZone:'America/New_York'};
const setStatus=(task,status)=>({action:'save',kind:'tasks',id:task.id,expectedRevision:task.revision,data:{name:task.data.name,status}});
const receipts=(db,workspaceId,id)=>db`SELECT successor_id,actor_id,created_at FROM portable_task_repeat_receipts
  WHERE workspace_id=${workspaceId} AND predecessor_id=${id}`;
const execute=promisify(execFile);
const worker=(env,enabled)=>execute(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
  env:{...env,HARBOR_PORTABLE_TASK_REPEAT_ENABLED:enabled,HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_CODE_ENABLED:'false'},
  cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6_000,
});

export async function verifyPortableTaskRepeatStatementTimeout({sql,env,workspaceId,ownerId,task,contactId}){
  const id=randomUUID();
  const readTask=async()=>(await sql`SELECT revision,updated_at,data,repeat_retry_at,repeat_retry_revision
    FROM portable_tasks WHERE workspace_id=${workspaceId} AND id=${task.id}`)[0];
  const original=await readTask();
  assert.match(task.id,/^[a-f0-9-]{36}$/);
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    VALUES(${workspaceId},${id},${contactId},${ownerId},'note','Fictional Note due during a slow Task repeat',0,0,0)`;
  await sql.unsafe(`CREATE FUNCTION harbor_test_slow_task_repeat() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM portable_task_repeat_receipts WHERE workspace_id=NEW.workspace_id
        AND predecessor_id='${task.id}' AND successor_id=NEW.task_id) THEN PERFORM pg_sleep(7); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER harbor_test_slow_task_repeat BEFORE INSERT ON portable_task_events
    FOR EACH ROW EXECUTE FUNCTION harbor_test_slow_task_repeat()`).simple();
  try{
    const {stderr}=await worker(env,'true');
    assert.match(stderr,/Portable overdue Task repeat unavailable/);
    const deferred=await readTask();
    assert.ok(Date.parse(deferred.repeat_retry_at)>Date.now());
    assert.deepEqual(deferred,{...original,repeat_retry_at:deferred.repeat_retry_at,repeat_retry_revision:task.revision});
    assert.equal((await receipts(sql,workspaceId,task.id)).length,0);
    const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_tasks
      WHERE workspace_id=${workspaceId} AND data->>'name'=${task.data.name}`;
    assert.equal(count,1,'The staged Task and receipt both roll back.');
    assert.deepEqual(Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${id}`),
      [{number:1,outcome:'succeeded'}]);
    assert.equal((await sql`SELECT job_id FROM portable_notes WHERE job_id=${id}`).length,1);
  }finally{
    await sql.unsafe('DROP TRIGGER harbor_test_slow_task_repeat ON portable_task_events; DROP FUNCTION harbor_test_slow_task_repeat()').simple();
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_notes WHERE job_id=${id}`;
      await tx`DELETE FROM portable_job_attempts WHERE job_id=${id}`;
      await tx`DELETE FROM portable_jobs WHERE id=${id}`;
    });
  }
}

async function waitFor(read,message){
  for(let i=0;i<80;i++){
    const result=await read();
    if(result)return result;
    await delay(25);
  }
  assert.fail(message);
}

async function changeDuringOverdueWorker(sql,env,change){
  const gate=810683411;
  await sql.unsafe(`CREATE FUNCTION harbor_test_task_repeat_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
    CREATE TRIGGER harbor_test_task_repeat_gate BEFORE INSERT ON portable_task_repeat_receipts
    FOR EACH ROW EXECUTE FUNCTION harbor_test_task_repeat_gate()`).simple();
  let advancing,changing;
  try{
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${gate}::bigint)`;
      advancing=worker(env,'true');
      advancing.catch(()=>{});
      const {pid}=await waitFor(async()=>(await sql`SELECT pid FROM pg_locks
        WHERE locktype='advisory' AND objid=${gate} AND NOT granted`)[0],'The worker did not reach the Task repeat receipt.');
      // The worker owns the workspace and predecessor locks while its receipt is pending.
      changing=change();
      changing.catch(()=>{});
      await waitFor(async()=>(await sql`SELECT EXISTS(SELECT FROM pg_stat_activity
        WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`)[0].waiting,'Task change did not wait behind the overdue worker.');
    });
    const [response]=await Promise.all([changing,advancing]);
    return response;
  }finally{
    await Promise.allSettled([changing,advancing]);
    await sql.unsafe(`DROP TRIGGER harbor_test_task_repeat_gate ON portable_task_repeat_receipts;
      DROP FUNCTION harbor_test_task_repeat_gate()`).simple();
  }
}

async function clearDuringOverdueWorker(sql,env,workspaceId,task,clear){
  const gate=810683412;
  await sql.unsafe(`CREATE FUNCTION harbor_test_task_repeat_clear_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
    CREATE TRIGGER harbor_test_task_repeat_clear_gate BEFORE UPDATE ON portable_tasks
    FOR EACH ROW WHEN (OLD.data ? 'repeat' AND NOT (NEW.data ? 'repeat'))
    EXECUTE FUNCTION harbor_test_task_repeat_clear_gate()`).simple();
  let saving;
  try{
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${gate}::bigint)`;
      saving=clear();
      saving.catch(()=>{});
      await waitFor(async()=>(await sql`SELECT pid FROM pg_locks
        WHERE locktype='advisory' AND objid=${gate} AND NOT granted`)[0],'The Task save did not reach its update.');
      await assert.rejects(sql`SELECT id FROM private_workspaces WHERE id=${workspaceId} FOR NO KEY UPDATE NOWAIT`,
        {code:'55P03'},'the admitted save holds the workspace lock');
      const {stderr}=await worker(env,'true');
      assert.doesNotMatch(stderr,/Portable overdue Task repeat unavailable/,
        'the overdue worker skips the locked workspace without waiting for its database deadline');
      assert.equal((await receipts(sql,workspaceId,task.id)).length,0);
    });
    return await saving;
  }finally{
    await Promise.allSettled([saving]);
    await sql.unsafe(`DROP TRIGGER harbor_test_task_repeat_clear_gate ON portable_tasks;
      DROP FUNCTION harbor_test_task_repeat_clear_gate()`).simple();
  }
}

async function verifyNoTaskRepeat(db,workspaceId,task){
  assert.equal((await receipts(db,workspaceId,task.id)).length,0,'a Task with recurrence cleared has no successor receipt');
  const [{count}]=await db`SELECT count(*)::int AS count FROM portable_tasks
    WHERE workspace_id=${workspaceId} AND data->>'name'=${task.data.name}`;
  assert.equal(count,1,'only the original Task remains after recurrence is cleared');
}

export async function verifyPortableTaskRepeats({request,origin,headers,other,sql,sharing,env}){
  const {workspaceId,grantId}=sharing;
  const send=(body,auth=headers,path=api)=>post(request,path,origin,auth,body);
  const create=(data,extra={})=>send({action:'save',kind:'tasks',data,...extra});
  const get=(id,auth=headers,scope)=>read(request,id,auth,scope);
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const [{id:editorId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const {record:active}=await (await send({action:'save',kind:'contacts',data:{name:'Fictional recurring-task contact'}})).json();
  const queueId=randomUUID();
  const queued=await send({action:'create',id:queueId,name:'Fictional recurring work'},headers,'/api/task-queues');
  assert.equal(queued.status,200);
  const {queue}=await queued.json();
  const editorPath=api+'?'+new URLSearchParams({workspaceId,grantId});
  const monthlyData={name:'Fictional monthly task',dueDate:'2040-01-31',repeat,notes:'Review the terms'};
  assert.equal((await create({...monthlyData,dueDate:''})).status,400);
  assert.equal((await create({...monthlyData,repeatAnchorDate:'2039-01-31'})).status,400);
  const response=await create(monthlyData,{queueId,contactId:active.id,assigneeId:editorId});
  assert.equal(response.status,201,await response.clone().text());
  const {record:source}=await response.json();
  assert.deepEqual([source.data.repeatAnchorDate,source.data.repeatDueAt,source.data.dueAt],
    ['2040-01-31','2040-02-01T05:00:00.000Z',undefined]);
  assert.equal((await send(setStatus(source,'Completed'),other)).status,404);
  const staleGrant=api+'?'+new URLSearchParams({workspaceId,grantId:randomUUID()});
  assert.equal((await send(setStatus(source,'Completed'),other,staleGrant)).status,403);

  const completion=setStatus(source,'Completed');
  const contenders=await Promise.all([send(completion,other,editorPath),send(completion,other,editorPath)]);
  assert.deepEqual(contenders.map(result=>result.status).sort(),[200,409]);
  const {record:completed,nextTaskId}=await contenders.find(result=>result.ok).json();
  assert.ok(nextTaskId);
  assert.equal(completed.data.status,'Completed');
  assert.equal(completed.queueId,null);
  const [receipt]=await receipts(sql,workspaceId,source.id);
  assert.deepEqual([receipt.successor_id,receipt.actor_id],[nextTaskId,editorId]);
  const next=await (await get(nextTaskId)).json();
  assert.deepEqual([next.data.dueDate,next.data.repeatAnchorDate,next.data.status,next.completedAt,next.data.notes,
    next.contactId,next.assigneeId,next.queueId],['2040-02-29','2040-01-31','Not started',null,monthlyData.notes,active.id,editorId,queueId]);
  assert.equal((await get(nextTaskId,other)).status,404);
  const shared=await (await get(nextTaskId,other,workspaceId)).json();
  assert.equal(shared.queueId,null);
  assert.equal(shared.contactId,active.id);
  const detailPath='/?kind=tasks&record='+source.id;
  const [ownerDetail,sharedDetail,unscopedDetail]=await Promise.all([
    request(detailPath,{headers}),
    request(detailPath+'&workspaceId='+workspaceId,{headers:other}),
    request(detailPath,{headers:other}),
  ]);
  assert.equal(ownerDetail.status,200);
  assert.ok((await ownerDetail.text()).includes('href="/?kind=tasks&amp;record='+nextTaskId+'">Open next task</a>'));
  assert.equal(sharedDetail.status,200);
  assert.ok((await sharedDetail.text()).includes('href="/?kind=tasks&amp;workspaceId='+workspaceId+'&amp;record='+nextTaskId+'">Open next task</a>'));
  assert.equal(unscopedDetail.status,404);
  assert.deepEqual(Array.from(await sql`SELECT revision,actor_id FROM portable_task_events WHERE workspace_id=${workspaceId} AND task_id=${nextTaskId}`),
    [{revision:1,actor_id:editorId}]);

  const reopened=await (await send(setStatus(completed,'Not started'))).json();
  const again=await send(setStatus(reopened.record,'Completed'));
  assert.equal(again.status,200);
  const repeated=await again.json();
  assert.equal(repeated.nextTaskId,nextTaskId);
  assert.equal((await receipts(sql,workspaceId,source.id)).length,1);
  assert.equal((await send(completion,other,editorPath)).status,409);

  const updated=await send({...setStatus(next,'Not started'),data:{name:'Fictional February task',status:'Not started'}});
  assert.equal(updated.status,200);
  const {record:afterEdit}=await updated.json();
  assert.equal(afterEdit.data.repeatAnchorDate,'2040-01-31');
  const third=await (await send(setStatus(afterEdit,'Completed'))).json();
  assert.equal((await (await get(third.nextTaskId)).json()).data.dueDate,'2040-03-31');

  const clockData={name:'Fictional clock change task',dueDate:'2040-03-10',dueTime:'02:30',dueTimeZone:'America/New_York',
    repeat:{...repeat,unit:'days'}};
  const {record:clock}=await (await create(clockData)).json();
  const {nextTaskId:clockNext}=await (await send(setStatus(clock,'Completed'))).json();
  const spring=await (await get(clockNext)).json();
  assert.deepEqual([spring.data.dueDate,spring.data.dueTime,spring.data.dueAt,spring.data.repeatAnchorTime],
    ['2040-03-11','03:00','2040-03-11T07:00:00.000Z','02:30']);

  const midnightGapData={name:'Fictional clock gap through midnight',dueDate:'2040-03-23',dueTime:'23:30',
    dueTimeZone:'America/Nuuk',repeat:{every:1,unit:'days',timeZone:'America/Nuuk'}};
  const gapCreated=await create(midnightGapData);
  assert.equal(gapCreated.status,201,await gapCreated.clone().text());
  const {record:gapTask}=await gapCreated.json();
  const gapCompleted=await send(setStatus(gapTask,'Completed'));
  assert.equal(gapCompleted.status,200,await gapCompleted.clone().text());
  const {nextTaskId:gapSuccessor}=await gapCompleted.json();
  const gapNext=await (await get(gapSuccessor)).json();
  assert.deepEqual([gapNext.data.dueDate,gapNext.data.dueTime,gapNext.data.dueAt,gapNext.data.repeatAnchorDate],
    ['2040-03-25','23:30','2040-03-26T00:30:00.000Z','2040-03-23']);
  assert.deepEqual((await receipts(sql,workspaceId,gapTask.id)).map(row=>row.successor_id),[gapSuccessor]);

  const {record:contact}=await (await send({action:'save',kind:'contacts',data:{name:'Fictional repeat archive contact'}})).json();
  const {record:dormant}=await (await create({...monthlyData,name:'Fictional dormant-linked repeat'},{contactId:contact.id})).json();
  const archived=await send({action:'archive',id:contact.id,expectedRevision:contact.revision,requestId:randomUUID()},headers,'/api/recycle-bin');
  assert.equal(archived.status,200,await archived.clone().text());
  const {receipt:archiveReceipt}=await archived.json();
  try{
    const saved=await send(setStatus(dormant,'Completed'));
    assert.equal(saved.status,200,await saved.clone().text());
    const {record:done,nextTaskId:dormantNext}=await saved.json();
    assert.equal(done.contactId,null);
    const [prior]=await sql`SELECT contact_id FROM portable_tasks WHERE workspace_id=${workspaceId} AND id=${dormant.id}`;
    assert.equal(prior.contact_id,contact.id);
    assert.equal((await (await get(dormantNext)).json()).contactId,null);
  }finally{
    const restored=await send({action:'restore',id:contact.id,expectedRevision:archiveReceipt.revision,requestId:randomUUID()},headers,'/api/recycle-bin');
    assert.equal(restored.status,200);
  }

  const {record:rollback}=await (await create({...monthlyData,name:'Fictional repeat rollback'})).json();
  await sql`ALTER TABLE portable_tasks ADD CONSTRAINT fixture_repeat_rollback
    CHECK (data->>'name'<>'Fictional repeat rollback' OR revision<>1) NOT VALID`;
  try{
    assert.equal((await send(setStatus(rollback,'Completed'))).status,500);
    assert.equal((await (await get(rollback.id)).json()).data.status,'Not started');
    assert.equal((await receipts(sql,workspaceId,rollback.id)).length,0);
  }finally{await sql`ALTER TABLE portable_tasks DROP CONSTRAINT fixture_repeat_rollback`;}
  const stopped=await send({...setStatus(rollback,'Completed'),data:{...setStatus(rollback,'Completed').data,repeat:null,dueDate:''}});
  assert.equal(stopped.status,200,await stopped.clone().text());
  assert.equal((await stopped.json()).nextTaskId,undefined);
  assert.equal((await receipts(sql,workspaceId,rollback.id)).length,0);

  const saveTask=async(data,extra)=>{
    const result=await create(data,extra);
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).record;
  };
  const {owner_id:ownerId}=(await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`)[0];
  const dateOnly=await saveTask({name:'Fictional overdue date',dueDate:'2000-01-15',repeat},{queueId,contactId:active.id,assigneeId:editorId});
  const timed=await saveTask({name:'Fictional overdue time',dueDate:'2000-02-15',dueTime:'10:00',dueTimeZone:'America/New_York',repeat});
  const future=await saveTask({name:'Fictional future repeat',dueDate:'2040-01-31',repeat});
  assert.deepEqual([dateOnly.data.repeatDueAt,timed.data.repeatDueAt],
    ['2000-01-16T05:00:00.000Z','2000-02-15T15:00:00.000Z']);
  const taskPage=await request('/?kind=tasks&record='+dateOnly.id,{headers});
  assert.equal(taskPage.status,200);
  const taskHtml=await taskPage.text();
  assert.match(taskHtml,/Set to repeat/);
  assert.match(taskHtml,/Overdue tasks also repeat when background Task processing is enabled/);

  await worker(env);
  assert.deepEqual(Array.from(await receipts(sql,workspaceId,dateOnly.id)),[],'the ordinary worker defaults to Off for overdue Task repeats');
  await worker(env,'true');
  const [dateReceipt]=await receipts(sql,workspaceId,dateOnly.id);
  assert.equal(dateReceipt?.actor_id,ownerId);
  assert.deepEqual(Array.from(await receipts(sql,workspaceId,timed.id)),[],'one pass advances at most one Task');
  assert.deepEqual(await (await get(dateOnly.id)).json(),dateOnly,'the overdue predecessor stays open and unchanged');
  const dateSuccessor=await (await get(dateReceipt.successor_id)).json();
  assert.deepEqual([dateSuccessor.data.repeatAnchorDate,dateSuccessor.data.status,dateSuccessor.completedAt,dateSuccessor.contactId,
    dateSuccessor.assigneeId,dateSuccessor.queueId],['2000-01-15','Not started',null,active.id,editorId,queueId]);
  assert.ok(Date.parse(dateSuccessor.data.repeatDueAt)>Date.now());
  assert.equal((await get(dateSuccessor.id,other)).status,404);
  assert.deepEqual(Array.from(await sql`SELECT revision,actor_id FROM portable_task_events WHERE workspace_id=${workspaceId} AND task_id=${dateSuccessor.id}`),
    [{revision:1,actor_id:ownerId}]);

  const quietResponse=await send({action:'save',kind:'tasks',data:{
    name:'Fictional quiet workspace repeat',dueDate:'2001-01-15',repeat,
  }},other);
  assert.equal(quietResponse.status,201,await quietResponse.clone().text());
  const {record:quietTask}=await quietResponse.json();
  const [quietWorkspace]=await sql`SELECT id,owner_id FROM private_workspaces WHERE owner_id=${editorId}`;
  assert.ok(quietWorkspace);
  const jobOrder=()=>sql`SELECT id,last_job_claim_at FROM private_workspaces
    WHERE id IN (${workspaceId},${quietWorkspace.id}) ORDER BY id`;
  const beforeTaskTurn=await jobOrder();
  await worker(env,'true');
  const [quietReceipt]=await receipts(sql,quietWorkspace.id,quietTask.id);
  assert.equal(quietReceipt?.actor_id,quietWorkspace.owner_id);
  assert.equal((await receipts(sql,workspaceId,timed.id)).length,0,
    'the quiet workspace gets the next turn despite older due work in the served workspace');
  assert.equal((await get(quietReceipt.successor_id)).status,404);
  assert.equal((await get(quietReceipt.successor_id,other)).status,200);
  assert.deepEqual(await jobOrder(),beforeTaskTurn,'Task service leaves ordinary job fairness unchanged');

  await Promise.all([worker(env,'true'),worker(env,'true')]);
  assert.deepEqual(Array.from(await receipts(sql,quietWorkspace.id,quietTask.id)),[quietReceipt]);
  const [timedReceipt]=await receipts(sql,workspaceId,timed.id);
  assert.equal(timedReceipt?.actor_id,ownerId);
  const timedSuccessor=await (await get(timedReceipt.successor_id)).json();
  assert.deepEqual([timedSuccessor.data.dueTime,timedSuccessor.data.dueTimeZone,timedSuccessor.data.repeatAnchorDate],
    ['10:00','America/New_York','2000-02-15']);
  assert.ok(Date.parse(timedSuccessor.data.dueAt)>Date.now());
  assert.equal((await receipts(sql,workspaceId,timed.id)).length,1);
  assert.equal((await receipts(sql,workspaceId,future.id)).length,0);
  const afterOverdue=await send(setStatus(timed,'Completed'));
  assert.equal(afterOverdue.status,200,await afterOverdue.clone().text());
  assert.equal((await afterOverdue.json()).nextTaskId,timedSuccessor.id);

  const raced=await saveTask({name:'Fictional overdue completion race',dueDate:'2000-03-15',repeat});
  const raceResponse=await changeDuringOverdueWorker(sql,env,()=>send(setStatus(raced,'Completed')));
  assert.equal(raceResponse.status,200,await raceResponse.clone().text());
  const {nextTaskId:racedNext}=await raceResponse.json();
  assert.equal((await receipts(sql,workspaceId,raced.id))[0].successor_id,racedNext);
  await worker(env,'true');
  const [{count:raceCount}]=await sql`SELECT count(*)::int AS count FROM portable_tasks
    WHERE workspace_id=${workspaceId} AND data->>'name'=${raced.data.name}`;
  assert.equal(raceCount,2,'the overdue worker and completion share one successor receipt');
  assert.deepEqual(Array.from(await receipts(sql,workspaceId,dateOnly.id)),[dateReceipt]);
  const stopping=await saveTask({name:'Fictional overdue clear race',dueDate:'2000-04-01',repeat});
  const clear=setStatus(stopping,'Not started');
  clear.data.repeat=null;
  const clearResponse=await clearDuringOverdueWorker(sql,env,workspaceId,stopping,()=>send(clear));
  assert.equal(clearResponse.status,200,await clearResponse.clone().text());
  const {record:cleared,nextTaskId:clearedNext}=await clearResponse.json();
  assert.equal(clearedNext,undefined);
  assert.deepEqual([cleared.revision,cleared.data.status,cleared.data.dueDate,cleared.data.repeat,cleared.data.repeatDueAt],
    [stopping.revision+1,'Not started',stopping.data.dueDate,undefined,undefined]);
  await worker(env,'true');
  assert.deepEqual(await (await get(cleared.id)).json(),cleared);
  await verifyNoTaskRepeat(sql,workspaceId,cleared);

  await reset();
  const broken=await saveTask({name:'Fictional invalid repeat',dueDate:'1999-01-15',repeat});
  const sameWorkspace=await saveTask({name:'Fictional healthy repeat',dueDate:'1999-02-15',repeat});
  const otherResponse=await send({action:'save',kind:'tasks',data:{
    name:'Fictional second workspace healthy repeat',dueDate:'1999-03-15',repeat,
  }},other);
  assert.equal(otherResponse.status,201,await otherResponse.clone().text());
  const {record:otherWorkspace}=await otherResponse.json();
  await sql`UPDATE portable_tasks SET data=jsonb_set(data,'{repeat,timeZone}','"Invalid/Legacy"')
    WHERE workspace_id=${workspaceId} AND id=${broken.id}`;
  await sql`UPDATE private_workspaces SET last_task_repeat_at=NULL WHERE id=${workspaceId}`;
  const readBroken=async()=>(await sql`SELECT revision,updated_at,data,repeat_retry_revision,repeat_retry_at
    FROM portable_tasks WHERE workspace_id=${workspaceId} AND id=${broken.id}`)[0];
  const beforeFailure=await readBroken();
  const failure=await worker(env,'true');
  assert.match(failure.stderr,/Portable overdue Task repeat unavailable/);
  assert.doesNotMatch(failure.stderr,/Invalid\/Legacy/);
  const cooled=await readBroken();
  assert.ok(Date.parse(cooled.repeat_retry_at)>Date.now());
  assert.deepEqual(cooled,{...beforeFailure,repeat_retry_at:cooled.repeat_retry_at,repeat_retry_revision:broken.revision},
    'deferral changes neither the Task fields nor its user-facing revision');
  assert.equal((await receipts(sql,workspaceId,broken.id)).length,0);

  await worker(env,'true');
  assert.equal((await receipts(sql,quietWorkspace.id,otherWorkspace.id)).length,1,'the other workspace gets the next turn');
  assert.equal((await receipts(sql,workspaceId,sameWorkspace.id)).length,0);
  await worker(env,'true');
  assert.equal((await receipts(sql,workspaceId,sameWorkspace.id)).length,1,'the original workspace can advance a healthy Task');
  assert.equal((await sql`SELECT due_count FROM portable_task_repeat_monitor`)[0].due_count,1,'the cooled Task is still visible in the backlog');
  assert.doesNotMatch((await worker(env,'true')).stderr,/Portable overdue Task repeat unavailable/);
  assert.deepEqual(await readBroken(),cooled,'a fresh worker process honors the cooldown');

  const waiting=await saveTask({name:'Fictional healthy Task waiting before retry',dueDate:'1999-04-15',repeat});
  await sql`UPDATE portable_tasks SET repeat_retry_at=clock_timestamp()-interval '1 second'
    WHERE workspace_id=${workspaceId} AND id=${broken.id}`;
  assert.doesNotMatch((await worker(env,'true')).stderr,/Portable overdue Task repeat unavailable/,
    'an expired cooldown does not jump ahead of healthy work that was already due');
  assert.equal((await receipts(sql,workspaceId,waiting.id)).length,1);
  assert.match((await worker(env,'true')).stderr,/Portable overdue Task repeat unavailable/,
    'the expired revision still receives a turn once the earlier waiting work is served');

  const repairTask=setStatus(broken,'Not started');
  repairTask.data.repeat=repeat;
  const repair=await send(repairTask);
  assert.equal(repair.status,200,await repair.clone().text());
  await verifyPortableTaskRepeatStatementTimeout({sql,env,workspaceId,ownerId,task:(await repair.json()).record,contactId:active.id});
  await sql`UPDATE portable_tasks SET repeat_retry_at=clock_timestamp()-interval '1 second'
    WHERE workspace_id=${workspaceId} AND id=${broken.id}`;
  await worker(env,'true');
  const [repairedReceipt]=await receipts(sql,workspaceId,broken.id);
  assert.equal(repairedReceipt?.actor_id,ownerId);
  await worker(env,'true');
  assert.deepEqual(Array.from(await receipts(sql,workspaceId,broken.id)),[repairedReceipt]);

  await reset();
  const taskArchive=await verifyPortableTaskArchive({request,origin,headers,other,sql,workspaceId,env,ownerId,editorId,queueId,active,saveTask});
  const restoredDue=await saveTask({name:'Fictional repeat pending restore',dueDate:'2000-04-15',repeat});
  await reset();
  return {workspaceId,original:repeated.record,successor:next,receipt,outstandingId:third.nextTaskId,editorId,queue,taskArchive,
    overdue:{dateOnly,dateReceipt,timed,timedReceipt,cleared,restoredDue}};
}

const taskArchiveRequest=(task,action='archive')=>({kind:'tasks',id:task.id,action,
  expectedRevision:task.revision,requestId:randomUUID()});

async function verifyPortableTaskArchive({request,origin,headers,other,sql,workspaceId,env,ownerId,editorId,queueId,active,saveTask}){
  const send=(path,body,auth=headers)=>post(request,path,origin,auth,body);
  const list=(auth=headers)=>request(bin+'?kind=tasks',{headers:auth});
  const report=async()=>{
    const response=await send('/api/reporting',{action:'preview',definition:{name:'Task archive count',kind:'tasks'}});
    assert.equal(response.status,200,await response.clone().text());
    return Number((await response.json()).result.total);
  };

  // An ordinary Task archive must be hidden by each active read, including the historical completion link.
  const historyPath=api+'?kind=tasks&completionHistoryFor='+active.id;
  const history=async()=>(await (await request(historyPath,{headers})).json()).items;
  const original=await saveTask({name:'Fictional archive visibility task'},{contactId:active.id});
  const completed=(await (await send(api,setStatus(original,'Completed'))).json()).record;
  const prior=(await history()).find(item=>item.id===original.id);
  assert.equal(prior.revision,completed.revision);
  const requestBody=taskArchiveRequest(completed);
  const tokenResponse=await send('/api/api-tokens',{name:'Fictional archive token',objects:['tasks'],permission:'read',days:30});
  assert.equal(tokenResponse.status,201,await tokenResponse.clone().text());
  const tokenHeaders={authorization:'Bearer '+(await tokenResponse.json()).token};
  const tokenPath='/api/v1/records/tasks/'+original.id;
  assert.equal((await request(tokenPath,{headers:tokenHeaders})).status,200);
  assert.equal((await list({})).status,401);
  assert.equal((await send(bin,requestBody,other)).status,404);
  assert.equal((await post(request,bin,'https://elsewhere.example.test',headers,requestBody)).status,403);
  assert.equal((await send(bin,{...requestBody,expectedRevision:original.revision})).status,409);
  const beforeCount=await report();
  const archived=await send(bin,requestBody);
  assert.equal(archived.status,200,await archived.clone().text());
  const {receipt:archivedTask}=await archived.json();
  assert.equal(archivedTask.nextTaskId,undefined);
  assert.deepEqual(await (await send(bin,requestBody)).json(),{receipt:archivedTask});
  assert.equal((await send(bin,{...requestBody,action:'restore'})).status,409);
  assert.equal((await read(request,original.id,headers)).status,404);
  assert.equal((await read(request,original.id,other,workspaceId)).status,404);
  assert.equal((await send(api,setStatus(completed,'Not started'))).status,404);
  assert.equal((await request(tokenPath,{headers:tokenHeaders})).status,404);
  const batch=await send('/api/v1/records/tasks/batch/read',{inputs:[{id:original.id}]},tokenHeaders);
  assert.equal(batch.status,207,await batch.clone().text());
  assert.equal((await batch.json()).results[0].error.status,404);
  const result=await (await send('/api/crm/search',{kind:'tasks',query:original.data.name})).json();
  assert.equal(result.total,0);
  assert.equal(await report(),beforeCount-1);
  assert.ok(!(await history()).some(item=>item.id===original.id));
  assert.ok(!(await (await request(api+'?kind=tasks&contactId='+active.id,{headers})).json()).records.some(item=>item.id===original.id));
  assert.ok((await (await list()).json()).records.some(item=>item.id===original.id));
  assert.ok(!(await (await list(other)).json()).records.some(item=>item.id===original.id));
  assert.match(await (await request('/?view=recycle-bin&kind=tasks',{headers})).text(),/Loading archived tasks/);
  const restored=await send(bin,taskArchiveRequest(archivedTask,'restore'));
  assert.equal(restored.status,200,await restored.clone().text());
  const activeAgain=(await (await read(request,original.id,headers)).json());
  assert.deepEqual([activeAgain.revision,activeAgain.completedAt],[completed.revision+2,completed.completedAt]);
  assert.deepEqual((await history()).filter(item=>item.id===original.id),[prior]);
  assert.equal(await report(),beforeCount);

  const repeating=await saveTask({name:'Fictional repeat archive rollback',dueDate:'2040-01-31',repeat},
    {contactId:active.id,assigneeId:editorId,queueId});
  const archive=taskArchiveRequest(repeating);
  await sql.unsafe(`ALTER TABLE portable_task_archive_receipts ADD CONSTRAINT fixture_task_archive_fail
    CHECK (request_id <> '${archive.requestId}'::uuid)`);
  try{
    assert.equal((await send(bin,archive)).status,503);
    assert.deepEqual(await (await read(request,repeating.id,headers)).json(),repeating);
    assert.equal((await receipts(sql,workspaceId,repeating.id)).length,0);
    const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_tasks WHERE workspace_id=${workspaceId} AND data->>'name'=${repeating.data.name}`;
    assert.equal(count,1,'a failure recording the archive rolls back the successor');
  }finally{await sql`ALTER TABLE portable_task_archive_receipts DROP CONSTRAINT fixture_task_archive_fail`;}
  const duplicate=await Promise.all([send(bin,archive),send(bin,archive)]);
  assert.deepEqual(duplicate.map(response=>response.status),[200,200]);
  const [first,second]=await Promise.all(duplicate.map(response=>response.json()));
  assert.deepEqual(first,second);
  const {receipt:repeatedArchive}=first;
  const [repeatReceipt]=await receipts(sql,workspaceId,repeating.id);
  assert.deepEqual([repeatReceipt.successor_id,repeatReceipt.actor_id],[repeatedArchive.nextTaskId,ownerId]);
  const next=(await (await read(request,repeatedArchive.nextTaskId,headers)).json());
  assert.deepEqual([next.data.dueDate,next.contactId,next.assigneeId,next.queueId],
    ['2040-02-29',active.id,editorId,queueId]);

  const overdue=await saveTask({name:'Fictional archive worker race',dueDate:'2000-05-15',repeat});
  const raced=await changeDuringOverdueWorker(sql,env,()=>send(bin,taskArchiveRequest(overdue)));
  assert.equal(raced.status,200,await raced.clone().text());
  const {receipt:racedReceipt}=await raced.json();
  assert.equal((await receipts(sql,workspaceId,overdue.id))[0].successor_id,racedReceipt.nextTaskId);
  const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_tasks
    WHERE workspace_id=${workspaceId} AND data->>'name'=${overdue.data.name}`;
  assert.equal(count,2,'worker and archive share one successor');
  return {archive,repeatedArchive};
}

export async function verifyRestoredPortableTaskRepeats({request,origin,owner,other,db,fixture,env}){
  const {workspaceId,original,successor,receipt,outstandingId,editorId,overdue}=fixture;
  assert.deepEqual(Array.from(await receipts(db,workspaceId,original.id)),[receipt]);
  const detail=await read(request,successor.id,owner);
  assert.equal(detail.status,200);
  assert.equal((await detail.json()).data.repeatAnchorDate,successor.data.repeatAnchorDate);
  assert.equal((await read(request,successor.id,other)).status,404);
  const reopened=await post(request,api,origin,owner,setStatus(original,'Not started'));
  assert.equal(reopened.status,200,await reopened.clone().text());
  const result=await post(request,api,origin,owner,setStatus((await reopened.json()).record,'Completed'));
  assert.equal(result.status,200,await result.clone().text());
  assert.equal((await result.json()).nextTaskId,successor.id);
  assert.deepEqual(Array.from(await receipts(db,workspaceId,original.id)),[receipt]);
  // Grants are deliberately excluded from backup. A new successor keeps
  // workspace/record links, but it cannot assign a former workspace editor.
  const outstanding=await (await read(request,outstandingId,owner)).json();
  assert.equal(outstanding.assigneeId,editorId);
  const advanced=await post(request,api,origin,owner,setStatus(outstanding,'Completed'));
  assert.equal(advanced.status,200,await advanced.clone().text());
  const next=await (await read(request,(await advanced.json()).nextTaskId,owner)).json();
  assert.deepEqual([next.data.dueDate,next.contactId,next.assigneeId,next.assigneeLabel],
    ['2040-04-30',outstanding.contactId,null,null]);
  await worker(env);
  assert.equal((await receipts(db,workspaceId,overdue.restoredDue.id)).length,0,'the restored worker still defaults to Off');
  await worker(env,'true');
  const [restoredDueReceipt]=await receipts(db,workspaceId,overdue.restoredDue.id);
  assert.ok(restoredDueReceipt,'the restored overdue Task advances only after an explicit worker opt-in');
  assert.deepEqual(Array.from(await receipts(db,workspaceId,overdue.dateOnly.id)),[overdue.dateReceipt]);
  assert.deepEqual(Array.from(await receipts(db,workspaceId,overdue.timed.id)),[overdue.timedReceipt]);
  await worker(env,'true');
  assert.deepEqual(await (await read(request,overdue.cleared.id,owner)).json(),overdue.cleared);
  await verifyNoTaskRepeat(db,workspaceId,overdue.cleared);
  assert.equal((await read(request,overdue.timedReceipt.successor_id,owner)).status,200);
  assert.equal((await read(request,overdue.timedReceipt.successor_id,other)).status,404);
  const {archive,repeatedArchive}=fixture.taskArchive;
  assert.equal((await read(request,archive.id,owner)).status,404);
  assert.equal((await post(request,bin,origin,other,archive)).status,404);
  assert.deepEqual(await (await post(request,bin,origin,owner,archive)).json(),{receipt:repeatedArchive});
  const restored=await post(request,bin,origin,owner,taskArchiveRequest(repeatedArchive,'restore'));
  assert.equal(restored.status,200,await restored.clone().text());
  const predecessor=await (await read(request,archive.id,owner)).json();
  const advancedAgain=await post(request,api,origin,owner,setStatus(predecessor,'Completed'));
  assert.equal(advancedAgain.status,200,await advancedAgain.clone().text());
  assert.equal((await advancedAgain.json()).nextTaskId,repeatedArchive.nextTaskId);
  assert.equal((await receipts(db,workspaceId,archive.id)).length,1);
}
