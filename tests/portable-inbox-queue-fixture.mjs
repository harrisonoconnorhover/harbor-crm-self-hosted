import assert from 'node:assert/strict';

export async function verifyInboxQueues({origin,sql,workspaceId,id,other,headers,read,post,ok,ownerId}){
  // Put older matching conversations behind a full page and unrelated mail ahead of them.
  await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,tags,updated_at)
    SELECT ${workspaceId},gen_random_uuid(),'sales@example.test','buyer@example.test','Pricing request '||n,
      ARRAY['Pricing'],now()-n*interval '1 minute' FROM generate_series(1,30) n`;
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,provider_id,body,created_at)
    SELECT workspace_id,gen_random_uuid(),id,mailbox,'incoming','received',gen_random_uuid()::text,'Fictional quantity confirmation '||n,
      updated_at+n*interval '1 minute' FROM portable_inbox_conversations CROSS JOIN generate_series(1,2) n
    WHERE workspace_id=${workspaceId} AND subject LIKE 'Pricing request %'`;
  // All have recent follow-ups. Three customers first wrote four days ago, the others two.
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,provider_id,body,created_at)
    SELECT workspace_id,gen_random_uuid(),id,mailbox,'incoming','received',gen_random_uuid()::text,'Initial inquiry',
      updated_at-CASE WHEN subject IN ('Pricing request 1','Pricing request 2','Pricing request 3')
        THEN interval '96 hours' ELSE interval '48 hours' END FROM portable_inbox_conversations
    WHERE workspace_id=${workspaceId} AND subject LIKE 'Pricing request %'`;
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,actor_id,internet_id,body,created_at)
    SELECT workspace_id,gen_random_uuid(),id,mailbox,'outgoing',CASE WHEN subject='Pricing request 1' THEN 'sent' ELSE 'failed' END,
      ${ownerId},gen_random_uuid()::text,'Fictional answer',updated_at-interval '12 hours'
    FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND subject IN ('Pricing request 1','Pricing request 2')`;
  const subject='Dispatch 50%_off\\hold';
  const [special]=await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,status)
    VALUES (${workspaceId},gen_random_uuid(),'sales@example.test','clerk+relay@example.test',${subject},'resolved')
    RETURNING id`;
  const search=(q,params={})=>'/api/team-inbox?'+new URLSearchParams({q,status:'resolved',...params});
  for(const term of ['50%_OFF\\hold','+RELAY@','%','_','\\']){
    assert.deepEqual((await ok(read(search(term,{workspaceId}),other))).items.map(row=>row.id),[special.id]);
  }
  assert.deepEqual((await ok(read(search('+relay@'),other))).items,[]);
  assert.deepEqual((await ok(read(search('+relay@',{status:'open'})))).items,[]);
  assert.equal((await read(search('x'.repeat(121)))).status,400);
  assert.equal((await read('/api/team-inbox?id='+id+'&q=pricing')).status,400);
  const filtered='/api/team-inbox?'+new URLSearchParams({workspaceId,mailbox:'Sales@Example.Test',claim:'unclaimed',tag:'PRICING',q:'pricing REQuest'});
  const first=await ok(read(filtered,other));
  assert.equal(first.items.length,25);
  const last=await ok(read(filtered+'&after='+first.next,other));
  assert.equal(last.items.length,5);assert.equal(last.next,null);
  assert.equal(new Set([...first.items,...last.items].map(item=>item.id)).size,30);
  const waiting=filtered+'&status=needs_reply&waiting=';
  const day=await ok(read(waiting+'24h',other));
  const dayEnd=await ok(read(waiting+'24h&after='+day.next,other));
  const allDay=[...day.items,...dayEnd.items];
  assert.equal(new Set(allDay.map(row=>row.id)).size,29);
  assert.ok(allDay.every(row=>row.subject!=='Pricing request 1'&&Date.parse(row.waitingSince)<Date.now()-86400000));
  const longest=(await ok(read(waiting+'72h',other))).items;
  assert.deepEqual(longest.map(row=>row.subject),['Pricing request 2','Pricing request 3']);
  assert.deepEqual((await ok(read('/api/team-inbox?status=needs_reply&waiting=72h',other))).items,[]);
  assert.equal((await read(filtered+'&waiting=24h',other)).status,400);
  const bodyFilter=filtered+'&messageText=confirmation%20QUANTITY';
  const bodyFirst=await ok(read(bodyFilter,other));
  const bodyNext=await ok(read(bodyFilter+'&after='+bodyFirst.next,other));
  const matching=[...bodyFirst.items,...bodyNext.items];
  assert.deepEqual(matching.map(row=>row.id),[...first.items,...last.items].map(row=>row.id));
  const newest=await ok(read('/api/team-inbox?'+new URLSearchParams({workspaceId,id:matching[0].id,messageId:matching[0].matchingMessageId}),other));
  assert.deepEqual(newest.messages.map(message=>message.body),['Fictional quantity confirmation 2']);
  const boundary=first.items.at(-1);
  const legacy=await ok(read(filtered+'&after='+boundary.id,other));
  assert.deepEqual(legacy.items.map(item=>item.id),last.items.map(item=>item.id));
  const mine='/api/team-inbox?workspaceId='+workspaceId+'&claim=mine&tag=HARDWARE';
  assert.deepEqual((await ok(read(mine,other))).items.map(item=>item.id),[id]);
  assert.deepEqual((await ok(read('/api/team-inbox?claim=mine&tag=hardware',headers))).items,[]);
  assert.deepEqual((await ok(read('/api/team-inbox?tag=Pricing',other))).items,[]);
  assert.equal((await read('/api/team-inbox?id='+id+'&claim=mine')).status,400);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const ctx=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await ctx.addCookies([{name,value,url:origin}]);
    const page=await ctx.newPage();
    const loaded=await page.goto(origin+'/?view=team-inbox&workspaceId='+workspaceId);
    assert.equal(loaded.status(),200,await page.locator('body').innerText());
    assert.ok(await page.getByRole('form',{name:'Filter conversations'}).isVisible(), await page.locator('body').innerText());
    await page.getByRole('link',{name:'Needs reply',exact:true}).click();
    const duration=page.getByLabel('Customer wait');
    await duration.selectOption('72h');
    await page.getByRole('button',{name:'Apply filters'}).click();
    const delayed=page.getByRole('listitem').filter({has:page.getByRole('link',{name:'Pricing request 2',exact:true})});
    assert.equal(Date.parse(await delayed.getByText('Waiting since').locator('time').getAttribute('datetime')),Date.parse(longest[0].waitingSince));
    await delayed.getByRole('link',{name:'Pricing request 2',exact:true}).click();
    await page.getByRole('link',{name:'Inbox',exact:true}).filter({visible:true}).click();
    assert.equal(await duration.inputValue(),'72h');
    await page.getByRole('link',{name:'Open',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.has('waiting'),false);
    await page.getByRole('link',{name:'Filter by tag hardware',exact:true}).click();
    assert.equal(await page.getByLabel('Conversation tag',{exact:true}).inputValue(),'hardware');
    await page.getByRole('link',{name:'Filter by mailbox support@example.test',exact:true}).click();
    assert.equal(await page.getByLabel('Team mailbox',{exact:true}).inputValue(),'support@example.test');
    await page.getByRole('combobox',{name:/^Claim/}).selectOption('unclaimed');
    await page.getByLabel('Team mailbox',{exact:true}).fill('sales@example.test');
    await page.getByLabel('Conversation tag',{exact:true}).fill('pricing');
    const searchBox=page.getByRole('searchbox',{name:'Search conversations'});
    await searchBox.fill('pricing REQuest');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.getByRole('link',{name:'Needs reply',exact:true}).click();
    await page.getByRole('link',{name:'More conversations'}).click();
    const secondPage=new URL(page.url()).searchParams;
    assert.equal(secondPage.get('after'),first.next);
    assert.equal(secondPage.get('status'),'needs_reply');
    const link=page.getByRole('link',{name:'Pricing request 26',exact:true});
    const address=await link.getAttribute('href');
    const selected=new URL(address,origin).searchParams.get('id');
    await link.click();
    await page.getByRole('link',{name:'Inbox',exact:true}).filter({visible:true}).click();
    await link.waitFor();
    assert.equal(new URL(page.url()).searchParams.get('after'),first.next);
    assert.equal(new URL(page.url()).searchParams.get('status'),'needs_reply');
    assert.equal(await page.getByLabel('Conversation tag',{exact:true}).inputValue(),'pricing');
    assert.equal(await searchBox.inputValue(),'pricing REQuest');
    await ok(post('/api/team-inbox',{id:boundary.id,revision:boundary.revision,action:'claim'}));
    const stable=await ok(read(filtered+'&after='+first.next,other));
    assert.deepEqual(stable.items.map(item=>item.id),last.items.map(item=>item.id));
    const detail=await ok(read('/api/team-inbox?id='+selected));
    await ok(post('/api/team-inbox',{id:selected,revision:detail.conversation.revision,action:'claim'}));
    await link.waitFor({state:'hidden',timeout:15000});
    await page.getByRole('link',{name:'Needs review',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('claim'),'unclaimed');
    assert.equal(new URL(page.url()).searchParams.get('after'),null);
    await page.getByRole('heading',{name:'No conversations match these filters'}).waitFor();
    await page.getByRole('link',{name:'Clear filters'}).click();
    await page.getByRole('heading',{name:'No conversations need a delivery review'}).waitFor();
    assert.equal(await page.getByLabel('Team mailbox',{exact:true}).inputValue(),'');
    assert.equal(await searchBox.inputValue(),'');
    await page.getByRole('link',{name:'Open',exact:true}).click();
    const claim=page.getByRole('combobox',{name:/^Claim/});
    await claim.selectOption({label:'Harbor Fixture (owner@example.test)'});
    await page.getByRole('button',{name:'Apply filters'}).click();
    const namedQueue=page.url();
    assert.equal(new URL(namedQueue).searchParams.get('claim'),ownerId);
    const ownedRows=await ok(read('/api/team-inbox?claim='+ownerId+'&workspaceId='+workspaceId,other));
    assert.deepEqual(new Set(ownedRows.items.map(row=>row.id)),new Set([selected,boundary.id]));
    assert.ok(ownedRows.items.every(row=>row.claimedBy===ownerId));
    assert.deepEqual((await ok(read('/api/team-inbox?claim='+ownerId,other))).items,[]);
    const current=ownedRows.items.find(row=>row.id===selected);
    const item=page.getByRole('link',{name:current.subject,exact:true});
    await item.click();
    await page.getByRole('link',{name:'Inbox',exact:true}).filter({visible:true}).click();
    assert.equal(await claim.inputValue(),ownerId);
    await ok(post('/api/team-inbox',{action:'release',id:selected,revision:current.revision}));
    await page.goto(namedQueue);
    await item.waitFor({state:'hidden'});
    await page.getByRole('link',{name:boundary.subject,exact:true}).waitFor();
    assert.equal(await claim.inputValue(),ownerId);
    await page.getByRole('link',{name:'Clear filters'}).click();
    const boundaryRow=page.getByRole('listitem').filter({has:page.getByRole('link',{name:boundary.subject,exact:true})});
    await boundaryRow.getByRole('link',{name:'Filter by teammate '+ownedRows.items[0].claimedByLabel,exact:true}).click();
    assert.equal(await claim.inputValue(),ownerId);
    assert.equal((await read('/api/team-inbox?claim=misspelled')).status,400);

    // Both agents submit the same visible revision. Let the rep's claim reach Harbor first.
    const contested=last.items.find(row=>row.id!==selected&&row.id!==boundary.id);
    const queue={view:'team-inbox',status:'needs_reply',mailbox:'sales@example.test',claim:'unclaimed',tag:'pricing',after:first.next};
    const ownerPage=await browser.newPage();
    const [ownerCookie,ownerValue]=headers.cookie.split('=');
    await ownerPage.context().addCookies([{name:ownerCookie,value:ownerValue,url:origin}]);
    const ownerQueue=origin+'/?'+new URLSearchParams(queue);
    await Promise.all([ownerPage.goto(ownerQueue),page.goto(ownerQueue+'&workspaceId='+workspaceId)]);
    const button=tab=>tab.getByRole('button',{name:'Claim and open '+contested.subject,exact:true});
    let resumeOwner;
    const holdOwner=new Promise(resolve=>{resumeOwner=resolve;});
    await ownerPage.route('**/api/team-inbox*',async route=>{
      if(route.request().method()==='POST')await holdOwner;
      await route.continue();
    });
    const ownerRequest=ownerPage.waitForRequest(r=>r.method()==='POST'&&r.url().includes('/api/team-inbox'));
    try{
      await button(ownerPage).click();
      await ownerRequest;
      await button(page).click();
      await page.getByRole('heading',{name:contested.subject,exact:true}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
    }finally{resumeOwner();}
    await ownerPage.getByRole('alert').filter({hasText:'conversation changed'}).waitFor();
    assert.equal(ownerPage.url(),ownerQueue);
    await button(ownerPage).waitFor({state:'hidden'});
    await ownerPage.getByRole('alert').getByRole('link',{name:'View conversation'}).click();
    await ownerPage.getByRole('heading',{name:contested.subject,exact:true}).waitFor();
    const claimed=await ok(read('/api/team-inbox?id='+contested.id));
    assert.ok(claimed.conversation.claimedBy&&claimed.conversation.claimedBy!==ownerId);
    assert.equal(claimed.conversation.revision,contested.revision+1);
    await page.getByRole('link',{name:'Inbox',exact:true}).filter({visible:true}).click();
    const returned=new URL(page.url()).searchParams;
    for(const [key,value] of Object.entries({...queue,workspaceId}))assert.equal(returned.get(key),value,key);
    await button(page).waitFor({state:'hidden'});
    await ok(post('/api/team-inbox',{action:'release',id:contested.id,revision:claimed.conversation.revision}));
  }finally{await browser.close();}
}
