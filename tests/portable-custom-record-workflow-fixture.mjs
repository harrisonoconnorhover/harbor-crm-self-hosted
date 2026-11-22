import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyCustomRecordWorkflows({request,origin,headers,other,sql,configure,signIn}){
  const objects='/api/custom-objects',workflows='/api/workflows',team='/api/workspaces',crm='/api/crm';
  const post=(path,body,actor=headers)=>request(path,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function ok(response){
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  const read=(path,actor=headers)=>request(path,{headers:actor}).then(ok);
  const save=(path,data,actor=headers)=>post(path,data,actor).then(ok);
  const type=(id,name,actor=headers,revision=0)=>save(objects,{action:'define',id,revision,definition:{name,fields:[]}},actor);
  const source=(objectId,id=randomUUID(),name='Fictional subscription')=>({action:'save',objectId,id,name,revision:0,schemaRevision:1});
  const historyPath=(objectId,record)=>workflows+'?'+new URLSearchParams({runObjectId:objectId,runCustomRecordId:record});
  const history=(objectId,record,actor=headers)=>read(historyPath(objectId,record),actor).then(r=>r.runs);
  const setting=(definition,id=randomUUID())=>({action:'save',revision:0,id,definition});
  const enable=(id,revision=1,enabled=true)=>save(workflows,{action:'setEnabled',id,revision,enabled});

  const subscription='ffffffff-ffff-4fff-bfff-ffffffffffff',asset=randomUUID(),foreignType=randomUUID();
  for(let i=0;i<25;i++)await type(randomUUID(),'Fictional catalog type '+i);
  await type(subscription,'Subscriptions');
  await type(asset,'Hardware assets');
  await type(foreignType,'Private projects',other);
  const workspace=(await read(team)).owned;
  const old=source(subscription);
  await save(objects,old);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    page.setDefaultTimeout(10000);
    const workflowName='Start subscription onboarding',taskName='Review the subscription';
    await page.goto(origin+'/?view=workflows');
    await page.getByLabel('Workflow name',{exact:true}).fill(workflowName);
    await page.locator('select[name=trigger]').selectOption('custom_record_created');
    assert.equal(await page.locator('select[name=objectId] option[value="'+subscription+'"]').count(),0);
    await page.getByRole('button',{name:'Next custom objects'}).click();
    await page.locator('select[name=objectId]').selectOption(subscription);
    assert.equal(await page.locator('input[name=delayMinutes]:visible').count(),0);
    await page.locator('input[name=taskName]').fill(taskName);
    await page.getByRole('button',{name:'Save workflow',exact:true}).click();
    await page.getByText('Workflow saved.',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:new RegExp('^'+workflowName+' · Off')}).click();
    assert.equal(await page.locator('select[name=objectId]').inputValue(),subscription);
    assert.equal(await page.locator('select[name=objectId] option:checked').textContent(),'Subscriptions');
    await page.getByRole('button',{name:'Turn on',exact:true}).click();
    await page.getByRole('button',{name:'Turn off',exact:true}).waitFor();
    const {workflows:definitions}=await read(workflows);
    const rule=definitions.find(r=>r.definition.name===workflowName);
    assert.deepEqual([rule.enabled,rule.definition.objectId,rule.definition.delayMinutes,rule.definition.actionKind],[true,subscription,0,'task']);
    assert.deepEqual(await history(subscription,old.id),[]);

    const invalid=[
      [setting({...rule.definition,delayMinutes:1}),400],
      [setting({name:'Invalid Note',trigger:'custom_record_created',objectId:subscription,actionKind:'note',delayMinutes:0,body:'No Contact'}),400],
    ];
    for(const [body,status] of invalid)assert.equal((await post(workflows,body)).status,status);
    const denied=await post(workflows,setting({...rule.definition,objectId:foreignType}));
    assert.equal(denied.status,404,'A workflow cannot refer to a type owned by a different workspace');
    assert.equal((await read(workflows)).workflows.length,definitions.length);
    for(const params of [{runObjectId:subscription},{runCustomRecordId:old.id},{runObjectId:subscription,runCustomRecordId:old.id,runCompanyId:randomUUID()}]){
      assert.equal((await request(workflows+'?'+new URLSearchParams(params),{headers})).status,400);
    }

    const recordName='Fictional spring subscription';
    await page.goto(origin+'/?view=custom-objects&objectId='+subscription);
    await page.getByRole('link',{name:'Add record',exact:true}).click();
    await page.getByLabel('Record name',{exact:true}).fill(recordName);
    await page.getByRole('button',{name:'Save record',exact:true}).click();
    await page.getByRole('heading',{name:recordName,exact:true}).waitFor();
    const record=new URL(page.url()).searchParams.get('record');
    assert.ok(record);
    await page.getByRole('link',{name:'View record workflow runs',exact:true}).click();
    const filters=new URL(page.url()).searchParams;
    assert.deepEqual([filters.get('runObjectId'),filters.get('runCustomRecordId')],[subscription,record]);
    const [receipt]=await history(subscription,record);
    assert.deepEqual([receipt.customObjectId,receipt.customRecordId,receipt.customObjectName,receipt.customRecordName,receipt.jobId],
      [subscription,record,'Subscriptions',recordName,null]);
    await page.getByRole('link',{name:'View created Task',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),receipt.customTaskId);
    await page.getByRole('link',{name:'Open source record',exact:true}).click();
    await page.getByRole('heading',{name:recordName,exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('objectId'),subscription);
    const followUp=page.getByRole('region',{name:'Workflow tasks'});
    await followUp.getByText(/ · Open/).waitFor();
    const task=await read(crm+'?kind=tasks&id='+receipt.customTaskId);
    assert.equal(task.data.name,taskName);
    await save(crm,{action:'save',kind:'tasks',id:task.id,expectedRevision:task.revision,data:{...task.data,status:'Completed'}});
    await page.reload();
    await followUp.getByText(/ · Completed/).waitFor();
    assert.equal((await request(crm+'?kind=tasks&id='+receipt.customTaskId,{headers:other})).status,404);

    // One record ID can independently identify an asset and a subscription, even in the same workspace.
    const assetRule=setting({...rule.definition,name:'Inspect new hardware',objectId:asset,taskAssignee:'record_owner',task:{name:'Inspect the asset'}});
    await save(workflows,assetRule);await enable(assetRule.id);
    await save(objects,source(asset,record,'Fictional scanner'));
    const assetHistory=await history(asset,record);
    assert.equal(assetHistory.length,1);assert.equal(assetHistory[0].workflowName,'Inspect new hardware');
    assert.notEqual(assetHistory[0].customTaskId,receipt.customTaskId);
    assert.deepEqual(await history(subscription,record),[receipt]);
    await type(subscription,'Subscriptions',other);
    await save(objects,source(subscription,record,'Separate workspace subscription'),other);
    assert.deepEqual(await history(subscription,record,other),[]);

    const company=(await save(crm,{action:'save',kind:'companies',data:{name:'Fictional subscriber'}})).record;
    await save(objects,{...source(subscription,record,'Renamed account contract'),revision:1});
    const link={action:'link',id:record,objectId:subscription,revision:2,kind:'companies',target:company.id};
    await save(objects,link);
    await save(objects,{...link,action:'unlink',revision:3});
    await type(subscription,'Service contracts',headers,1);
    await save(objects,{action:'archive',objectId:subscription,id:record,revision:4,archived:true});
    const archived=await history(subscription,record);
    assert.equal(archived.length,1);
    assert.deepEqual([archived[0].customRecordArchived,archived[0].customRecordName,archived[0].customObjectName],[true,recordName,'Subscriptions']);
    await save(objects,{action:'archive',objectId:subscription,id:record,revision:5,archived:false});
    await configure({});
    assert.deepEqual(await history(subscription,record),[receipt]);

    const teamGrant=async body=>(await save(team,body)).viewers.find(v=>v.email==='other@example.test');
    const viewer=await teamGrant({action:'grant',email:'other@example.test'});
    const sharedPath=id=>objects+'?'+new URLSearchParams({workspaceId:workspace,grantId:id});
    const shared={...source(subscription),schemaRevision:2};
    assert.equal((await post(sharedPath(viewer.id),shared,other)).status,403);
    const editor=await teamGrant({action:'role',id:viewer.id,role:'editor'});
    const [{actor}]=await sql`SELECT id AS actor FROM login_identities WHERE email='other@example.test'`;
    await save(sharedPath(editor.id),{...shared,assigneeId:actor},other);
    const [sharedRun]=await history(subscription,shared.id);
    const [attribution]=await sql`SELECT h.actor_id, t.assignee_id=w.owner_id AS assigned_to_owner FROM portable_tasks t
      JOIN portable_task_events h ON h.workspace_id=t.workspace_id AND h.task_id=t.id AND h.revision=1
      JOIN private_workspaces w ON w.id=t.workspace_id WHERE t.workspace_id=${workspace} AND t.id=${sharedRun.customTaskId}`;
    assert.deepEqual(attribution,{actor_id:actor,assigned_to_owner:true});
    const teammate=await browser.newPage();
    const [otherCookie,otherValue]=other.cookie.split('=');
    await teammate.context().addCookies([{name:otherCookie,value:otherValue,url:origin}]);
    teammate.setDefaultTimeout(10000);
    const sharedTask='/?'+new URLSearchParams({kind:'tasks',record:sharedRun.customTaskId,workspaceId:workspace});
    const sharedDetail='/?'+new URLSearchParams({view:'custom-objects',objectId:subscription,record:shared.id,workspaceId:workspace});
    await teammate.goto(origin+sharedDetail);
    await teammate.getByRole('region',{name:'Workflow tasks'}).getByRole('link',{name:taskName,exact:true}).click();
    assert.equal(new URL(teammate.url()).searchParams.get('record'),sharedRun.customTaskId);
    await teammate.getByRole('link',{name:'Open source record',exact:true}).click();
    const related=new URL(teammate.url()).searchParams;
    assert.deepEqual([related.get('workspaceId'),related.get('objectId'),related.get('record')],[workspace,subscription,shared.id]);
    await teammate.getByRole('heading',{name:shared.name,exact:true}).waitFor();
    assert.equal(await teammate.getByRole('link',{name:'View record workflow runs',exact:true}).count(),0);
    const restricted=await teamGrant({action:'record_scope',id:editor.id,viewScope:'owned',editScope:'owned'});
    const hardware={...source(asset),assigneeId:actor};
    await save(objects,hardware);
    const hardwareDetail=objects+'?'+new URLSearchParams({workspaceId:workspace,objectId:asset,record:hardware.id});
    const hardwareTasks=(await read(hardwareDetail,other)).followUps;
    assert.equal(hardwareTasks.length,1);
    const taskRead=crm+'?'+new URLSearchParams({kind:'tasks',id:hardwareTasks[0].id,workspaceId:workspace});
    const inspection=await read(taskRead,other);
    assert.equal(inspection.assigneeId,actor);
    await save(crm+'?'+new URLSearchParams({workspaceId:workspace,grantId:restricted.id}),{action:'save',kind:'tasks',id:inspection.id,
      expectedRevision:inspection.revision,data:{...inspection.data,status:'Completed'}},other);
    assert.equal((await read(taskRead,other)).data.status,'Completed');
    const scoped=await read(objects+'?'+new URLSearchParams({workspaceId:workspace,objectId:subscription,record:shared.id}),other);
    assert.equal(scoped.record.id,shared.id);
    assert.deepEqual(scoped.followUps,[]);
    await teammate.reload();
    assert.equal(await teammate.getByRole('heading',{name:shared.name,exact:true}).count(),1);
    assert.equal(await teammate.getByRole('region',{name:'Workflow tasks'}).count(),0);
    const blocked=await request(sharedTask,{headers:other});
    assert.ok([403,404].includes(blocked.status));
    assert.ok(!(await blocked.text()).includes(shared.name));
    // Assign the previously hidden task to the rep. Each end of the link still
    // needs its own permission, even when the task and source share a workflow.
    const assigned=await read(crm+'?kind=tasks&id='+sharedRun.customTaskId);
    await save(crm,{action:'save',kind:'tasks',id:assigned.id,expectedRevision:assigned.revision,data:assigned.data,assigneeId:actor});
    const detailApi=objects+'?'+new URLSearchParams({workspaceId:workspace,objectId:subscription,record:shared.id});
    const taskReceipts=async()=>(await sql`SELECT count(*)::int AS n FROM portable_record_access_events
      WHERE workspace_id=${workspace} AND actor_id=${actor} AND kind='tasks' AND action='related' AND ${assigned.id}::uuid=ANY(record_ids)`)[0].n;
    const baseline=await taskReceipts();
    assert.equal((await request(detailApi,{method:'HEAD',headers:other})).status,200);
    assert.equal((await request(sharedDetail,{method:'HEAD',headers:other})).status,200);
    assert.equal(await taskReceipts(),baseline);
    assert.deepEqual((await read(detailApi,other)).followUps.map(row=>row.id),[assigned.id]);
    assert.equal(await taskReceipts(),baseline+1);
    await teammate.reload();
    const taskLink=teammate.getByRole('region',{name:'Workflow tasks'}).getByRole('link',{name:taskName,exact:true});
    await taskLink.waitFor();
    assert.equal(await taskReceipts(),baseline+2);
    const sourcePreviews=async()=>Number((await sql`SELECT count(*) AS count FROM portable_record_access_events
      WHERE workspace_id=${workspace} AND actor_id=${actor} AND action='related' AND kind='custom-objects'
      AND custom_object_id=${subscription} AND record_ids=ARRAY[${shared.id}::uuid]`)[0].count);
    const beforeSource=await sourcePreviews();
    assert.equal((await request(sharedTask,{method:'HEAD',headers:other})).status,200);
    assert.equal(await sourcePreviews(),beforeSource);
    await taskLink.click();
    await teammate.getByRole('link',{name:'Open source record',exact:true}).click();
    await teammate.getByRole('heading',{name:shared.name,exact:true}).waitFor();
    assert.equal(await sourcePreviews(),beforeSource+1);
    await save(objects,{...shared,revision:1,assigneeId:null});
    await teammate.goto(origin+sharedTask);
    await teammate.getByRole('heading',{name:'Edit task',exact:true}).waitFor();
    assert.equal(await teammate.getByRole('link',{name:'Open source record',exact:true}).count(),0);
    assert.equal(await sourcePreviews(),beforeSource+1);
    assert.equal((await request(detailApi,{headers:other})).status,404);
    // A manager can follow a task owned by a rep in a child team while the
    // source is theirs. Moving the rep out must remove only the task link.
    const peerEmail='invitee@example.test',parent=randomUUID(),child=randomUUID();
    // Start the independent manager scenario with a fresh fixture request window.
    await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject IN
      (SELECT owner_id FROM private_workspaces WHERE id=${workspace})`;
    await signIn(peerEmail);
    const peerGrant=(await save(team,{action:'grant',email:peerEmail})).viewers.find(v=>v.email===peerEmail);
    const peer=(await save(team,{action:'role',id:peerGrant.id,role:'editor'})).viewers.find(v=>v.email===peerEmail);
    const [{id:peerId}]=await sql`SELECT id FROM login_identities WHERE email=${peerEmail}`;
    await save(team,{action:'team_create',id:parent,name:'Fictional sales',parentId:null});
    await save(team,{action:'team_create',id:child,name:'Fictional renewals',parentId:parent});
    await save(team,{action:'team_assign',id:restricted.id,teamId:parent,previousTeamId:null});
    await save(team,{action:'team_assign',id:peer.id,teamId:child,previousTeamId:null});
    const manager=await teamGrant({action:'record_scope',id:restricted.id,viewScope:'team',editScope:'owned'});
    await save(objects,{...shared,revision:2,assigneeId:actor});
    await save(crm,{action:'save',kind:'tasks',id:assigned.id,expectedRevision:assigned.revision+1,data:assigned.data,assigneeId:peerId});
    assert.deepEqual((await read(detailApi,other)).followUps.map(row=>row.id),[assigned.id]);
    await teammate.goto(origin+sharedTask);
    await teammate.getByRole('link',{name:'Open source record',exact:true}).click();
    await teammate.getByRole('heading',{name:shared.name,exact:true}).waitFor();
    await save(team,{action:'team_assign',id:peer.id,teamId:null,previousTeamId:child});
    assert.deepEqual((await read(detailApi,other)).followUps,[]);
    assert.equal((await request(sharedTask,{headers:other})).status,404);
    await save(team,{action:'revoke',id:manager.id});
    assert.equal((await request(sharedTask,{headers:other})).status,404);
    assert.equal((await post(sharedPath(editor.id),{...shared,id:randomUUID()},other)).status,403);

    const failed={...source(subscription),schemaRevision:2};
    const before=await sql`SELECT count(*)::int AS n FROM portable_tasks WHERE workspace_id=${workspace}`;
    await sql.unsafe("ALTER TABLE portable_workflow_runs ADD CONSTRAINT fixture_custom_workflow_failure CHECK (custom_record_id <> '"+failed.id+"'::uuid) NOT VALID");
    try{
      assert.equal((await post(objects,failed)).status,503);
      assert.equal((await sql`SELECT id FROM portable_object_records WHERE workspace_id=${workspace} AND object_id=${subscription} AND id=${failed.id}`).length,0);
      const [rolledBack]=await sql`SELECT count(*)::int AS n FROM portable_tasks WHERE workspace_id=${workspace}`;
      assert.equal(rolledBack.n,before[0].n);
    }finally{await sql`ALTER TABLE portable_workflow_runs DROP CONSTRAINT fixture_custom_workflow_failure`;}
    const raced=await Promise.all([post(objects,failed),post(objects,failed)]);
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
    assert.equal((await history(subscription,failed.id)).length,1);
    const [after]=await sql`SELECT count(*)::int AS n FROM portable_tasks WHERE workspace_id=${workspace}`;
    assert.equal(after.n,before[0].n+1);
    await enable(rule.id,rule.revision,false);
    const off={...failed,id:randomUUID()};
    await save(objects,off);
    assert.deepEqual(await history(subscription,off.id),[]);
    // A renewal handoff is independent of the record's creation and its link edits.
    const handoffName='Review a transferred subscription';
    await page.goto(origin+'/?view=workflows');
    await page.getByRole('button',{name:'New workflow',exact:true}).click();
    await page.getByLabel('Workflow name',{exact:true}).fill('Subscription handoff');
    await page.locator('select[name=trigger]').selectOption('custom_record_owner_assigned');
    await page.getByRole('button',{name:'Next custom objects'}).click();
    await page.locator('select[name=objectId]').selectOption(subscription);
    await page.locator('[name=taskAssignee]').selectOption('record_owner');
    await page.getByLabel('Task name',{exact:true}).fill(handoffName);
    await page.getByRole('button',{name:'Save workflow',exact:true}).click();
    await page.getByText('Workflow saved.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Turn on',exact:true}).click();
    await page.getByRole('button',{name:'Turn off',exact:true}).waitFor();
    const ownerId=(await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspace}`)[0].owner_id;
    const handoffRecord={...source(subscription),schemaRevision:2,assigneeId:ownerId};
    await save(objects,handoffRecord);
    assert.deepEqual(await history(subscription,handoffRecord.id),[]);
    await page.goto(origin+'/?view=custom-objects&objectId='+subscription+'&record='+handoffRecord.id);
    await page.getByRole('link',{name:'Edit record',exact:true}).click();
    await page.locator('select[name=assignee]').selectOption(peerId);
    await page.getByRole('button',{name:'Save record',exact:true}).click();
    await page.getByRole('region',{name:'Workflow tasks'}).getByRole('link',{name:handoffName}).waitFor();
    const [firstHandoff]=await history(subscription,handoffRecord.id);
    const assignee=async id=>(await sql`SELECT assignee_id FROM portable_tasks WHERE workspace_id=${workspace} AND id=${id}`)[0].assignee_id;
    assert.equal(firstHandoff.customRecordRevision,2);
    assert.equal(await assignee(firstHandoff.customTaskId),peerId);
    await page.getByRole('link',{name:'View record workflow runs',exact:true}).click();
    await page.getByText(/Revision 2/).first().waitFor();
    await save(objects,{...handoffRecord,revision:2,name:'Updated subscription',assigneeId:peerId});
    await save(objects,{...handoffRecord,revision:3,assigneeId:null});
    assert.deepEqual(await history(subscription,handoffRecord.id),[firstHandoff]);
    // Both requests use the same reviewed source revision; only one can enroll.
    const reassign={...handoffRecord,revision:4};
    const simultaneous=await Promise.all([post(objects,reassign),post(objects,reassign)]);
    assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
    const runs=await history(subscription,handoffRecord.id);
    assert.deepEqual(runs.map(run=>run.customRecordRevision),[5,2]);
    assert.equal(await assignee(runs[0].customTaskId),ownerId);
    assert.deepEqual(await history(subscription,handoffRecord.id,other),[]);
    // A long-running subscription keeps its oldest handoffs reachable.
    for(let revision=5;revision<25;revision++){
      await save(objects,{...handoffRecord,revision,assigneeId:revision%2?peerId:ownerId});
    }
    const recordQuery=new URLSearchParams({objectId:subscription,record:handoffRecord.id});
    const currentTasks=await read(objects+'?'+recordQuery);
    assert.equal(currentTasks.followUps.length,20);
    assert.ok(currentTasks.nextTasks);
    const allRuns=await history(subscription,handoffRecord.id);
    assert.equal(allRuns.length,22);
    assert.deepEqual(currentTasks.followUps.map(t=>t.id),allRuns.slice(0,20).map(r=>r.customTaskId));
    await page.goto(origin+'/?view=custom-objects&'+recordQuery);
    await page.getByRole('link',{name:'Older workflow tasks'}).click();
    const oldTasks=page.getByRole('region',{name:'Workflow tasks'});
    await oldTasks.getByRole('link',{name:'Newest workflow tasks'}).waitFor();
    assert.equal(await oldTasks.getByRole('link',{name:handoffName,exact:true}).count(),2);
    assert.ok((await oldTasks.getByRole('link',{name:handoffName,exact:true}).last().getAttribute('href')).includes(firstHandoff.customTaskId));
    assert.equal(await oldTasks.getByRole('link',{name:'Older workflow tasks'}).count(),0);
    await oldTasks.getByRole('link',{name:'Newest workflow tasks'}).click();
    await oldTasks.getByRole('link',{name:'Older workflow tasks'}).waitFor();
    await save(team,{action:'tool_permissions',ids:[peer.id],tool:'tasks',policy:{view:'all',edit:'none',create:false,delete:false}});
    const transfer={...handoffRecord,revision:25,assigneeId:peerId};
    await sql`ALTER TABLE portable_workflow_runs ADD CONSTRAINT fixture_handoff_write CHECK (custom_record_revision <> 26) NOT VALID`;
    try{
      assert.equal((await post(objects,transfer)).status,503);
      const original=(await read(objects+'?'+recordQuery)).record;
      assert.equal(original.revision,25);
      assert.equal(original.data.recordOwner.userId,ownerId);
      assert.equal((await history(subscription,handoffRecord.id)).length,22);
    }finally{await sql`ALTER TABLE portable_workflow_runs DROP CONSTRAINT fixture_handoff_write`;}
    await save(objects,transfer);
    const [fallback]=await history(subscription,handoffRecord.id);
    assert.equal(fallback.customRecordRevision,26);
    assert.equal(await assignee(fallback.customTaskId),ownerId);
    assert.equal((await read(objects+'?'+recordQuery)).record.data.recordOwner.userId,peerId);

  }finally{await browser.close();}
}
