import assert from 'node:assert/strict';
import {verifyRoutingAvailability} from './portable-routing-availability-fixture.mjs';

export async function verifyInboundSalesRouting({request,origin,headers,other,sql,workspace,rep,general,coverAllCanada,disable,processWaiting}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function post(url,body,identity){
    const response=await request(url,{method:'POST',headers:{...identity,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }
  const title='Fictional demo requests';
  let formId,first;
  try{
    const context=await browser.newContext(),page=await context.newPage();
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=forms');
    const route=page.getByLabel('Route captured contacts to sales');
    assert.ok(await route.isDisabled());
    await page.getByLabel('Title',{exact:true}).fill(title);
    await page.getByLabel('Automatically create or link contacts').check();
    await route.check();
    await page.getByLabel('Location fields').selectOption('region');
    await page.getByRole('button',{name:'Save form',exact:true}).click();
    await page.getByRole('button',{name:'Enable public form'}).click();
    const link=page.getByRole('link',{name:'Open public form'});
    await link.waitFor();
    formId=(await link.getAttribute('href')).split('/').pop();
    const guest=await browser.newPage();
    await guest.goto(origin+'/forms/'+formId);
    await guest.locator('input[name="name"]').fill('Fictional inbound visitor');
    await guest.getByLabel('Email address').fill('fictional-inbound@example.test');
    await guest.getByLabel('Country or region').fill(' Canada ');
    await guest.getByLabel('State or province').fill('Ontario');
    const submission=guest.waitForRequest(req=>new URL(req.url()).pathname==='/api/public/forms/'+formId&&req.method()==='POST');
    await guest.getByRole('button',{name:'Send inquiry'}).click();
    await guest.getByText('Thank you. Your inquiry has been received.').waitFor();
    first=(await submission).postDataJSON();
  }finally{await browser.close();}
  const endpoint='/api/public/forms/'+formId;
  const inquiry=(name,email)=>({id:crypto.randomUUID(),revision:2,payload:{name,email}});
  const list=async email=>sql`SELECT l.id,l.assignee_id,e.intake_form_id,e.actor_id FROM portable_leads l JOIN contacts c
    ON (l.workspace_id,l.contact_id)=(c.workspace_id,c.id) JOIN portable_lead_events e
    ON (l.workspace_id,l.id)=(e.workspace_id,e.lead_id) AND e.revision=1
    WHERE l.workspace_id=${workspace} AND c.data->>'email'=${email}`;
  await Promise.all([first,first,{...first,id:crypto.randomUUID()}].map(body=>post(endpoint,body)));
  const routed=await list(first.payload.email);
  assert.equal(routed.length,1);
  assert.equal(routed[0].assignee_id,rep);
  assert.equal(routed[0].intake_form_id,formId);
  assert.equal(routed[0].actor_id,null);
  const myLead=await request('/api/leads?id='+routed[0].id+'&workspaceId='+workspace,{headers:other});
  const lead=await myLead.json();
  assert.equal(lead.data.name,first.payload.name);
  assert.ok(lead.contactId);
  const contact=await request('/api/crm?kind=contacts&id='+lead.contactId+'&workspaceId='+workspace,{headers:other});
  const captured=(await contact.json()).data;
  assert.equal(captured.recordOwner.userId,rep);
  assert.equal(captured.country,'Canada');
  assert.equal(captured.state,'Ontario');
  const [intake]=await sql`SELECT intake_region FROM portable_leads WHERE workspace_id=${workspace} AND id=${lead.id}`;
  assert.equal(intake.intake_region,'Ontario');
  const elsewhere=inquiry('Outside the province','fictional-quebec@example.test');
  await post(endpoint,{...elsewhere,payload:{...elsewhere.payload,country:'Canada',region:'Quebec'}});
  assert.equal((await list(elsewhere.payload.email))[0].assignee_id,general);
  await coverAllCanada();
  const changedLocation=await request(endpoint,{method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({...first,payload:{...first.payload,region:'Quebec'}})});
  assert.equal(changedLocation.status,409);
  const latest=await request('/api/lead-forms?formId='+formId,{headers});
  assert.equal((await latest.json()).results.find(row=>row.id===first.id).payload.country,'Canada');
  const [created]=await sql`SELECT data FROM contact_events WHERE workspace_id=${workspace} AND contact_id=${lead.contactId} AND revision=1`;
  assert.equal(created.data.recordOwner.userId,rep);
  const history=await request('/api/leads?view=history&id='+routed[0].id,{headers});
  assert.equal((await history.json()).entries[0].actorName,'Website form');
  const repBrowser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await repBrowser.newContext({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=sales-workspace&workspaceId='+workspace);
    await page.getByRole('link',{name:'My leads',exact:true}).click();
    await page.getByRole('form',{name:'Lead filters'}).locator('input[name="search"]').fill(first.payload.name);
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('link',{name:first.payload.name,exact:true}).click();
    await page.getByRole('form',{name:'Edit lead'}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('record'),routed[0].id);
  }finally{await repBrowser.close();}
  const ended=await request('/api/leads',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',id:routed[0].id,expectedRevision:1,data:{name:first.payload.name,leadStage:'Qualified'}})});
  assert.ok(ended.ok,await ended.text());
  await post(endpoint,first);
  assert.equal((await list(first.payload.email)).length,1,'A replay after qualification cannot reopen the lead.');
  await post(endpoint,{...first,id:crypto.randomUUID()});
  assert.equal((await list(first.payload.email)).length,2,'A new inquiry after qualification starts a new lead.');
  const [existing]=await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    VALUES(${workspace},gen_random_uuid(),1,'{"name":"Existing private contact","email":"fictional-existing@example.test"}',now(),now()) RETURNING id`;
  const existingMatch=inquiry('Demo inquiry','fictional-existing@example.test');
  await post(endpoint,{...existingMatch,payload:{...existingMatch.payload,country:'Canada'}});
  assert.equal((await list('fictional-existing@example.test'))[0].assignee_id,rep);
  const [preserved]=await sql`SELECT data,revision FROM contacts WHERE workspace_id=${workspace} AND id=${existing.id}`;
  assert.equal(preserved.data.recordOwner,undefined);
  assert.equal(preserved.data.country,undefined);
  assert.equal(preserved.revision,1);
  const known=inquiry('Known territory','fictional-known@example.test');
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at) VALUES
    (${workspace},gen_random_uuid(),1,${sql.json({name:'Known contact',email:known.payload.email,country:'France'})},now(),now())`;
  await post(endpoint,{...known,payload:{...known.payload,country:'Canada'}});
  assert.equal((await list(known.payload.email))[0].assignee_id,general,'Saved territory takes precedence over the inquiry.');
  const blank=inquiry('Country omitted','fictional-no-country@example.test');
  await post(endpoint,blank);
  assert.equal((await list(blank.payload.email))[0].assignee_id,general);
  await verifyRoutingAvailability({request,origin,headers,other,workspace,rep,general,sql,submitInquiry:async tag=>{
    const body=inquiry('Routing availability',tag+'@example.test');
    body.payload.country='Canada';
    await post(endpoint,body);
    const matches=await list(body.payload.email);
    assert.equal(matches.length,1);
    return matches[0];
  }});
  await disable();
  const next=inquiry('長'.repeat(300),'fictional-waiting@example.test');
  await Promise.all([next,{...next,id:crypto.randomUUID()}].map(body=>post(endpoint,body)));
  const waiting=await list(next.payload.email);
  assert.deepEqual(waiting.map(row=>row.assignee_id),[null]);
  const detail=await request('/api/leads?id='+waiting[0].id,{headers});
  const pending=await detail.json();
  assert.equal(pending.data.name,title);assert.equal(pending.routingPending,true);
  const scopedContact=id=>request('/api/crm?kind=contacts&id='+id+'&workspaceId='+workspace,{headers:other});
  assert.equal((await scopedContact(pending.contactId)).status,404);
  const priorInquiry=inquiry('Returning customer','prior-while-closed@example.test');
  const [priorContact]=await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    VALUES(${workspace},gen_random_uuid(),1,${sql.json({name:'Existing private contact',email:priorInquiry.payload.email})},now(),now()) RETURNING id`;
  await post(endpoint,{...priorInquiry,payload:{...priorInquiry.payload,country:'Canada',region:'Ontario'}});
  const editedInquiry=inquiry('Owner reviewed before routing','edited-while-closed@example.test');
  await post(endpoint,editedInquiry);
  const [editedContact]=await sql`SELECT id,data FROM contacts WHERE workspace_id=${workspace} AND data->>'email'=${editedInquiry.payload.email}`;
  await post('/api/crm',{action:'save',kind:'contacts',id:editedContact.id,expectedRevision:1,assigneeId:general,data:editedContact.data},headers);
  const manualInquiry=inquiry('Owner retries form routing','manual-form-routing@example.test');
  await post(endpoint,manualInquiry);
  const [manual]=await list(manualInquiry.payload.email);
  const [returning]=await list(priorInquiry.payload.email);
  await processWaiting(2,manual.id,returning.id);
  const manualLead=await request('/api/leads?id='+manual.id+'&workspaceId='+workspace,{headers:other});
  const manualContact=(await manualLead.json()).contactId;
  assert.ok(manualContact);
  assert.equal((await scopedContact(manualContact)).status,200);
  const [manualEvent]=await sql`SELECT e.actor_id,w.owner_id FROM contact_events e JOIN private_workspaces w ON w.id=e.workspace_id
    WHERE e.workspace_id=${workspace} AND e.contact_id=${manualContact} AND e.revision=2`;
  assert.equal(manualEvent.actor_id,manualEvent.owner_id);
  const assignedFromForm=await list(next.payload.email);
  assert.deepEqual(assignedFromForm.map(row=>[row.assignee_id,row.intake_form_id]),[[rep,formId]]);
  const won=await scopedContact(pending.contactId);
  assert.equal(won.status,200);
  assert.equal((await won.json()).data.recordOwner.userId,rep);
  const sharedLead=await request('/api/leads?id='+pending.id+'&workspaceId='+workspace,{headers:other});
  assert.equal((await sharedLead.json()).contactId,pending.contactId);
  for(const [inquiry,contactId] of [[priorInquiry,priorContact.id],[editedInquiry,editedContact.id]]){
    assert.equal((await list(inquiry.payload.email))[0].assignee_id,rep);
    assert.equal((await scopedContact(contactId)).status,404);
  }
  const events=await sql`SELECT revision,intake_form_id,data->'recordOwner'->>'userId' AS owner FROM contact_events
    WHERE workspace_id=${workspace} AND contact_id=${pending.contactId} ORDER BY revision`;
  assert.deepEqual(events.map(e=>[e.revision,e.intake_form_id,e.owner]),[[1,formId,null],[2,formId,rep]]);
  const historyPath='/api/crm?kind=contacts&history='+pending.contactId+'&workspaceId='+workspace;
  const ownerHistory=await request(historyPath+'&field=owner',{headers:other});
  assert.equal(ownerHistory.status,200);
  assert.deepEqual((await ownerHistory.json()).items.map(change=>change.actorName),['Website form routing']);
  const automated=await request('/api/leads?view=history&id='+pending.id,{headers});
  assert.deepEqual((await automated.json()).entries.map(e=>e.actorName),['Automatic lead routing','Website form']);

  // Manual review only routes when the originally approved form revision still applies.
  for(const current of [true,false]){
    const email='fictional-duplicate-'+current+'@example.test';
    const contacts=await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspace},gen_random_uuid(),1,jsonb_build_object('name','Duplicate','email',${email}::text),now(),now()
      FROM generate_series(1,2) RETURNING id`;
    const submission=inquiry('Needs matching',email);
    await post(endpoint,submission);
    assert.equal((await list(email)).length,0);
    await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspace} AND id=${contacts[0].id}`;
    if(!current)await post('/api/lead-forms',{action:'save',id:formId,revision:2,definition:{title,captureContacts:true,routeSalesLead:false,collectCountry:false}},headers);
    const retry={action:'retry',formId,submissionId:submission.id};
    await post('/api/lead-forms',retry,headers);
    await post('/api/lead-forms',retry,headers);
    assert.equal((await list(email)).length,current?1:0);
  }
  const off=inquiry('Fictional capture only','fictional-capture-only@example.test');
  const disabledCountry=await request(endpoint,{method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({...off,revision:3,payload:{...off.payload,country:'Canada'}})});
  assert.equal(disabledCountry.status,400);
  assert.ok(!(await (await request('/forms/'+formId)).text()).includes('name="country"'));
  await post(endpoint,first);
  await post(endpoint,{...off,revision:3,payload:{...off.payload,country:'  '}});
  assert.equal((await list(off.payload.email)).length,0);
  const settings=(revision,collectCountry)=>post('/api/lead-forms',{action:'save',id:formId,revision,
    definition:{title,captureContacts:false,routeSalesLead:false,collectCountry,collectRegion:collectCountry}},headers);
  await settings(3,true);
  const retryBrowser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await retryBrowser.newPage();
    page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin+'/forms/'+formId);
    const email='fictional-country-retry@example.test';
    async function fill(){
      await page.getByLabel('Name',{exact:true}).fill('Country retry');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Country or region').fill('Canada');
      await page.getByLabel('State or province').fill('Ontario');
    }
    await fill();
    await page.route('**'+endpoint,async route=>{
      const accepted=await route.fetch();
      assert.equal(accepted.status(),200);
      await route.abort();
    },{times:1});
    await page.getByRole('button',{name:'Send inquiry'}).click();
    await page.getByRole('button',{name:'Retry same inquiry'}).waitFor();
    const saved=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),'harbor:lead-inquiry:'+formId);
    assert.deepEqual(Object.keys(saved).sort(),['collectCountry','collectRegion','id','revision']);
    await settings(4,false);
    await page.reload();
    await fill();
    await page.getByRole('button',{name:'Retry same inquiry'}).click();
    await page.getByText('Thank you. Your inquiry has been received.').waitFor();
    const rows=await sql`SELECT id FROM portable_lead_inquiries WHERE form_id=${formId} AND payload->>'email'=${email}`;
    assert.deepEqual(rows.map(row=>row.id),[saved.id]);
  }finally{await retryBrowser.close();}
}
