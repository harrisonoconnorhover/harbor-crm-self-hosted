import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyCompanyWorkflows({request,origin,headers,other,sql,configure}){
  const workflows='/api/workflows',crm='/api/crm',imports='/api/crm/import';
  const workflowName='Onboard a new fictional company',taskName='Review the new company';
  const post=(path,data,actor=headers)=>request(path,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  async function checked(response,status){
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  }
  const read=(path,actor=headers)=>request(path,{headers:actor}).then(response=>checked(response,200));
  const createCompany=async(name,actor=headers,path=crm)=>(await checked(await post(path,{action:'save',kind:'companies',data:{name}},actor),201)).record;
  const [initial]=await Promise.all([createCompany('Pre-existing fictional company'),createCompany('Other pre-existing company',other)]);
  const {owned:workspaceId}=await read('/api/workspaces');
  const [{owner_id:workspaceOwner}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    page.setDefaultTimeout(10000);
    await page.goto(origin+'/?view=workflows');
    await page.getByLabel('Workflow name',{exact:true}).fill(workflowName);
    await page.locator('select[name=trigger]').selectOption('company_created');
    assert.equal(await page.locator('input[name=delayMinutes]:visible').count(),0);
    await page.getByRole('combobox',{name:/Assign task to/}).selectOption('record_owner');
    await page.locator('input[name=taskName]').fill(taskName);
    await page.locator('select[name=taskPriority]').selectOption('High');
    await page.getByRole('button',{name:'Save workflow',exact:true}).click();
    await page.getByText('Workflow saved.',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:new RegExp('^'+workflowName+' · Off')}).click();
    assert.equal(await page.locator('select[name=trigger]').inputValue(),'company_created');
    assert.equal(await page.locator('input[name=taskName]').inputValue(),taskName);
    assert.equal(await page.getByRole('combobox',{name:/Assign task to/}).inputValue(),'record_owner');
    await page.getByRole('button',{name:'Turn on',exact:true}).click();
    await page.getByRole('button',{name:'Turn off',exact:true}).waitFor();
    const rule=(await read(workflows)).workflows.find(w=>w.definition.name===workflowName);
    assert.deepEqual([rule.enabled,rule.definition.trigger,rule.definition.actionKind,rule.definition.delayMinutes],[true,'company_created','task',0]);
    const runs=async(companyId,actor=headers)=>(await read(workflows+'?'+new URLSearchParams({runWorkflowId:rule.id,...(companyId?{runCompanyId:companyId}:{})}),actor)).runs;
    async function checkTask(company,expectedAssignee=company.data?.recordOwner?.userId??workspaceOwner){
      const records=await runs(company.id);
      assert.equal(records.length,1,'One workflow run per Company created');
      const [run]=records;
      assert.deepEqual([run.companyId,run.companyRevision,run.jobId],[company.id,1,null]);
      assert.ok(run.companyTaskId);
      const task=await read(crm+'?kind=tasks&id='+run.companyTaskId);
      assert.deepEqual([task.data.name,task.data.priority,task.companyId,task.contactId],[taskName,'High',company.id,null]);
      assert.equal(task.assigneeId,expectedAssignee);
      const links=await sql`SELECT id FROM portable_tasks WHERE workspace_id=${workspaceId} AND company_id=${company.id}`;
      assert.deepEqual(links.map(t=>t.id),[run.companyTaskId]);
      return run;
    }
    assert.deepEqual(await runs(initial.id),[],'Activation only enrolls future Companies');
    for(const definition of [{...rule.definition,delayMinutes:5},{name:'Invalid note',trigger:'company_created',actionKind:'note',delayMinutes:0,body:'Unlinked note'}]){
      assert.equal((await post(workflows,{action:'save',id:randomUUID(),revision:0,definition})).status,400);
    }
    await page.goto(origin+'/?kind=companies');
    await page.getByRole('button',{name:'Add company',exact:true}).click();
    await page.locator('form.portable-record-editor input[name=name]').fill('Fictional unstaffed company');
    await page.getByRole('button',{name:'Save company',exact:true}).click();
    await page.getByText('Company added.',{exact:true}).waitFor();
    const found=await read(crm+'?kind=companies&search=Fictional%20unstaffed%20company');
    assert.equal(found.records.length,1);
    const [company]=found.records;
    const first=await checkTask(company);
    assert.equal(first.companyName,company.data.name);
    await page.goto(origin+'/?kind=companies&record='+company.id);
    await page.getByRole('link',{name:'View Company workflow runs',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('runCompanyId'),company.id);
    await page.getByText('Completed · Company task created',{exact:false}).waitFor();
    assert.equal(await page.getByRole('link',{name:company.data.name,exact:true}).getAttribute('href'),'/?kind=companies&record='+company.id);
    await page.getByRole('link',{name:'View created Task',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),first.companyTaskId);
    await checked(await post(crm,{action:'save',kind:'companies',id:company.id,expectedRevision:1,data:{name:'Fictional renamed company'}}),200);
    for(const name of ['Fictional account lead','Fictional account buyer']){
      await checked(await post(crm,{action:'save',kind:'contacts',primaryCompanyId:company.id,data:{name}}),201);
    }
    await configure({}); // Restart the web process and reread the persisted receipt.
    assert.equal((await checkTask(company)).companyTaskId,first.companyTaskId);
    const recycle=(kind,id,expectedRevision,action)=>post('/api/recycle-bin',{kind,id,expectedRevision,action,requestId:randomUUID()}).then(r=>checked(r,200));
    await recycle('tasks',first.companyTaskId,1,'archive');
    await recycle('companies',company.id,2,'archive');
    const [archived]=await runs(company.id);
    assert.deepEqual([archived.companyArchived,archived.companyTaskArchived,archived.companyName],[true,true,company.data.name]);
    await page.goto(origin+'/?view=workflows&runCompanyId='+company.id);
    await page.getByText(company.data.name+' (archived)',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'View created Task',exact:true}).count(),0);
    await recycle('companies',company.id,3,'restore');
    await recycle('tasks',first.companyTaskId,2,'restore');
    assert.deepEqual(await runs(company.id),[first]);
    const foreign=await createCompany('Fictional independent business',other);
    assert.deepEqual(await runs(foreign.id),[]);
    assert.deepEqual(await runs(company.id,other),[]);
    assert.equal((await request(crm+'?kind=tasks&id='+first.companyTaskId,{headers:other})).status,404);

    async function importTwice(kind,csv,actor=headers){
      const preview=await checked(await post(imports,{action:'preview',kind,csv},actor),200);
      assert.equal(preview.errors,0);
      const data={action:'import',kind,csv,review:preview.review,requestId:randomUUID()};
      const responses=await Promise.all([post(imports,data,actor),post(imports,data,actor)]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
    }
    await importTwice('companies','Company Name,Company Domain\nFictional direct CSV,bulk-co.example.test\nFictional second CSV,second-co.example.test');
    await importTwice('paired','Contact Name,Contact Email,Company Name,Company Domain\nFictional buyer,buyer@paired.example.test,Fictional paired CSV,paired.example.test\nFictional rep,rep@paired.example.test,Fictional paired CSV,paired.example.test');
    const imported=(await read(crm+'?kind=companies&search=CSV')).records;
    assert.equal(imported.length,3);
    for(const row of imported)await checkTask(row);
    const [{count:pairedContacts}]=await sql`SELECT count(*)::int AS count FROM contacts c JOIN companies co
      ON co.id=c.primary_company_id AND co.workspace_id=c.workspace_id WHERE c.workspace_id=${workspaceId} AND co.data->>'domain'='paired.example.test'`;
    assert.equal(pairedContacts,2);

    const access=await post('/api/workspaces',{action:'grant',email:'other@example.test'});
    assert.ok(access.ok,await access.clone().text());
    const viewer=(await access.json()).viewers.find(row=>row.email==='other@example.test');
    const sharedPath=grant=>crm+'?'+new URLSearchParams({workspaceId,grantId:grant.id});
    const sharedSave={action:'save',kind:'companies',data:{name:'Fictional teammate company'}};
    assert.equal((await post(sharedPath(viewer),sharedSave,other)).status,403);
    const promoted=await checked(await post('/api/workspaces',{action:'role',id:viewer.id,role:'editor'}),200);
    const editor=promoted.viewers.find(row=>row.email==='other@example.test');
    const shared=await createCompany(sharedSave.data.name,other,sharedPath(editor));
    const sharedRun=await checkTask(shared);
    const [attribution]=await sql`SELECT te.actor_id = ce.actor_id AS same_actor, t.assignee_id=w.owner_id AS owner_assigned,
      ce.actor_id<>w.owner_id AS teammate_created FROM portable_tasks t JOIN private_workspaces w ON w.id=t.workspace_id
      JOIN portable_task_events te ON te.workspace_id=t.workspace_id AND te.task_id=t.id AND te.revision=1
      JOIN company_events ce ON ce.workspace_id=t.workspace_id AND ce.company_id=t.company_id AND ce.revision=1
      WHERE t.workspace_id=${workspaceId} AND t.id=${sharedRun.companyTaskId}`;
    assert.deepEqual(attribution,{same_actor:true,owner_assigned:true,teammate_created:true});
    const [{rep}]=await sql`SELECT id AS rep FROM login_identities WHERE email='other@example.test'`;
    const {record:ownedCompany}=await checked(await post(crm,{...sharedSave,assigneeId:rep}),201);
    const ownedRun=await checkTask(ownedCompany);
    const [ownedTask]=await sql`SELECT t.assignee_id,t.assignee_label,h.actor_id=w.owner_id AS created_by_owner FROM portable_tasks t
      JOIN private_workspaces w ON w.id=t.workspace_id JOIN portable_task_events h ON h.workspace_id=t.workspace_id AND h.task_id=t.id
      WHERE t.workspace_id=${workspaceId} AND t.id=${ownedRun.companyTaskId} AND h.revision=1`;
    assert.deepEqual(ownedTask,{assignee_id:rep,assignee_label:ownedCompany.data.recordOwner.label,created_by_owner:true});
    const restricted=await checked(await post('/api/workspaces',{action:'tool_permissions',ids:[editor.id],tool:'tasks',
      policy:{view:'all',edit:'none',create:false,delete:false}}),200);
    const {record:restrictedCompany}=await checked(await post(crm,{...sharedSave,assigneeId:rep}),201);
    assert.equal(restrictedCompany.data.recordOwner.userId,rep);
    await checkTask(restrictedCompany,workspaceOwner);
    await checked(await post('/api/workspaces',{action:'revoke',id:restricted.viewers.find(row=>row.email==='other@example.test').id}),200);
    assert.equal((await post(sharedPath(editor),sharedSave,other)).status,403);

    const {token}=await checked(await post('/api/api-tokens',{name:'Fictional Company API',days:30,permissions:{companies:'read_write'}}),201);
    const id=randomUUID();
    const external=()=>request('/api/v1/records/companies',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({id,properties:{name:'Fictional replayed Company'}})});
    // Fail enrollment after company creation. Both the originating write and the Task must roll back.
    await sql.unsafe("ALTER TABLE portable_workflow_runs ADD CONSTRAINT fixture_company_workflow_failure CHECK (company_id <> '"+id+"'::uuid) NOT VALID");
    try{
      const response=await external();
      assert.ok(response.status>=500,'Injected receipt failure should fail the whole write');
      const [failed]=await sql`SELECT (SELECT count(*)::int FROM companies WHERE workspace_id=${workspaceId} AND id=${id}) AS companies,
        (SELECT count(*)::int FROM portable_tasks WHERE workspace_id=${workspaceId} AND company_id=${id}) AS tasks`;
      assert.deepEqual(failed,{companies:0,tasks:0});
    }finally{await sql`ALTER TABLE portable_workflow_runs DROP CONSTRAINT fixture_company_workflow_failure`;}
    const retry=await Promise.all([external(),external()]);
    assert.deepEqual(retry.map(response=>response.status).sort(),[201,409]);
    await checkTask({id});
    await checked(await post(workflows,{action:'setEnabled',id:rule.id,revision:rule.revision,enabled:false}),200);
    const off=await createCompany('Fictional company after disabling');
    assert.deepEqual(await runs(off.id),[]);
    const remaining=await sql`SELECT id FROM portable_tasks WHERE workspace_id=${workspaceId} AND company_id=${off.id}`;
    assert.equal(remaining.length,0);

    // Exercise the supported import and workflow limits together, including a repeated commit.
    const {owned:scaleWorkspace}=await read('/api/workspaces',other);
    for(let i=0;i<20;i++){
      const id=randomUUID();
      await checked(await post(workflows,{action:'save',id,revision:0,definition:{...rule.definition,name:'Account handoff '+i}},other),200);
      await checked(await post(workflows,{action:'setEnabled',id,revision:1,enabled:true},other),200);
    }
    const rows=Array.from({length:500},(_,i)=>'Fictional scale company '+i+',scale-'+i+'.example.test');
    await importTwice('companies',['Company Name,Company Domain',...rows].join('\n'),other);
    const [scale]=await sql`SELECT count(DISTINCT r.company_id)::int AS companies,
      count(DISTINCT r.company_task_id)::int AS tasks, count(*)::int AS receipts
      FROM portable_workflow_runs r JOIN companies c ON c.workspace_id=r.workspace_id AND c.id=r.company_id
      WHERE c.workspace_id=${scaleWorkspace} AND c.data->>'name' LIKE 'Fictional scale company %'`;
    assert.deepEqual(scale,{companies:500,tasks:10000,receipts:10000});
  }finally{await browser.close();}
}
