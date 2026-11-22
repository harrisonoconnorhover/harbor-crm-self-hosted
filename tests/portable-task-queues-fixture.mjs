import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableTaskQueues({request,origin,headers,other,sharing,sql}){
  const path='/api/task-queues',taskPath='/api/crm?kind=tasks';
  const write=(url,body,auth=headers)=>request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=(url,auth=headers)=>request(url,{headers:auth});
  const taskById=async(id)=>(await read(taskPath+'&id='+id)).json();
  const assign=(queueId,...tasks)=>({action:'assign',queueId,tasks:tasks.map(task=>({id:task.id,expectedRevision:task.revision}))});
  const makeTask=async(name,auth=headers)=>{
    const response=await write('/api/crm',{action:'save',kind:'tasks',data:{name}},auth);
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const archive=async(task,auth=headers)=>{
    const response=await write('/api/recycle-bin',{kind:'tasks',action:'archive',id:task.id,
      expectedRevision:task.revision,requestId:randomUUID()},auth);
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).receipt;
  };
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudget();
  const create={action:'create',id:randomUUID(),name:'Fictional priority queue'};
  assert.equal((await read(path,{})).status,401);
  assert.equal((await write(path,create)).status,200);
  const result=await (await write(path,create)).json();
  assert.deepEqual(result,{queue:{id:create.id,name:create.name,revision:1}});
  assert.equal((await write(path,{...create,id:randomUUID(),name:create.name.toLowerCase()})).status,409);
  assert.deepEqual((await (await read(path,other)).json()).queues,[]);
  assert.equal((await read(path+'?workspaceId='+sharing.workspaceId,other)).status,403);
  assert.equal((await write(path,{action:'rename',id:create.id,revision:1,name:'Foreign rename'},other)).status,404);
  const renamed={action:'rename',id:create.id,revision:1,name:'Fictional next actions'};
  const renamedQueue=(await (await write(path,renamed)).json()).queue;
  assert.equal(renamedQueue.revision,2);
  assert.equal((await write(path,renamed)).status,409);

  const {owner_id:ownerId}=(await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`)[0];
  const companyId=sharing.companyTask.companyId;
  const fields={name:'Fictional queued task',status:'Not started',dueDate:'2099-11-30'};
  const payload={action:'save',kind:'tasks',data:fields,queueId:create.id};
  assert.equal((await write('/api/crm',payload,other)).status,404);
  const queued=await write('/api/crm',{...payload,assigneeId:ownerId,related:{kind:'companies',id:companyId}});
  assert.equal(queued.status,201);
  const {record:task}=await queued.json();
  assert.equal(task.queueId,create.id);
  const list=await (await read(taskPath+'&queueId='+create.id)).json();
  assert.deepEqual(list.records.map(item=>item.id),[task.id]);
  assert.equal((await read(taskPath+'&queueId='+create.id+'&workspaceId='+sharing.workspaceId,other)).status,400);
  const shared=await read(taskPath+'&id='+task.id+'&workspaceId='+sharing.workspaceId,other);
  assert.equal(shared.status,200);
  assert.equal((await shared.json()).queueId,null);
  const editorPath='/api/crm?workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId;
  assert.equal((await write(editorPath,{...payload,id:task.id,expectedRevision:task.revision,queueId:null},other)).status,403);
  const kept=await write(editorPath,{action:'save',kind:'tasks',id:task.id,expectedRevision:task.revision,
    data:{...fields,name:'Fictional task from editor',notes:'=1+1, "fixture"'}},other);
  assert.equal(kept.status,200);
  const {record:edited}=await kept.json();
  assert.equal(edited.queueId,null);
  const ownerTask=await (await read(taskPath+'&id='+task.id)).json();
  assert.equal(ownerTask.queueId,create.id);
  assert.equal((await write(path,{action:'remove',id:create.id,revision:2})).status,409);
  const ownerHtml=await (await read('/?kind=tasks&taskQueueId='+create.id)).text();
  assert.match(ownerHtml,/Fictional next actions/);
  assert.match(ownerHtml,/Fictional task from editor/);
  assert.match(ownerHtml,/aria-label="Select Fictional task from editor"/);
  assert.match(ownerHtml,/Export CSV/);
  const sharedHtml=await (await read('/?kind=tasks&workspaceId='+sharing.workspaceId,other)).text();
  assert.doesNotMatch(sharedHtml,/aria-label="Select Fictional task from editor"|Export CSV/);
  const workspacesLink=sharedHtml.match(/href="([^"]+)" aria-label="Workspaces"/)?.[1];
  assert.equal(workspacesLink,'/?view=workspaces&amp;workspaceId='+sharing.workspaceId);
  const switcher=await read(workspacesLink.replaceAll('&amp;','&'),other);
  assert.equal(switcher.status,200);
  assert.match(await switcher.text(),/<h1>Switch workspace<\/h1>/);
  assert.equal((await read('/?kind=tasks&taskQueueId='+create.id,other)).status,404);

  const csvPath=taskPath+'&export=csv';
  const queueCsv=csvPath+'&queueId='+create.id;
  assert.equal((await read(queueCsv,{})).status,401);
  assert.equal((await read(csvPath+'&workspaceId='+sharing.workspaceId,other)).status,403);
  assert.equal((await read(csvPath+'&workspaceId='+sharing.workspaceId)).status,403);
  assert.equal((await read(queueCsv+'&limit=501')).status,400);
  const emptyCsv=await (await read(queueCsv,other)).text();
  assert.equal(emptyCsv.trimEnd().split('\r\n').length,1);
  const filtered=await read(queueCsv+'&status=Not+started');
  assert.equal(filtered.status,200);
  assert.equal(filtered.headers.get('content-type'),'text/csv; charset=utf-8');
  assert.equal(filtered.headers.get('content-disposition'),'attachment; filename="harbor-tasks.csv"');
  assert.match(filtered.headers.get('cache-control'),/no-store/);
  const csv=await filtered.text();
  assert.equal(csv.trimEnd().split('\r\n').length,2);
  assert.ok(csv.includes('"'+task.id+'"'));
  assert.ok(csv.includes('"Fictional next actions","Company","'+companyId+'"'));
  assert.match(csv,/"'=1\+1, ""fixture"""/);
  assert.equal(await (await read(queueCsv+'&status=Completed')).text(),emptyCsv);
  const upcoming='&taskView=upcoming&taskZone=America%2FNew_York&taskAssignee=me&companyId=';
  assert.equal(await (await read(queueCsv+upcoming+companyId)).text(),csv);
  assert.equal(await (await read(queueCsv+upcoming+randomUUID())).text(),emptyCsv);

  const attributes='&taskPriority=High&taskType=Email';
  const queuedView='&queueId='+create.id+upcoming+companyId;
  const fixturePrefix='Fictional task filter '+randomUUID();
  const searchMarker='Éclair %_\\';
  const search='&'+new URLSearchParams({search:'  '+searchMarker.toLowerCase()+'  '});
  const filteredIds=(page)=>page.records.map(row=>row.id);
  try{
    // Lower IDs fail one filter each, so a query limited before filtering cannot reach the matches.
    await sql`INSERT INTO portable_tasks(workspace_id,id,revision,queue_id,company_id,assignee_id,assignee_label,data,created_at,updated_at)
      SELECT ${sharing.workspaceId},('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,1,${create.id},${companyId},${ownerId},${ownerTask.assigneeLabel},
        jsonb_build_object('name',${fixturePrefix}::text||' '||i||CASE WHEN i<=39 THEN ' '||${searchMarker}::text ELSE '' END,
          'status','Not started','dueDate','2099-11-30','priority',CASE WHEN i BETWEEN 14 AND 26 THEN 'Low' ELSE 'High' END,
          'taskType',CASE WHEN i<=13 THEN 'Call' ELSE 'Email' END)||CASE
            WHEN i BETWEEN 40 AND 52 THEN jsonb_build_object('notes','Task notes '||${searchMarker}::text)
            WHEN i=53 THEN jsonb_build_object('notes','Task notes Éclair xy')
            ELSE '{}'::jsonb END,now(),now()
      FROM generate_series(1,53) i`;
    const first=await (await read(taskPath+queuedView+attributes+search)).json();
    const second=await (await read(taskPath+queuedView+attributes+search+'&after='+first.next)).json();
    const matches=[...filteredIds(first),...filteredIds(second)];
    assert.equal(first.records.length,25);
    assert.equal(first.next,first.records.at(-1).id);
    assert.equal(second.next,null);
    assert.equal(matches.length,26);
    assert.equal(new Set(matches).size,26);
    assert.ok([...first.records,...second.records].every(row=>row.data.priority==='High'&&row.data.taskType==='Email'));
    assert.equal((await (await read(taskPath+queuedView+attributes+'&search=+&limit=50')).json()).records.length,27);
    assert.deepEqual(filteredIds(await (await read(taskPath+queuedView+attributes+'&search=%25&limit=50')).json()),matches);
    assert.deepEqual(filteredIds(await (await read(taskPath+queuedView+attributes+'&search=_&limit=50')).json()),matches);
    assert.deepEqual(filteredIds(await (await read(taskPath+queuedView+attributes+'&search=%5C&limit=50')).json()),matches);
    const html=await (await read('/?kind=tasks&taskQueueId='+create.id+upcoming+companyId+attributes+search)).text();
    assert.match(html,/Search tasks/);
    assert.match(html,/Clear search/);
    assert.match(html,/Task priority filter/);
    assert.match(html,/Task type filter/);
    assert.match(html,new RegExp(`href="[^"]*search=[^"]+&amp;taskPriority=High&amp;taskType=Email[^"]*&amp;after=${first.next}">Next page</a>`));
    assert.doesNotMatch(html,/Fictional task from editor/);
    const filteredCsv=await read(queueCsv+upcoming+companyId+attributes+search);
    assert.equal(filteredCsv.status,200);
    assert.deepEqual((await filteredCsv.text()).trimEnd().split('\r\n').slice(1).map(line=>line.split(',')[0].slice(1,-1)),matches);
    const sharedFilter=taskPath+attributes+search+'&status=Not+started&companyId='+companyId+'&workspaceId='+sharing.workspaceId+'&limit=50';
    assert.deepEqual(filteredIds(await (await read(sharedFilter,other)).json()),matches);
    assert.equal((await read(sharedFilter+'&export=csv',other)).status,403);
    assert.deepEqual(filteredIds(await (await read(taskPath+search,other)).json()),[]);
    assert.equal((await read('/?kind=tasks&record='+task.id+attributes)).status,404);
    assert.equal((await read('/?kind=tasks&record='+task.id+search)).status,200);
    assert.equal((await read(taskPath+'&id='+task.id+search)).status,400);
    assert.equal((await read(taskPath+'&id='+task.id+attributes)).status,400);
    assert.equal((await read(taskPath+'&taskPriority=Urgent')).status,400);
    assert.equal((await read(csvPath+'&taskType=Meeting')).status,400);
  }finally{
    await sql`DELETE FROM portable_tasks WHERE workspace_id=${sharing.workspaceId} AND queue_id=${create.id}
      AND starts_with(data->>'name',${fixturePrefix})`;
  }

  const fixtureName='Fictional export ceiling '+randomUUID();
  const addExportRows=(count)=>sql`INSERT INTO portable_tasks(workspace_id,id,revision,queue_id,data,created_at,updated_at)
    SELECT ${sharing.workspaceId},gen_random_uuid(),1,${create.id},
      jsonb_build_object('name',${fixtureName}::text,'status','Not started'),now(),now()
    FROM generate_series(1,${count}::integer)`;
  try{
    await addExportRows(499);
    const atLimit=await read(queueCsv);
    assert.equal(atLimit.status,200);
    assert.equal((await atLimit.text()).trimEnd().split('\r\n').length,501);
    await addExportRows(1);
    const overLimit=await read(queueCsv);
    assert.equal(overLimit.status,413);
    assert.match((await overLimit.json()).error,/more than 500 tasks/);
  }finally{
    await sql`DELETE FROM portable_tasks WHERE workspace_id=${sharing.workspaceId} AND queue_id=${create.id}
      AND data->>'name'=${fixtureName}`;
  }

  const companion=await makeTask('Fictional bulk queue companion');
  const foreign=await makeTask('Fictional foreign queue task',other);
  const foreignQueue={action:'create',id:randomUUID(),name:'Fictional foreign destination'};
  assert.equal((await write(path,foreignQueue,other)).status,200);
  assert.equal((await write(path,assign(create.id))).status,400);
  assert.equal((await write(path,assign(create.id,companion,companion))).status,400);
  assert.equal((await write(path,assign(create.id,...Array.from({length:51},()=>({id:randomUUID(),revision:1}))))).status,400);
  assert.equal((await write(path,assign(null,ownerTask,foreign))).status,404);
  assert.equal((await write(path,assign(foreignQueue.id,ownerTask,companion))).status,404);
  assert.equal((await write(path+'?workspaceId='+sharing.workspaceId,assign(null,ownerTask),other)).status,403);
  assert.deepEqual(await taskById(ownerTask.id),ownerTask);
  assert.deepEqual(await taskById(companion.id),companion);

  const assigned=await write(path,assign(create.id,ownerTask,companion));
  assert.equal(assigned.status,200,await assigned.clone().text());
  assert.deepEqual(await assigned.json(),{changed:1});
  const assignedCompanion=await taskById(companion.id);
  assert.deepEqual(assignedCompanion,{...companion,revision:companion.revision+1,queueId:create.id});
  assert.deepEqual(await taskById(ownerTask.id),ownerTask,'the Task already in the destination is unchanged');
  assert.deepEqual(await (await write(path,assign(create.id,ownerTask,assignedCompanion))).json(),{changed:0});
  assert.equal((await write(path,assign(null,ownerTask,companion))).status,409);
  assert.deepEqual(await taskById(ownerTask.id),ownerTask,'a stale selection must not move a valid Task');

  const clear=assign(null,ownerTask,assignedCompanion);
  const contenders=await Promise.all([write(path,clear),write(path,clear)]);
  assert.deepEqual(contenders.map(response=>response.status).sort(),[200,409]);
  assert.deepEqual(await contenders.find(response=>response.ok).json(),{changed:2});
  const unqueued=await taskById(task.id);
  const unqueuedCompanion=await taskById(companion.id);
  assert.deepEqual(unqueued,{...ownerTask,revision:ownerTask.revision+1,queueId:null});
  assert.deepEqual(unqueuedCompanion,{...assignedCompanion,revision:assignedCompanion.revision+1,queueId:null});
  assert.equal((await write('/api/crm',{...payload,id:task.id,expectedRevision:ownerTask.revision})).status,409,
    'an editor carrying an old assignment cannot undo the bulk update');
  assert.deepEqual((await (await read(taskPath+'&queueId='+create.id)).json()).records,[]);
  assert.ok((await (await read(taskPath+'&queueId=__none__&limit=50')).json()).records.some(row=>row.id===task.id));
  const reassigned=await write(path,assign(create.id,unqueued));
  assert.equal(reassigned.status,200);
  assert.deepEqual(await reassigned.json(),{changed:1});
  const finalTask=await taskById(task.id);
  const history=await sql`SELECT revision,actor_id,previous->>'queueId' AS old_queue,data->>'queueId' AS new_queue
    FROM portable_task_events WHERE workspace_id=${sharing.workspaceId} AND task_id=${companion.id} AND revision>${companion.revision} ORDER BY revision`;
  assert.deepEqual(Array.from(history),[
    {revision:assignedCompanion.revision,actor_id:ownerId,old_queue:null,new_queue:create.id},
    {revision:unqueuedCompanion.revision,actor_id:ownerId,old_queue:create.id,new_queue:null},
  ]);
  const archived=await archive(unqueuedCompanion);
  assert.equal((await write(path,assign(null,finalTask,archived))).status,404);
  assert.deepEqual(await taskById(task.id),finalTask);
  await archive(foreign,other);
  assert.equal((await write(path,{action:'remove',id:foreignQueue.id,revision:1},other)).status,200);


  const empty={action:'create',id:randomUUID(),name:'Fictional empty queue'};
  assert.equal((await write(path,empty)).status,200);
  assert.equal((await write(path,{action:'remove',id:empty.id,revision:2})).status,409);
  assert.equal((await write(path,{action:'remove',id:empty.id,revision:1})).status,200);
  await resetBudget();
  sharing.queueExportTask=finalTask;
  return async (restored,owner,outsider,repeatQueue)=>{
    assert.deepEqual((await (await restored(path,{headers:owner})).json()).queues,[renamedQueue,repeatQueue]);
    assert.deepEqual((await (await restored(taskPath+'&queueId='+create.id,{headers:owner})).json()).records,[finalTask]);
    assert.deepEqual((await (await restored(path,{headers:outsider})).json()).queues,[]);
    assert.equal((await restored(taskPath+'&id='+task.id,{headers:outsider})).status,404);
  };
}
