import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableTaskReminders({request,origin,headers,other,sql,sharing}){
  const path='/api/task-reminders';
  const sharedPath=path+'?workspaceId='+sharing.workspaceId;
  const tasks=[];
  const anchor=Math.floor(Date.now()/60_000)*60_000;
  const instant=minutes=>new Date(anchor+minutes*60_000).toISOString();
  const deadline=minutes=>({dueDate:instant(minutes).slice(0,10),dueTime:instant(minutes).slice(11,16),dueTimeZone:'UTC'});
  const read=(url,auth=headers)=>request(url,{headers:auth});
  const write=(url,data,auth=headers,source=origin)=>request(url,{method:'POST',
    headers:{...auth,origin:source,'content-type':'application/json'},body:JSON.stringify(data)});
  async function checked(response,status=200){
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  }
  const list=async(url=path,auth=headers)=>checked(await read(url,auth));
  const create=async(name,fields,options={})=>{
    const result=await checked(await write('/api/crm',{action:'save',kind:'tasks',data:{name,...fields},...options}),201);
    tasks.push(result.record.id);
    return result.record;
  };
  const edit=async(task,data,options={})=>{
    const result=await checked(await write('/api/crm',{action:'save',kind:'tasks',id:task.id,expectedRevision:task.revision,
      data:{name:task.data.name,...data},...options}));
    if(result.nextTaskId)tasks.push(result.nextTaskId);
    return result;
  };
  const dismiss=(task,url=path,auth=headers,source=origin)=>write(url,{id:task.id,expectedRevision:task.revision},auth,source);
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const [editor]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  await resetBudget();
  try{
    assert.equal((await read(path,{})).status,401);
    assert.equal((await read(sharedPath+'&workspaceId='+sharing.workspaceId)).status,400);
    for(const data of [{dueDate:deadline(0).dueDate,reminderMinutes:0},{...deadline(15),reminderMinutes:13}]){
      assert.equal((await write('/api/crm',{action:'save',kind:'tasks',data:{name:'Invalid reminder',...data}})).status,400);
    }
    const dateOnly=await create('Fictional date only',{dueDate:deadline(-5).dueDate});
    const legacy=await create('Fictional silent timed task',deadline(-10));
    const future=await create('Fictional future call',{...deadline(180),reminderMinutes:15});
    const upcoming=await list();
    assert.equal(upcoming.nextAt,instant(165));
    assert.ok(Number.isFinite(Date.parse(upcoming.serverNow)));
    assert.ok(!upcoming.items.some(item=>[dateOnly.id,legacy.id,future.id].includes(item.id)));
    assert.ok(!JSON.stringify(upcoming).includes(future.data.name),'a future timestamp need not disclose any record');
    assert.equal((await dismiss(future)).status,404);

    let assigned=await create('Fictional rep call',{...deadline(30),reminderMinutes:60},{assigneeId:editor.id});
    assert.ok(!(await list()).items.some(item=>item.id===assigned.id));
    assert.ok(!(await list(path,other)).items.some(item=>item.id===assigned.id));
    assert.deepEqual((await list(sharedPath,other)).items.find(item=>item.id===assigned.id),
      {id:assigned.id,revision:assigned.revision,name:assigned.data.name,remindAt:instant(-30),dueAt:instant(30)});
    assert.equal((await read(sharedPath,other)).headers.get('cache-control'),'private, no-store');
    assert.equal((await dismiss(assigned,path)).status,404);
    assert.equal((await dismiss(assigned,sharedPath,other,'https://wrong.example.test')).status,403);
    assert.deepEqual((await list(path+'?workspaceId='+randomUUID(),other)).items,[]);

    const stale=assigned;
    assigned=(await edit(assigned,{notes:'Updated by owner'})).record;
    assert.equal((await dismiss(stale,sharedPath,other)).status,404);
    assert.deepEqual(await checked(await dismiss(assigned,sharedPath,other)),{dismissed:true});
    assert.deepEqual(await checked(await dismiss(assigned,sharedPath,other)),{dismissed:true});
    assigned=(await edit(assigned,{notes:'Still dismissed after reopening Harbor'})).record;
    assert.ok(!(await list(sharedPath,other)).items.some(item=>item.id===assigned.id));

    assigned=(await edit(assigned,{...deadline(-2),reminderMinutes:0})).record;
    assert.ok((await list(sharedPath,other)).items.some(item=>item.id===assigned.id));
    // Simulate a role change by another request without disturbing the suite's
    // grant id and unrelated feature flags. A fresh read or dismissal must honor it.
    try{
      await sql`UPDATE portable_workspace_viewers SET role='viewer' WHERE id=${sharing.grantId}`;
      assert.ok(!(await list(sharedPath,other)).items.some(item=>item.id===assigned.id));
      assert.equal((await dismiss(assigned,sharedPath,other)).status,404);
    }finally{
      await sql`UPDATE portable_workspace_viewers SET role='editor' WHERE id=${sharing.grantId}`;
    }
    assigned=(await edit(assigned,{},{assigneeId:null})).record;
    assert.ok(!(await list(sharedPath,other)).items.some(item=>item.id===assigned.id));
    assert.ok((await list()).items.some(item=>item.id===assigned.id));
    assigned=(await edit(assigned,{status:'Completed'})).record;
    assert.ok(!(await list()).items.some(item=>item.id===assigned.id));
    assigned=(await edit(assigned,{status:'Not started'})).record;
    assert.ok((await list()).items.some(item=>item.id===assigned.id));
    assigned=(await edit(assigned,{dueDate:''})).record;
    assert.ok(!(await list()).items.some(item=>item.id===assigned.id));

    const daylight=await create('Fictional second 1:30 call',{dueDate:'2026-11-01',dueTime:'01:30',
      dueTimeZone:'America/New_York',dueTimeOccurrence:'later',reminderMinutes:15});
    const [daylightRow]=await sql`SELECT reminder_at FROM portable_tasks WHERE id=${daylight.id}`;
    assert.equal(new Date(daylightRow.reminder_at).toISOString(),'2026-11-01T06:15:00.000Z');
    const archived=await write('/api/recycle-bin',{kind:'tasks',action:'archive',id:daylight.id,
      expectedRevision:daylight.revision,requestId:randomUUID()});
    assert.equal(archived.status,200);
    assert.ok(!(await list()).items.some(item=>item.id===daylight.id));
    const repeating=await create('Fictional recurring call',{...deadline(-90),reminderMinutes:15,
      repeat:{every:1,unit:'days',timeZone:'UTC'}});
    const {nextTaskId}=await edit(repeating,{status:'Completed'});
    assert.ok(nextTaskId);
    const [successor]=await sql`SELECT data,reminder_at,reminder_dismissed_by FROM portable_tasks WHERE id=${nextTaskId}`;
    assert.equal(successor.data.reminderMinutes,15);
    assert.equal(+new Date(successor.reminder_at),Date.parse(successor.data.dueAt)-15*60_000);
    assert.equal(successor.reminder_dismissed_by,null);
    assert.ok(!(await list()).items.some(item=>item.id===repeating.id));

    const backlog=[];
    for(let offset=-9;offset<=-4;offset++){
      backlog.unshift(await create('Fictional follow-up '+offset,{...deadline(offset),reminderMinutes:0}));
    }
    const firstPage=await list();
    assert.equal(firstPage.more,true);
    assert.deepEqual(firstPage.items.map(item=>item.id),backlog.slice(0,5).map(task=>task.id));
    await checked(await dismiss(backlog[0]));
    const remaining=await list();
    assert.equal(remaining.more,false);
    assert.deepEqual(remaining.items.map(item=>item.id),backlog.slice(1).map(task=>task.id));
  }finally{
    if(tasks.length){
      await sql`DELETE FROM portable_task_repeat_receipts WHERE predecessor_id=ANY(${tasks}::uuid[]) OR successor_id=ANY(${tasks}::uuid[])`;
      await sql`DELETE FROM portable_task_archive_receipts WHERE task_id=ANY(${tasks}::uuid[])`;
      await sql`DELETE FROM portable_task_events WHERE task_id=ANY(${tasks}::uuid[])`;
      await sql`DELETE FROM portable_tasks WHERE id=ANY(${tasks}::uuid[])`;
    }
    await resetBudget();
  }
}
