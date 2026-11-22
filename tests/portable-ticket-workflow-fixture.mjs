import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const workflows='/api/workflows';
const tickets='/api/tickets';
const workflowName='Fictional resolution follow-up';
const taskName='Call the requester after resolution';

async function checked(response,status){
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}

export async function verifyTicketWorkflows({request,origin,headers,other,sql,env,configure}){
  const post=(path,data,actor=headers)=>request(path,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const get=(path,actor=headers)=>request(path,{headers:actor});
  const createContact=async(name,actor=headers)=>(await checked(await post('/api/crm',{action:'save',kind:'contacts',data:{name,city:'Boston'}},actor),201)).record;
  const ticket=async(name,ticketStatus,contactId,actor=headers)=>(await checked(await post(tickets,{action:'save',data:{name,ticketStatus},contactId},actor),201)).record;
  const change=(row,status,actor=headers)=>post(tickets,{action:'status',id:row.id,expectedRevision:row.revision,status},actor);
  const edit=(row,data,links={})=>post(tickets,{action:'save',id:row.id,expectedRevision:row.revision,data,...links});
  const state=async(id='',actor=headers)=>checked(await get(workflows+(id?'?runWorkflowId='+id:''),actor),200);
  const worker=()=>execFileSync(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once'],{
    env:{...env,HARBOR_WEBHOOK_DELIVERY_ENABLED:'false'},cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:15_000,
  });

  const requester=await createContact('Fictional requester');
  const replacement=await createContact('Fictional replacement requester');
  const outsider=await createContact('Fictional other business',other);
  const {owned:workspaceId}=await checked(await get('/api/workspaces'),200);
  await configure({HARBOR_WEBHOOK_DESTINATIONS:JSON.stringify([{workspaceId,name:'support-operations'}])});
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    page.setDefaultTimeout(10_000);
    await page.goto(origin+'/?view=workflows');
    await page.getByLabel('Workflow name',{exact:true}).fill(workflowName);
    await page.locator('select[name=trigger]').selectOption('ticket_status');
    await page.locator('select[name=ticketStatus]').selectOption('Waiting on us');
    await page.locator('select[name=actionKind]').selectOption('task');
    await page.locator('input[name=taskName]').fill(taskName);
    const save=async()=>{
      const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===workflows);
      await page.getByRole('button',{name:'Save workflow',exact:true}).click();
      assert.equal((await response).status(),200);
      await page.getByText('Workflow saved.',{exact:true}).waitFor();
    };
    await save();
    await page.reload();
    await page.getByRole('button',{name:new RegExp('^'+workflowName+' · Off')}).click();
    assert.equal(await page.locator('select[name=ticketStatus]').inputValue(),'Waiting on us');
    await page.locator('select[name=ticketStatus]').selectOption('Closed');
    // A slow server refresh must not let the owner toggle the previous revision.
    let releaseRefresh;
    const refreshGate=new Promise(resolve=>{releaseRefresh=resolve;});
    const holdRefresh=async route=>{
      if(route.request().method()==='GET')await refreshGate;
      await route.continue();
    };
    await page.route('**/*',holdRefresh);
    try{
      await save();
      assert.ok(await page.getByRole('button',{name:'Turn on',exact:true}).isDisabled());
    }finally{
      releaseRefresh();
      await page.unrouteAll({behavior:'wait'});
    }
    await page.getByRole('button',{name:'Turn on',exact:true}).click();
    await page.getByRole('button',{name:'Turn off',exact:true}).waitFor();
    const rule=(await state()).workflows.find(w=>w.definition.name===workflowName);
    assert.deepEqual([rule.enabled,rule.definition.trigger,rule.definition.ticketStatus,rule.definition.actionKind],[true,'ticket_status','Closed','task']);
    const runs=async(actor=headers)=>(await state(rule.id,actor)).runs;

    const subject='Fictional scanner resolution';
    const first=await ticket(subject,'Closed',requester.id);
    const [created]=await runs();
    assert.deepEqual([created.ticketId,created.ticketName,created.ticketRevision,created.jobStatus],[first.id,subject,1,'queued']);
    const renamed=(await checked(await edit(first,{name:'Renamed fictional resolution'},{contactId:replacement.id}),200)).record;
    assert.equal((await runs()).length,1);
    // Enrollment uses the contact and ticket revision from the original change.
    await configure({});
    worker();
    worker();
    const task=await checked(await get('/api/crm?kind=tasks&id='+created.jobId),200);
    assert.deepEqual([task.contactId,task.data.name],[requester.id,taskName]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM portable_task_events WHERE task_id=${created.jobId}`)[0].n,1);
    await page.goto(origin+'/?view=workflows&runWorkflowId='+rule.id);
    const link=page.getByRole('link',{name:subject,exact:true});
    assert.equal(await link.getAttribute('href'),'/tickets?id='+first.id);
    await link.click();
    assert.equal(new URL(page.url()).searchParams.get('id'),first.id);
    await page.goto(origin+'/?view=job-queue&jobId='+created.jobId);
    assert.ok(await page.locator('a[href="/tickets?id='+first.id+'"]').count()>0);

    await page.goto(origin+'/tickets?id='+first.id);
    await page.getByRole('link',{name:'View Ticket workflow runs',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('runTicketId'),first.id);
    await page.getByText('Showing runs for this Ticket.',{exact:false}).waitFor();
    const reopened=(await checked(await change(renamed,'New'),200)).record;
    const raced=await Promise.all([change(reopened,'Closed'),change(reopened,'Closed')]);
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
    const closed=(await raced.find(r=>r.ok).json()).record;
    const same=(await checked(await change(closed,'Closed'),200)).record;
    const entered=await runs();
    assert.deepEqual(entered.filter(r=>r.ticketId===first.id).map(r=>[r.ticketRevision,r.ticketName]).sort((a,b)=>a[0]-b[0]),
      [[first.revision,subject],[closed.revision,renamed.data.name]]);
    assert.notEqual(entered.find(r=>r.ticketRevision===closed.revision).jobId,created.jobId);
    const missing=await ticket('Fictional ticket without a requester','Closed',null);
    const skipped=(await runs()).find(r=>r.ticketId===missing.id);
    assert.deepEqual([skipped.ticketRevision,skipped.issue,skipped.jobId],[1,'missing_contact',null]);
    await ticket('Fictional other business issue','Closed',outsider.id,other);
    assert.deepEqual(await runs(other),[]);
    assert.equal((await runs()).length,3);

    const scoped=workflows+'?runTicketId='+first.id;
    const scopedRuns=await checked(await get(scoped),200);
    assert.deepEqual(scopedRuns.runs.map(row=>row.ticketRevision),[closed.revision,1]);
    const cursor=scopedRuns.runs[0];
    const older=await checked(await get(scoped+'&at='+cursor.createdAt+'&id='+cursor.id),200);
    assert.deepEqual(older.runs.map(row=>row.id),[created.id]);
    assert.deepEqual((await checked(await get(scoped,other),200)).runs,[]);
    assert.equal((await get(scoped+'&runDealId='+first.id)).status,400);
    await page.goto(origin+'/?view=workflows&runTicketId='+first.id);
    await page.getByRole('link',{name:'Missed runs to review'}).click();
    assert.equal(new URL(page.url()).searchParams.get('runTicketId'),first.id);
    await page.getByRole('link',{name:'Clear Ticket filter'}).click();
    assert.equal(new URL(page.url()).searchParams.has('runTicketId'),false);
    const archived=await checked(await post('/api/recycle-bin',{action:'archive',kind:'tickets',id:missing.id,expectedRevision:1,requestId:randomUUID()}),200);
    const archivedHistory=workflows+'?runTicketId='+missing.id;
    const [archivedSource]=(await checked(await get(archivedHistory),200)).runs;
    assert.equal(archivedSource.ticketArchived,true);
    await page.goto(origin+'/?view=workflows&runTicketId='+missing.id);
    await page.getByText(missing.data.name+' (archived)',{exact:true}).waitFor();
    assert.equal(await page.locator('a[href="/tickets?id='+missing.id+'"]').count(),0);
    await checked(await post('/api/recycle-bin',{action:'restore',kind:'tickets',id:missing.id,expectedRevision:archived.receipt.revision,requestId:randomUUID()}),200);
    const restoredRuns=(await checked(await get(archivedHistory),200)).runs;
    assert.deepEqual(restoredRuns.map(r=>[r.id,r.ticketRevision,r.ticketArchived]),[[skipped.id,1,undefined]]);
    const sharedTicket=await ticket('Fictional shared escalation','New',requester.id);
    const grantResponse=await post('/api/workspaces',{action:'grant',email:'other@example.test'});
    assert.ok(grantResponse.ok,await grantResponse.clone().text());
    const grant=(await grantResponse.json()).viewers.find(row=>row.email==='other@example.test');
    const sharedPath=tickets+'?'+new URLSearchParams({workspaceId,grantId:grant.id});
    const transition={action:'status',id:sharedTicket.id,expectedRevision:1,status:'Closed'};
    assert.equal((await post(sharedPath,transition,other)).status,403);
    const promoted=await checked(await post('/api/workspaces',{action:'role',id:grant.id,role:'editor'}),200);
    const editor=promoted.viewers.find(row=>row.email==='other@example.test');
    const editorPath=tickets+'?'+new URLSearchParams({workspaceId,grantId:editor.id});
    assert.equal((await post(sharedPath,transition,other)).status,403);
    await checked(await post(editorPath,transition,other),200);
    const [sharedRun]=(await checked(await get(workflows+'?runTicketId='+sharedTicket.id),200)).runs;
    assert.equal(sharedRun.ticketContactId,requester.id);
    const [attribution]=await sql`SELECT j.actor_id=e.actor_id AS matches,j.actor_id<>j.authorized_owner_id AS teammate
      FROM portable_jobs j JOIN portable_ticket_events e ON e.workspace_id=j.workspace_id
      WHERE e.ticket_id=${sharedTicket.id} AND e.revision=2 AND j.id=${sharedRun.jobId}`;
    assert.deepEqual(attribution,{matches:true,teammate:true});
    await checked(await post('/api/workspaces',{action:'revoke',id:editor.id}),200);
    assert.equal((await post(editorPath,{...transition,expectedRevision:2,status:'New'},other)).status,403);
    const archivedContact=await createContact('Fictional former requester');
    const unlinked=await ticket('Fictional previous contact','New',archivedContact.id);
    await checked(await post('/api/recycle-bin',{action:'archive',kind:'contacts',id:archivedContact.id,expectedRevision:archivedContact.revision,requestId:randomUUID()}),200);
    const afterArchive=(await checked(await change(unlinked,'Closed'),200)).record;
    const archivedRun=(await runs()).find(r=>r.ticketId===afterArchive.id);
    assert.deepEqual([archivedRun.issue,archivedRun.jobId],['missing_contact',null]);

    // Roll back the ticket, event and queued action together when the workflow receipt cannot be recorded.
    const rollback=await ticket('Fictional rollback case','New',requester.id);
    const jobCount=async()=>(await sql`SELECT count(*)::int AS n FROM portable_jobs WHERE workspace_id=${workspaceId}`)[0].n;
    const before=await jobCount();
    await sql.unsafe("ALTER TABLE portable_workflow_runs ADD CONSTRAINT fixture_ticket_admission_failure CHECK (ticket_id <> '"+rollback.id+"'::uuid) NOT VALID");
    try{
      assert.equal((await change(rollback,'Closed')).status,503);
      assert.equal(await jobCount(),before);
      const unchanged=await checked(await get(tickets+'?id='+rollback.id),200);
      assert.deepEqual([unchanged.revision,unchanged.data.ticketStatus],[rollback.revision,'New']);
      assert.equal((await sql`SELECT count(*)::int AS n FROM portable_ticket_events WHERE ticket_id=${rollback.id}`)[0].n,1);
    }finally{await sql`ALTER TABLE portable_workflow_runs DROP CONSTRAINT fixture_ticket_admission_failure`;}
    await checked(await edit(rollback,{name:rollback.data.name,ticketStatus:'Closed'}),200);
    assert.equal((await runs()).filter(r=>r.ticketId===rollback.id).length,1);

    const {token}=await checked(await post('/api/api-tokens',{name:'Fictional ticket intake',days:30,permissions:{tickets:'read_write'}}),201);
    const externalId=randomUUID(),creation={id:externalId,properties:{name:'Fictional API resolution',ticketStatus:'Closed'}};
    const createExternal=()=>request('/api/v1/records/tickets',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(creation)});
    const repeated=await Promise.all([createExternal(),createExternal()]);
    assert.deepEqual(repeated.map(r=>r.status).sort(),[201,409]);
    assert.deepEqual((await runs()).filter(r=>r.ticketId===externalId).map(r=>r.issue),['missing_contact']);

    await checked(await post(workflows,{action:'setEnabled',id:rule.id,revision:rule.revision,enabled:false}),200);
    const left=(await checked(await change(same,'New'),200)).record;
    await checked(await change(left,'Closed'),200);
    assert.equal((await runs()).filter(r=>r.ticketId===first.id).length,2);

    await verifyTagBranches({page,origin,save,state,post,ticket,edit,change,requester,worker,sql});

    const pathId=randomUUID(),urgentPathId=randomUUID(),branchId=randomUUID();
    const branch={name:'Fictional support handoff',trigger:'ticket_status',ticketStatus:'Waiting on us',actionKind:'conditional_paths',
      paths:[{id:urgentPathId,name:'Urgent requester',mode:'all',conditions:[{field:'name',operator:'eq',value:'Priority support'}],
        action:{kind:'webhook',destination:'support-operations',delayMinutes:0}},
        {id:pathId,name:'Boston requester',mode:'all',conditions:[{field:'city',operator:'eq',value:'Boston'}],
        action:{kind:'note',body:'Prepare the handoff',delayMinutes:0},
        then:[{id:randomUUID(),action:{kind:'webhook',destination:'support-operations',delayMinutes:0}}]}],
      otherwise:{id:randomUUID(),name:'Manual review',action:{kind:'note',body:'Review unassigned support request',delayMinutes:0}}};
    await checked(await post(workflows,{action:'save',id:branchId,revision:0,definition:branch}),200);
    await checked(await post(workflows,{action:'setEnabled',id:branchId,revision:1,enabled:true}),200);
    const waiting=await ticket('Fictional service follow-up','Waiting on us',requester.id);
    let [handoff]=(await state(branchId)).runs;
    assert.deepEqual(handoff.pathSteps.map(step=>step.status),['queued',null]);
    for(let i=0;i<16&&!handoff.pathSteps[1].jobId;i++){
      worker();
      [handoff]=(await state(branchId)).runs;
    }
    assert.deepEqual(handoff.pathSteps.map(step=>step.status),['succeeded','queued']);
    await page.goto(origin+'/?view=job-queue&jobId='+handoff.jobId);
    await page.locator('a[href="/tickets?id='+waiting.id+'"]').first().waitFor();
    assert.deepEqual([handoff.pathId,handoff.ticketId,handoff.jobKind,handoff.jobStatus],[pathId,waiting.id,'external','queued']);
    const [metadata]=await sql`SELECT object_kind,record_id,record_revision FROM portable_workflow_webhook_jobs WHERE workspace_id=${workspaceId} AND job_id=${handoff.jobId}`;
    assert.deepEqual({...metadata},{object_kind:'tickets',record_id:waiting.id,record_revision:1});
    const priority=await createContact('Priority support');
    const directTicket=await ticket('Immediate support handoff','Waiting on us',priority.id);
    const direct=(await state(branchId)).runs.find(run=>run.ticketId===directTicket.id);
    assert.deepEqual([direct.pathId,direct.jobKind,direct.jobStatus,direct.pathSteps],[urgentPathId,'external','queued',undefined]);
  }finally{await browser.close();}
}


async function verifyTagBranches({page,origin,save,state,post,ticket,edit,change,requester,worker,sql}){
  const name='Fictional warranty follow-up',label='Warranty, West';
  await page.goto(origin+'/?view=workflows');
  await page.getByLabel('Workflow name',{exact:true}).fill(name);
  await page.locator('select[name=trigger]').selectOption('ticket_status');
  await page.locator('select[name=ticketStatus]').selectOption('Closed');
  await page.locator('select[name=actionKind]').selectOption('conditional_paths');
  const first=page.getByRole('group',{name:'If',exact:true}),otherwise=page.getByRole('group',{name:'Otherwise',exact:true});
  await first.getByLabel(/^Path name/).fill('Warranty specialist');
  await first.getByLabel(/^Property/).selectOption('ticketTags');
  assert.equal(await first.getByLabel(/^Operator/).inputValue(),'has_tag');
  await first.getByLabel(/^Value/).fill(label);
  await first.getByRole('button',{name:'Add condition',exact:true}).click();
  const excluded=first.getByRole('group',{name:'Condition 2',exact:true});
  await excluded.getByLabel(/^Property/).selectOption('ticketTags');
  await excluded.getByLabel(/^Operator/).selectOption('lacks_tag');
  await excluded.getByLabel(/^Value/).fill('duplicate');
  await first.getByLabel(/^Note text/).fill('Send to the warranty specialist');
  await otherwise.getByLabel(/^Note text/).fill('General support follow-up');
  const map=page.getByRole('region',{name:'Workflow map',exact:true});
  await map.getByRole('button',{name:'Test paths'}).click();
  for(const [tags,selected] of [['Warranty','Otherwise'],['WARRANTY, WEST','Warranty specialist'],
    ['warranty, west\nDuplicate','Otherwise'],['warranty, west\nHardware','Warranty specialist']]){
    await map.getByLabel('Sample ticket tags',{exact:true}).fill(tags);
    await map.getByText('Selected path: '+selected,{exact:true}).waitFor();
  }
  const sample=map.getByLabel('Sample ticket tags',{exact:true});
  const include=first.getByRole('group',{name:'Condition 1',exact:true});
  await include.getByLabel(/^Operator/).selectOption('unknown');
  await sample.fill('');
  await map.getByText('Selected path: Warranty specialist',{exact:true}).waitFor();
  await include.getByLabel(/^Operator/).selectOption('known');
  await map.getByText('Selected path: Otherwise',{exact:true}).waitFor();
  await sample.fill('hardware');
  await map.getByText('Selected path: Warranty specialist',{exact:true}).waitFor();
  await include.getByLabel(/^Operator/).selectOption('has_tag');
  await include.getByLabel(/^Value/).fill(label);
  await save();
  const workflow=(await state()).workflows.find(item=>item.definition.name===name);
  assert.ok(workflow);
  for(const invalid of [
    {...workflow.definition,trigger:'manual_contact',ticketStatus:undefined},
    {...workflow.definition,paths:[{...workflow.definition.paths[0],conditions:[{field:'ticketTags',operator:'contains',value:'West'}]}]},
  ])assert.equal((await post(workflows,{action:'save',id:randomUUID(),revision:0,definition:invalid})).status,400);
  await checked(await post(workflows,{action:'setEnabled',id:workflow.id,revision:workflow.revision,enabled:true}),200);
  for(const [tags,expected] of [[[label,'hardware'],'Warranty specialist'],[['extended warranty, west'],'Otherwise'],[[label,'duplicate'],'Otherwise'],[[],'Otherwise']]){
    const fresh=await ticket('Warranty case','New',requester.id);
    const tagged=(await checked(await edit(fresh,{name:fresh.data.name,tags}),200)).record;
    const closed=(await checked(await change(tagged,'Closed'),200)).record;
    // A tag edit after enrollment must preserve the original path and its action.
    await checked(await edit(closed,{name:closed.data.name,tags:['reclassified']}),200);
    let run;
    for(let i=0;i<16;i++){
      const matching=(await state(workflow.id)).runs.filter(item=>item.ticketId===fresh.id);
      assert.equal(matching.length,1);
      run=matching[0];
      assert.equal(run.pathName,expected);
      if(run.jobStatus==='succeeded')break;
      worker();
    }
    assert.equal(run.jobStatus,'succeeded');
    const notes=await sql`SELECT body FROM portable_notes WHERE job_id=${run.jobId}`;
    assert.deepEqual(Array.from(notes),[{body:expected==='Otherwise'?'General support follow-up':'Send to the warranty specialist'}]);
  }
}
