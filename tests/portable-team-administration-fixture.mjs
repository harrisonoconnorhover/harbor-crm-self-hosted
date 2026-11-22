import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
import {DomUtils,parseDocument} from 'htmlparser2';

function verifyRoleGuide(html,role){
  const guide=DomUtils.findOne(el=>el.name==='details'&&el.attribs.class==='portable-role-guide',parseDocument(html).children);
  assert.ok(guide,'The workspace and the invitation should both offer the role comparison.');
  const preset=DomUtils.findOne(el=>el.name==='input'&&el.attribs.type==='radio'&&'checked' in el.attribs,guide.children);
  assert.equal(preset.attribs.value,role,'The compact comparison starts at the role under review.');
  const rows=DomUtils.getElementsByTagName('tr',guide.children);
  const permissions=label=>{
    const row=rows.find(row=>DomUtils.getElementsByTagName('th',row.children).some(th=>DomUtils.textContent(th).startsWith(label)));
    assert.ok(row,'Missing capability: '+label);
    return Object.fromEntries(DomUtils.getElementsByTagName('td',row.children).map(td=>[td.attribs['data-column'],DomUtils.textContent(td)]));
  };
  assert.deepEqual(permissions('Appoint or change a backup administrator'),{owner:'Yes',backup:'No',editor:'No',viewer:'No'});
  assert.equal(permissions('Change extra permissions').backup,'Only permissions held');
  assert.equal(permissions('Grant Viewer access without an invitation').backup,'No');
  assert.equal(permissions('Merge duplicate contacts or companies').editor,'With required extras');
  assert.equal(permissions('Contact files').viewer,'Download');
  assert.equal(permissions('Scheduled notes').editor,'View and schedule');
  assert.match(DomUtils.textContent(guide),/off for new teammates/);
}

