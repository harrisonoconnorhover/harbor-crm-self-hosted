import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {tsImport} from 'tsx/esm/api';
import {verifyPortableDataQuality} from './portable-data-quality-fixture.mjs';
import {verifySharedServiceToolPermissions} from './portable-service-tool-permissions-fixture.mjs';
import {verifySharedToolGates} from './portable-shared-tool-gates-fixture.mjs';
import {verifyAccountDefaults} from './portable-account-defaults-fixture.mjs';

export async function verifySettingsDestinations(context){
  const {request,origin,headers,other,signIn,sql}=context;
  const users='/?view=settings&section=users-teams';
  const teams=users+'&tab=teams';
  const quality='/?view=settings&section=data-quality';
  const defaults='/?view=settings&section=account-defaults';
  const change=async(path,body,auth=headers)=>{
    const response=await request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  };
  await change('/api/crm',{action:'save',kind:'contacts',data:{name:'Settings rehearsal contact'}});
  await signIn('invitee@example.test');
  let sharing;
  for(const email of ['other@example.test','invitee@example.test']){
    sharing=await change('/api/workspaces',{action:'grant',email});
    const grant=sharing.viewers.find(m=>m.email===email);
    sharing=await change('/api/workspaces',{action:'role',id:grant.id,role:'editor'});
  }
  const workspace=sharing.owned;
  for(const path of [users,teams,quality,defaults]){
    const login=await request(path);
    assert.equal(login.status,307);
    assert.equal(new URL(login.headers.get('location'),origin).searchParams.get('return_to'),path);
    assert.equal((await request(path+'&workspaceId='+workspace,{headers:other})).status,404,path);
  }
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=settings');
    const navigation=page.getByRole('navigation',{name:'Settings navigation'});
    for(const [label,path] of [['Users & Teams',users],['Account defaults',defaults],['Data quality',quality]]){
      assert.equal(await navigation.getByRole('link',{name:label,exact:true}).getAttribute('href'),path);
      await page.getByText('Find in Harbor',{exact:true}).click();
      const find=page.getByRole('searchbox',{name:'Search CRM records'});
      await find.fill(label);
      assert.equal(await page.getByRole('region',{name:'Matching tools'}).getByRole('link',{name:label,exact:true}).getAttribute('href'),path);
      await find.press('Escape');
    }
    await navigation.getByRole('link',{name:'Users & Teams'}).click();
    await page.getByRole('navigation',{name:'Users and teams'}).getByRole('link',{name:'Teams',exact:true}).click();
    await page.getByLabel('Team name',{exact:true}).fill('Sales');
    await page.getByRole('button',{name:'Create team'}).click();
    await page.getByRole('button',{name:'Save team'}).waitFor();
    await page.getByLabel('Manage team').selectOption('');
    await page.getByLabel('Team name',{exact:true}).fill('Inbound');
    await page.getByLabel('Parent team').selectOption({label:'Sales'});
    await page.getByRole('button',{name:'Create team'}).click();
    await page.getByRole('button',{name:'Save team'}).waitFor();
    const person=page.locator('.portable-access-member').filter({hasText:'other@example.test'});
    await person.locator('summary').first().click();
    await person.getByLabel('Primary team for other@example.test').selectOption({label:'Sales / Inbound'});
    await page.getByText('Primary team updated.',{exact:true}).waitFor();
    const usersTab=page.getByRole('navigation',{name:'Users and teams'}).getByRole('link',{name:'Users',exact:true});
    await usersTab.click();
    await usersTab.and(page.locator('[aria-current="page"]')).waitFor();
    if(!await person.evaluate(row=>row.open))await person.locator('summary').first().click();
    const preview=person.getByRole('link',{name:'Preview record and field access'});
    const memberHistory=await person.getByRole('link',{name:'View access history'}).getAttribute('href');
    const member=sharing.viewers.find(row=>row.email==='other@example.test');
    assert.ok(member.actorId);
    assert.equal(memberHistory,'/?view=record-access&actor='+encodeURIComponent(member.actorId));
    const another=sharing.viewers.find(row=>row.email==='invitee@example.test');
    const historical=await sql`INSERT INTO portable_record_access_events(workspace_id,actor_id,actor_email,kind,action,record_ids)
      VALUES (${workspace},${member.actorId},'former@example.test','contacts','detail',ARRAY[gen_random_uuid()]),
             (${workspace},${another.actorId},'other@example.test','contacts','detail',ARRAY[gen_random_uuid()])
      RETURNING id,actor_id`;
    const original=historical.find(row=>row.actor_id===member.actorId).id;
    const namesake=historical.find(row=>row.actor_id===another.actorId).id;
    await person.getByRole('link',{name:'View access history'}).click();
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.getByRole('cell',{name:'former@example.test',exact:true}).waitFor();
    const download=await page.getByRole('link',{name:/Export matching events/}).getAttribute('href');
    const csv=await (await request(download,{headers})).text();
    assert.ok(csv.includes(original)&&!csv.includes(namesake));
    const separateWorkspace=await request(download,{headers:other});
    assert.equal(separateWorkspace.status,200);
    assert.ok(!(await separateWorkspace.text()).includes(original));
    const legacy=await request('/api/workspaces?view=record-access&export=csv&email=other%40example.test',{headers});
    assert.equal(legacy.status,200);
    const byEmail=await legacy.text();
    assert.ok(byEmail.includes(namesake)&&!byEmail.includes(original));
    await page.getByRole('link',{name:'Back to Users & Teams'}).click();
    await person.locator('summary').first().click();
    await preview.click();
    await page.getByRole('heading',{name:'Record and field access for other@example.test'}).waitFor();
    await verifyMemberRecordChecks({page,origin,workspace,request,headers,other,change});
    await page.getByRole('link',{name:'Back to Users'}).click();
    for(const address of ['other@example.test','invitee@example.test']){
      await page.getByRole('checkbox',{name:'Select '+address,exact:true}).check();
    }
    await page.getByRole('button',{name:'Edit selected users’ permissions'}).click();
    const bulk=page.locator('.portable-bulk-tool-access');
    await bulk.getByLabel('Tool',{exact:true}).selectOption('contacts');
    await bulk.getByLabel('View',{exact:true}).selectOption('none');
    await bulk.getByRole('button',{name:'Apply to 2 users'}).click();
    await page.getByText('Workspace permissions updated.',{exact:true}).waitFor();
    const roster=await (await request('/api/workspaces',{headers})).json();
    for(const person of roster.viewers)assert.deepEqual(person.toolPolicies.contacts,{view:'none',edit:'none',delete:false,create:false});
    const list=await request('/api/crm?kind=contacts&workspaceId='+workspace,{headers:other});
    if(list.ok)assert.equal((await list.json()).records.length,0);
    else assert.ok([403,404].includes(list.status));
    const exportAccess=page.getByRole('link',{name:'Export all active teammates’ access (CSV)'});
    const rosterPath=await exportAccess.getAttribute('href');
    assert.equal((await request(rosterPath)).status,401);
    assert.equal((await request(rosterPath,{headers:other})).status,404);
    const response=await request(rosterPath,{headers,method:'HEAD'});
    assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control'),/no-store/);
    await page.getByLabel('Find a teammate').fill('other@example.test');
    const downloading=page.waitForEvent('download');
    await exportAccess.click();
    const file=await downloading;
    assert.ok(file.suggestedFilename().includes(workspace));
    const {parseCSV}=await tsImport('../lib/csv-import.ts',import.meta.url);
    const sheet=parseCSV(await readFile(await file.path(),'utf8'));
    const cell=(row,column)=>row[sheet.headers.indexOf(column)];
    assert.deepEqual(sheet.rows.map(row=>cell(row,'Email')),['invitee@example.test','other@example.test']);
    const rep=sheet.rows[1];
    assert.deepEqual(['Teammate ID','Primary team','Role','Membership source','Contacts override','Deals override'].map(key=>cell(rep,key)),
      [member.actorId,'Sales / Inbound','editor','Harbor','View none / Create No / Edit none / Delete No','Default']);
    await page.reload();
    const invited=page.locator('.portable-access-member').filter({hasText:'invitee@example.test'});
    await invited.locator('summary').first().click();
    const savedHistory=await invited.getByRole('link',{name:'View access history'}).getAttribute('href');
    await invited.getByText('Revoke access…',{exact:true}).click();
    await invited.getByRole('button',{name:'Confirm revocation'}).click();
    await invited.waitFor({state:'detached'});
    assert.deepEqual(parseCSV(await (await request(rosterPath,{headers})).text()).rows.map(row=>cell(row,'Email')),['other@example.test']);
    await page.getByText('Review assignments after access changes',{exact:true}).click();
    const recovery=page.getByRole('navigation',{name:'Review assignments after access changes'});
    assert.equal(await recovery.getByRole('link',{name:'Deals',exact:true}).getAttribute('href'),'/?kind=deals&owner=unavailable');
    await recovery.getByRole('link',{name:'Sales sequences with unavailable assignees'}).click();
    await page.getByText('No enrollments with unavailable assignees on this page.').waitFor();
    await page.getByRole('link',{name:'Clear assignee filter'}).click();
    assert.equal(new URL(page.url()).searchParams.has('assignee'),false);
    await page.goto(origin+savedHistory);
    const revokedExport=await page.getByRole('link',{name:/Export matching events/}).getAttribute('href');
    const afterRevocation=await (await request(revokedExport,{headers})).text();
    assert.ok(afterRevocation.includes(namesake)&&!afterRevocation.includes(original));
    const shared=await request('/?view=settings&workspaceId='+workspace,{headers:other});
    assert.equal(shared.status,200);
    const html=(await shared.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    assert.match(html,/Your workspace access/);
    assert.match(html,/<th scope="row">Contacts<\/th><td>None<\/td><td>No<\/td><td>None<\/td><td>None<\/td>/);
    assert.doesNotMatch(html,/Open shared records/);
    assert.doesNotMatch(html,/section=(users-teams|data-quality|account-defaults)/);
    const sharedPage=await browser.newPage({viewport:{width:390,height:844}});
    const [cookieName,cookieValue]=other.cookie.split('=');
    await sharedPage.context().addCookies([{name:cookieName,value:cookieValue,url:origin}]);
    await sharedPage.goto(origin+'/?view=settings&workspaceId='+workspace);
    const accessTable=sharedPage.getByRole('table',{name:'Record permissions'});
    assert.deepEqual(await accessTable.getByRole('row',{name:/^Contacts /}).getByRole('cell').allTextContents(),['None','No','None','None']);
    assert.ok(await sharedPage.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),
      'The permissions table must fit or scroll within its pane on a phone.');
    const activeMember=roster.viewers.find(row=>row.email==='other@example.test');
    await page.goto(origin+users+'&member='+activeMember.id);
    const ownerTable=page.getByRole('table',{name:'Record permissions'});
    const rowText=table=>table.locator('tbody tr').allTextContents();
    const actual=await rowText(accessTable);
    assert.equal(actual.length,7);
    assert.deepEqual((await rowText(ownerTable)).map(row=>row.replaceAll('Their ','Your ')),actual);
    await sharedPage.close();
    await page.setViewportSize({width:390,height:844});
    for(const [path,title] of [[users,'Users & Teams'],[defaults,'Account defaults'],[quality,'Data quality']]){
      await page.goto(origin+path);
      await page.getByRole('heading',{name:title,exact:true}).first().waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),
        title+' should fit a phone without scrolling the entire page sideways');
    }
    await verifyPortableDataQuality(context,page);
  }finally{await browser.close();}
  const current=await (await request('/api/workspaces',{headers})).json();
  await change('/api/workspaces',{action:'tool_permissions',ids:[current.viewers.find(p=>p.email==='other@example.test').id],
    tool:'contacts',policy:{view:'all',edit:'all',create:true,delete:true}});
  await verifyAccountDefaults(context);
  // Start the independent permission walkthrough with fresh request budgets for its two test users.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await verifySharedToolGates(context);
  await verifySharedServiceToolPermissions(context);
}

