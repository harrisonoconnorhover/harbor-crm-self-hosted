import assert from 'node:assert/strict';

export async function verifyFirstResponseQueue({origin,other,sql,workspaceId,grantId,newTicket,post,get,ok,open}){
  const api='/api/tickets',settings='/api/ticket-sla?kind=first-response',term='Response queue fixture';
  const previous=await ok(get(settings));
  await ok(post(settings,{...open,revision:previous.revision}));
  await newTicket('Pending response for the team dashboard');
  const create=label=>newTicket(term+' '+label);
  const [a,b,c,future,archived,answered]=await Promise.all(['Alpha','Bravo','Charlie','Delta','Archived','Answered'].map(create));
  const untargeted=await newTicket(term+' Low','Low'),untargeted2=await newTicket(term+' Low 2','Low');
  await ok(post(api,{id:answered.id,action:'first_response',expectedRevision:answered.revision,channel:'Phone',summary:'Called the customer.'}));
  const original='2020-01-02T00:00:00.123456Z',later='2020-01-02T00:00:00.123457Z';
  for(const [ticket,due] of [[a,original],[b,original],[c,later],[archived,original],[future,'2099-01-02T00:00:00Z']]){
    await sql`UPDATE portable_ticket_first_responses SET started_at='2020-01-01',due_at=${due}::text::timestamptz
      WHERE workspace_id=${workspaceId} AND ticket_id=${ticket.id}`;
  }
  await sql`UPDATE portable_tickets SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${archived.id}`;
  const sorted=[...[a.id,b.id].sort(),c.id,future.id];
  const queue={search:term,response:'unanswered',sort:'response_due'};
  async function walk(filters,auth){
    const ids=[];
    let cursor={};
    for(let i=0;i<10;i++){
      const path=api+'?'+new URLSearchParams({...filters,...cursor,limit:'1'});
      const page=await ok(get(path,auth));
      ids.push(...page.records.map(t=>t.id));
      if(!page.next)return ids;
      cursor={after:page.next,afterDueAt:page.nextDueAt};
      if(page.next===sorted[0]||page.next===sorted[1])assert.equal(page.nextDueAt,original);
      if(page.next===c.id)assert.equal(page.nextDueAt,later);
    }
    assert.fail('First-response queue did not reach its last page.');
  }
  assert.deepEqual(await walk(queue),sorted);
  assert.deepEqual(await walk({...queue,workspaceId},other),sorted);
  assert.deepEqual(await walk({...queue,response:'overdue'}),sorted.slice(0,3));
  assert.deepEqual(await walk({search:term,sort:'response_due'}),[...sorted.slice(0,3),answered.id,future.id,...[untargeted.id,untargeted2.id].sort()]);
  assert.deepEqual(await walk(queue,other),[]);
  const csv=await get(api+'?'+new URLSearchParams({...queue,export:'csv'}));
  assert.equal(csv.status,200);
  assert.deepEqual((await csv.text()).trimEnd().split('\r\n').slice(1).map(line=>line.split(',')[0].replaceAll('"','')),sorted);
  for(const params of [{sort:'response_due',after:a.id},{sort:'updated',after:a.id,afterDueAt:original},{afterDueAt:'none'}]){
    assert.equal((await get(api+'?'+new URLSearchParams(params))).status,400);
  }

  const [{owner_id:ownerId}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const [{id:repId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const assign=(ticket,assigneeId)=>ok(post(api,{action:'save',id:ticket.id,expectedRevision:ticket.revision,data:{name:ticket.data.name},assigneeId}));
  await assign(b,repId);
  await assign(c,ownerId);
  const mine={...queue,assignee:'me'},unassigned={...queue,assignee:'unassigned'};
  const coverage={...queue,assignee:ownerId};
  assert.deepEqual(await walk(coverage),[c.id]);
  assert.deepEqual(await walk({...coverage,workspaceId},other),[c.id]);
  assert.deepEqual(await walk(coverage,other),[]);
  assert.deepEqual(await walk({...coverage,assignee:crypto.randomUUID()}),[]);
  const coverageCsv=await get(api+'?'+new URLSearchParams({...coverage,export:'csv'}));
  assert.equal(coverageCsv.status,200);
  assert.deepEqual((await coverageCsv.text()).trimEnd().split('\r\n').slice(1).map(line=>line.split(',')[0].replaceAll('"','')),[c.id]);
  assert.deepEqual(await walk(mine),[c.id]);
  assert.deepEqual(await walk({...mine,workspaceId},other),[b.id]);
  assert.deepEqual(await walk(unassigned),[a.id,future.id]);
  const upcoming={...unassigned,response:'due_next_hour'};
  assert.deepEqual(await walk(upcoming),[]);
  await sql`UPDATE portable_ticket_first_responses SET due_at=now()+interval '20 minutes'
    WHERE workspace_id=${workspaceId} AND ticket_id=${future.id}`;
  assert.deepEqual(await walk(upcoming),[future.id]);
  const shortCsv=await get(api+'?'+new URLSearchParams({...upcoming,export:'csv'}));
  assert.equal(shortCsv.status,200);
  assert.deepEqual((await shortCsv.text()).trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0].replaceAll('"','')),[future.id]);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/tickets?'+new URLSearchParams({search:term,workspaceId}));
    await page.getByRole('link',{name:'First responses due',exact:true}).click();
    const rows=page.locator('tbody tr');
    assert.equal(await rows.count(),4);
    const firstPage=page.url();
    await page.goto(firstPage+'&limit=1');
    await page.getByRole('link',{name:'Next tickets'}).click();
    const secondPage=page.url();
    const secondTicket=await rows.getByRole('link').first().innerText();
    await rows.getByRole('link').first().click();
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams),Object.fromEntries(new URL(secondPage).searchParams));
    assert.equal(await rows.count(),1);
    assert.equal(await rows.getByRole('link').first().innerText(),secondTicket);
    await page.goto(firstPage);
    const deadline=rows.first().locator('.ticket-deadline time');
    assert.equal(await deadline.getAttribute('datetime'),'2020-01-02T00:00:00.123Z');
    const box=await deadline.boundingBox();
    assert.ok(box&&box.x>=0&&box.x+box.width<=390,'The deadline should be readable before horizontal scrolling.');
    await rows.first().getByRole('link').first().click();
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams),{...queue,workspaceId});
    await page.getByLabel('Assigned to',{exact:true}).selectOption(ownerId);
    await page.getByRole('button',{name:'Apply filters'}).click();
    await rows.getByRole('link',{name:c.data.name,exact:true}).click();
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    assert.equal(await page.getByLabel('Assigned to',{exact:true}).inputValue(),ownerId);
    assert.equal(await rows.count(),1);
    await page.getByRole('link',{name:'My first responses',exact:true}).click();
    assert.equal(await rows.count(),1);
    await rows.getByRole('link',{name:b.data.name,exact:true}).waitFor();
    await page.getByRole('link',{name:'Unassigned first responses',exact:true}).click();
    await page.getByLabel('First response',{exact:true}).selectOption('due_next_hour');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await rows.getByRole('link',{name:future.data.name,exact:true}).click();
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    assert.equal(await page.getByLabel('Assigned to',{exact:true}).inputValue(),'unassigned');
    assert.equal(await page.getByLabel('First response',{exact:true}).inputValue(),'due_next_hour');
    assert.equal(await rows.count(),1);
    await rows.getByRole('button',{name:'Take ticket: '+future.data.name,exact:true}).click();
    await page.getByRole('heading',{name:future.data.name,exact:true}).waitFor();
    assert.equal((await ok(get(api+'?id='+future.id))).assigneeId,repId);
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    await page.getByText('No matching tickets.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'My first responses',exact:true}).click();
    assert.equal(await rows.count(),2);
    await rows.getByRole('link',{name:future.data.name,exact:true}).click();
    await page.getByText('Log first customer response',{exact:true}).click();
    await page.getByLabel('What did you tell the customer?').fill('Confirmed the replacement shipment by phone.');
    await page.locator('select[name="channel"]').selectOption('Phone');
    await page.getByRole('button',{name:'Log completed response'}).click();
    await page.getByText(/Confirmed the replacement shipment by phone.*Logged by/).waitFor();
    await page.getByRole('link',{name:'Back to Help desk'}).click();
    assert.equal(await rows.count(),1);
    await rows.getByRole('link',{name:b.data.name,exact:true}).waitFor();
  }finally{await browser.close();}
  const take=ticket=>({action:'take_first_response',id:ticket.id,expectedRevision:ticket.revision});
  const before=await ok(get(api+'?id='+a.id));
  const competing=await Promise.all([post(api,take(a)),post(api+'?'+new URLSearchParams({workspaceId,grantId}),take(a),other)]);
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
  const claimed=await ok(get(api+'?id='+a.id)),winner=competing[0].ok?ownerId:repId;
  assert.equal(claimed.assigneeId,winner);
  assert.equal(claimed.revision,a.revision+1);
  assert.deepEqual(claimed.data,before.data);
  assert.deepEqual(claimed.firstResponse,before.firstResponse);
  const [history]=await sql`SELECT actor_id FROM portable_ticket_events WHERE workspace_id=${workspaceId}
    AND ticket_id=${a.id} AND revision=${claimed.revision}`;
  assert.equal(history.actor_id,winner);
  assert.equal((await post(api,take(claimed))).status,409,'A fresh revision cannot steal another assignment');
  assert.equal((await post(api,take(answered))).status,409,'A confirmed reply can arrive without a ticket revision change');
  assert.equal((await post(api,take(untargeted))).status,409);
  await ok(post(api,{action:'first_response',id:a.id,expectedRevision:claimed.revision,channel:'Phone',summary:'Responded to Alpha.'}));
  assert.deepEqual(await walk(queue),sorted.filter(id=>id!==a.id&&id!==future.id));
  await ok(post(settings,{...previous,revision:previous.revision+1}));
  return api+'?'+new URLSearchParams({...queue,workspaceId});
}