// Use the second account's workspace so the main sharing fixture's memberships stay intact.
export async function verifyPortableBackupTeamAdministration({request,origin,headers,other,signIn,sql}){
  const owner=other,backup=headers,backupEmail='owner@example.test',repEmail='invitee@example.test';
  const rep=await signIn(repEmail),base='/api/workspaces';
  const get=(auth,path=base)=>request(path,{headers:auth});
  const change=(auth,body,path=base)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const members=await read(await get(owner)),workspaceId=members.owned;
  assert.ok(workspaceId);
  assert.ok(!members.viewers.some(m=>[backupEmail,repEmail].includes(m.email)));
  const locate=(directory,email)=>directory.viewers.find(m=>m.email===email);
  const scoped=id=>base+'?'+new URLSearchParams({workspaceId,grantId:id});
  const update=(id,action,fields)=>change(owner,{action,id,...fields});
  const appoint=(id,enabled)=>update(id,'backup_admin',{enabled});
  const ownedMember=async(response,email)=>locate(await read(await response),email);
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test','invitee@example.test'))`;
  await reset();
  try{
    let member=await ownedMember(change(owner,{action:'grant',email:backupEmail}),backupEmail);
    assert.equal((await appoint(member.id,true)).status,404,'A Viewer cannot be appointed.');
    member=await ownedMember(update(member.id,'role',{role:'editor'}),backupEmail);
    assert.equal((await get(backup,scoped(member.id))).status,403);
    member=await ownedMember(update(member.id,'record_activities',{enabled:true}),backupEmail);
    member=await ownedMember(appoint(member.id,true),backupEmail);
    assert.equal(member.backupAdmin,true);
    const link=scoped(member.id),manage=body=>change(backup,body,link);
    const contactsPage=await (await get(owner,'/?kind=contacts')).text();
    assert.match(contactsPage,/href="[^"]*view=workspaces#workspace-role-guide-viewer"/);
    assert.doesNotMatch(contactsPage,/<table class="portable-role-matrix"/,'Ordinary CRM lists link to the full role comparison in Workspaces.');
    verifyRoleGuide(await (await get(owner,'/?view=workspaces')).text(),'owner');
    const first=await read(await get(backup,link));
    assert.equal(first.managed.ownerEmail,'other@example.test');
    assert.equal(first.managed.permissions.contactFiles,false);
    const ownerExport=base+'?'+new URLSearchParams({view:'teammate-access',export:'csv',workspaceId});
    assert.equal((await get(backup,ownerExport)).status,404);
    assert.equal(first.owned,null);
    assert.deepEqual(first.incoming,[]);
    assert.deepEqual(first.shared,[]);
    const backupPage=(await (await get(backup,'/?view=workspaces')).text()).replaceAll('<!-- -->','');
    assert.match(backupPage,/Manage team from other@example.test/);
    assert.equal((await get(rep,link)).status,403,'Another account cannot reuse a backup grant.');
    assert.equal((await get(backup,base+'?'+new URLSearchParams({workspaceId:crypto.randomUUID(),grantId:member.id}))).status,403);
    assert.equal((await manage({action:'invite',email:'other@example.test',role:'viewer'})).status,404);
    assert.equal((await manage({action:'role',id:member.id,role:'viewer'})).status,404);
    assert.equal((await manage({action:'contact_files',id:member.id,enabled:true})).status,404);

    if(process.env.HARBOR_TEST_TEAMS_ONLY==='true'){
      const {verifyTeamInvitation}=await import('./portable-team-invitation-fixture.mjs');
      await verifyTeamInvitation({request,origin,owner,backup,rep,repEmail,backupEmail,backupId:member.id,manage,change,read,workspaceId,sql});
      await reset();
    }
    const invited=await read(await manage({action:'invite',email:repEmail,role:'editor'}));
    const invitation=invited.sent.find(i=>i.email===repEmail);
    const review=(await (await get(rep,'/?invitation='+invitation.id)).text()).replaceAll('<!-- -->','');
    verifyRoleGuide(review,'editor');
    assert.match(review,/What an Editor can do/);
    assert.match(review,/Create, assign and complete shared tasks/);
    assert.match(review,/mail and calendar connections stay private/);
    const revised=await read(await manage({action:'invite_role',id:invitation.id,role:'viewer'}));
    const replacement=revised.sent.find(i=>i.email===repEmail);
    assert.notEqual(replacement.id,invitation.id);
    const nextPreview=(await (await get(rep,'/?invitation='+replacement.id)).text()).replaceAll('<!-- -->','');
    verifyRoleGuide(nextPreview,'viewer');
    assert.match(nextPreview,/What a Viewer can do/);
    assert.match(nextPreview,/Read shared tasks and their due dates/);
    await read(await change(rep,{action:'accept_invite',id:replacement.id}));
    let sales=locate(await read(await get(backup,link)),repEmail);
    assert.equal(sales.backupAdmin,false);
    for(const permission of ['contactFiles','scheduledNotes','contactOutreach','recordActivities'])assert.equal(sales[permission],false);
    assert.equal((await manage({action:'backup_admin',id:sales.id,enabled:true})).status,403);
    assert.equal((await manage({action:'contact_files',id:sales.id,enabled:true})).status,404);
    sales=await ownedMember(update(sales.id,'contact_files',{enabled:true}),repEmail);
    assert.equal((await manage({action:'role',id:sales.id,role:'editor'})).status,404,'Promotion must not unlock editing for extras the backup does not have.');
    sales=await ownedMember(update(sales.id,'contact_files',{enabled:false}),repEmail);
    sales=await ownedMember(manage({action:'role',id:sales.id,role:'editor'}),repEmail);
    sales=await ownedMember(manage({action:'record_activities',id:sales.id,enabled:true}),repEmail);
    assert.equal(sales.recordActivities,true);
    sales=await ownedMember(appoint(sales.id,true),repEmail);
    assert.equal((await manage({action:'revoke',id:sales.id})).status,404,'Only the owner can remove another backup.');
    sales=await ownedMember(appoint(sales.id,false),repEmail);
    await reset();
    const root=crypto.randomUUID(),pod=crypto.randomUUID(),foreign=crypto.randomUUID();
    const create=(id,name,parentId=null)=>({action:'team_create',id,name,parentId});
    const removeTeam=(id,revision=1)=>({action:'team_remove',id,revision});
    await read(await change(backup,create(foreign,'Other workspace')));
    const parent=await read(await manage(create(root,'Sales')));
    assert.equal(parent.teams.find(team=>team.id===root).parentId,null);
    assert.equal((await change(rep,create(crypto.randomUUID(),'Forged team'),link)).status,403);
    assert.equal((await manage(create(pod,'Inbound',foreign))).status,409);
    await read(await manage(create(pod,'Inbound',root)));
    const replay=await read(await manage(create(pod,'Inbound',root)));
    assert.equal(replay.teams.filter(team=>team.id===pod).length,1);
    assert.equal((await manage(create(crypto.randomUUID(),'INBOUND',root))).status,409);
    assert.equal((await manage({action:'team_edit',id:root,revision:1,name:'Sales',parentId:pod})).status,409);
    const edit={action:'team_edit',id:pod,revision:1,name:'Inbound SDRs',parentId:null};
    await read(await manage(edit));
    assert.equal((await manage(edit)).status,409,'Stale tree changes must be rejected.');
    const moves=await Promise.all([
      manage({action:'team_edit',id:root,revision:1,name:'Sales',parentId:pod}),
      manage({action:'team_edit',id:pod,revision:2,name:'Inbound SDRs',parentId:root}),
    ]);
    assert.deepEqual(moves.map(response=>response.status).sort(),[200,409],'Concurrent moves cannot create a cycle.');
    let tree=(await read(await get(owner))).teams;
    const nested=tree.find(team=>team.parentId);
    assert.ok(nested);
    assert.equal((await manage(removeTeam(nested.parentId,tree.find(t=>t.id===nested.parentId).revision))).status,409);
    const assign={action:'team_assign',id:sales.id,teamId:nested.id,previousTeamId:null};
    assert.equal((await manage({...assign,teamId:foreign})).status,409);
    assert.equal((await manage({...assign,id:member.id})).status,409,'Delegated admin cannot change a protected member.');
    const assigned=await read(await manage(assign));
    assert.equal(locate(assigned,repEmail).teamId,nested.id);
    assert.equal((await manage({...assign,teamId:null})).status,409,'A stale assignment cannot clear a newer assignment.');
    assert.equal((await manage(removeTeam(nested.id,nested.revision))).status,409);
    const page=await (await get(owner,'/?view=workspaces')).text();
    assert.match(page,/Teams and pods/);
    assert.match(page,/Inbound SDRs/);
    assert.equal((await read(await get(backup))).teams.some(team=>team.id===root),false);
    await reset();
    const removed=await read(await manage({action:'revoke',id:sales.id}));
    assert.equal(locate(removed,repEmail),undefined);
    assert.equal((await get(rep,'/api/crm?workspaceId='+workspaceId)).status,404);
    const rejoined=await ownedMember(change(owner,{action:'grant',email:repEmail}),repEmail);
    assert.equal(rejoined.teamId,null,'Revoked members do not regain a team when added again.');
    await read(await change(owner,{action:'revoke',id:rejoined.id}));
    tree=(await read(await manage(removeTeam(nested.id,nested.revision)))).teams;
    const last=tree.find(team=>team.id===nested.parentId);
    await read(await manage(removeTeam(last.id,last.revision)));
    await read(await change(backup,removeTeam(foreign)));
    member=await ownedMember(update(member.id,'role',{role:'viewer'}),backupEmail);
    assert.equal(member.backupAdmin,false);
    assert.equal((await get(backup,link)).status,403);
    assert.equal((await manage({action:'invite',email:repEmail,role:'editor'})).status,403,'A prepared invitation is denied after the owner removes backup access.');
    assert.equal((await read(await get(owner))).sent.some(i=>i.email===repEmail),false);
  }finally{
    await reset();
    const after=await read(await get(owner));
    for(const member of after.viewers.filter(m=>[repEmail,backupEmail].includes(m.email)))await read(await change(owner,{action:'revoke',id:member.id}));
    for(const invite of after.sent.filter(i=>i.email===repEmail))await read(await change(owner,{action:'cancel_invite',id:invite.id}));
    const logout=await request('/auth/logout',{method:'POST',headers:{...rep,origin},body:new URLSearchParams({scope:'current'})});
    assert.equal(logout.status,303);
    await reset();
  }
}