async function verifyMemberRecordChecks({page,origin,workspace,request,headers,other,change}){
  const workspaceApi='/api/workspaces';
  const currentMember=async()=>(await (await request(workspaceApi,{headers})).json()).viewers.find(person=>person.email==='other@example.test');
  const member=await currentMember(),section=page.getByRole('region',{name:'Record access',exact:true});
  await section.getByRole('button',{name:'Check a specific record'}).click();
  async function select(kind,id,name){
    await section.getByLabel('Record type').selectOption(kind);
    await section.getByLabel('Find a '+kind.slice(0,-1),{exact:true}).fill(name);
    await section.getByLabel('Record to check').selectOption(id);
  }
  for(const kind of ['leads','tasks','tickets']){
    const name='Preview fixture '+kind;
    const service=kind==='tasks'?'/api/crm':'/api/'+kind;
    const input={action:'save',assigneeId:member.actorId,data:{name},...(kind==='tasks'?{kind}:{})};
    const saved=await change(service,input);
    const id=saved.record?.id??saved.id;
    await select(kind,id,name);
    await section.getByText('Can view and edit',{exact:true}).waitFor();
    const path=service+'?'+new URLSearchParams({id,workspaceId:workspace,...(kind==='tasks'?{kind}:{})});
    const shared=await request(path,{headers:other});
    assert.ok(shared.ok);
    assert.equal((await shared.json()).editable,true,kind);
  }

  // The same record ID is legal under two object definitions. Only one belongs to the rep.
  const id=crypto.randomUUID(),types=[];
  for(const [index,typeName] of ['Pilot assets','Pilot projects'].entries()){
    const objectId=crypto.randomUUID();types.push(objectId);
    await change('/api/custom-objects',{action:'define',id:objectId,revision:0,definition:{name:typeName,fields:[]}});
    await change('/api/custom-objects',{action:'save',id,objectId,revision:0,schemaRevision:1,name:'Preview custom record',
      values:{},assigneeId:index?null:member.actorId});
  }
  const policy={view:'owned',edit:'owned',create:true,delete:true};
  await change(workspaceApi,{action:'tool_permissions',ids:[member.id],tool:'custom-objects',policy});
  await section.getByRole('button',{name:'Check again'}).click();
  await section.getByText('This teammate or record is no longer available.').waitFor();
  const fresh=await currentMember();
  await page.goto(origin+'/?view=settings&section=users-teams&member='+fresh.id);
  await section.getByRole('button',{name:'Check a specific record'}).click();
  await section.getByLabel('Record type').selectOption('custom-objects');
  await section.getByLabel('Find a custom record').fill('Preview custom record');
  await section.getByRole('button',{name:'Search records'}).click();
  for(const [i,typeName] of ['Pilot assets','Pilot projects'].entries()){
    await section.getByRole('button',{name:'Check access Preview custom record · '+typeName}).click();
    await section.getByText(i?'No record access':'Can view and edit',{exact:true}).waitFor();
    const shared=await request('/api/custom-objects?'+new URLSearchParams({objectId:types[i],record:id,workspaceId:workspace}),{headers:other});
    assert.equal(shared.status,i?404:200);
    if(!i)assert.equal((await shared.json()).record.editable,true);
  }
  await section.getByRole('button',{name:'Check access Preview custom record · Pilot assets'}).click();
  await section.getByText('Can view and edit',{exact:true}).waitFor();
  await change('/api/custom-objects',{action:'save',id,objectId:types[0],revision:1,schemaRevision:1,
    name:'Preview custom record',values:{},assigneeId:null});
  await section.getByRole('button',{name:'Check again'}).click();
  await section.getByText('No record access',{exact:true}).waitFor();
  const released=await request('/api/custom-objects?'+new URLSearchParams({objectId:types[0],record:id,workspaceId:workspace}),{headers:other});
  assert.equal(released.status,404);
  await change(workspaceApi,{action:'tool_permissions',ids:[fresh.id],tool:'custom-objects',policy:{...policy,view:'all',edit:'all'}});
}
