import assert from 'node:assert/strict';
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
    const removed=await read(await manage({action:'revoke',id:sales.id}));
    assert.equal(locate(removed,repEmail),undefined);
    assert.equal((await get(rep,'/api/crm?workspaceId='+workspaceId)).status,404);
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
