import assert from 'node:assert/strict';

export async function prepareResponseTickets({post,ok,read,other}){
  const settings='/api/ticket-sla?kind=first-response';
  for(const auth of [undefined,other]){
    const policy=await ok(read(settings,auth));
    await ok(post(settings,{...policy,enabled:true,targets:{Urgent:null,High:60,Medium:null,Low:null},
      calendar:{zone:'UTC',week:Array(7).fill({open:0,close:1440}),holidays:[]}},auth));
  }
  async function create(name,auth){
    return (await ok(post('/api/tickets',{action:'save',data:{name,ticketPriority:'High'}},auth))).record;
  }
  const first=await create('Dock scanner case'),second=await create('Spare scanner case'),foreign=await create('Other workspace case',other);
  const payload=(ticket,replyId)=>({action:'inbox_first_response',id:ticket.id,expectedRevision:ticket.revision,replyId});
  return {first,second,foreign,payload};
}

export async function verifyResponseFromInbox({origin,other,workspaceId,id,reply,incomingId,tickets,post,read,ok,detail,deliveries,signIn}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const {second,foreign,payload}=tickets,source=reply.replyId;
  const email='invitee@example.test',agent=await signIn(email);
  const change=async input=>(await ok(post('/api/workspaces',input))).viewers.find(row=>row.email===email);
  let grant=await change({action:'grant',email});
  grant=await change({action:'role',id:grant.id,role:'editor'});
  const policy=async(tool,view,edit)=>{
    grant=await change({action:'tool_permissions',ids:[grant.id],tool,policy:{view,edit,create:false,delete:false}});
  };
  await policy('contacts','none','none');
  await policy('tickets','all','owned');
  await policy('team-inbox','all','none');
  const first=(await ok(post('/api/tickets',{action:'save',id:tickets.first.id,expectedRevision:tickets.first.revision,
    assigneeId:grant.actorId,data:{name:tickets.first.data.name}}))).record;
  tickets.first=first;
  const log=(ticket,msg,overrides={})=>post('/api/tickets?'+new URLSearchParams({workspaceId,grantId:grant.id}),{...payload(ticket,msg),...overrides},agent);
  const mine='/api/tickets?workspaceId='+workspaceId+'&response=unanswered&editableOnly=1';
  assert.deepEqual((await ok(read(mine,agent))).records.map(r=>r.id),[first.id]);
  assert.equal((await log(second,source)).status,404);
  const before=(await deliveries()).length;
  assert.equal((await log(first,incomingId)).status,409);
  assert.equal((await log(first,source,{expectedRevision:99})).status,409);
  assert.equal((await post('/api/tickets',payload(foreign,source),other)).status,409);
  const recordedMessage=(await detail()).messages.find(row=>row.id===source);
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=agent.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    const from='/?'+new URLSearchParams({view:'team-inbox',id,workspaceId});
    await page.goto(origin+from);
    assert.equal(await page.getByRole('button',{name:'Claim conversation'}).count(),0);
    await page.getByRole('button',{name:'Use as first response'}).click();
    await page.getByLabel('Find a ticket').fill('Dock scanner case');
    await page.getByLabel('Ticket awaiting a first response').selectOption({label:first.data.name});
    await page.getByRole('button',{name:'Log first response',exact:true}).click();
    await page.getByRole('link',{name:'View first response on ticket'}).click();
    await page.getByRole('heading',{name:first.data.name,exact:true}).waitFor();
    await page.getByText(/Logged by/).waitFor();
    await page.getByRole('link',{name:'View original reply'}).click();
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
    assert.equal(new URL(page.url()).searchParams.get('messageId'),source);
    assert.equal(await page.locator('.inbox-msg').count(),1);
    await page.getByRole('heading',{name:'Original reply'}).waitFor();
    await page.getByRole('link',{name:'View first response on ticket'}).waitFor();
  }finally{await browser.close();}
  const receipt=(await ok(read('/api/tickets?id='+first.id))).firstResponse;
  assert.equal(receipt.respondedAt,new Date(recordedMessage.createdAt).toISOString());
  assert.equal(receipt.inboxConversationId,id);assert.equal(receipt.actorId,grant.actorId);
  assert.equal(receipt.channel,'Email');assert.equal(receipt.status,'met');
  assert.equal(receipt.workingMs,Date.parse(receipt.respondedAt)-Date.parse(first.createdAt));
  assert.deepEqual((await ok(read('/api/tickets?response=unanswered'))).records.map(r=>r.id),[second.id]);
  assert.equal((await post('/api/tickets',payload(second,source))).status,409);
  assert.equal((await log(first,source)).status,200);
  await policy('team-inbox','none','none');
  assert.equal((await log(first,source)).status,403);
  const ticketPath='/api/tickets?id='+first.id+'&workspaceId='+workspaceId;
  const hidden=(await ok(read(ticketPath,agent))).firstResponse;
  assert.equal(hidden.inboxReplyId,null);
  assert.equal(hidden.summary,'Reply from team inbox');
  await policy('team-inbox','all','none');
  grant=await change({action:'record_scope',id:grant.id,viewScope:'owned',editScope:'owned'});
  assert.equal((await log(first,source)).status,403);
  assert.equal((await ok(read(ticketPath,agent))).firstResponse.inboxConversationId,null);
  await ok(post('/api/workspaces',{action:'revoke',id:grant.id}));
  assert.equal((await deliveries()).length,before);
}
