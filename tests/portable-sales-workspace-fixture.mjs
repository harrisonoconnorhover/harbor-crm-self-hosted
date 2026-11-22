import assert from 'node:assert/strict';
import {verifyForecast} from './portable-forecast-fixture.mjs';
import {verifyLeadDealHandoff} from './portable-lead-deal-handoff-fixture.mjs';

// The third allowlisted fixture account owns this workspace, so other navigation fixtures
// can use owner@example.test's workspace without changing its roles or records.
export async function verifySalesWorkspace({request,origin,other,sql,signIn}){
  const owner=await signIn('invitee@example.test');
  const logged=await sql`SELECT id,email FROM login_identities WHERE email IN ('other@example.test','invitee@example.test')`;
  const rep=logged.find(user=>user.email==='other@example.test').id;
  const ownerId=logged.find(user=>user.email==='invitee@example.test').id;
  async function write(path,body,auth=owner){
    const res=await request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(res.ok,await res.clone().text());
    return res.json();
  }
  await write('/api/crm',{action:'save',kind:'contacts',data:{name:'Sales workspace rehearsal'}});
  const sharing=await write('/api/workspaces',{action:'grant',email:'other@example.test'});
  async function changeGrant(change){
    const latest=await (await request('/api/workspaces',{headers:owner})).json();
    const id=latest.viewers.find(row=>row.email==='other@example.test').id;
    return write('/api/workspaces',{...change,id});
  }
  const editors=await changeGrant({action:'role',role:'editor'});
  const zone='Pacific/Kiritimati';
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const task=(name,fields,assigneeId)=>write('/api/crm',{action:'save',kind:'tasks',data:{name,...fields},assigneeId});
  for(let i=0;i<7;i++)await task('Rep callback '+i,{priority:'High',taskType:'Call',dueDate:day},rep);
  const old=await task('Overdue email',{taskType:'Email',dueDate:'2000-01-01'},rep);
  await task('Already finished',{status:'Completed',taskType:'Email',dueDate:day},rep);
  await task('Unassigned task',{dueDate:day},null);
  await task('Private owner follow-up',{dueDate:day},ownerId);
  const lead=await write('/api/leads',{action:'save',data:{name:'Assigned rehearsal lead'},assigneeId:rep});
  const inquiries=[];
  for(let i=1;i<=6;i++){
    const name='Waiting inquiry '+i;
    const {id}=await write('/api/leads',{action:'save',data:{name},assigneeId:null});
    inquiries.push({name,id});
  }
  // Force creation order to differ from UUID order and put a tie across a page boundary.
  const byAge=[inquiries[0],...inquiries.slice(1).sort((a,b)=>b.id.localeCompare(a.id))];
  for(const [index,item] of byAge.entries()){
    const tick=index===2?1:index;
    await sql`UPDATE portable_leads SET created_at=TIMESTAMPTZ '2020-01-01 10:00:00 UTC' + ${tick}::int * interval '1 microsecond'
      WHERE workspace_id=${sharing.owned} AND id=${item.id}`;
  }
  [byAge[1],byAge[2]]=[byAge[2],byAge[1]];
  const queuePath='/api/leads?owner=needs-routing&limit=1';
  async function queuePage(after){
    const response=await request(queuePath+(after?'&after='+encodeURIComponent(after):''),{headers:owner});
    assert.equal(response.status,200);
    return response.json();
  }
  const first=await queuePage();
  assert.deepEqual(first.records.map(row=>row.id),[byAge[0].id]);
  const bookmark='/?'+new URLSearchParams({kind:'leads',owner:'needs-routing',after:first.next,workspaceId:sharing.owned});
  const signInRequired=await request(bookmark);
  assert.equal(signInRequired.status,307);
  assert.equal(new URL(signInRequired.headers.get('location'),origin).searchParams.get('return_to'),bookmark);
  let cursor=first.next;
  for(const item of byAge.slice(1)){
    assert.ok(cursor);
    const next=await queuePage(cursor);
    assert.deepEqual(next.records.map(row=>row.id),[item.id]);
    cursor=next.next;
  }
  assert.equal(cursor,null);
  const originalOrder=inquiries.map(row=>row.id).sort();
  const legacy=await queuePage(originalOrder[0]);
  assert.equal(legacy.next,originalOrder[1]);
  assert.equal(legacy.records[0].id,originalOrder[1]);
  const invalid=await request('/api/leads?owner=mine&after='+encodeURIComponent(first.next),{headers:owner});
  assert.equal(invalid.status,400);
  await write('/api/leads',{action:'save',data:{name:'Closed inquiry',leadStage:'Disqualified'},assigneeId:null});
  const url=origin+'/?'+new URLSearchParams({view:'sales-workspace',workspaceId:sharing.owned,taskZone:zone});
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  try{
    const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,timezoneId:zone});
    const [name,value]=other.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(url);
    const counts=page.locator('.sales-summary-counts');
    const metric=async(label,n)=>assert.equal(await counts.getByRole('link',{name:label+' '+n,exact:true}).count(),1,label);
    await metric('Open tasks',8);await metric('Due today',7);await metric('Overdue',1);await metric('Emails',1);
    await metric('Calls',7);await metric('High priority',7);
    assert.equal(await page.getByRole('region',{name:'My open tasks'}).locator('li').count(),5);
    const waiting=page.getByRole('region',{name:'Needs routing'});
    assert.deepEqual(await waiting.locator('li a').allTextContents(),byAge.slice(0,5).map(row=>row.name));
    for(const kind of ['tasks','leads']){
      const visible=await page.locator('.sales-summary-lists li a[href*="kind='+kind+'"]').evaluateAll(links=>
        links.map(link=>new URL(link.href).searchParams.get('record')));
      const receipts=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${sharing.owned}
        AND actor_id=${rep} AND kind=${kind} AND action='list'`;
      assert.deepEqual(receipts.map(row=>row.record_ids),[visible]);
    }
    await waiting.getByRole('link',{name:'View all leads needing routing'}).click();
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),sharing.owned);
    assert.equal(await page.getByRole('form',{name:'Lead filters'}).locator('select[name="owner"]').inputValue(),'needs-routing');
    assert.deepEqual(await page.getByRole('link',{name:/Waiting inquiry/}).allTextContents(),byAge.map(row=>row.name));
    assert.equal(await page.getByRole('columnheader',{name:'Created (UTC)'}).count(),1);
    assert.equal(await page.getByRole('link',{name:'Closed inquiry'}).count(),0);
    const leadFilters=page.getByRole('form',{name:'Lead filters'});
    await leadFilters.getByRole('searchbox',{name:'Search leads'}).fill('Waiting inquiry 1');
    await leadFilters.getByRole('button',{name:'Apply'}).click();
    await page.getByRole('button',{name:'Route this lead',exact:true}).click();
    await page.getByText('0 assigned. 1 still waiting for an available rep.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Waiting inquiry 1',exact:true}).click();
    const preview=page.getByRole('region',{name:'Routing preview'});
    await preview.getByRole('button',{name:'Preview routing'}).click();
    await preview.getByText('No reps are configured for lead routing.').waitFor();
    const route=page.getByRole('button',{name:'Route unassigned lead'});
    await route.click();
    await page.getByText('No rep is available for this lead.',{exact:true}).waitFor();
    const pool=await (await request('/api/leads?view=routing',{headers:owner})).json();
    const {label,...rule}=pool.members.find(member=>member.memberId===editors.viewers.find(person=>person.email==='other@example.test').id);
    assert.ok(label);
    await write('/api/leads?view=routing',{...rule,available:true});
    await preview.getByRole('button',{name:'Refresh routing preview'}).click();
    await preview.getByText('Next in line: '+label,{exact:true}).waitFor();
    await route.click();
    await page.getByText('Lead assigned.',{exact:true}).waitFor();
    assert.equal((await queuePage(first.next)).records[0].id,byAge[1].id);
    await page.goto(url);
    assert.equal(await waiting.locator('li').count(),5);
    assert.equal(await waiting.getByRole('link',{name:'Waiting inquiry 1'}).count(),0);
    assert.equal(await page.getByRole('region',{name:'My leads'}).getByRole('link',{name:'Waiting inquiry 1'}).count(),1);
    await page.getByRole('link',{name:'Assigned rehearsal lead'}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),lead.id);
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),sharing.owned);
    await page.goBack();
    await counts.getByRole('link',{name:'Overdue 1',exact:true}).click();
    await page.getByRole('link',{name:'Overdue email',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),old.record.id);
    await page.getByRole('button',{name:'Mark complete'}).click();
    await page.getByRole('button',{name:'Reopen task'}).waitFor();
    await page.goto(url);
    await metric('Open tasks',7);await metric('Overdue',0);
    // Late on the previous UTC date is today in the salesperson's +14 zone.
    const previousDate=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    await task('Follow-up across midnight',{taskType:'Email',dueDate:previousDate,dueTime:'23:00',dueTimeZone:'UTC'},rep);
    await page.reload();
    await metric('Due today',8);
    await counts.getByRole('link',{name:'Due today 8',exact:true}).click();
    await page.getByRole('link',{name:'Follow-up across midnight',exact:true}).waitFor();
    await page.goto(url);
    const savedPool=await (await request('/api/leads?view=routing',{headers:owner})).json();
    const {label:repLabel,...limited}=savedPool.members.find(member=>member.memberId===rule.memberId);
    assert.ok(repLabel);
    await write('/api/leads?view=routing',{...limited,capacity:3});
    await waiting.getByRole('button',{name:'Route these 5 leads'}).click();
    await waiting.getByText('1 assigned. 4 still waiting for an available rep.',{exact:true}).waitFor();
    await waiting.getByRole('button',{name:'Route these 4 leads'}).waitFor();
    assert.deepEqual(await waiting.locator('li a').allTextContents(),byAge.slice(2).map(row=>row.name));
    await page.getByRole('region',{name:'My leads'}).getByRole('link',{name:byAge[1].name,exact:true}).waitFor();
    await changeGrant({action:'record_scope',viewScope:'owned',editScope:'owned'});
    await page.reload();
    await metric('Open tasks',8);
    assert.equal(await waiting.count(),0);
    await page.getByRole('link',{name:'Assigned rehearsal lead'}).waitFor();
    await counts.getByRole('link',{name:'Calls 7',exact:true}).click();
    assert.equal(await page.getByRole('link',{name:/Rep callback/}).count(),7);
    assert.equal(await page.getByRole('link',{name:'Private owner follow-up'}).count(),0);
    await page.getByRole('link',{name:'Rep callback 0',exact:true}).click();
    await page.getByRole('button',{name:'Mark complete'}).click();
    await page.getByRole('button',{name:'Reopen task'}).waitFor();
    await page.goto(url);
    await metric('Open tasks',7);await metric('Calls',6);
    await changeGrant({action:'record_scope',viewScope:'all',editScope:'all'});
    await changeGrant({action:'role',role:'viewer'});
    await page.reload();
    await metric('Open tasks',7);
    assert.equal(await waiting.count(),0);
    await page.getByRole('region',{name:'My open tasks'}).locator('li a').first().click();
    await page.getByRole('region',{name:'Task details'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Mark complete'}).count(),0);
    const privateHtml=await (await request('/?view=sales-workspace&taskZone=UTC',{headers:owner})).text();
    assert.match(privateHtml,/Private owner follow-up/);
    assert.doesNotMatch(privateHtml,/Rep callback/);
    const savedTaskUrl=page.url();
    await verifyLeadDealHandoff({browser,page,origin,owner,rep,ownerId,workspaceId:sharing.owned,changeGrant,sql,write});
    // The independent forecast trial begins with a fresh minute of fictional API traffic.
    await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
    await verifyForecast({browser,page,origin,owner,other,rep,ownerId,workspaceId:sharing.owned,changeGrant,write,request,sql});
    await changeGrant({action:'revoke'});
    assert.equal((await request('/?view=forecast&workspaceId='+sharing.owned,{headers:other})).status,404);
    await page.goto(savedTaskUrl);
    assert.equal(await page.getByRole('region',{name:'Task details'}).count(),0);
    assert.equal((await request('/api/crm?kind=tasks&id='+old.record.id+'&workspaceId='+sharing.owned,{headers:other})).status,404);
    assert.equal((await request(new URL(url).pathname+new URL(url).search,{headers:other})).status,404);
    assert.equal((await request('/?view=sales-workspace&taskZone=invalid-invalid',{headers:owner})).status,404);
  }finally{await browser.close();}
}
