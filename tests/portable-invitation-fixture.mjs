import assert from 'node:assert/strict';
import {acceptReviewedWorkspaceInvitation,declineReviewedWorkspaceInvitation,saveWorkspaceAccess} from '../runtime/portable-invitation-acceptance.ts';

async function assertStatus(response,expected,step){
  if(response.status===expected)return;
  const detail=await response.clone().text().catch(()=>'(response body unavailable)');
  assert.equal(response.status,expected,step+': '+detail.slice(0,512));
}

export async function verifyPortableInvitations({request,origin,headers,other,signIn,sql,workspaceId}){
  const email='invitee@example.test';
  const listing=async auth=>{
    const response=await request('/api/workspaces',{headers:auth});
    await assertStatus(response,200,'Read workspace sharing');
    return response.json();
  };
  const change=(auth,data)=>request('/api/workspaces',{method:'POST',headers:{
    ...auth,origin,'content-type':'application/json',
  },body:JSON.stringify(data)});
  const invite=(target=email,role)=>change(headers,{action:'invite',email:target,role});
  const changeRole=(id,role,auth=headers)=>change(auth,{action:'invite_role',id,role});
  const decline=(auth,id)=>change(auth,{action:'decline_invite',id});
  const requestFor=(auth,calls)=>(path,init)=>{
    calls.push([init.method??'GET',init.cache??null]);
    return request(path,{...init,headers:{...auth,...(init.method==='POST'?{origin}:{}),...init.headers}});
  };
  const [owner]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  // The acceptance fixture combines independent scenarios within one minute.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject=${owner.id}`;
  assert.equal((await listing(headers)).inviteSignIn,false);
  const unapproved=await invite('outside@example.test');
  await assertStatus(unapproved,404,'Reject an invitation for an unapproved account');
  assert.match((await unapproved.json()).error,/Ask your Harbor administrator/);
  const self=await invite('owner@example.test');
  await assertStatus(self,404,'Reject an invitation to the owner');
  assert.match((await self.json()).error,/teammate’s Google email/);
  assert.equal((await sql`SELECT count(*)::int AS count FROM login_identities WHERE email=${email}`)[0].count,0);
  const prepared=await invite('INVITEE@example.test');
  await assertStatus(prepared,200,'Prepare a Viewer invitation');
  const [first]=(await prepared.json()).sent;
  assert.equal(first.email,email);
  assert.equal(first.role,'viewer');
  assert.ok(Date.parse(first.expiresAt)>Date.now()+6*86400000);
  const expiry=new Date(first.expiresAt).toISOString();
  const expiryMarkup=`Expires <time dateTime="${expiry}">${expiry.slice(0,19).replace('T',' ')} UTC</time>`;
  const ownerSharing=await request('/?view=workspaces',{headers});
  await assertStatus(ownerSharing,200,'Open pending invitations as the owner');
  assert.ok((await ownerSharing.text()).replaceAll('<!-- -->','').includes(expiryMarkup),'The owner sees the exact UTC invitation expiry');
  assert.deepEqual((await (await invite()).json()).sent,[first]);
  assert.deepEqual((await listing(other)).incoming,[]);
  await assertStatus(await change(other,{action:'accept_invite',id:first.id}),404,'Workspace change accept_invite');
  const wrongAccountCalls=[];
  assert.equal((await acceptReviewedWorkspaceInvitation(requestFor(headers,wrongAccountCalls),first.id,workspaceId,false)).status,'denied');
  assert.deepEqual(wrongAccountCalls,[['POST',null],['GET','no-store']]);
  await assertStatus(await change(other,{action:'cancel_invite',id:first.id}),404,'Workspace change cancel_invite');
  await assertStatus(await change({}, {action:'accept_invite',id:first.id}),401,'Workspace change accept_invite');

  const invitee=await signIn(email);
  try{
    const pending=await listing(invitee);
    assert.deepEqual(pending.incoming,[{id:first.id,ownerEmail:'owner@example.test',role:'viewer',expiresAt:first.expiresAt}]);
    const normalHome=async auth=>{
      const response=await request('/',{headers:auth});
      await assertStatus(response,200,'Open ordinary Contacts home');
      return (await response.text()).replaceAll('<!-- -->','');
    };
    const yourWorkspaceContext=/<p class="portable-workspace-context"><strong>Your workspace<\/strong>/;
    const invitationShortcut=/<a href="([^"]+)">Review invitation from owner@example\.test<\/a>/;
    const sharedShortcut=/<a href="([^"]+)">Open workspace from owner@example\.test<\/a>/;
    const pendingHome=await normalHome(invitee);
    assert.match(pendingHome,yourWorkspaceContext);
    assert.doesNotMatch(pendingHome,sharedShortcut);
    const invitePath=pendingHome.match(invitationShortcut)?.[1];
    assert.equal(invitePath,'/?invitation='+first.id);
    assert.ok(!(await normalHome(other)).includes(first.id));
    const anonymous=await request('/');
    assert.match(anonymous.headers.get('location')||'',/\/auth\/sign-in/);
    assert.ok(!(await anonymous.text()).includes(first.id));
    const review=await request(invitePath,{headers:invitee});
    await assertStatus(review,200,'Open Viewer invitation review');
    const reviewHtml=(await review.text()).replaceAll('<!-- -->','');
    assert.match(reviewHtml,/Join the workspace from <strong>owner@example\.test<\/strong> as a Viewer\./);
    assert.ok(reviewHtml.includes(expiryMarkup),'The invitee sees the same UTC invitation expiry');
    assert.match(reviewHtml,/>Accept invitation<\/button>/);
    assert.match(reviewHtml,/>Decline invitation<\/button>/);
    const reviewed=await listing(invitee);
    assert.deepEqual(reviewed.incoming,pending.incoming);
    assert.deepEqual(reviewed.shared,[]);
    await assertStatus(await request('/api/crm?workspaceId='+workspaceId,{headers:invitee}),404,'Check workspace record access');
    await assertStatus(await change(headers,{action:'grant',email}),409,'Workspace change grant');
    const accepted=await Promise.all([0,1].map(()=>change(invitee,{action:'accept_invite',id:first.id})));
    accepted.sort((a,b)=>a.status-b.status);
    await assertStatus(accepted[0],200,'Accept one copy of the invitation');
    await assertStatus(accepted[1],404,'Reject the concurrent duplicate acceptance');
    const staleTabCalls=[];
    assert.equal((await acceptReviewedWorkspaceInvitation(requestFor(invitee,staleTabCalls),first.id,workspaceId,false)).status,'accepted');
    assert.deepEqual(staleTabCalls,[['POST',null],['GET','no-store']]);
    const member=await listing(invitee);
    assert.deepEqual(member.incoming,[]);
    assert.equal(member.shared.length,1);
    assert.equal(member.shared[0].id,workspaceId);
    assert.equal(member.shared[0].role,'viewer');
    assert.equal(member.shared[0].contactFiles,false);
    assert.equal(member.shared[0].scheduledNotes,false);
    const ownerContacts=await request('/api/crm?workspaceId='+workspaceId,{headers:invitee});
    await assertStatus(ownerContacts,200,'Check workspace record access');
    const [sharedContact]=(await ownerContacts.json()).records;
    assert.ok(sharedContact);
    const memberHome=await normalHome(invitee);
    assert.match(memberHome,yourWorkspaceContext);
    assert.doesNotMatch(memberHome,invitationShortcut);
    assert.ok(!memberHome.includes(sharedContact.id));
    const sharedPath=memberHome.match(sharedShortcut)?.[1];
    assert.equal(sharedPath,'/?workspaceId='+workspaceId);
    const ownerHome=await normalHome(headers);
    assert.match(ownerHome,yourWorkspaceContext);
    assert.doesNotMatch(ownerHome,sharedShortcut);
    const signedOutHome=await request('/');
    assert.match(signedOutHome.headers.get('location')||'',/\/auth\/sign-in/);
    assert.ok(!(await signedOutHome.text()).includes(sharedPath));
    const sharedPage=await request(sharedPath,{headers:invitee});
    await assertStatus(sharedPage,200,'Follow the workspace link from Contacts');
    const sharedHtml=(await sharedPage.text()).replaceAll('<!-- -->','');
    assert.match(sharedHtml,/Shared workspace · View only/);
    assert.doesNotMatch(sharedHtml,yourWorkspaceContext);
    assert.doesNotMatch(sharedHtml,sharedShortcut);
    const escapedName=sharedContact.data.name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#x27;');
    const sharedRecordHref='/?contact='+sharedContact.id+'&amp;workspaceId='+workspaceId;
    assert.ok(sharedHtml.includes('href="'+sharedRecordHref+'">'+escapedName+'</a></th>'),
      'The shared Contacts table links the owner’s record in the selected workspace');
    const returnedHome=await normalHome(invitee);
    assert.match(returnedHome,sharedShortcut);
    assert.ok(!returnedHome.includes(sharedContact.id));
    await assertStatus(await invite(),409,'Prepare invitation');
    await assertStatus(await change(headers,{action:'revoke',id:member.shared[0].grantId}),200,'Workspace change revoke');
    const revokedHome=await normalHome(invitee);
    assert.match(revokedHome,yourWorkspaceContext);
    assert.doesNotMatch(revokedHome,sharedShortcut);
    assert.ok(!revokedHome.includes(sharedContact.id));
    await assertStatus(await request(sharedPath,{headers:invitee}),404,'Reopen the revoked workspace URL');
    await assertStatus(await change(invitee,{action:'accept_invite',id:first.id}),404,'Workspace change accept_invite');

    const prepareCalls=[];
    const sendAsOwner=requestFor(headers,prepareCalls);
    const recoveredInvite=await saveWorkspaceAccess(async(path,init)=>{
      const response=await sendAsOwner(path,init);
      if(init.method==='POST'){
        assert.equal(response.status,200);
        await response.body?.cancel();
        throw new TypeError('Fictional connection lost after invitation preparation');
      }
      return response;
    },{action:'invite',email:'INVITEE@example.test'});
    assert.equal(recoveredInvite.status,'refreshed');
    assert.deepEqual(prepareCalls,[['POST',null],['GET','no-store']]);
    assert.equal(recoveredInvite.sharing.sent.length,1);
    const [lost]=recoveredInvite.sharing.sent;
    assert.equal(lost.email,email);
    assert.match(await (await request('/?invitation='+lost.id,{headers:invitee})).text(),/Accept invitation/);
    const pendingCalls=[];
    const readPending=requestFor(invitee,pendingCalls);
    let interruptedBody;
    const interrupted=await acceptReviewedWorkspaceInvitation((path,init)=>{
      if(init.method==='POST'){
        pendingCalls.push(['POST',null]);
        interruptedBody=init.body;
        throw new TypeError('Fictional connection lost before sending the acceptance');
      }
      return readPending(path,init);
    },lost.id,workspaceId,false);
    assert.equal(interrupted.status,'pending');
    assert.deepEqual(JSON.parse(interruptedBody),{action:'accept_invite',id:lost.id});
    assert.deepEqual(pendingCalls,[['POST',null],['GET','no-store']]);
    const stillPending=await listing(invitee);
    assert.deepEqual(stillPending.incoming.map(invitation=>invitation.id),[lost.id]);
    assert.deepEqual(stillPending.shared,[]);
    assert.equal((await acceptReviewedWorkspaceInvitation(readPending,lost.id,workspaceId,true)).status,'pending');
    assert.deepEqual(pendingCalls,[['POST',null],['GET','no-store'],['GET','no-store']]);

    const recoveryCalls=[],lostStatuses=[];
    const send=requestFor(invitee,recoveryCalls);
    const loseReplies=async(path,init)=>{
      const response=await send(path,init);
      lostStatuses.push(response.status);
      await response.body?.cancel();
      throw new TypeError('Fictional connection lost after the server replied');
    };
    assert.equal((await acceptReviewedWorkspaceInvitation(loseReplies,lost.id,workspaceId,false)).status,'unconfirmed');
    assert.deepEqual(recoveryCalls,[['POST',null],['GET','no-store']]);
    assert.deepEqual(lostStatuses,[200,200]);
    assert.equal((await acceptReviewedWorkspaceInvitation(send,lost.id,workspaceId,true)).status,'accepted');
    assert.deepEqual(recoveryCalls,[['POST',null],['GET','no-store'],['GET','no-store']]);
    const recovered=(await listing(invitee)).shared;
    assert.equal(recovered.length,1);
    assert.equal(recovered[0].id,workspaceId);
    assert.equal(recovered[0].role,'viewer');
    const [{count}]=await sql`SELECT count(*)::int AS count FROM portable_workspace_viewers v
      JOIN login_identities i ON i.id=v.viewer_id WHERE v.workspace_id=${workspaceId} AND i.email=${email}`;
    assert.equal(count,1);
    assert.equal((await acceptReviewedWorkspaceInvitation(send,lost.id,'00000000-0000-4000-8000-000000000000',true)).status,'unconfirmed');
    const ownerCalls=[];
    const ownerRequest=requestFor(headers,ownerCalls);
    const revoked=await saveWorkspaceAccess(async(path,init)=>{
      const response=await ownerRequest(path,init);
      if(init.method==='POST'){
        assert.equal(response.status,200);
        await response.body?.cancel();
        throw new TypeError('Fictional connection lost after revocation');
      }
      return response;
    },{action:'revoke',id:recovered[0].grantId});
    assert.equal(revoked.status,'refreshed');
    assert.ok(revoked.sharing.viewers.every(viewer=>viewer.id!==recovered[0].grantId));
    assert.deepEqual(ownerCalls,[['POST',null],['GET','no-store']]);
    assert.equal((await acceptReviewedWorkspaceInvitation(send,lost.id,workspaceId,true)).status,'unconfirmed');
    assert.deepEqual(recoveryCalls,[['POST',null],...Array.from({length:4},()=>['GET','no-store'])]);
    await assertStatus(await request('/api/crm?workspaceId='+workspaceId,{headers:invitee}),404,'Check workspace record access');

    await assertStatus(await invite(email,'owner'),400,'Prepare invitation');
    const editorPrepared=await invite(email,'editor');
    await assertStatus(editorPrepared,200,'Prepare an Editor invitation');
    const [editorInvite]=(await editorPrepared.json()).sent;
    assert.equal(editorInvite.role,'editor');
    assert.deepEqual((await (await invite(email,'editor')).json()).sent,[editorInvite]);
    const conflict=await invite();
    await assertStatus(conflict,409,'Reject a role change on an existing invitation');
    assert.match((await conflict.json()).error,/different role is pending/);
    assert.deepEqual((await listing(headers)).sent,[editorInvite]);
    await assertStatus(await changeRole(editorInvite.id,'viewer',{}),401,'Require sign-in to change the invitation role');
    await assertStatus(await changeRole(editorInvite.id,'viewer',other),404,'Reject a role change by a non-owner');
    await assertStatus(await changeRole(editorInvite.id,'owner'),400,'Reject an unsupported invitation role');
    const sameRole=await changeRole(editorInvite.id,'editor');
    await assertStatus(sameRole,200,'Keep the same invitation for an unchanged role');
    assert.deepEqual((await sameRole.json()).sent,[editorInvite]);
    const downgrades=await Promise.all([changeRole(editorInvite.id,'viewer'),changeRole(editorInvite.id,'viewer')]);
    downgrades.sort((left,right)=>left.status-right.status);
    await assertStatus(downgrades[0],200,'Change one pending invitation to Viewer');
    await assertStatus(downgrades[1],404,'Reject the duplicate change with the replaced invitation ID');
    const [viewerInvite]=(await downgrades[0].json()).sent;
    assert.notEqual(viewerInvite.id,editorInvite.id);
    assert.deepEqual(viewerInvite,{...editorInvite,id:viewerInvite.id,role:'viewer'});
    await assertStatus(await change(invitee,{action:'accept_invite',id:editorInvite.id}),404,'Reject the replaced Editor link');
    assert.match(await (await request('/?invitation='+editorInvite.id,{headers:invitee})).text(),/Invitation unavailable/);
    assert.equal((await listing(invitee)).incoming[0].role,'viewer');
    const replacementCalls=[];
    const readReplacement=requestFor(invitee,replacementCalls);
    assert.equal((await acceptReviewedWorkspaceInvitation(readReplacement,editorInvite.id,workspaceId,true)).status,'unconfirmed');
    assert.equal((await acceptReviewedWorkspaceInvitation(readReplacement,viewerInvite.id,workspaceId,true)).status,'pending');
    assert.deepEqual(replacementCalls,[['GET','no-store'],['GET','no-store']]);

    const sharingBeforeUpgrade=await listing(headers);
    const seatsRemaining=25-sharingBeforeUpgrade.viewers.length-sharingBeforeUpgrade.sent.length;
    await sql`INSERT INTO portable_workspace_invites(id,workspace_id,email,expires_at)
      SELECT gen_random_uuid(),${workspaceId},'role-capacity-'||seat||'@example.test',clock_timestamp()+interval '1 day'
      FROM generate_series(1,${seatsRemaining}::int) AS seat`;
    try{
      const atCapacity=await listing(headers);
      assert.equal(atCapacity.viewers.length+atCapacity.sent.length,25);
      const upgraded=await changeRole(viewerInvite.id,'editor');
      await assertStatus(upgraded,200,'Upgrade the existing invitation at capacity');
      const after=await upgraded.json();
      assert.equal(after.viewers.length+after.sent.length,25);
    }finally{await sql`DELETE FROM portable_workspace_invites WHERE workspace_id=${workspaceId} AND email LIKE 'role-capacity-%'`;}
    const [replacement]=(await listing(headers)).sent;
    assert.notEqual(replacement.id,viewerInvite.id);
    assert.deepEqual(replacement,{...editorInvite,id:replacement.id});
    await assertStatus(await change(invitee,{action:'accept_invite',id:viewerInvite.id}),404,'Reject the replaced Viewer link');
    await assertStatus(await decline(invitee,viewerInvite.id),404,'Reject decline of the replaced Viewer link');
    await assertStatus(await change(other,{action:'accept_invite',id:replacement.id}),404,'Keep the replacement bound to the original recipient');
    assert.equal((await listing(invitee)).incoming[0].role,'editor');
    const editorReview=await request('/?invitation='+replacement.id,{headers:invitee});
    await assertStatus(editorReview,200,'Open Editor invitation review');
    assert.match((await editorReview.text()).replaceAll('<!-- -->',''),/as an Editor\./);
    await assertStatus(await change(invitee,{action:'accept_invite',id:replacement.id}),200,'Accept the replacement as Editor');
    await assertStatus(await changeRole(replacement.id,'viewer'),404,'Reject a role change on a consumed invitation');
    const [editor]=(await listing(invitee)).shared;
    assert.equal(editor.role,'editor');
    assert.equal(editor.contactFiles,false);
    assert.equal(editor.scheduledNotes,false);
    assert.equal(editor.contactOutreach,false);
    assert.equal(editor.recordActivities,false);
    const crm='/api/crm?workspaceId='+workspaceId+'&grantId='+editor.grantId;
    const save=(body)=>request(crm,{method:'POST',headers:{...invitee,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',...body})});
    const created=await save({data:{name:'Direct Editor invitation fixture'}});
    await assertStatus(created,201,'Create a contact as the invited Editor');
    const {record}=await created.json();
    await assertStatus(await save({id:record.id,expectedRevision:record.revision,data:{...record.data,name:'Edited by invited teammate'}}),200,'Save a shared contact');
    const ownerRead=()=>request('/api/crm?kind=contacts&id='+record.id,{headers});
    const saved=await ownerRead();
    await assertStatus(saved,200,'Read the invited Editor’s saved change as owner');
    const persisted=await saved.json();
    assert.equal(persisted.data.name,'Edited by invited teammate');
    await assertStatus(await change(headers,{action:'revoke',id:editor.grantId}),200,'Workspace change revoke');
    await assertStatus(await request('/api/crm?workspaceId='+workspaceId+'&kind=contacts&id='+record.id,{headers:invitee}),404,'Check workspace record access');
    await assertStatus(await save({id:record.id,expectedRevision:persisted.revision,data:{...persisted.data,name:'Revoked edit'}}),403,'Save a shared contact');
    assert.deepEqual(await (await ownerRead()).json(),persisted);

    const [raceInvite]=(await (await invite()).json()).sent;
    const [roleRace,acceptRace]=await Promise.all([
      changeRole(raceInvite.id,'editor'),
      change(invitee,{action:'accept_invite',id:raceInvite.id}),
    ]);
    let acceptedRole='viewer';
    if(roleRace.ok){
      await assertStatus(acceptRace,404,'Reject the original invitation when the role change wins');
      const [raceReplacement]=(await roleRace.json()).sent;
      await assertStatus(await change(invitee,{action:'accept_invite',id:raceReplacement.id}),200,'Accept the replacement after the race');
      acceptedRole='editor';
    }else{
      await assertStatus(roleRace,404,'Reject a role change when acceptance wins');
      await assertStatus(acceptRace,200,'Accept the original invitation before it can be replaced');
    }
    const [raceGrant]=(await listing(invitee)).shared;
    assert.equal(raceGrant.role,acceptedRole);
    assert.deepEqual((await listing(headers)).sent,[]);
    await assertStatus(await change(headers,{action:'revoke',id:raceGrant.grantId}),200,'Revoke the grant from the race fixture');

    const [declinable]=(await (await invite()).json()).sent;
    await assertStatus(await decline({},declinable.id),401,'Require sign-in to decline an invitation');
    await assertStatus(await decline(headers,declinable.id),404,'Only the recipient can decline, including when the owner knows the link');
    await assertStatus(await decline(other,declinable.id),404,'Reject decline by another account');
    assert.deepEqual((await listing(headers)).sent,[declinable]);
    const declineCalls=[];
    const sendDecline=requestFor(invitee,declineCalls);
    const uncertain=await declineReviewedWorkspaceInvitation(async(path,init)=>{
      const response=await sendDecline(path,init);
      if(init.method==='POST'){
        await assertStatus(response,200,'Recipient decline reached the server');
        await response.body?.cancel();
        throw TypeError('Fictional connection lost after decline');
      }
      return response;
    },declinable.id);
    assert.equal(uncertain.status,'unconfirmed');
    assert.deepEqual(declineCalls,[['POST',null],['GET','no-store']]);
    assert.deepEqual((await listing(headers)).sent,[]);
    assert.deepEqual((await listing(invitee)).incoming,[]);
    assert.deepEqual((await listing(invitee)).shared,[]);
    await assertStatus(await decline(invitee,declinable.id),404,'Reject a duplicate decline');
    await assertStatus(await change(invitee,{action:'accept_invite',id:declinable.id}),404,'Reject a declined invitation');
    assert.match(await (await request('/?invitation='+declinable.id,{headers:invitee})).text(),/Invitation unavailable/);

    const [responseRace]=(await (await invite()).json()).sent;
    const replies=await Promise.all([
      decline(invitee,responseRace.id),
      change(invitee,{action:'accept_invite',id:responseRace.id}),
    ]);
    assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,404]);
    assert.deepEqual((await listing(headers)).sent,[]);
    const responseGrants=(await listing(invitee)).shared;
    assert.equal(responseGrants.length,replies[1].status===200?1:0);
    if(responseGrants.length)await assertStatus(await change(headers,{action:'revoke',id:responseGrants[0].grantId}),200,'Revoke the accepted grant from the response race');

    const [expired]=(await (await invite()).json()).sent;
    await sql`UPDATE portable_workspace_invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.id}`;
    await assertStatus(await changeRole(expired.id,'editor'),404,'Reject a role change on an expired invitation');
    await assertStatus(await decline(invitee,expired.id),404,'Reject decline of an expired invitation');
    assert.deepEqual((await listing(invitee)).incoming,[]);
    assert.match(await (await request('/?invitation='+expired.id,{headers:invitee})).text(),/Invitation unavailable/);
    await assertStatus(await change(invitee,{action:'accept_invite',id:expired.id}),404,'Workspace change accept_invite');
    const [renewed]=(await (await invite()).json()).sent;
    assert.notEqual(renewed.id,expired.id);
    await assertStatus(await change(headers,{action:'cancel_invite',id:expired.id}),404,'Workspace change cancel_invite');
    await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES('fixture-ambiguous-invite','fixture-ambiguous-invite',${email},0,0)`;
    try{
      assert.deepEqual((await listing(invitee)).incoming,[]);
      await assertStatus(await change(invitee,{action:'accept_invite',id:renewed.id}),404,'Workspace change accept_invite');
      await assertStatus(await decline(invitee,renewed.id),404,'Reject decline with an ambiguous recipient identity');
    }finally{await sql`DELETE FROM login_identities WHERE id='fixture-ambiguous-invite'`;}
    await assertStatus(await change(headers,{action:'cancel_invite',id:renewed.id}),200,'Workspace change cancel_invite');
    await assertStatus(await change(invitee,{action:'accept_invite',id:renewed.id}),404,'Workspace change accept_invite');
    const cancelledCalls=[];
    assert.equal((await acceptReviewedWorkspaceInvitation(requestFor(invitee,cancelledCalls),renewed.id,workspaceId,false)).status,'denied');
    assert.deepEqual(cancelledCalls,[['POST',null],['GET','no-store']]);

    await sql`INSERT INTO portable_workspace_invites(id,workspace_id,email,expires_at)
      SELECT gen_random_uuid(),${workspaceId},'capacity-'||seat||'@example.test',clock_timestamp()+interval '1 day'
      FROM generate_series(1,24) AS seat`;
    try{await assertStatus(await invite(),409,'Prepare invitation');}
    finally{await sql`DELETE FROM portable_workspace_invites WHERE workspace_id=${workspaceId} AND email LIKE 'capacity-%'`;}
    const [backupInvite]=(await (await invite()).json()).sent;
    return backupInvite.id;
  }finally{
    const logout=await request('/auth/logout',{method:'POST',headers:{...invitee,origin},body:new URLSearchParams({scope:'current'})});
    await assertStatus(logout,303,'Sign out the invitee');
  }
}
