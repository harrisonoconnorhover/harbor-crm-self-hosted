import assert from 'node:assert/strict';

export async function verifyPortableGuestSignIn({request,origin,headers,other,prepareSignIn,signIn,sql,env,restart,workspaceId,record}){
  const email='guest@example.test';
  // The shared rate-limit fixture ran immediately before this independent sign-in probe.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('login_start','login_callback')
    OR subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const path='/api/workspaces';
  const workspacesPage='/?view=workspaces';
  const sharedHome='/?workspaceId='+workspaceId;
  const shared='/api/crm?workspaceId='+workspaceId+'&id='+record.id;
  const associations='/api/associations?kind=contacts&workspaceId='+workspaceId+'&id='+record.id;
  const views='/api/crm/views?kind=contacts&workspaceId='+workspaceId;
  const dashboards='/api/reporting?view=dashboards&workspaceId='+workspaceId;
  const reminders='/api/task-reminders?workspaceId='+workspaceId;
  const search=(auth,query)=>request('/api/crm/search?workspaceId='+workspaceId,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify({query})});
  const get=(url,auth)=>request(url,{headers:auth});
  const workspaceHtml=async(url,auth)=>{
    const response=await get(url,auth);
    assert.equal(response.status,200);
    return (await response.text()).replaceAll('<!-- -->','');
  };
  const change=(auth,data)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(data)});
  const invite=()=>change(headers,{action:'invite',email});
  async function denied(){
    const attempt=await prepareSignIn(email);
    const callback=await get(attempt.path,attempt.headers);
    assert.equal(callback.status,303);
    assert.match(callback.headers.get('location'),/\/auth\/sign-in\?error=sign_in_failed&reference=[0-9a-f-]{36}$/);
    assert.ok(!callback.headers.getSetCookie().some(value=>value.startsWith('harbor-session=')));
  }
  await denied();
  assert.equal((await invite()).status,404);
  const originalOwners=env.HARBOR_LOGIN_ALLOWED_EMAILS;
  env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED='true';
  await restart();
  let guest;
  const teammates=[];
  try{
    await denied();
    assert.equal((await (await get(path,headers)).json()).inviteSignIn,true);
    const directGrant=await change(headers,{action:'grant',email});
    assert.equal(directGrant.status,404);
    assert.match((await directGrant.json()).error,/Prepare an invitation/);
    const pendingInvite=async()=>{
      const response=await invite();
      assert.equal(response.status,200);
      return (await response.json()).sent.find(item=>item.email===email);
    };
    const expired=await pendingInvite();
    await sql`UPDATE portable_workspace_invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.id}`;
    await denied();
    const pending=await pendingInvite();
    assert.notEqual(pending.id,expired.id);
    await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES('fixture-other-guest-subject','fixture-other-guest-subject',${email},0,0)`;
    try{await denied();}
    finally{await sql`DELETE FROM login_identities WHERE id='fixture-other-guest-subject'`;}
    const invitationPath='/?invitation='+pending.id;
    const redirect=await get(invitationPath,{});
    assert.equal(redirect.status,307);
    assert.equal(new URL(redirect.headers.get('location'),origin).searchParams.get('return_to'),invitationPath);
    assert.equal((await get('/?invitation=bad',{})).status,404);
    const wrong=await (await get(invitationPath,other)).text();
    assert.match(wrong,/Invitation unavailable/);
    assert.doesNotMatch(wrong,/owner@example.test|guest@example.test|>Accept invitation<|>Decline invitation</);
    assert.ok(!wrong.includes(sharedHome));
    guest=await signIn(email,request,origin,invitationPath);
    const [guestIdentity]=await sql`SELECT id FROM login_identities WHERE email=${email}`;
    // Keep the synthetic saturated budget valid if the test crosses a database minute.
    await sql`INSERT INTO portable_request_budgets(scope,subject,minute,used)
      VALUES('api_read',${guestIdentity.id},floor(extract(epoch FROM clock_timestamp())/60)::integer+1,120)
      ON CONFLICT(scope,subject) DO UPDATE SET minute=excluded.minute,used=excluded.used`;
    try{
      const budgetDenied=await get(associations,guest);
      assert.equal(budgetDenied.status,429,'Rate limit applies before checking a guest workspace grant');
      assert.equal(budgetDenied.headers.get('retry-after'),'60');
      assert.equal(budgetDenied.headers.get('cache-control'),'private, no-store');
      assert.equal((await get(path,headers)).status,200,'Another identity has a separate budget');
    }finally{await sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject=${guestIdentity.id}`;}
    assert.equal((await get(associations,guest)).status,403);
    const [charged]=await sql`SELECT used FROM portable_request_budgets WHERE scope='api_read' AND subject=${guestIdentity.id}`;
    assert.equal(charged.used,1,'Denied guest requests still count toward the request budget');
    assert.equal((await get(views,guest)).status,403);
    const review=await workspaceHtml(invitationPath,guest);
    assert.match(review,/Join the workspace from/);
    assert.match(review,/owner@example.test/);
    assert.match(review,/>Accept invitation</);
    assert.match(review,/>Decline invitation</);
    assert.match(review,/What a Viewer can do/);
    assert.match(review,/Open records, follow linked records and view the pipeline/);
    assert.match(review,/href="\/\?view=workspaces">Workspaces<\/a>/);
    assert.equal((await get(shared,guest)).status,403);

    for(const url of ['/',workspacesPage]){
      const home=await workspaceHtml(url,guest);
      assert.match(home,/Your shared workspaces/);
      assert.match(home,/Invitations for you/);
      assert.ok(home.includes('href="'+invitationPath+'">Review invitation</a>'));
      assert.ok(!home.includes(sharedHome),'A pending invitation is not a workspace link.');
      assert.doesNotMatch(home,/Add contact|Share your workspace|Prepare invitation|Loading workspace access/);
    }
    const list=await (await get(path,guest)).json();
    assert.equal(list.owned,null);
    assert.equal(Object.hasOwn(list,'inviteSignIn'),false);
    assert.ok(list.incoming.some(item=>item.id===pending.id));
    assert.equal((await get(shared,guest)).status,403);
    assert.equal((await get('/?view=workflows',guest)).status,404);
    assert.equal((await get('/?view=getting-started',guest)).status,404);
    for(const url of ['/api/crm','/api/workflows','/api/lead-forms','/api/email/suppressions','/api/pipeline']){
      assert.equal((await get(url,guest)).status,403);
    }
    const ownCreate=await request('/api/crm',{method:'POST',headers:{...guest,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',data:{name:'Denied guest workspace'}})});
    assert.equal(ownCreate.status,403);
    assert.equal((await change(guest,{action:'invite',email:'another@example.test'})).status,403);
    assert.equal((await change(other,{action:'accept_invite',id:pending.id})).status,404);
    const declined=await change(guest,{action:'decline_invite',id:pending.id});
    assert.equal(declined.status,200);
    const guestAfterDecline=await declined.json();
    assert.deepEqual(guestAfterDecline.incoming,[]);
    assert.deepEqual(guestAfterDecline.shared,[]);
    assert.ok(!(await (await get(path,headers)).json()).sent.some(item=>item.id===pending.id));
    assert.equal((await get(shared,guest)).status,401);
    const replacement=await pendingInvite();
    assert.notEqual(replacement.id,pending.id);
    assert.equal((await change(guest,{action:'accept_invite',id:pending.id})).status,404);
    const accepted=await change(guest,{action:'accept_invite',id:replacement.id});
    assert.equal(accepted.status,200);
    const [grant]=(await accepted.json()).shared;
    assert.equal(grant.role,'viewer');
    const consumedPath='/?invitation='+replacement.id;
    const consumed=await workspaceHtml(consumedPath,guest);
    assert.match(consumed,/Invitation unavailable/);
    assert.ok(consumed.includes('href="'+workspacesPage+'">Open my workspaces</a>'));
    assert.doesNotMatch(consumed,/owner@example\.test|>Accept invitation<|>Decline invitation</);
    assert.ok(!consumed.includes(sharedHome),'The unavailable invitation stays generic.');
    const workspaceLink='href="'+sharedHome+'">Workspace from owner@example.test</a>';
    const joined=await workspaceHtml(workspacesPage,guest);
    assert.ok(joined.includes(workspaceLink+' · Viewer'));
    assert.ok(!joined.includes(consumedPath));
    assert.doesNotMatch(joined,/Loading workspace access|other@example\.test/);
    const firstRead=await get(shared,guest);
    assert.equal(firstRead.status,200);
    const sharedRecord=await firstRead.json();
    const results=await search(guest,sharedRecord.data.name);
    assert.equal(results.status,200);
    assert.ok((await results.json()).results.some(hit=>hit.id===record.id));
    assert.equal((await get(dashboards,guest)).status,200);
    assert.equal((await get(reminders,guest)).status,200);
    assert.equal((await get('/api/reporting?view=dashboards',guest)).status,403);
    const viewerHome=await get(sharedHome,guest);
    assert.equal(viewerHome.status,200);
    const viewerHtml=(await viewerHome.text()).replaceAll('<!-- -->','');
    assert.match(viewerHtml,/Your workspace access/);
    assert.match(viewerHtml,/Ask the workspace owner for Editor access/);
    assert.match(viewerHtml,/Contact files · Unavailable/);
    assert.doesNotMatch(viewerHtml,/<button[^>]*>Add contact/);
    const linked=await get(associations,guest);
    assert.equal(linked.status,200);
    assert.ok((await linked.json()).items.length>0);
    const sharedViews=await get(views,guest);
    assert.equal(sharedViews.status,200);
    const [view]=(await sharedViews.json()).views;
    assert.equal((await get('/?workspaceId='+workspaceId+'&savedView='+view.id,guest)).status,200);

    const original=await (await get(shared,guest)).json();
    const save=(grantId,body)=>request('/api/crm?'+new URLSearchParams({workspaceId,grantId}),{
      method:'POST',headers:{...guest,origin,'content-type':'application/json'},body:JSON.stringify(body),
    });
    const edit=(current,name)=>({action:'save',kind:'contacts',id:current.id,
      expectedRevision:current.revision,data:{...current.data,name}});
    assert.equal((await save(grant.grantId,edit(original,'Denied viewer edit'))).status,403);
    const promote=await change(headers,{action:'role',id:grant.grantId,role:'editor'});
    assert.equal(promote.status,200);
    let editor=(await promote.json()).viewers.find(member=>member.email===email);
    assert.ok(editor);
    assert.notEqual(editor.id,grant.grantId);
    assert.ok((await workspaceHtml(workspacesPage,guest)).includes(workspaceLink+' · Editor'));
    const appointed=await change(headers,{action:'backup_admin',id:editor.id,enabled:true});
    assert.equal(appointed.status,200);
    const backup=(await appointed.json()).viewers.find(member=>member.email===email);
    const managed=path+'?'+new URLSearchParams({workspaceId,grantId:backup.id});
    assert.match(await workspaceHtml(workspacesPage,guest),/Manage team from owner@example.test/);
    const asBackup=body=>request(managed,{method:'POST',headers:{...guest,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const prepared=await asBackup({action:'invite',email:'backup-invited-guest@example.test',role:'viewer'});
    assert.equal(prepared.status,200);
    const directory=await prepared.json();
    assert.equal(directory.inviteSignIn,true);
    assert.equal(directory.managed.permissions.contactFiles,false);
    const delegatedInvite=directory.sent.find(invite=>invite.email==='backup-invited-guest@example.test');
    assert.equal((await asBackup({action:'cancel_invite',id:delegatedInvite.id})).status,200);
    assert.equal((await change(guest,{action:'invite',email:'backup-invited-guest@example.test'})).status,403);
    const retired=await change(headers,{action:'backup_admin',id:backup.id,enabled:false});
    assert.equal(retired.status,200);
    editor=(await retired.json()).viewers.find(member=>member.email===email);
    assert.equal((await get(managed,guest)).status,403);
    const editorHome=await get(sharedHome,guest);
    assert.equal(editorHome.status,200);
    const editorHtml=(await editorHome.text()).replaceAll('<!-- -->','');
    assert.match(editorHtml,/Shared workspace · Editor/);
    assert.match(editorHtml,/choose Add contact to create one in this workspace/);
    assert.match(editorHtml,/Contact files · Unavailable/);
    assert.equal((await save(editor.id,edit(original,'Invited editor follow-up'))).status,200);
    const ownerRecord=()=>get('/api/crm?id='+record.id,headers).then(response=>response.json());
    const saved=await ownerRecord();
    assert.equal(saved.data.name,'Invited editor follow-up');
    const [audit]=await sql`SELECT actor_id FROM contact_events WHERE workspace_id=${workspaceId}
      AND contact_id=${record.id} AND revision=${saved.revision}`;
    assert.equal(audit.actor_id,guestIdentity.id);
    const stale=edit(saved,'Denied stale editor edit');

    // Exercise the ten-person pilot size with an owner, this editor and eight viewers.
    for(let seat=3;seat<=10;seat++){
      const teammateEmail='pilot-seat-'+seat+'@example.test';
      const invited=await change(headers,{action:'invite',email:teammateEmail});
      assert.equal(invited.status,200);
      const invitation=(await invited.json()).sent.find(item=>item.email===teammateEmail);
      assert.ok(invitation);
      const auth=await signIn(teammateEmail,request,origin,'/?invitation='+invitation.id);
      teammates.push({auth,email:teammateEmail});
      const joined=await change(auth,{action:'accept_invite',id:invitation.id});
      assert.equal(joined.status,200);
      const [member]=(await joined.json()).shared;
      assert.equal(member.role,'viewer');
      assert.equal(member.id,workspaceId);
      assert.equal((await get(shared,auth)).status,200);
      assert.equal((await get('/api/crm',auth)).status,403);
    }
    const team=(await (await get(path,headers)).json()).viewers;
    const pilotTeam=team.filter(member=>member.email===email||teammates.some(teammate=>teammate.email===member.email));
    assert.equal(pilotTeam.length,9);
    assert.equal(pilotTeam.filter(member=>member.role==='editor').length,1);

    env.HARBOR_LOGIN_ALLOWED_EMAILS='other@example.test,invitee@example.test';
    await restart();
    assert.equal((await get(shared,guest)).status,401);
    env.HARBOR_LOGIN_ALLOWED_EMAILS=originalOwners;
    await restart();
    assert.equal((await get(shared,guest)).status,200);
    assert.equal((await change(headers,{action:'revoke',id:editor.id})).status,200);
    assert.equal((await search(guest,sharedRecord.data.name)).status,401);
    assert.equal((await get(dashboards,guest)).status,401);
    assert.equal((await get(reminders,guest)).status,401);
    const revokedWorkspaces=await get(workspacesPage,guest);
    assert.equal(revokedWorkspaces.status,307);
    assert.equal(new URL(revokedWorkspaces.headers.get('location'),origin).pathname,'/auth/sign-in');
    assert.ok(!(await revokedWorkspaces.text()).includes(sharedHome));
    assert.equal((await save(editor.id,stale)).status,401);
    assert.equal((await ownerRecord()).revision,saved.revision);
    assert.equal((await ownerRecord()).data.name,saved.data.name);
    assert.equal((await get(associations,guest)).status,401);
    assert.equal((await get(views,guest)).status,401);
    assert.equal((await get(shared,guest)).status,401);
    for(const teammate of teammates){
      const read=await get(shared,teammate.auth);
      assert.equal(read.status,200);
      assert.equal((await read.json()).revision,saved.revision);
    }
    await denied();
  }finally{
    if(guest)await request('/auth/logout',{method:'POST',headers:{...guest,origin},body:new URLSearchParams({scope:'current'})});
    env.HARBOR_LOGIN_ALLOWED_EMAILS=originalOwners;
    const currentTeam=(await (await get(path,headers)).json()).viewers;
    for(const teammate of teammates){
      const logout=await request('/auth/logout',{method:'POST',headers:{...teammate.auth,origin},
        body:new URLSearchParams({scope:'current'})});
      assert.equal(logout.status,303);
      const member=currentTeam.find(item=>item.email===teammate.email);
      if(member)assert.equal((await change(headers,{action:'revoke',id:member.id})).status,200);
    }
    env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED='false';
    await restart();
  }
}