export async function verifyPortableSeatCapacity({request,origin,headers,other,sql,restart}){
  const post=(auth,data)=>request('/api/workspaces',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const list=async()=>{
    const response=await request('/api/workspaces',{headers});
    assert.equal(response.status,200);
    return response.json();
  };
  const before=await list();
  assert.equal(before.seatLimit,25);
  const workspaceId=before.owned;
  await restart('150');
  await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
    SELECT gen_random_uuid()::text,'seat-test-'||n,'seat-test-'||lpad(n::text,3,'0')||'@example.test',0,0 FROM generate_series(1,149) AS n`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role)
    SELECT ${workspaceId},id,gen_random_uuid(),'editor' FROM login_identities WHERE google_subject LIKE 'seat-test-%'`;
  const full=await post(headers,{action:'invite',email:'other@example.test',role:'editor'});
  assert.equal(full.status,200);
  const directory=await full.json();
  assert.equal(directory.viewers.length+directory.sent.length,150);
  assert.equal(directory.seatLimit,150);
  const {parseCSV}=await tsImport('../lib/csv-import.ts',import.meta.url);
  async function exportedEmails(){
    const path='/api/workspaces?'+new URLSearchParams({view:'teammate-access',export:'csv',workspaceId});
    const response=await request(path,{headers});
    assert.equal(response.status,200);
    const parsed=parseCSV(await response.text());
    return parsed.rows.map(row=>row[parsed.headers.indexOf('Email')]);
  }
  assert.deepEqual(await exportedEmails(),directory.viewers.map(member=>member.email));

  const invite=directory.sent.find(item=>item.email==='other@example.test');
  assert.equal((await post(headers,{action:'invite',email:'invitee@example.test'})).status,409);
  await restart('25');
  const lowered=await list();
  assert.equal(lowered.seatLimit,25);
  assert.equal(lowered.viewers.length,149);
  assert.equal(lowered.sent.length,1);
  const accepted=await post(other,{action:'accept_invite',id:invite.id});
  assert.equal(accepted.status,200,'A lower limit must honor an existing reservation.');
  const retained=(await list()).viewers;
  assert.equal(retained.length,150);
  assert.deepEqual(await exportedEmails(),retained.map(member=>member.email));
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=workspaces#team-directory');
    const shown=page.locator('.portable-access-member > summary');
    const pages=page.getByRole('navigation',{name:'teammates pages'});
    const lastRep='seat-test-149@example.test';
    await pages.getByText('1–25 of 150',{exact:true}).waitFor();
    assert.equal(await shown.count(),25);
    for(let i=1;i<6;i++)await pages.getByRole('button',{name:'Next teammates'}).click();
    await pages.getByText('126–150 of 150',{exact:true}).waitFor();
    assert.ok(await shown.filter({hasText:lastRep}).isVisible());
    await pages.getByRole('button',{name:'Previous teammates'}).click();
    assert.equal(await shown.filter({hasText:lastRep}).count(),0);
    await page.getByRole('searchbox',{name:'Find a teammate'}).fill(lastRep);
    await shown.filter({hasText:lastRep}).click();
    assert.equal(await page.getByLabel('Access for '+lastRep,{exact:true}).inputValue(),'editor');
    await page.getByRole('button',{name:'Clear search'}).click();
    await pages.getByText('1–25 of 150',{exact:true}).waitFor();
  }finally{await browser.close();}
  const routing=await request('/api/leads?view=routing',{headers});
  assert.equal(routing.status,200);
  const {members}=await routing.json();
  assert.equal(members.length,150);
  assert.equal(members.at(-1).label,'seat-test-149@example.test');
  const contacts=await request('/',{headers});
  assert.equal(contacts.status,200);
  const filter=DomUtils.findOne(el=>el.name==='select'&&el.attribs.name==='owner',parseDocument(await contacts.text()).children);
  assert.ok(filter);
  const choices=DomUtils.getElementsByTagName('option',filter.children);
  const last=choices.find(el=>DomUtils.textContent(el)==='seat-test-149@example.test');
  assert.ok(last,'The owner picker includes teammates beyond the first hundred, even after lowering the limit.');
  const saved=await request('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',assigneeId:last.attribs.value,data:{name:'Fictional team handoff'}})});
  assert.equal(saved.status,201,await saved.clone().text());
  const {record}=await saved.json();
  const assigned=await request('/api/crm?id='+record.id,{headers});
  assert.equal(assigned.status,200);
  assert.equal((await assigned.json()).data.recordOwner.userId,last.attribs.value);
  assert.equal((await post(headers,{action:'invite',email:'invitee@example.test'})).status,409);
}
