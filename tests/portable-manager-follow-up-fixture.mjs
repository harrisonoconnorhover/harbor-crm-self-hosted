import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableManagerFollowUp({request,headers,other,sql}){
  const [source,foreign,managerId,foreignOwner,pipeline,open,won,lost]=Array.from({length:8},()=>randomUUID());
  const [{id:viewer}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const screen='/?view=dashboards&workspaceId='+source;
  const read=(url,auth=other)=>request(url,{headers:auth});
  const overdue=(zone,auth=other)=>read('/api/crm?'+new URLSearchParams({kind:'tasks',taskView:'overdue',taskZone:zone,limit:'5',workspaceId:source}),auth);
  const rows=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
  const now=new Date(),when='2023-01-01T00:00:00Z',customIds={open,won,lost};
  const tasks=[],deals=[];
  function deal(name,{workspace=source,custom,stage='Qualified to buy',nextStep,archived=false,id=randomUUID()}={}){
    const data={name,stage,...(nextStep===undefined?{}:{nextStep})};
    const created=new Date(Date.UTC(2020,0,1+deals.length)).toISOString();
    deals.push({workspace_id:workspace,id,revision:1,data:sql.json(data),pipeline_id:custom?pipeline:null,
      stage_id:custom?customIds[custom]:null,created_at:created,updated_at:created,archived_at:archived?when:null});
    return id;
  }
  function task(name,{workspace=source,dealId=null,dueDate,done=false,archived=false,assigned=false}={}){
    const id=randomUUID();
    tasks.push({workspace_id:workspace,id,revision:1,deal_id:dealId,assignee_id:assigned?viewer:null,assignee_label:assigned?'Devon Rep':null,
      data:sql.json({name,taskType:'To-do',priority:'Medium',status:done?'Completed':'Not started',dueDate}),
      created_at:when,updated_at:when,archived_at:archived?when:null,completed_at:done?when:null});
    return id;
  }
  try{
    await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES (${managerId},${managerId},${managerId+'@example.test'},${now.getTime()},${now.getTime()}),
             (${foreignOwner},${foreignOwner},${foreignOwner+'@example.test'},${now.getTime()},${now.getTime()})`;
    await sql`INSERT INTO private_workspaces(id,owner_id) VALUES (${source},${managerId}),(${foreign},${foreignOwner})`;
    await sql`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role) VALUES(${source},${viewer},${randomUUID()},'viewer')`;
    const empty=await read(screen);
    assert.equal(empty.status,200);
    assert.match(await empty.text(),/Every open deal has a next step, or the pipeline is empty/);
    assert.deepEqual(await rows(await overdue('UTC')),{records:[],next:null});
    await sql`INSERT INTO deal_pipelines(workspace_id,id,name,revision) VALUES(${source},${pipeline},'Fixture pipeline',1)`;
    await sql`INSERT INTO deal_pipeline_stages(workspace_id,pipeline_id,id,name,outcome,position)
      VALUES (${source},${pipeline},${open},'Closed won','open',0),
             (${source},${pipeline},${won},'Verbal agreement','won',1),
             (${source},${pipeline},${lost},'Archived lead','lost',2)`;

    deal('Typed next step',{nextStep:'Send updated pricing'});
    const linked=deal('Already has an open task');
    deal('Builtin closed won',{stage:'Closed won'});deal('Builtin closed lost',{stage:'Closed lost'});
    deal('Custom won deal',{custom:'won'});deal('Custom lost deal',{custom:'lost'});deal('Archived deal',{archived:true});
    const expected=[deal('Unplanned deal'),deal('Custom open deal',{stage:'Closed won',custom:'open'}),
      deal('Has only a completed task'),deal('Has only an archived task'),deal('Whitespace next step',{nextStep:' \n\t '})];
    const sixth=deal('Sixth open deal');
    deal('Foreign deal',{workspace:foreign,id:expected[0]}); // Same ID tests tenant-qualified joins.
    const behind='Pacific/Pago_Pago',ahead='Pacific/Kiritimati';
    const boundary=new Intl.DateTimeFormat('en-CA',{timeZone:behind,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    const past=task('Return overdue call',{dealId:linked,dueDate:'2020-10-01',assigned:true});
    const localDay=task('Date-only boundary',{dueDate:boundary});
    task('Already completed',{done:true,dealId:expected[2],dueDate:'2020-10-01'});
    task('Archived task',{archived:true,dealId:expected[3],dueDate:'2020-10-01'});
    task('Other team task',{workspace:foreign,dealId:expected[0],dueDate:'2020-10-01'});
    await sql`INSERT INTO deals ${sql(deals)}`;
    await sql`INSERT INTO portable_tasks ${sql(tasks)}`;
    const landing=await read(screen);
    assert.equal(landing.status,200);
    const html=(await landing.text()).replaceAll('&amp;','&');
    assert.match(html,/Team follow-up/);
    assert.match(html,/5 shown · more available/);
    let prior=-1;
    for(const id of expected){
      const href='/?kind=deals&record='+id+'&workspaceId='+source;
      const index=html.indexOf(href);
      assert.ok(index>prior,'Oldest matching deals have exact workspace links in creation order.');
      prior=index;
    }
    assert.ok(!html.includes(sixth));
    for(const name of ['Typed next step','Already has an open task','Builtin closed','Custom won deal','Custom lost deal','Archived deal','Foreign deal'])assert.ok(!html.includes(name),name);
    const early=await rows(await overdue(behind)),late=await rows(await overdue(ahead));
    assert.deepEqual(early.records.map(t=>t.id),[past]);
    assert.equal(early.records[0].assigneeLabel,'Devon Rep');
    assert.equal(early.records[0].dealId,linked);
    assert.deepEqual(late.records.map(t=>t.id).sort(),[past,localDay].sort());
    assert.equal((await read('/api/crm?kind=tasks&id='+past+'&workspaceId='+source)).status,200);
    assert.equal((await read('/api/crm?id='+expected[0]+'&kind=deals&workspaceId='+source)).status,200);
    assert.equal((await read(screen,headers)).status,404);
    await sql`DELETE FROM portable_workspace_viewers WHERE workspace_id=${source} AND viewer_id=${viewer}`;
    assert.equal((await read(screen)).status,404);
    assert.equal((await overdue(ahead)).status,404);
  }finally{
    const scopes=[source,foreign];
    await sql`DELETE FROM portable_tasks WHERE workspace_id IN ${sql(scopes)}`;
    await sql`DELETE FROM deals WHERE workspace_id IN ${sql(scopes)}`;
    await sql`DELETE FROM deal_pipeline_stages WHERE workspace_id=${source}`;
    await sql`DELETE FROM deal_pipelines WHERE workspace_id=${source}`;
    await sql`DELETE FROM portable_workspace_viewers WHERE workspace_id=${source}`;
    await sql`DELETE FROM private_workspaces WHERE id IN ${sql(scopes)}`;
    await sql`DELETE FROM login_identities WHERE id IN ${sql([managerId,foreignOwner])}`;
  }
}
