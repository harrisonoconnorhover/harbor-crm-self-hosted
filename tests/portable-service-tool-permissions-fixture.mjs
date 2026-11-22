import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// The settings rehearsal has already granted the second account editor access.
// Rotate its grant through the owner API and reuse the same signed-in session.
export async function verifySharedServiceToolPermissions({request,origin,headers,other,sql}){
  const post=async(path,body,auth=headers)=>{
    const send=()=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const response=await send();
    if(response.status!==429)return response;
    assert.equal(response.headers.get('retry-after'),'60');
    await new Promise(resolve=>setTimeout(resolve,60_000));
    return send();
  };
  const get=path=>request(path,{headers:other});
  const roster=await (await request('/api/workspaces',{headers})).json();
  let grant=roster.viewers.find(m=>m.email==='other@example.test').id;
  const workspace=roster.owned,scope='workspaceId='+workspace,thread=randomUUID(),ticket=randomUUID();
  const threadPath='/api/team-inbox?id='+thread+'&'+scope,ticketPath='/api/tickets?id='+ticket+'&'+scope;
  const checked=async(response)=>{assert.ok(response.ok,await response.clone().text());return response.json();};
  async function set(tool,view,edit='none'){
    const result=await checked(await post('/api/workspaces',{action:'tool_permissions',ids:[grant],tool,
      policy:{view,edit,create:false,delete:false}}));
    grant=result.viewers.find(m=>m.email==='other@example.test').id;
  }
  await sql.begin(async tx=>{
    await tx`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject) VALUES
      (${workspace},${thread},'support@example.test','visitor@example.test','Fictional scope rehearsal')`;
    await tx`INSERT INTO portable_tickets(workspace_id,id,revision,data,created_at,updated_at) VALUES
      (${workspace},${ticket},1,'{"name":"Fictional ticket","ticketStatus":"New","tags":["practice"]}',now(),now())`;
    await tx`INSERT INTO portable_inbox_ticket_links(workspace_id,ticket_id,conversation_id) VALUES (${workspace},${ticket},${thread})`;
  });
  assert.equal((await checked(await get(threadPath))).ticket.id,ticket);
  const lookup={
    'team-inbox':[threadPath,'/?view=team-inbox&'+scope],
    knowledge:['/api/team-inbox?articles=1&'+scope,'/api/team-inbox?articles=topics&'+scope,'/?view=knowledge&'+scope],
    snippets:['/api/team-inbox?snippets=names&'+scope,'/api/team-inbox?snippets=1&'+scope,'/?view=snippets&'+scope],
    segments:['/api/segments?'+scope,'/?view=segments&'+scope],
  };
  for(const [tool,paths] of Object.entries(lookup)){
    assert.equal((await get(paths[0])).status,200,tool);
    await set(tool,'none');
    for(const path of paths)assert.equal((await get(path)).status,404,path);
    if(tool==='team-inbox')assert.equal((await checked(await get(ticketPath))).inboxConversationId,null);
    await set(tool,'all');
    assert.equal((await get(paths[0])).status,200,tool);
  }
  const grantCalls=await checked(await post('/api/workspaces',{action:'contact_outreach',id:grant,enabled:true}));
  grant=grantCalls.viewers.find(m=>m.email==='other@example.test').id;
  for(const tool of ['sales-workspace','calls']){
    const path='/?view='+tool+'&'+scope;
    assert.equal((await get(path)).status,200,tool);
    await set(tool,'none');assert.equal((await get(path)).status,404,tool);
    await set(tool,'all');assert.equal((await get(path)).status,200,tool);
  }
  const dupPage='/?view=duplicates&kind=companies&'+scope;
  const dupApi=()=>'/api/duplicates?'+scope+'&grantId='+grant;
  const a=randomUUID(),b=randomUUID();
  for(const view of ['none','all']){
    await set('duplicates',view);
    assert.equal((await get(dupPage)).status,view==='none'?404:200);
    assert.equal((await get(dupApi()+'&kind=companies')).status,view==='none'?403:200);
    assert.equal((await post(dupApi(),{action:'dismiss',kind:'companies',recordA:a,recordB:b},other)).status,403);
    for(const kind of ['contacts','companies']){
      const pair={kind,primaryId:a,secondaryId:b};
      for(const action of [{...pair,action:'preview'},{...pair,action:'merge',requestId:randomUUID(),expectedRevisions:{primary:1,secondary:1},choices:{}}]){
        assert.equal((await post('/api/record-merge?'+scope+'&grantId='+grant,action,other)).status,403);
      }
    }
  }
  await set('duplicates','all','all');
  assert.equal((await post(dupApi(),{action:'dismiss',kind:'companies',recordA:a,recordB:b},other)).status,404);
  const claim=()=>post('/api/team-inbox?'+scope+'&grantId='+grant,{action:'claim',id:thread,revision:1},other);
  assert.equal((await claim()).status,403);
  await set('tickets','none');
  assert.equal((await checked(await get(threadPath))).ticket,null);
  assert.deepEqual((await checked(await get('/api/team-inbox?ticketTag=practice&'+scope))).items,[]);
  await set('team-inbox','all','all');
  assert.equal((await claim()).status,200);
  // Start the independent support-shift rehearsal with a fresh fixture request window.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const detail=async()=>checked(await request('/api/team-inbox?id='+thread,{headers}));
  const current=async()=>(await detail()).conversation;
  const held=await current(),rep=held.claimedBy;
  const ownerAction=(action,revision,extra={})=>post('/api/team-inbox',{action,id:thread,revision,...extra});
  assert.ok(rep);
  // An editor can cover a conversation without being able to work its linked ticket.
  const linkedTicket={id:ticket,revision:1};
  assert.equal((await ownerAction('assign_ticket',held.revision,{ticketId:ticket,ticketRevision:1,assigneeId:rep})).status,409);
  await checked(await ownerAction('release',held.revision));
  const free=await current();
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=team-inbox&id='+thread);
    await page.getByText('Assign to teammate',{exact:true}).click();
    await page.getByLabel('Teammate',{exact:true}).selectOption(rep);
    assert.ok(await page.getByLabel('Also assign linked ticket').isDisabled());
    await page.getByText('Reassign ticket',{exact:true}).click();
    assert.equal(await page.getByLabel('Ticket assignee',{exact:true}).locator('option[value="'+rep+'"]').count(),0);
    await set('team-inbox','all');
    await page.reload();
    assert.equal(await page.locator('#inbox-handoff-recipient option[value="'+rep+'"]').count(),0);
    await set('team-inbox','all','all');
  }finally{await browser.close();}
  assert.equal((await ownerAction('assign',free.revision,{assigneeId:rep,linkedTicket})).status,409);
  assert.equal((await current()).revision,free.revision);
  await checked(await ownerAction('assign',free.revision,{assigneeId:rep,note:'Cover the support queue.'}));
  const assigned=await current();
  await set('segments','none');
  assert.equal((await current()).revision,assigned.revision);
  await set('team-inbox','all');
  const released=await current();
  assert.equal(released.claimedBy,null);
  assert.equal(released.revision,assigned.revision+1);
  assert.equal((await ownerAction('assign',released.revision,{assigneeId:rep})).status,409);
  assert.equal((await detail()).messages.filter(m=>m.state==='handoff'&&m.body==='Cover the support queue.').length,1);
  assert.equal((await detail()).ticket.revision,1);
  await set('team-inbox','all','all');
  // If a handoff wins the race it must be released; otherwise the handoff must be refused.
  const [transfer]=await Promise.all([ownerAction('assign',released.revision,{assigneeId:rep}),set('team-inbox','none')]);
  assert.ok([200,409].includes(transfer.status));
  const afterRace=await current();
  assert.equal(afterRace.claimedBy,null);
  assert.equal(afterRace.revision,released.revision+(transfer.ok?2:0));
  await checked(await ownerAction('claim',afterRace.revision));
  await set('team-inbox','all','all');
  assert.notEqual((await current()).claimedBy,rep);
}
