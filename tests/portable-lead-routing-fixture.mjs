import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {verifyInboundSalesRouting} from './portable-inbound-sales-fixture.mjs';

export async function verifyLeadRouting({request,origin,headers,other,sql,env,configureWeb}){
  const path='/api/leads',settings=path+'?view=routing',workspaces='/api/workspaces';
  const get=(url,auth=headers)=>request(url,{headers:auth});
  const post=(url,body,auth=headers)=>request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function json(pending,status=200){
    const response=await pending;
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  }
  const change=body=>json(post(workspaces,body));
  const workspace=(await json(get(workspaces))).owned;
  const emails=['other@example.test','invitee@example.test'];
  const userIds=Object.fromEntries((await sql`SELECT email,id FROM login_identities WHERE email IN ${sql(emails)}`).map(row=>[row.email,row.id]));
  const members=[];
  for(const email of emails){
    const rep=(await change({action:'grant',email})).viewers.find(row=>row.email===email);
    const result=await change({action:'role',id:rep.id,role:'editor'});
    members.push(result.viewers.find(row=>row.email===email));
  }
  async function withPage(visit,account=headers,options){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const page=await browser.newPage(options);
      const [name,value]=account.cookie.split('=');
      await page.context().addCookies([{name,value,url:origin}]);
      await visit(page);
    }finally{await browser.close();}
  }
  const pool=async()=>(await json(get(settings))).members;
  const rule=async(index)=>{
    const {label,...config}=(await pool()).find(row=>row.memberId===members[index].id);
    assert.ok(label);
    return config;
  };
  const configure=async(index,changes)=>json(post(settings,{...await rule(index),...changes}));
  const details=async id=>json(get(path+'?id='+id));
  const create=async(name,options={})=>{
    const {id}=await json(post(path,{action:'save',data:{name},...options}),201);
    return details(id);
  };
  const close=lead=>json(post(path,{action:'save',id:lead.id,expectedRevision:lead.revision,data:{name:lead.data.name,leadStage:'Qualified'}}));
  const retry=lead=>json(post(path,{action:'route',id:lead.id,expectedRevision:lead.revision}));
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await reset();
  const run=promisify(execFile);
  const tick=(args=[],enabled='true')=>run(process.execPath,[process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs','worker','--once',...args],{
    cwd:process.env.HARBOR_TEST_PORTABLE_CWD,env:{...env,HARBOR_LEAD_ROUTING_RETRY_ENABLED:enabled},timeout:20000,
  });
  async function verifyBackgroundRouting(){
    const original=await create('Lead before background routing was enabled');
    assert.equal(original.routingPending,false);
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'true'});
    const waiting=await create('Waiting for a rep to return');
    const manual=await create('Intentionally unassigned',{assigneeId:null});
    const removed=await create('Take out of rotation');
    const closed=await create('Closed before routing');
    assert.equal(waiting.routingPending,true);
    assert.equal(manual.routingPending,false);
    const pendingPage=await get('/?kind=leads&record='+waiting.id);
    assert.match(await pendingPage.text(),/Waiting for automatic routing/);
    await withPage(async browserPage=>{
      await browserPage.goto(origin+'/?kind=leads&record='+removed.id);
      const editor=browserPage.getByRole('form',{name:'Edit lead'});
      await editor.locator('select[name="assigneeId"]').selectOption('');
      const saved=browserPage.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
      await editor.getByRole('button',{name:'Save lead'}).click();
      assert.equal((await saved).status(),200);
    });
    await close(closed);
    const preview=()=>json(get(path+'?view=routing-preview&id='+waiting.id));
    const initial=await preview();
    assert.equal(initial.lastMiss,undefined);
    const started=Date.now();
    await tick();
    const [deferred]=await sql`SELECT routing_retry_at>now()+interval '4 minutes' AS deferred FROM portable_leads WHERE id=${waiting.id}`;
    assert.ok(deferred.deferred);
    const firstMiss=(await preview()).lastMiss;
    assert.deepEqual(firstMiss.counts,initial.counts);
    assert.ok(Date.parse(firstMiss.checkedAt)>=started&&Date.parse(firstMiss.checkedAt)<=Date.now());
    await configure(0,{available:true});
    const team='/api/workspaces?'+new URLSearchParams({team:'booking',workspaceId:workspace,grantId:members[0].id});
    const [dates]=await sql`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today,((now() AT TIME ZONE 'UTC')::date+2)::text AS later`;
    const today={from:dates.today,through:dates.today,timeZone:'UTC'};
    const changeLeave=async(period,operation='add')=>{
      const {revision}=await json(get(team,other));
      await json(post(team,{action:'timeOff',revision,operation,period},other));
    };
    const fmt=offset=>new Date(Date.now()+offset*60000).toISOString().slice(0,16).split('T');
    const [from,startTime]=fmt(-20),[through,endTime]=fmt(20);
    const breakTime={from,through,startTime,endTime,timeZone:'UTC'};
    await changeLeave(breakTime);
    assert.ok((await preview()).next);
    await changeLeave({...breakTime,pauseLeadRouting:true});
    assert.equal((await preview()).counts.timeOff,1);
    const onBreak=await create('Inquiry during a short break');
    assert.equal(onBreak.assigneeId,null);
    assert.equal((await retry(onBreak)).routing,'unavailable');
    // Cross the saved end instant on the disposable database without making the rep click Resume.
    await sql`UPDATE portable_team_availability SET time_off=jsonb_set(time_off,'{0,endMs}',
      to_jsonb(floor(extract(epoch FROM now())*1000)::bigint)) WHERE workspace_id=${workspace} AND user_id=${userIds[emails[0]]}`;
    assert.equal((await retry(onBreak)).routing,'assigned');
    await changeLeave(breakTime,'remove');
    await close(await details(onBreak.id));
    await changeLeave({...today,from:dates.later,through:dates.later,pauseLeadRouting:true});
    await changeLeave(today);
    assert.ok((await preview()).next,'Future leave and calendar-only leave allow assignment today.');
    const calendarOnly=await create('Lead during calendar-only absence');
    assert.equal(calendarOnly.assigneeId,userIds[emails[0]]);
    await close(calendarOnly);
    await changeLeave({...today,pauseLeadRouting:true});
    await changeLeave(today); // An older calendar client can repeat the save without changing lead routing.
    assert.equal((await preview()).counts.timeOff,1);
    await sql`UPDATE portable_leads SET routing_retry_at=now() WHERE id=${waiting.id}`;
    await tick();
    assert.equal((await details(waiting.id)).assigneeId,null);
    const latestMiss=(await preview()).lastMiss;
    assert.equal(latestMiss.counts.timeOff,1);
    assert.ok(Date.parse(latestMiss.checkedAt)>Date.parse(firstMiss.checkedAt));
    await configure(1,{available:true});
    const nowReady=await preview();
    assert.ok(nowReady.next);
    assert.deepEqual(nowReady.lastMiss,latestMiss);
    await withPage(async page=>{
      await page.setViewportSize({width:390,height:844});
      await page.goto(origin+'/?kind=leads&record='+waiting.id);
      await page.getByRole('button',{name:'Preview routing'}).click();
      const receipt=page.getByRole('region',{name:'Last automatic check'});
      await receipt.getByText('Scheduled time off · 1',{exact:true}).waitFor();
      assert.equal(await receipt.locator('time').getAttribute('datetime'),latestMiss.checkedAt);
      await page.getByText('Next in line: '+nowReady.next,{exact:true}).waitFor();
    });
    const coverage=await create('Covered by another sales rep');
    assert.equal(coverage.assigneeId,userIds[emails[1]]);
    const direct=await create('Explicit assignment during leave',{assigneeId:userIds[emails[0]]});
    assert.equal(direct.assigneeId,userIds[emails[0]]);
    await close(coverage);await close(direct);
    await configure(1,{available:false});
    await changeLeave({...today,pauseLeadRouting:false});
    assert.ok((await preview()).next);
    await changeLeave({...today,from:dates.later,through:dates.later},'remove');
    await changeLeave({...today,pauseLeadRouting:true});
    assert.equal((await preview()).counts.timeOff,1);
    // Advance the end of this saved absence on the disposable database to exercise automatic return.
    await sql`UPDATE portable_team_availability
      SET time_off=jsonb_set(time_off,'{0,endMs}',to_jsonb(floor(extract(epoch FROM now())*1000)::bigint))
      WHERE workspace_id=${workspace} AND user_id=${userIds[emails[0]]}`;
    assert.ok((await preview()).next);
    await sql`UPDATE portable_leads SET routing_retry_at=now() WHERE id=${waiting.id}`;
    await tick(['--notes-only']);
    await tick([],'false');
    assert.equal((await details(waiting.id)).assigneeId,null);
    await tick();
    await tick();
    const assigned=await details(waiting.id);
    assert.equal(assigned.assigneeId,userIds[emails[0]]);
    assert.equal(assigned.routingPending,false);
    assert.equal((await sql`SELECT routing_miss FROM portable_leads WHERE id=${waiting.id}`)[0].routing_miss,null);
    assert.equal(assigned.revision,waiting.revision+1);
    const history=await json(get(path+'?view=history&id='+waiting.id));
    assert.equal(history.entries[0].actorName,'Automatic lead routing');
    assert.equal(history.entries.length,2);
    for(const item of [original,manual,removed,closed]){
      const record=await details(item.id);
      assert.equal(record.assigneeId,null);
      assert.equal(record.routingPending,false);
      if(record.data.leadStage!=='Qualified')await close(record);
    }
    // Return the pool to its initial state for the routing capacity checks below.
    await close(assigned);
    await configure(0,{available:false});
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'false'});
    await reset();
  }
  // A lead manager can route without editing Contacts. A rep can retain contact
  // access yet lose the ability to receive leads, including manual handoffs.
  async function verifyRoutingPermissions(){
    const full={view:'all',edit:'all',create:true,delete:true};
    const readOnly={view:'all',edit:'none',create:false,delete:false};
    const set=async(index,tool,policy)=>{
      const result=await change({action:'tool_permissions',ids:[members[index].id],tool,policy});
      members[index]=result.viewers.find(row=>row.email===emails[index]);
    };
    const shared=()=>path+'?'+new URLSearchParams({workspaceId:workspace,grantId:members[0].id});
    const original=await create('Fictional lead handoff',{assigneeId:userIds[emails[1]]});
    const form=crypto.randomUUID();
    await json(post('/api/lead-forms',{action:'save',id:form,revision:0,
      definition:{title:'Local routing handoff',captureContacts:true,routeSalesLead:true}}));
    await json(post('/api/lead-forms',{action:'setEnabled',id:form,revision:1,enabled:true}));
    const inquiry='Fictional access rehearsal';
    await json(post('/api/public/forms/'+form,{id:crypto.randomUUID(),revision:2,payload:{name:inquiry,email:'local-routing@example.test'}},{}));
    const [captured]=(await json(get(path+'?search='+encodeURIComponent(inquiry)))).records;
    assert.equal(captured.assigneeId,null);
    await configure(0,{available:true,capacity:5});
    await configure(1,{available:true,capacity:5});
    await set(1,'leads',readOnly);
    await json(post(path,{action:'save',assigneeId:userIds[emails[1]],data:{name:'Unavailable handoff'}}),409);
    await withPage(async page=>{
      await page.goto(origin+'/?kind=leads&add=1');
      const choices=page.locator('select[name=assigneeId] option');
      assert.ok(!(await choices.evaluateAll(options=>options.map(option=>option.value))).includes(userIds[emails[1]]));
      await page.goto(origin+'/?kind=leads&record='+original.id);
      await page.getByRole('button',{name:'Reassign lead',exact:true}).waitFor();
    });
    const oldScope=shared();
    const noAccess={view:'none',edit:'none',create:false,delete:false};
    await set(0,'contacts',noAccess);
    const previewUrl=id=>path+'?view=routing-preview&id='+id+'&workspaceId='+workspace;
    const next=await json(get(previewUrl(original.id),other));
    assert.ok(next.next);
    await withPage(async page=>{
      await page.goto(origin+'/?kind=leads&record='+original.id+'&workspaceId='+workspace);
      await page.getByRole('button',{name:'Preview routing'}).click();
      await page.getByText('Next in line: '+next.next,{exact:true}).waitFor();
    },other);
    assert.equal((await details(original.id)).revision,original.revision);
    const sharedLead=await json(get(path+'?id='+captured.id+'&workspaceId='+workspace,other));
    assert.equal(sharedLead.contactId,null);
    assert.equal(sharedLead.contactName,null);
    const submit=async(name,email)=>{
      await json(post('/api/public/forms/'+form,{id:crypto.randomUUID(),revision:2,payload:{name,email}},{}));
      const [lead]=(await json(get(path+'?search='+encodeURIComponent(name)))).records;
      return lead;
    };
    // An owned-only reader would gain access if intake incorrectly gave them the Contact.
    await set(0,'contacts',{...noAccess,view:'owned'});
    const immediate=await submit('Restricted immediate intake','immediate-restricted@example.test');
    assert.equal(immediate.assigneeId,userIds[emails[0]]);
    const assertContactUnassigned=async lead=>{
      const linked=await json(get('/api/crm?kind=contacts&id='+lead.contactId));
      assert.equal(linked.revision,1);
      assert.ok(!linked.data.recordOwner);
      await json(get('/api/crm?kind=contacts&id='+lead.contactId+'&workspaceId='+workspace,other),404);
    };
    await assertContactUnassigned(immediate);
    await configure(0,{available:false});
    const deferred=await submit('Restricted deferred intake','deferred-restricted@example.test');
    assert.equal(deferred.assigneeId,null);
    await configure(0,{available:true});
    // The workspace owner may edit Contacts, but the receiving rep cannot.
    assert.equal((await retry(deferred)).routing,'assigned');
    assert.equal((await details(deferred.id)).assigneeId,userIds[emails[0]]);
    await assertContactUnassigned(deferred);
    await close(await details(immediate.id));await close(await details(deferred.id));
    const batch={action:'route_page',leads:[{id:original.id,expectedRevision:original.revision}]};
    await json(post(oldScope,batch,other),403);
    assert.deepEqual(await json(post(shared(),batch,other)),{assigned:1,unavailable:0,skipped:0});
    assert.deepEqual(await json(post(shared(),batch,other)),{assigned:0,unavailable:0,skipped:1});
    // The reverse case: the recipient can edit Contacts, while the manager cannot.
    await configure(0,{available:false});
    await set(1,'leads',full);
    const route={action:'route',id:captured.id,expectedRevision:captured.revision};
    assert.equal((await json(post(shared(),route,other))).routing,'assigned');
    assert.equal((await details(captured.id)).assigneeId,userIds[emails[1]]);
    const contact=await json(get('/api/crm?kind=contacts&id='+captured.contactId));
    assert.equal(contact.revision,1);assert.ok(!contact.data.recordOwner);
    const waiting=await create('Waiting on lead permissions',{assigneeId:null});
    await set(0,'leads',{...full,edit:'owned',delete:false});
    const limited=shared();
    await json(get(previewUrl(waiting.id),other),403);
    await json(post(limited,{...route,id:waiting.id,expectedRevision:waiting.revision},other),403);
    await json(post(limited,{action:'route_page',leads:[{id:waiting.id,expectedRevision:1}]},other),403);
    const sales=await get('/?view=sales-workspace&workspaceId='+workspace,other);
    assert.equal(sales.status,200);assert.doesNotMatch((await sales.text()).replace(/<script[\s\S]*?<\/script>/gi,''),/id="sales-routing-queue"/);
    await set(0,'leads',full);await set(0,'contacts',full);
    const recovered=await create('Available again',{assigneeId:userIds[emails[1]]});
    assert.equal(recovered.assigneeId,userIds[emails[1]]);
    for(const record of [original,captured,waiting,recovered])await close(await details(record.id));
    for(const index of [0,1])await configure(index,{available:false,capacity:10});
    await json(post('/api/lead-forms',{action:'setEnabled',id:form,revision:2,enabled:false}));
    await reset();
  }
  await verifyRoutingPermissions();
  await verifyBackgroundRouting();
  // An off-duty workspace has more older leads than two whole worker passes.
  // The other workspace's single eligible lead should still reach its rep.
  {
    const busyWorkspace=(await json(get(workspaces,other))).owned;
    assert.ok(busyWorkspace&&workspace!==busyWorkspace);
    const backlog=await sql`INSERT INTO portable_leads(workspace_id,id,revision,data,created_at,updated_at,routing_retry_at)
      SELECT ${busyWorkspace},gen_random_uuid(),1,jsonb_build_object('name','Fictional backlog '||n,'leadStage','New'),now(),now(),
        now()-interval '2 days'+n*interval '1 second' FROM generate_series(1,32) n RETURNING id`;
    const waiting=await create('Callback for the smaller queue',{assigneeId:null});
    await sql`UPDATE portable_leads SET routing_retry_at=now()-interval '1 minute' WHERE workspace_id=${workspace} AND id=${waiting.id}`;
    await configure(0,{available:true,capacity:10000,country:'',additionalCountries:[],regions:[],days:127,start:0,end:1440,awayThrough:null});
    await tick(['--notes-only']);
    assert.equal((await details(waiting.id)).assigneeId,null);
    await tick();
    if(!(await details(waiting.id)).assigneeId)await tick(); // A slow worker may yield after just one turn.
    const saved=await details(waiting.id);
    assert.equal(saved.assigneeId,userIds[emails[0]]);
    assert.equal(saved.revision,waiting.revision+1);
    const checked=await sql`SELECT data->>'name' AS name FROM portable_leads WHERE workspace_id=${busyWorkspace}
      AND id=ANY(${backlog.map(row=>row.id)}::uuid[]) AND routing_miss IS NOT NULL`;
    assert.ok(checked.length>0&&checked.length<backlog.length);
    assert.deepEqual(new Set(checked.map(row=>row.name)),new Set(Array.from({length:checked.length},(_,i)=>'Fictional backlog '+(i+1))));
    await sql`DELETE FROM portable_leads WHERE workspace_id=${busyWorkspace} AND id=ANY(${backlog.map(row=>row.id)}::uuid[])`;
    await close(saved);
    await configure(0,{available:false});
    await reset();
  }

  async function verifyManualQueue(){
    // Put a previously manual lead into the retry queue and follow it through a worker handoff.
    const manual=await create('Queue rehearsal first',{assigneeId:null});
    const second=await create('Queue rehearsal second',{assigneeId:null});
    const enqueue=lead=>({action:'queue_routing',id:lead.id,expectedRevision:lead.revision});
    await json(post(path,enqueue(manual)),409);
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'true'});
    await json(post(path,{...enqueue(manual),expectedRevision:manual.revision+1}),409);
    async function sharedWrite(scope){
      const updated=await change({action:'record_scope',id:members[0].id,viewScope:scope,editScope:scope});
      members[0]=updated.viewers.find(row=>row.email===emails[0]);
      return path+'?'+new URLSearchParams({workspaceId:workspace,grantId:members[0].id});
    }
    await json(post(await sharedWrite('owned'),enqueue(manual),other),403);
    await json(post(path,enqueue(manual),other),404);
    await withPage(async page=>{
      await page.setViewportSize({width:390,height:844});
      await page.goto(origin+'/?kind=leads&record='+manual.id);
      await page.getByRole('button',{name:'Queue for automatic routing'}).click();
      await page.getByRole('status').filter({hasText:'Queued for automatic routing.'}).waitFor();
      await page.getByText('Lead history',{exact:true}).click();
      await page.getByText(/Queued for automatic routing · /).waitFor();
      const form=page.getByRole('form',{name:'Lead filters'});
      await form.locator('select[name="owner"]').selectOption('waiting-routing');
      await form.getByRole('button',{name:'Apply'}).click();
      await page.getByRole('columnheader',{name:'Retry eligible from (UTC)'}).waitFor();
      await page.getByRole('link',{name:manual.data.name,exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:second.data.name,exact:true}).count(),0);
    });
    const queued=await details(manual.id);
    assert.equal((await json(post(path,enqueue(manual)))).routing,'queued');
    assert.equal((await details(manual.id)).revision,queued.revision);
    const pending=path+'?owner=waiting-routing&search=Queue+rehearsal&limit=1';
    assert.equal((await json(get(pending+'&workspaceId='+workspace,other))).records.length,0);
    await json(post(await sharedWrite('all'),enqueue(second),other));
    const firstPage=await json(get(pending));
    assert.equal(firstPage.records[0].id,manual.id);
    const nextPage=await json(get(pending+'&after='+encodeURIComponent(firstPage.next)));
    assert.equal(nextPage.records[0].id,second.id);
    assert.equal(nextPage.next,null);
    const cancelled=await details(second.id);
    await json(post(path,{action:'save',id:second.id,expectedRevision:cancelled.revision,assigneeId:null,data:{name:second.data.name}}));
    await json(post(path,enqueue(second)),409);
    const trail=await json(get(path+'?view=history&id='+second.id));
    assert.deepEqual(trail.entries.slice(0,2).map(row=>row.data.routingChange),['cancelled','queued']);
    await tick();
    assert.ok(Date.parse((await details(manual.id)).routingRetryAt)>Date.now());
    await configure(0,{available:true});
    await sql`UPDATE portable_leads SET routing_retry_at=now() WHERE id=${manual.id}`;
    await tick();await tick();
    const routed=await details(manual.id);
    assert.equal(routed.assigneeId,userIds[emails[0]]);
    assert.equal(routed.revision,queued.revision+1);
    assert.equal((await json(get(pending))).records.length,0);
    assert.equal((await details(second.id)).assigneeId,null);
    await close(routed);await close(await details(second.id));
    // One rep has a single free slot. Two managers reviewing the same page must not consume it twice.
    const reviewed=await Promise.all(['First','Second'].map(name=>create('Shift coverage '+name,{assigneeId:null})));
    const previous=await rule(0);
    const [load]=await sql`SELECT count(*)::int AS used FROM portable_leads WHERE workspace_id=${workspace}
      AND assignee_id=${userIds[emails[0]]} AND archived_at IS NULL AND deal_id IS NULL AND data->>'leadStage' NOT IN ('Qualified','Disqualified')`;
    await configure(0,{capacity:load.used+1});
    const batch={action:'route_page',queueIfUnavailable:true,leads:reviewed.map(row=>({id:row.id,expectedRevision:row.revision}))};
    const results=await Promise.all([json(post(path,batch)),json(post(path,batch))]);
    assert.deepEqual(results.sort((a,b)=>b.assigned-a.assigned),[
      {assigned:1,queued:1,unavailable:0,skipped:0},{assigned:0,queued:0,unavailable:0,skipped:2}]);
    const firstRouted=await details(reviewed[0].id);
    assert.equal(firstRouted.assigneeId,userIds[emails[0]]);
    assert.equal((await details(reviewed[1].id)).routingPending,true);
    await close(firstRouted);
    await tick();
    const nextRouted=await details(reviewed[1].id);
    assert.equal(nextRouted.assigneeId,userIds[emails[0]]);
    assert.equal(nextRouted.revision,reviewed[1].revision+2);
    await close(nextRouted);
    await configure(0,{available:false,capacity:previous.capacity});
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'false'});
    await reset();
  }
  await verifyManualQueue();
  const ownerPage=await get('/?kind=leads');
  assert.match(await ownerPage.text(),/<summary>Lead routing<\/summary>/);
  const sharedPage=await get('/?kind=leads&workspaceId='+workspace,other);
  assert.doesNotMatch(await sharedPage.text(),/<summary>Lead routing<\/summary>/);
  assert.match(await (await get('/?kind=leads&add=1')).text(),/>Use lead routing<\/option>/);
  // Existing workspaces distribute by count. Owners can opt into comparing each rep to their own limit.
  async function verifyCapacityBalance(){
    assert.equal((await json(get(settings))).byCapacity,false);
    await configure(0,{available:true,capacity:5});
    await configure(1,{available:true,capacity:30});
    const leads=[];
    for(const [index,load] of [4,6].entries()){
      for(let n=0;n<load;n++)leads.push(await create('Existing work '+index+'-'+n,{assigneeId:userIds[emails[index]]}));
    }
    const waiting=await create('Compare both distribution methods',{assigneeId:null});
    const preview=()=>json(get(path+'?view=routing-preview&id='+waiting.id));
    const label=async index=>(await pool()).find(member=>member.memberId===members[index].id).label;
    assert.equal((await preview()).next,await label(0));
    await withPage(async page=>{
      await page.goto(origin+'/?kind=leads');
      await page.getByText('Lead routing',{exact:true}).click();
      await page.getByLabel('Assign the next lead by').selectOption('capacity');
      await page.getByRole('button',{name:'Save distribution'}).click();
      await page.getByText('Lead distribution saved.').waitFor();
      await page.reload();
      await page.getByText('Lead routing',{exact:true}).click();
      assert.equal(await page.getByLabel('Assign the next lead by').inputValue(),'capacity');
    });
    assert.equal((await json(get(settings,other))).byCapacity,false);
    await json(post(settings+'&workspaceId='+workspace,{action:'balance',byCapacity:false},other),403);
    assert.equal((await preview()).next,await label(1));
    const incoming=await create('New inbound inquiry');
    assert.equal(incoming.assigneeId,userIds[emails[1]]);
    leads.push(incoming);
    assert.equal((await retry(waiting)).routing,'assigned');
    const retried=await details(waiting.id);
    assert.equal(retried.assigneeId,userIds[emails[1]]);
    leads.push(retried);
    await json(post(settings,{action:'balance',byCapacity:false}));
    const counted=await create('Back to fewest leads');
    assert.equal(counted.assigneeId,userIds[emails[0]]);
    leads.push(counted);
    for(const lead of leads)await close(lead);
    await reset();
    await json(post(settings,{action:'balance',byCapacity:true}));
    const wave=await Promise.all(Array.from({length:14},(_,n)=>create('Simultaneous capacity inquiry '+n)));
    assert.deepEqual(emails.map(email=>wave.filter(lead=>lead.assigneeId===userIds[email]).length),[2,12]);
    for(const lead of wave)await close(lead);
    await json(post(settings,{action:'balance',byCapacity:false}));
    for(const i of [0,1])await configure(i,{available:false});
    await reset();
  }
  await verifyCapacityBalance();
  async function verifyRoundRobin(){
    await withPage(async page=>{
      await page.goto(origin+'/?kind=leads');
      await page.getByText('Lead routing',{exact:true}).click();
      await page.getByLabel('Assign the next lead by').selectOption({label:'Round robin'});
      await page.getByRole('button',{name:'Save distribution'}).click();
      await page.getByText('Lead distribution saved.').waitFor();
      await page.reload();
      await page.getByText('Lead routing',{exact:true}).click();
      assert.equal(await page.getByLabel('Assign the next lead by').inputValue(),'round_robin');
    });
    await json(post(settings+'&workspaceId='+workspace,{action:'balance',distribution:'round_robin'},other),403);
    assert.equal((await json(get(settings,other))).distribution,'count');
    const firstId=userIds[emails[0]],secondId=userIds[emails[1]],created=[];
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'true'});
    const waiting=await create('Round robin after shift starts');
    assert.equal(waiting.routingPending,true);
    await configure(0,{available:true,capacity:6});
    for(let i=0;i<2;i++)created.push(await create('Existing assigned workload '+i,{assigneeId:firstId}));
    created.push(await create('Only rep on shift'));
    assert.equal(created.at(-1).assigneeId,firstId);
    await configure(1,{available:true,capacity:30});
    created.push(await create('Second rep on shift'));
    assert.equal(created.at(-1).assigneeId,secondId);
    const next=(await pool()).find(row=>row.memberId===members[0].id).label;
    const peek=()=>json(get(path+'?view=routing-preview&id='+waiting.id));
    assert.equal((await peek()).next,next);
    assert.equal((await peek()).next,next);
    await tick();
    const assigned=await details(waiting.id);
    assert.equal(assigned.assigneeId,firstId,'The worker gives the busier rep their turn.');
    created.push(assigned);
    const wave=await Promise.all(Array.from({length:4},(_,i)=>create('Round robin concurrent '+i)));
    assert.deepEqual(wave.map(row=>row.assigneeId).sort(),[firstId,firstId,secondId,secondId].sort());
    created.push(...wave);
    for(let i=0;i<2;i++){
      const overflow=await create('First rep is at capacity '+i);
      assert.equal(overflow.assigneeId,secondId);
      created.push(overflow);
    }
    await close(created.shift());
    const resumed=await create('Back in rotation');
    assert.equal(resumed.assigneeId,firstId);
    for(const lead of [...created,resumed])await close(lead);
    // A shift starts with more waiting leads than fit in one worker pass.
    for(const i of [0,1])await configure(i,{available:false,capacity:5});
    const backlog=[];
    for(let i=0;i<12;i++)backlog.push(await create('Start of shift '+i));
    assert.ok(backlog.every(lead=>lead.routingPending));
    const ids=backlog.map(lead=>lead.id);
    for(const i of [0,1])await configure(i,{available:true});
    const states=()=>sql`SELECT id, revision, assignee_id, routing_retry_at>now() AS deferred
      FROM portable_leads WHERE workspace_id=${workspace} AND id IN ${sql(ids)} ORDER BY created_at,id`;
    await tick();
    const afterFirst=await states();
    const assignedCount=afterFirst.filter(row=>row.assignee_id).length;
    assert.ok(assignedCount>1&&assignedCount<=8,'One pass should assign a bounded batch: '+assignedCount);
    assert.ok(afterFirst.slice(0,assignedCount).every(row=>row.assignee_id),'Oldest due leads should go first');
    await Promise.all([tick(),tick()]);
    let finished=await states();
    // A slow or contended pass can yield earlier. Each additional pass must advance the backlog.
    while(finished.some(row=>!row.assignee_id&&!row.deferred)){
      const previous=finished.filter(row=>!row.assignee_id&&!row.deferred).length;
      await tick();
      finished=await states();
      assert.ok(finished.filter(row=>!row.assignee_id&&!row.deferred).length<previous);
    }
    assert.deepEqual([firstId,secondId].map(user=>finished.filter(row=>row.assignee_id===user).length),[5,5]);
    assert.equal(finished.filter(row=>!row.assignee_id&&row.deferred).length,2);
    const turns=await sql`SELECT lead_id FROM portable_lead_events WHERE workspace_id=${workspace}
      AND lead_id IN ${sql(ids)} AND automatic_routing`;
    assert.deepEqual(turns.map(row=>row.lead_id).sort(),finished.filter(row=>row.assignee_id).map(row=>row.id).sort());
    await reset();
    for(const row of finished)await close({...backlog.find(lead=>lead.id===row.id),revision:row.revision});
    for(const i of [0,1])await configure(i,{available:false});
    await json(post(settings,{action:'balance',byCapacity:false}));
    assert.equal((await json(get(settings))).distribution,'count');
    await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'false'});
    await reset();
  }
  await verifyRoundRobin();
  const first=await rule(0);
  assert.equal(first.available,false);
  await json(post(settings,{...first,available:true,timeZone:'Not/AZone'}),400);
  await json(post(settings,{...first,available:true},other),409);
  await json(post(settings+'&workspaceId='+workspace,{...first,available:true},other),403);
  await configure(0,{available:true,capacity:1});
  await json(post(settings,{...first,available:false}),409);
  await configure(1,{available:true,capacity:1});
  const assigned=await Promise.all(['One','Two','Three'].map(name=>create('Routing '+name)));
  assert.deepEqual(assigned.map(row=>row.assigneeId).sort(),[null,...Object.values(userIds)].sort());
  const held=assigned.find(row=>!row.assigneeId);
  const previewUrl=path+'?view=routing-preview&id='+held.id;
  const sharedPreview=previewUrl+'&workspaceId='+workspace;
  const cursor=()=>sql`SELECT user_id,last_assigned_at FROM portable_lead_routing_members WHERE workspace_id=${workspace} ORDER BY user_id`;
  const beforePreview=await cursor();
  const workload=()=>path+'?view=routing-workload&memberId='+members[0].id;
  assert.deepEqual(await json(get(workload())),{capacity:1,openLeads:1});
  await json(get(workload(),other),404);
  await json(get(workload()+'&workspaceId='+workspace,other),403);
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads');
    await page.getByText('Lead routing',{exact:true}).click();
    await page.getByRole('combobox',{name:/^Sales rep/}).selectOption(members[0].id);
    await page.getByText('1 of 1 open lead · At capacity',{exact:true}).waitFor();
    // A manual assignment can exceed a routing limit. Refresh must keep the owner's unsaved edits.
    const capacity=page.getByLabel('Maximum open leads');
    await capacity.fill('6');
    const extra=await create('Direct assignment beyond the limit',{assigneeId:userIds[emails[0]]});
    await page.getByRole('button',{name:'Refresh workload'}).click();
    await page.getByText('More than 1 open lead · Over capacity',{exact:true}).waitFor();
    assert.equal(await capacity.inputValue(),'6');
    await close(extra);
    await page.getByRole('button',{name:'Refresh workload'}).click();
    await page.getByText('1 of 1 open lead · At capacity',{exact:true}).waitFor();
  });
  assert.deepEqual(await json(get(previewUrl)),{next:null,counts:{capacity:2}});
  assert.deepEqual(await json(get(sharedPreview,other)),{next:null,counts:{capacity:2}});
  await json(get(previewUrl,other),404);
  assert.deepEqual(await cursor(),beforePreview);
  assert.equal((await retry(held)).routing,'unavailable');
  assert.equal((await details(held.id)).revision,1);
  const scoped=path+'?owner=mine&workspaceId='+workspace;
  const myLead=assigned.find(lead=>lead.assigneeId===userIds[emails[0]]);
  const mine=await json(get(scoped+'&search='+encodeURIComponent(myLead.data.name),other));
  assert.deepEqual(mine.records.map(row=>row.id),[myLead.id]);
  const rotated=await sql`SELECT user_id FROM portable_lead_routing_members WHERE workspace_id=${workspace} ORDER BY last_assigned_at`;
  for(const lead of assigned.filter(row=>row.assigneeId))await close(lead);
  assert.deepEqual(await json(get(workload())),{capacity:1,openLeads:0});
  const ready=await json(get(previewUrl));
  assert.deepEqual(ready.counts,{ready:2});
  assert.equal((await retry(held)).routing,'assigned');
  const routed=await details(held.id);
  assert.equal(routed.assigneeId,rotated[0].user_id);
  assert.equal(routed.assigneeLabel,ready.next);
  await json(get(previewUrl),409);
  assert.equal((await json(get(path+'?view=history&id='+held.id))).entries[0].data.assigneeId,routed.assigneeId);
  await json(post(path,{action:'route',id:held.id,expectedRevision:held.revision}),409);
  await close(routed);

  const backlog=[];
  for(let index=0;index<5;index++)backlog.push(await create('Waiting batch '+index,{assigneeId:null}));
  const targets=backlog.slice(0,4).map(({id,revision})=>({id,expectedRevision:revision}));
  await close(backlog[0]);
  const scope=path+'?'+new URLSearchParams({workspaceId:workspace,grantId:members[0].id});
  const routePage=(leads=targets)=>post(scope,{action:'route_page',leads},other);
  await json(routePage([targets[1],targets[1]]),400);
  await json(routePage(Array.from({length:26},()=>({id:crypto.randomUUID(),expectedRevision:1}))),400);
  // A rejected assignment history row must roll back the earlier assignment and the routing cursor.
  await sql`ALTER TABLE portable_lead_events ADD CONSTRAINT fixture_route_history CHECK
    (data->'data'->>'name' <> 'Waiting batch 2' OR revision < 2) NOT VALID`;
  const beforeCursor=await cursor();
  try{
    await json(routePage(),500);
    assert.equal((await details(backlog[1].id)).assigneeId,null);
    assert.deepEqual(await cursor(),beforeCursor);
  }finally{await sql`ALTER TABLE portable_lead_events DROP CONSTRAINT fixture_route_history`;}
  const concurrent=await Promise.all([json(routePage()),json(routePage())]);
  assert.deepEqual(concurrent.sort((a,b)=>b.assigned-a.assigned),[
    {assigned:2,unavailable:1,skipped:1},{assigned:0,unavailable:1,skipped:3},
  ]);
  await json(post(path,{action:'route_page',leads:[{id:backlog[4].id,expectedRevision:2},targets[0]]}))
    .then(result=>assert.deepEqual(result,{assigned:0,unavailable:0,skipped:2}));
  const assignedPair=await Promise.all(backlog.slice(1,3).map(row=>details(row.id)));
  assert.deepEqual(assignedPair.map(row=>row.assigneeId).sort(),Object.values(userIds).sort());
  for(const lead of assignedPair){
    assert.equal(lead.revision,2);
    const history=await json(get(path+'?view=history&id='+lead.id));
    assert.equal(history.entries.length,2);
    assert.equal(history.entries[0].data.assigneeId,lead.assigneeId);
    await close(lead);
  }
  assert.equal((await details(backlog[3].id)).revision,1);
  assert.equal((await details(backlog[4].id)).assigneeId,null);
  await reset();

  // A matching territory outranks the general pool, even when the specialist is busier.
  const linked=async(kind,country,state)=>(await json(post('/api/crm',{action:'save',kind,data:{name:'Routing '+kind,country,state}}),201)).record.id;
  const contactId=await linked('contacts','Canada'),companyId=await linked('companies','France');
  await configure(0,{country:'canada',capacity:5});
  await configure(1,{capacity:5});
  for(const index of [1,2])assert.equal((await create('Territory '+index,{contactId})).assigneeId,userIds[emails[0]]);
  assert.equal((await create('Company territory',{contactId,companyId})).assigneeId,userIds[emails[1]]);
  await configure(0,{additionalCountries:['France','Korea, Republic of']});
  const extra=await create('Second country territory',{contactId,companyId});
  assert.equal(extra.assigneeId,userIds[emails[0]]);
  await close(extra);
  const {additionalCountries,...legacyRule}=await rule(0);
  assert.deepEqual(additionalCountries,['France','Korea, Republic of']);
  await json(post(settings,{...legacyRule,capacity:6}));
  assert.deepEqual((await rule(0)).additionalCountries,additionalCountries);
  for(const countries of [['CANADA'],['France','france'],[''],Array(50).fill('Mexico')]){
    await json(post(settings,{...await rule(0),additionalCountries:countries}),400);
  }
  const largeTerritory=Array.from({length:49},(_,i)=>'Fictional sales region '+i+' '+ '郡'.repeat(48));
  await configure(0,{additionalCountries:largeTerritory});
  assert.deepEqual((await rule(0)).additionalCountries,largeTerritory);
  await configure(0,{additionalCountries:[],capacity:5});
  assert.equal((await create('Manual choice',{companyId,assigneeId:userIds[emails[0]]})).assigneeId,userIds[emails[0]]);
  assert.equal((await create('Manual unassigned',{contactId,assigneeId:null})).assigneeId,null);
  await reset();
  // An eligible provincial rep wins before the country-wide rep, using one record's full address.
  const prior=[await rule(0),await rule(1)];
  const ontario=await linked('contacts','Canada','onTArio');
  const quebec=await linked('companies','Canada','Quebec');
  const missingProvince=await linked('companies','Canada');
  await configure(0,{country:'Canada',additionalCountries:[],capacity:100});
  await configure(1,{country:'Canada',additionalCountries:[],capacity:100});
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads');
    await page.getByText('Lead routing',{exact:true}).click();
    const form=page.getByRole('group',{name:'Routing pool',exact:true});
    await form.locator('select').selectOption(members[0].id);
    await form.getByLabel('States or provinces').fill('Ontario\nAlberta');
    await form.getByRole('button',{name:'Save routing'}).click();
    await page.getByRole('status').filter({hasText:'Routing saved for'}).waitFor();
  });
  const {regions,...legacyHours}=await rule(0);
  assert.deepEqual(regions,['Ontario','Alberta']);
  await json(post(settings,legacyHours));
  assert.deepEqual((await rule(0)).regions,regions,'Legacy hours edits retain the provincial territory.');
  await json(post(settings,{...await rule(0),additionalCountries:['France']}),400);
  const sample=path+'?view=territory-preview';
  const sampleLocation=(country,region='')=>sample+'&'+new URLSearchParams({country,region});
  const savedState=()=>sql`SELECT user_id,last_assigned_at::text,
    (SELECT count(*) FROM portable_leads WHERE workspace_id=${workspace}) AS leads
    FROM portable_lead_routing_members WHERE workspace_id=${workspace} ORDER BY user_id`;
  const priorRoutingState=await savedState();
  const labels=await pool();
  const provincialRep=labels.find(member=>member.memberId===members[0].id).label;
  const nationalRep=labels.find(member=>member.memberId===members[1].id).label;
  const coverageDay=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
  const upcomingLeave={from:coverageDay,through:coverageDay,startTime:'12:00',endTime:'19:00',timeZone:'UTC',pauseLeadRouting:true};
  const offer=workspaces+'?'+new URLSearchParams({team:'booking',workspaceId:workspace,grantId:members[0].id});
  async function changeFutureLeave(operation){
    const {revision}=await json(get(offer,other));
    await json(post(offer,{action:'timeOff',operation,period:upcomingLeave,revision},other));
  }
  await changeFutureLeave('add');
  const futureSample=time=>sampleLocation('Canada','Ontario')+'&at='+encodeURIComponent(coverageDay+'T'+time+':00Z');
  assert.equal((await json(get(futureSample('11:59')))).next,provincialRep);
  const onLeave=await json(get(futureSample('12:00')));
  assert.equal(onLeave.next,nationalRep);
  assert.equal(onLeave.counts.timeOff,1);
  assert.equal((await json(get(futureSample('19:00')))).next,provincialRep);
  for(const at of ['not-a-date','2001-01-01T12:00:00Z'])await json(get(sample+'&at='+at),400);
  const sampleResult=await json(get(sampleLocation(' Canada ','oNtArIo')));
  assert.equal(sampleResult.next,provincialRep);
  assert.equal((await json(get(sampleLocation('Canada','Quebec')))).next,nationalRep);
  assert.equal((await json(get(sample))).next,null);
  await json(get(sampleLocation('','Ontario')),400);
  await json(get(sampleLocation('A'.repeat(101))),400);
  await json(get(sample+'&workspaceId='+workspace,other),403);
  assert.deepEqual(await json(get(sampleLocation('Canada','Ontario'),other)),{counts:{},next:null});
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads');
    await page.getByText('Lead routing',{exact:true}).click();
    await page.getByText('Test a territory',{exact:true}).click();
    await page.getByLabel('Country or region',{exact:true}).fill('Canada');
    await page.getByLabel('State or province',{exact:true}).fill('Ontario');
    await page.getByRole('button',{name:'Test routing',exact:true}).click();
    await page.getByText('Next in line: '+provincialRep,{exact:true}).waitFor();
    const when=page.getByLabel(/^Preview time/);
    await when.fill(coverageDay+'T12:30');
    await page.getByRole('button',{name:'Test routing',exact:true}).click();
    await page.getByText('Projected rep: '+nationalRep,{exact:true}).waitFor();
    await page.getByText('Scheduled time off · 1',{exact:true}).waitFor();
    // A repeated New York wall time identifies two distinct instants. Exercise the
    // operator's explicit choice on the normal web form.
    const nextYear=new Date().getUTCFullYear()+1;
    const nextMarch=new Date(Date.UTC(nextYear,2,1));
    nextMarch.setUTCDate(8+(7-nextMarch.getUTCDay())%7);
    await when.fill(nextMarch.toISOString().slice(0,10)+'T02:30');
    await page.getByRole('button',{name:'Test routing',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'This local time does not exist'}).waitFor();
    const nextNovember=new Date(Date.UTC(nextYear,10,1));
    nextNovember.setUTCDate(1+(7-nextNovember.getUTCDay())%7);
    const sunday=nextNovember.toISOString().slice(0,10);
    await when.fill(sunday+'T01:30');
    await page.getByLabel('Time occurrence').selectOption({label:'06:30 UTC'});
    const submitted=page.waitForRequest(r=>new URL(r.url()).searchParams.get('view')==='territory-preview');
    await page.getByRole('button',{name:'Test routing',exact:true}).click();
    assert.equal(new URL((await submitted).url()).searchParams.get('at'),sunday+'T06:30:00.000Z');
    await page.getByText('Projected rep: '+provincialRep,{exact:true}).waitFor();
    await when.fill('');
    await page.getByLabel('State or province',{exact:true}).fill('Quebec');
    await page.getByText('Next in line: '+provincialRep,{exact:true}).waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Test routing',exact:true}).click();
    await page.getByText('Next in line: '+nationalRep,{exact:true}).waitFor();
  },headers,{timezoneId:'America/New_York'});
  await changeFutureLeave('remove');
  assert.deepEqual(await savedState(),priorRoutingState,'Sample locations must not create leads or advance the routing pool.');
  const territorial=await create('Provincial territory preview',{contactId:ontario,assigneeId:null});
  const provincialPreview=await json(get(path+'?view=routing-preview&id='+territorial.id));
  assert.deepEqual(provincialPreview,sampleResult);
  assert.equal(provincialPreview.next,(await pool()).find(member=>member.memberId===members[0].id).label);
  assert.equal((await retry(territorial)).routing,'assigned');
  assert.equal((await details(territorial.id)).assigneeId,userIds[emails[0]]);
  await close(await details(territorial.id));
  for(const company of [quebec,missingProvince]){
    const fallback=await create('Company address overrides contact province',{contactId:ontario,companyId:company});
    assert.equal(fallback.assigneeId,userIds[emails[1]]);
    await close(fallback);
  }
  // A waiting lead should follow active addresses as linked records enter or leave the recycle bin.
  const archiveLead=await create('Archive before assignment',{contactId:ontario,companyId:quebec,assigneeId:null});
  const previewWaiting=()=>json(get(path+'?view=routing-preview&id='+archiveLead.id));
  const recycle=(kind,id,action,expectedRevision)=>json(post('/api/recycle-bin',{kind,id,action,expectedRevision,requestId:crypto.randomUUID()}));
  await recycle('companies',quebec,'archive',1);
  assert.deepEqual(await previewWaiting(),provincialPreview,'Archiving the company should reveal the active contact territory.');
  await recycle('contacts',ontario,'archive',1);
  assert.equal((await previewWaiting()).next,null,'Two archived addresses must not qualify either territory.');
  assert.equal((await retry(archiveLead)).routing,'unavailable');
  await recycle('contacts',ontario,'restore',2);
  assert.equal((await retry(archiveLead)).routing,'assigned');
  assert.equal((await details(archiveLead.id)).assigneeId,userIds[emails[0]]);
  await close(await details(archiveLead.id));
  await configure(0,{available:false});
  const fallback=await create('Province rep unavailable',{contactId:ontario});
  assert.equal(fallback.assigneeId,userIds[emails[1]]);
  await close(fallback);
  for(const [index,saved] of prior.entries())await configure(index,{...saved,revision:(await rule(index)).revision});
  await reset();
  // Use the database clock, with a window well away from the current hour.
  const [clock]=await sql`SELECT zone, extract(hour FROM now() AT TIME ZONE zone)::int AS hour,
    extract(isodow FROM now() AT TIME ZONE zone)::int AS day
    FROM (VALUES ('Pacific/Honolulu'),('Asia/Kolkata')) AS zones(zone)
    WHERE extract(hour FROM now() AT TIME ZONE zone) BETWEEN 2 AND 21 ORDER BY zone LIMIT 1`;
  const zone=clock.zone;
  const outside=(clock.hour+12)%24;
  await configure(0,{timeZone:zone,start:outside*60,end:(outside+1)*60});
  await configure(1,{available:false});
  const offShift=await create('Off shift',{contactId});
  assert.equal(offShift.assigneeId,null);
  assert.deepEqual(await json(get(path+'?view=routing-preview&id='+offShift.id)),{next:null,counts:{hours:1,paused:1}});
  await configure(0,{days:1<<((clock.day+2)%7),start:0,end:1440});
  assert.equal((await create('Day off',{contactId})).assigneeId,null);
  // Fixed-offset zones put this instant safely inside each part of a night shift.
  const nightClocks=await sql`SELECT name, extract(hour FROM local_time)::int AS hour,
    extract(isodow FROM local_time)::int AS day, (local_time::date-1)::text AS previous_date,
    (local_time::date-2)::text AS two_days_ago FROM pg_timezone_names
    CROSS JOIN LATERAL (SELECT statement_timestamp() AT TIME ZONE name AS local_time) clock
    WHERE name LIKE 'Etc/GMT%' AND extract(hour FROM local_time) IN (2,12,21)
    ORDER BY name`;
  const clockAt=hour=>nightClocks.find(clock=>clock.hour===hour);
  const dayMask=day=>1<<(day-1);
  const yesterday=day=>day===1?7:day-1;
  const early=clockAt(2),late=clockAt(21),midday=clockAt(12);
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads');
    await page.getByText('Lead routing',{exact:true}).click();
    const form=page.getByRole('group',{name:'Routing pool',exact:true});
    await form.locator('select').selectOption(members[0].id);
    const territory=form.getByLabel('Territory countries or regions');
    await territory.fill('Canada\nKorea, Republic of');
    await form.getByLabel('Time zone').fill(early.name);
    for(const box of await form.locator('[name="days"]').all()){
      await box.setChecked(Number(await box.getAttribute('value'))===yesterday(early.day)-1);
    }
    await form.locator('[name="start"]').fill('20:00');
    await form.locator('[name="end"]').fill('06:00');
    await form.getByRole('button',{name:'Save routing'}).click();
    await page.getByRole('status').filter({hasText:'Routing saved for'}).waitFor();
  });
  const night=await rule(0);
  assert.deepEqual([night.days,night.start,night.end],[dayMask(yesterday(early.day)),1200,360]);
  assert.deepEqual([night.country,...night.additionalCountries],['Canada','Korea, Republic of']);
  const secondCountry=await linked('companies','KOREA, REPUBLIC OF');
  const regional=await create('Multi-country overnight territory',{companyId:secondCountry,assigneeId:null});
  assert.deepEqual((await json(get(path+'?view=routing-preview&id='+regional.id))).counts,{ready:1,paused:1});
  assert.equal((await retry(regional)).routing,'assigned');
  assert.equal((await details(regional.id)).assigneeId,userIds[emails[0]]);
  await close(await details(regional.id));
  const {additionalCountries:previousTerritory,...legacyReplacement}=await rule(0);
  assert.equal(previousTerritory.length,1);
  await json(post(settings,{...legacyReplacement,country:'Canada only'}));
  assert.deepEqual((await rule(0)).additionalCountries,[]);
  await configure(0,{country:'Canada'});
  const previewNight=async()=>json(get(path+'?view=routing-preview&id='+offShift.id));
  assert.deepEqual((await previewNight()).counts,{ready:1,paused:1});
  await configure(0,{awayThrough:early.previous_date});
  assert.deepEqual((await previewNight()).counts,{away:1,paused:1});
  const heldOvernight=await create('Previous evening’s shift',{contactId});
  assert.equal(heldOvernight.assigneeId,null);
  assert.equal((await retry(heldOvernight)).routing,'unavailable');
  await configure(0,{awayThrough:early.two_days_ago});
  assert.deepEqual((await previewNight()).counts,{ready:1,paused:1});
  assert.equal((await retry(heldOvernight)).routing,'assigned');
  const assignedOvernight=await details(heldOvernight.id);
  assert.equal(assignedOvernight.assigneeId,userIds[emails[0]]);
  await close(assignedOvernight);
  await configure(0,{awayThrough:null});
  await configure(0,{days:dayMask(early.day)});
  assert.deepEqual((await previewNight()).counts,{hours:1,paused:1});
  assert.equal((await retry(offShift)).routing,'unavailable');
  await configure(0,{days:dayMask(late.day),timeZone:late.name});
  assert.deepEqual((await previewNight()).counts,{ready:1,paused:1});
  await configure(0,{days:127,timeZone:midday.name});
  assert.deepEqual((await previewNight()).counts,{hours:1,paused:1});
  await json(post(settings,{...await rule(0),start:600,end:600}),400);
  for(const [start,end] of [[-1,60],[1440,360],[60,0],[60,1441],[600,600]]){
    await assert.rejects(sql`UPDATE portable_lead_routing_members SET start_minute=${start}, end_minute=${end}
      WHERE workspace_id=${workspace} AND user_id=${userIds[emails[0]]}`,{code:'23514'});
  }
  await reset();
  // A window surrounding the local hour excludes the same instant in UTC.
  await configure(0,{timeZone:zone,days:127,start:Math.max(0,clock.hour-1)*60,end:Math.min(24,clock.hour+2)*60,capacity:10});
  const normal=await create('Available again',{contactId});
  assert.equal(normal.assigneeId,userIds[emails[0]]);
  await change({action:'revoke',id:members[0].id});
  await json(routePage(),403);
  await json(get(sharedPreview,other),403);
  assert.equal((await create('After removal',{contactId})).assigneeId,null);
  const added=(await change({action:'grant',email:emails[0]})).viewers.find(row=>row.email===emails[0]);
  members[0]=(await change({action:'role',id:added.id,role:'editor'})).viewers.find(row=>row.email===emails[0]);
  assert.equal((await rule(0)).available,false);
  await configure(0,{available:true,capacity:10});
  const closed=await create('Closed lead',{data:{name:'Already qualified',leadStage:'Qualified'}});
  assert.equal(closed.assigneeId,null);
  await json(post(path,{action:'route',id:closed.id,expectedRevision:closed.revision}),409);
  const narrowed=(await change({action:'record_scope',id:members[0].id,viewScope:'team',editScope:'owned'})).viewers.find(row=>row.email===emails[0]);
  members[0]=narrowed;
  await json(get(sharedPreview,other),403);
  await json(post(path+'?'+new URLSearchParams({workspaceId:workspace,grantId:narrowed.id}),{action:'route_page',leads:targets},other),403);
  await json(post(path+'?'+new URLSearchParams({workspaceId:workspace,grantId:narrowed.id}),
    {action:'route',id:offShift.id,expectedRevision:offShift.revision},other),403);
  const scopedQuery='workspaceId='+workspace;
  const sharedWrite=path+'?'+scopedQuery+'&grantId='+narrowed.id;
  const sharedLead=id=>json(get(path+'?id='+id+'&'+scopedQuery,other));
  const privateLinks=await create('Scoped inquiry',{contactId,companyId});
  assert.equal(privateLinks.assigneeId,userIds[emails[0]]);
  const owned=await sharedLead(privateLinks.id);
  assert.equal(owned.editable,true);
  assert.deepEqual([owned.companyId,owned.companyName,owned.contactId,owned.contactName],[null,null,null,null]);
  const history=await json(get(path+'?view=history&id='+owned.id+'&'+scopedQuery,other));
  assert.equal(history.entries[0].data.companyId,null);
  assert.equal(history.entries[0].data.contactId,null);
  await json(post(sharedWrite,{action:'save',id:owned.id,expectedRevision:1,data:{name:'Scoped inquiry edited'}},other));
  assert.equal((await details(owned.id)).companyId,companyId);
  const elsewhere=await create('Scoped inquiry peer',{assigneeId:userIds[emails[1]]});
  assert.equal((await get(path+'?id='+elsewhere.id+'&'+scopedQuery,other)).status,404);
  assert.equal((await get(path+'?view=history&id='+elsewhere.id+'&'+scopedQuery,other)).status,404);
  const search=()=>json(post('/api/crm/search?'+scopedQuery,{kind:'leads',query:'Scoped inquiry'},other));
  assert.equal((await search()).total,1);
  const localPage=await get('/?kind=leads&record='+owned.id+'&'+scopedQuery,other);
  assert.equal(localPage.status,200);
  const html=await localPage.text();
  assert.ok(html.includes('Scoped inquiry edited'));
  assert.ok(!html.includes(companyId)&&!html.includes(contactId));
  const report=(await json(post('/api/reporting',{action:'report',definition:{kind:'leads',name:'Rep leads'}}),201)).item;
  const dashboard=(await json(post('/api/reporting',{action:'dashboard',teamVisible:true,
    definition:{name:'Assigned leads',cards:[{reportId:report.id,wide:false}]}}),201)).item;
  const card=await json(get('/api/reporting?view=dashboard&id='+dashboard.id+'&'+scopedQuery,other));
  const visibleLeads=await json(get(path+'?limit=50&'+scopedQuery,other));
  assert.equal(Number(card.cards[0].result.count),visibleLeads.records.length);
  const drillPath='/api/reporting?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+'&'+scopedQuery;
  const drillIds=[];
  let after;
  do{
    const page=await json(get(drillPath+(after?'&after='+after:''),other));
    drillIds.push(...page.records.map(record=>record.id));
    assert.ok(drillIds.length<=visibleLeads.records.length);
    after=page.next;
  }while(after);
  assert.deepEqual(drillIds.sort(),visibleLeads.records.map(record=>record.id).sort());
  assert.ok(drillIds.includes(owned.id)&&!drillIds.includes(elsewhere.id));

  // A team manager may read a child team's leads while retaining own-only edits.
  const team=crypto.randomUUID(),child=crypto.randomUUID();
  await change({action:'team_create',id:team,name:'Inbound routing',parentId:null});
  await change({action:'team_create',id:child,name:'Inbound West',parentId:team});
  for(const [index,teamId] of [[0,team],[1,child]]){
    await change({action:'team_assign',id:members[index].id,teamId,previousTeamId:null});
  }
  assert.equal((await search()).total,2);
  assert.equal((await sharedLead(elsewhere.id)).editable,false);
  await json(post(sharedWrite,{action:'save',id:elsewhere.id,expectedRevision:elsewhere.revision,data:{name:'Blocked edit'}},other),404);
  const manual=await json(post(sharedWrite,{action:'save',data:{name:'Scoped self-created lead'}},other),201);
  assert.equal((await details(manual.id)).assigneeId,userIds[emails[0]]);
  const deal=await json(post(sharedWrite,{action:'convert',id:manual.id,expectedRevision:1,dealName:'Scoped deal'},other),201);
  const visibleDeal=await json(get('/api/crm?kind=deals&id='+deal.dealId+'&'+scopedQuery,other));
  assert.equal(visibleDeal.data.recordOwner.userId,userIds[emails[0]]);
  await reset();
  // This burst leaves room for exactly 40 additional Leads across two active reps.
  for(const [index,email] of emails.entries()){
    const [{load}]=await sql`SELECT count(*)::int AS load FROM portable_leads WHERE workspace_id=${workspace} AND archived_at IS NULL
      AND assignee_id=${userIds[email]} AND deal_id IS NULL AND data->>'leadStage' NOT IN ('Qualified','Disqualified')`;
    await configure(index,{available:true,timeZone:'UTC',days:127,start:0,end:1440,country:'',capacity:load+20});
  }
  await reset();
  const burst=await Promise.all(Array.from({length:50},(_,n)=>create('Fictional routing burst '+n)));
  for(const email of emails)assert.equal(burst.filter(row=>row.assigneeId===userIds[email]).length,20);
  assert.equal(burst.filter(row=>row.assigneeId===null).length,10);
  await reset();
  await configure(0,{country:'canada',regions:['Ontario'],capacity:10000});
  await configure(1,{country:'',capacity:10000});
  await verifyInboundSalesRouting({request,origin,headers,other,sql,workspace,rep:userIds[emails[0]],general:userIds[emails[1]],
    coverAllCanada:()=>configure(0,{regions:[]}),
    disable:async()=>{
      const restricted=await change({action:'record_scope',id:members[0].id,viewScope:'owned',editScope:'owned'});
      members[0]=restricted.viewers.find(member=>member.email===emails[0]);
      await configure(0,{available:false});await configure(1,{available:false});
      await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'true'});
    },
    processWaiting:async(count,manualId,returningId)=>{
      await configure(0,{available:true,country:'Canada',regions:['Ontario']});
      assert.ok((await json(get(path+'?view=routing-preview&id='+returningId))).next);
      assert.equal((await retry(await details(returningId))).routing,'assigned','Retry uses the original submission for a returning contact without an address.');
      await configure(0,{available:true,country:'',additionalCountries:[],regions:[]});
      const manual=await details(manualId);
      assert.equal((await retry(manual)).routing,'assigned');
      for(let index=0;index<count;index++)await tick();
      await configure(0,{available:false});
      await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'false'});
    }});
  await reset();
  const departed=userIds[emails[0]],replacement=userIds[emails[1]];
  // Their editor access in a separate workspace does not keep the old assignment active here.
  await sql`INSERT INTO private_workspaces(id,owner_id) VALUES (gen_random_uuid(),${replacement}) ON CONFLICT (owner_id) DO NOTHING`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role)
    SELECT id,${departed},gen_random_uuid(),'editor' FROM private_workspaces WHERE owner_id=${replacement}
    ON CONFLICT (workspace_id,viewer_id) DO UPDATE SET role='editor'`;
  const target=lead=>({id:lead.id,expectedRevision:lead.revision});
  const waiting=async()=>new Set((await json(get(path+'?owner=needs-routing&search=Departure'))).records.map(row=>row.id));
  const followUp=await create('Departure phone follow-up',{assigneeId:departed});
  const renewal=await create('Departure renewal',{assigneeId:departed});
  const healthy=await create('Departure healthy rep',{assigneeId:replacement});
  const singleHandoff=await create('Former rep handoff',{assigneeId:departed});
  const batchHandoff=await create('Overnight handoff batch',{assigneeId:departed});
  const [{owner_id:manager}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspace}`;
  await create('Departure manager',{assigneeId:manager});
  const finished=await create('Departure closed',{assigneeId:departed});
  await close(finished);
  assert.deepEqual(await waiting(),new Set());
  await change({action:'revoke',id:members[0].id});
  assert.deepEqual(await waiting(),new Set([followUp.id,renewal.id]));
  assert.equal((await retry(followUp)).routing,'unavailable');
  assert.equal((await details(followUp.id)).revision,followUp.revision);
  const queueFormer={action:'queue_routing',...target(singleHandoff),releaseAssigneeId:departed};
  const queuePage={action:'route_page',leads:[target(batchHandoff),target(healthy),target(finished)],queueIfUnavailable:true};
  await json(post(path,queuePage),409);
  await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'true'});
  await json(post(path,{...queueFormer,releaseAssigneeId:replacement}),409);
  await json(post(path,{...queueFormer,...target(healthy),releaseAssigneeId:replacement}),409);
  await json(post(path+'?'+new URLSearchParams({workspaceId:workspace,grantId:members[0].id}),queuePage,other),403);
  assert.equal((await details(singleHandoff.id)).assigneeId,departed);
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads&record='+singleHandoff.id);
    await page.getByRole('button',{name:'Release former assignee and queue for routing'}).click();
    await page.getByRole('status').filter({hasText:'Queued for automatic routing.'}).waitFor();
    await page.getByText('Lead history',{exact:true}).click();
    await page.getByText('Released '+singleHandoff.assigneeLabel+' and queued for automatic routing',{exact:false}).waitFor();
    await page.goto(origin+'/?kind=leads&owner=needs-routing&search=Overnight+handoff+batch');
    await page.getByRole('checkbox',{name:/If no rep is available/}).check();
    await page.getByRole('button',{name:'Route this lead',exact:true}).click();
    await page.getByRole('status').filter({hasText:'1 waiting for automatic routing.'}).waitFor();
  });
  await json(post(path,queueFormer));
  assert.deepEqual(await json(post(path,queuePage)),{assigned:0,unavailable:0,skipped:3,queued:0});
  for(const held of [singleHandoff,batchHandoff]){
    const queued=await details(held.id);
    assert.equal(queued.assigneeId,null);
    assert.equal(queued.routingPending,true);
    assert.equal(queued.revision,held.revision+1);
    const [event]=(await json(get(path+'?view=history&id='+held.id))).entries;
    assert.equal(event.previous.assigneeId,departed);
    assert.equal(event.data.routingChange,'queued');
  }
  await configure(1,{available:true,country:'',additionalCountries:[],awayThrough:null,days:127,timeZone:'UTC',start:0,end:1440,capacity:10000});
  await tick();await tick();
  for(const held of [singleHandoff,batchHandoff]){
    const reassigned=await details(held.id);
    assert.equal(reassigned.assigneeId,replacement);
    assert.equal(reassigned.routingPending,false);
    assert.equal(reassigned.revision,held.revision+2);
  }
  await configureWeb({HARBOR_LEAD_ROUTING_RETRY_ENABLED:'false'});
  await reset();
  await withPage(async page=>{
    await page.goto(origin+'/?kind=leads&owner=needs-routing&search=Departure');
    const row=page.getByRole('row').filter({hasText:followUp.data.name});
    await row.getByText(followUp.assigneeLabel+' (unavailable)',{exact:true}).waitFor();
    await row.getByRole('link',{name:followUp.data.name}).click();
    await page.getByRole('button',{name:'Preview routing'}).click();
    await page.getByRole('button',{name:'Refresh routing preview'}).waitFor();
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
    await page.getByRole('button',{name:'Reassign lead'}).click();
    assert.equal((await (await response).json()).routing,'assigned');
  });
  const [event]=(await json(get(path+'?view=history&id='+followUp.id))).entries;
  assert.deepEqual([event.previous.assigneeId,event.data.assigneeId],[departed,replacement]);
  const batch=()=>json(post(path,{action:'route_page',leads:[target(followUp),target(renewal)]}));
  const restored=(await change({action:'grant',email:emails[0]})).viewers.find(row=>row.email===emails[0]);
  assert.deepEqual(await waiting(),new Set([renewal.id]),'A viewer still needs an editor to take their leads.');
  members[0]=(await change({action:'role',id:restored.id,role:'editor'})).viewers.find(row=>row.email===emails[0]);
  assert.deepEqual(await batch(),{assigned:0,unavailable:0,skipped:2},'A restored editor keeps their assignment.');
  const connected=await create('Still needs a follow-up',{data:{name:'Still needs a follow-up',leadStage:'Connected'},assigneeId:departed});
  members[0]=(await change({action:'role',id:members[0].id,role:'viewer'})).viewers.find(row=>row.email===emails[0]);
  assert.deepEqual(await batch(),{assigned:1,unavailable:0,skipped:1});
  assert.deepEqual(await batch(),{assigned:0,unavailable:0,skipped:2});
  assert.equal((await details(renewal.id)).assigneeId,replacement);
  assert.deepEqual(await waiting(),new Set());
  // Exercise the queue when almost every open lead already has an active editor.
  const scale=70000;
  await sql`INSERT INTO portable_leads(workspace_id,id,revision,data,assignee_id,assignee_label,created_at,updated_at)
    SELECT ${workspace},gen_random_uuid(),1,jsonb_build_object('name','Fictional follow-up '||n,'leadStage','Connected'),
      ${replacement},${emails[1]},now(),now() FROM generate_series(1,${scale}::int) n`;
  await sql`ANALYZE portable_leads`;
  const plan=await sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM (SELECT 1 FROM portable_leads
    WHERE archived_at IS NULL AND deal_id IS NULL AND data->>'leadStage' NOT IN ('Qualified','Disqualified')
      AND workspace_id=${workspace} AND assignee_id=${departed} LIMIT 26) open_work`;
  assert.match(JSON.stringify(plan[0]),/portable_leads_open_assignee/);
  const lookup=path+'?owner=needs-routing&stage=Connected&limit=25';
  const expected=await json(get(lookup));
  assert.equal(expected.next,null);
  assert.ok(expected.records.some(lead=>lead.id===connected.id));
  const elapsed=[];
  for(let i=0;i<5;i++){
    const start=performance.now();
    assert.deepEqual(await json(get(lookup)),expected);
    elapsed.push(performance.now()-start);
  }
  console.log('Needs routing with %d additional assigned leads: %d ms median over 5 warm local requests.',
    scale,Math.round(elapsed.sort((x,y)=>x-y)[2]));
  for(const member of members)await change({action:'revoke',id:member.id});
  await reset();
}
