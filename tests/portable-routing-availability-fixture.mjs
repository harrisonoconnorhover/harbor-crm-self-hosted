import assert from 'node:assert/strict';

export async function verifyRoutingAvailability({request,origin,headers,other,workspace,rep,general,sql,submitInquiry}){
  const routing='/api/leads?view=routing',leads='/api/leads';
  async function post(url,body,status=200){
    const res=await request(url,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(res.status,status,await res.clone().text());
    return res.json();
  }
  const rules=async()=>(await (await request(routing,{headers})).json()).members;
  const specialist=async()=>(await rules()).find(rule=>rule.country.toLowerCase()==='canada');
  const configure=async fields=>{
    const {label,...rule}=await specialist();
    assert.ok(label);
    await post(routing,{...rule,...fields});
  };
  // Use two zones a day apart and keep the fixture away from their midnight boundary.
  const [{west,east,day}]=await sql`SELECT west,east,(now() AT TIME ZONE west)::date::text AS day
    FROM (VALUES ('Pacific/Honolulu','Pacific/Kiritimati'),('Etc/GMT+12','Etc/GMT-12')) zones(west,east)
    WHERE extract(hour FROM now() AT TIME ZONE west)<23 LIMIT 1`;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext();
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?kind=leads');
    const loaded=page.waitForResponse(res=>new URL(res.url()).search==='?view=routing');
    await page.getByText('Lead routing',{exact:true}).click();
    const response=await loaded;
    assert.equal(response.status(),200,await response.text());
    await page.getByRole('combobox',{name:/^Sales rep/}).selectOption((await specialist()).memberId);
    await page.getByLabel('Time zone',{exact:true}).fill(west);
    await page.getByLabel('Away through').fill(day);
    await page.getByRole('button',{name:'Save routing'}).click();
    await page.getByText(/^Routing saved for /).waitFor();
  }finally{await browser.close();}
  const {awayThrough,label,...legacy}=await specialist();
  assert.ok(label);
  assert.equal(awayThrough,day);
  await post(routing,{...legacy,awayThrough:'2025-02-30'},400);
  await post(routing,legacy);
  assert.equal((await specialist()).awayThrough,day,'Older settings clients preserve an existing absence.');
  assert.equal((await submitInquiry('rep-away')).assignee_id,general);
  await configure({timeZone:east});
  assert.equal((await submitInquiry('rep-returned')).assignee_id,rep);
  await configure({awayThrough:null,timeZone:'UTC'});
  assert.equal((await specialist()).awayThrough,null);

  // Seed meetings around the current instant. Public booking creation only allows future slots.
  async function booking(scope,host,startOffset,endOffset){
    const id=crypto.randomUUID();
    const now=Date.now();
    await sql.begin(async tx=>{
      await tx`INSERT INTO portable_team_bookings(workspace_id,id,page_id,title,email,start_at,end_at) VALUES
        (${scope},${id},gen_random_uuid(),'Routing rehearsal','guest@example.test',${now+startOffset},${now+endOffset})`;
      await tx`INSERT INTO portable_team_booking_hosts(workspace_id,booking_id,user_id) VALUES (${scope},${id},${host})`;
    });
    return id;
  }
  const hour=3600000;
  const {owned:outside}=await (await request('/api/workspaces',{headers:other})).json();
  assert.ok(outside&&outside!==workspace);
  await booking(outside,rep,-hour,hour);
  await booking(workspace,rep,-2*hour,-hour);
  await booking(workspace,rep,hour,2*hour);
  assert.equal((await submitInquiry('other-or-inactive-meetings')).assignee_id,rep);
  const active=await booking(workspace,rep,-hour,hour);
  assert.equal((await submitInquiry('specialist-in-meeting')).assignee_id,general);
  const generalBooking=await booking(workspace,general,-hour,hour);
  // Returning visitors can supply a territory without changing their existing contact.
  for(const tag of ['both-in-meetings','updated-territory']){
    const contact={name:'Existing routing contact',email:tag+'@example.test'};
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspace},gen_random_uuid(),1,${sql.json(contact)},now(),now())`;
  }
  const held=await submitInquiry('both-in-meetings');
  assert.equal(held.assignee_id,null);
  const updated=await submitInquiry('updated-territory');
  assert.equal(updated.assignee_id,null);
  await sql`UPDATE contacts SET data=data||'{"country":"France"}'::jsonb WHERE workspace_id=${workspace}
    AND data->>'email'='updated-territory@example.test'`;
  async function preview(id){
    const res=await request(leads+'?view=routing-preview&id='+id,{headers});
    assert.equal(res.status,200,await res.clone().text());
    return res.json();
  }
  assert.deepEqual(await preview(held.id),{next:null,counts:{meeting:2}});
  assert.deepEqual(await preview(updated.id),{next:null,counts:{territory:1,meeting:1}});
  // The visitor submitted Canada, while the existing CRM contact has a different country.
  const [former]=await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    VALUES (${workspace},gen_random_uuid(),1,'{"name":"Former customer","email":"archived-territory@example.test","country":"France"}',now(),now()) RETURNING id`;
  const archived=await submitInquiry('archived-territory');
  assert.equal(archived.assignee_id,null);
  await post('/api/recycle-bin',{action:'archive',kind:'contacts',id:former.id,expectedRevision:1,requestId:crypto.randomUUID()});
  assert.deepEqual(await preview(archived.id),{next:null,counts:{meeting:2}});
  await configure({awayThrough:'2099-12-31'});
  assert.deepEqual(await preview(held.id),{next:null,counts:{away:1,meeting:1}});
  await configure({awayThrough:null});
  const retry=(id=held.id)=>post(leads,{action:'route',id,expectedRevision:1});
  assert.equal((await retry()).routing,'unavailable');
  const manual=await post(leads,{action:'save',data:{name:'Manually assigned during a team meeting'},assigneeId:rep},201);
  assert.equal((await (await request(leads+'?id='+manual.id,{headers})).json()).assigneeId,rep);
  await post('/api/workspaces?team=booking&workspaceId='+workspace,{action:'cancel',id:active});
  await post('/api/workspaces?team=booking&workspaceId='+workspace,{action:'cancel',id:generalBooking});
  assert.equal((await retry()).routing,'assigned');
  assert.equal((await (await request(leads+'?id='+held.id,{headers})).json()).assigneeId,rep);
  assert.equal((await retry(archived.id)).routing,'assigned');
  assert.equal((await (await request(leads+'?id='+archived.id,{headers})).json()).assigneeId,rep,'The original inquiry supplies the territory after archival.');
  assert.equal((await retry(updated.id)).routing,'assigned');
  assert.equal((await (await request(leads+'?id='+updated.id,{headers})).json()).assigneeId,general);
}