export async function verifyDeadlineQueueAtScale({request,origin,headers,sql,workspaceId}){
  // The ordinary list rehearsal has already populated real ticket rows. Reuse them for the support queue.
  const entries=await sql`WITH sample AS (
      SELECT id FROM portable_tickets WHERE workspace_id=${workspaceId} AND archived_at IS NULL AND data->>'name' LIKE 'Fictional case %' LIMIT 40000
    ) INSERT INTO portable_ticket_first_responses(workspace_id,ticket_id,policy_revision,target_minutes,started_at,due_at)
      SELECT ${workspaceId},id,1,60,'2039-01-01'::timestamptz,'2040-01-01'::timestamptz+(row_number() OVER (ORDER BY id)/10)*interval '1 minute'
      FROM sample RETURNING ticket_id,to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due`;
  assert.equal(entries.length,40000);
  entries.sort((a,b)=>a.due.localeCompare(b.due)||a.ticket_id.localeCompare(b.ticket_id));
  await sql`VACUUM (ANALYZE) portable_ticket_first_responses`;
  const [expected]=await sql`SELECT count(*) AS total,count(*) FILTER(WHERE r.ticket_id IS NULL) AS untargeted
    FROM portable_tickets t LEFT JOIN portable_ticket_first_responses r ON r.workspace_id=t.workspace_id AND r.ticket_id=t.id
    WHERE t.workspace_id=${workspaceId} AND t.archived_at IS NULL`;
  const reportStart=performance.now();
  const response=await request('/api/reporting',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'preview',definition:{name:'Support deadline performance',kind:'tickets',groupBy:'firstResponseOutcome'}})});
  assert.equal(response.status,200,await response.clone().text());
  const {result}=await response.json();
  assert.equal(Number(result.count),Number(expected.total));
  assert.equal(Number(result.rows.find(row=>row.key==='no_target').count),Number(expected.untargeted));
  assert.ok(result.rows.some(row=>row.key==='waiting'&&Number(row.count)>=40000));
  console.log('First-response report, '+result.count+' local tickets: '+Math.round(performance.now()-reportStart)+' ms.');
  async function reads(){
    const [r]=await sql`SELECT idx_scan,idx_tup_read FROM pg_stat_user_indexes WHERE indexrelname='portable_first_response_due'`;
    return {scans:Number(r.idx_scan),entries:Number(r.idx_tup_read)};
  }
  const before=await reads();
  const boundary=entries[35000],params=new URLSearchParams({response:'unanswered',sort:'response_due',after:boundary.ticket_id,afterDueAt:boundary.due,limit:'25'});
  const start=performance.now();
  async function loadPage(){
    const response=await request('/api/tickets?'+params,{headers});
    assert.equal(response.status,200,await response.clone().text());
    const page=await response.json();
    assert.deepEqual(page.records.map(r=>r.id),entries.slice(35001,35026).map(row=>row.ticket_id));
  }
  await loadPage();
  const elapsed=Math.round(performance.now()-start);
  for(let i=0;i<15;i++){
    const stats=await reads();
    if(stats.scans>before.scans){
      const inspected=stats.entries-before.entries;
      assert.ok(inspected<300*(i+1),'Deep page inspected '+inspected+' deadline index entries for 25 rows.');
      console.log('40,000 pending tickets, deep 25-ticket page: '+elapsed+' ms, '+inspected+' deadline index entries.');
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,200));
    await loadPage();
  }
  assert.fail('The first-response queue did not use its deadline index.');
}
