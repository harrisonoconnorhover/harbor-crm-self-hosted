import assert from 'node:assert/strict';
import {verifyDirectorySchemas} from './portable-directory-schemas-fixture.mjs';
import {directoryGroupLifecycle} from './portable-directory-group-fixture.mjs';

async function withDirectoryPage(origin,cookie,check){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext();
    const [name,value]=cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=workspaces#team-directory');
    await check(page);
  }finally{await browser.close();}
}
async function verifyOwnerGroupControls(origin,cookie){
  await withDirectoryPage(origin,cookie,async page=>{
    async function openTeam(){
      await page.locator('summary').filter({hasText:/^Teams and pods/}).click();
      await page.getByRole('combobox',{name:/^Manage team/}).selectOption({label:'Manual support'});
    }
    await openTeam();
    const objectId=crypto.randomUUID();
    await page.getByLabel('Microsoft Entra group object ID').fill(objectId);
    await page.getByRole('button',{name:'Link directory group',exact:true}).click();
    await page.getByText(objectId,{exact:true}).waitFor();
    await page.reload();
    await openTeam();
    await page.getByText(objectId,{exact:true}).waitFor();
    await page.getByText('Unlink directory group…',{exact:true}).click();
    await page.getByRole('button',{name:'Unlink directory group',exact:true}).click();
    await page.getByLabel('Microsoft Entra group object ID').waitFor();
  });
}

export async function directoryLifecycle({request,json,login,sql,tenant,peerEmail,ownerCookie,secondOwner,employee,employeeObj,record,workspace,hasFiles,origin,assertLoginDenied}){
  const path='/scim/v2/Users',type='urn:ietf:params:scim:schemas:core:2.0:User';
  const enterprise='urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
  const employeeInput={schemas:[type],externalId:employeeObj,userName:employee,active:true};
  const entraCreate={...employeeInput,schemas:[type,enterprise],roles:[],
    name:{formatted:'Fictional employee'},emails:[{primary:true,type:'work',value:employee}],meta:{resourceType:'User'}};
  const createToken=async(cookie,objects,permission='read_write')=>{
    const response=await json('/api/api-tokens',{name:'Fictional directory rehearsal',...(objects[0]==='directory'?{purpose:'directory'}:{objects,permission}),days:30},cookie);
    assert.equal(response.status,201,await response.clone().text());
    return response.json();
  };
  const directory=async(token,method='GET',suffix='',body)=>request(path+suffix,{method,headers:{
    authorization:'Bearer '+token,'content-type':'application/scim+json'},body:body===undefined?undefined:JSON.stringify(body)});
  const grant=async(cookie,change)=>json('/api/workspaces',change,cookie);
  const state=async(cookie)=>(await request('/api/workspaces',{headers:{cookie}})).json();
  const activePatch=value=>({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'Replace',path:'active',value}]});
  const member=async()=>(await state(ownerCookie)).viewers.find(row=>row.email===employee);
  const read=(cookie,workspaceId,id)=>request('/api/crm?workspaceId='+workspaceId+'&id='+id,{headers:{cookie}});
  const token=await createToken(ownerCookie,['directory']);
  const second=await createToken(secondOwner,['directory']);
  const records=await createToken(ownerCookie,['contacts'],'read');
  await verifyDirectorySchemas(request,token.token,records.token);
  assert.equal((await directory(records.token)).status,403);
  assert.equal((await request('/api/v1/records/contacts',{headers:{authorization:'Bearer '+token.token}})).status,403);
  const legacy=await createToken(ownerCookie,['directory']);
  await sql`UPDATE portable_api_tokens SET scopes='["directory:manage"]'::jsonb WHERE id=${legacy.info.id}`;
  assert.equal((await directory(legacy.token)).status,403);
  assert.equal((await json('/api/api-tokens',{action:'revoke',id:legacy.info.id},ownerCookie)).status,200);
  const empty=await directory(token.token,'GET','?filter='+encodeURIComponent('userName eq "'+employee+'"'));
  assert.equal(empty.status,200,await empty.clone().text());
  assert.equal((await empty.json()).totalResults,0);
  assert.equal((await directory(token.token,'POST','',{...employeeInput,userName:'outsider@other.test'})).status,400);
  assert.equal((await directory(second.token,'POST','',employeeInput)).status,400);
  await sql`WITH employees AS (
    INSERT INTO login_identities(id,microsoft_subject,directory_authority,email,created_at,updated_at)
    SELECT gen_random_uuid()::text,${tenant}::text||':'||gen_random_uuid()::text,${workspace},
      'roster-'||n||'@fictional-company.example',0,0 FROM generate_series(1,149) n RETURNING id
  ), memberships AS (
    INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,view_scope,edit_scope)
    SELECT ${workspace},id,gen_random_uuid(),'viewer','owned','owned' FROM employees
  )
  INSERT INTO portable_directory_users(id,workspace_id,user_id) SELECT gen_random_uuid(),${workspace},id FROM employees`;
  // Converting a pending invite must also invalidate its original grant.
  const invitation=await grant(ownerCookie,{action:'invite',email:employee,role:'editor'});
  assert.equal(invitation.status,200);
  const oldInvite=(await invitation.json()).sent.find(row=>row.email===employee);
  for(const schemas of [[enterprise],[type,type],[type,enterprise+'-unknown']]){
    assert.equal((await directory(token.token,'POST','',{...employeeInput,schemas})).status,400);
  }
  const results=await Promise.all([directory(token.token,'POST','',entraCreate),directory(token.token,'POST','',{...entraCreate,schemas:[enterprise,type]})]);
  assert.deepEqual(results.map(value=>value.status).sort(),[201,409]);
  const created=await results.find(value=>value.status===201).json(),id='/'+created.id;
  assert.deepEqual(created.schemas,[type]);
  assert.equal(created.active,true);assert.equal(created.externalId,employeeObj);
  assert.equal((await directory(token.token,'POST','',{...employeeInput,externalId:crypto.randomUUID()})).status,409);
  const filtered=await directory(token.token,'GET','?filter='+encodeURIComponent('externalId eq "'+employeeObj+'"'));
  const list=await filtered.json();assert.equal(list.totalResults,1);assert.equal(list.Resources[0].id,created.id);
  const first=await (await directory(token.token,'GET','?count=150')).json();
  const next=await (await directory(token.token,'GET','?startIndex=101&count=100')).json();
  assert.deepEqual([first.totalResults,first.Resources.length,next.totalResults,next.Resources.length],[150,100,150,50]);
  const people=[...first.Resources,...next.Resources];
  const unknown=await (await directory(token.token,'GET',id+'?attributes=userName.value,roles.unknown')).json();
  assert.deepEqual(unknown,{schemas:[type],id:created.id});
  const compact=await (await directory(token.token,'GET','?startIndex=101&count=100&attributes=USERNAME,roles.value')).json();
  assert.equal(compact.totalResults,150);
  assert.deepEqual(compact.Resources,next.Resources.map(({schemas,id,userName,roles})=>({schemas,id,userName,roles})));
  assert.equal(new Set(people.map(person=>person.id)).size,150);
  assert.ok(people.every(person=>person.active));
  const overflow={...employeeInput,userName:'over-capacity@fictional-company.example',externalId:crypto.randomUUID()};
  const refused=await directory(token.token,'POST','',overflow);
  assert.equal(refused.status,409);
  assert.equal((await refused.json()).detail,'No seats available.');
  const absent=await directory(token.token,'GET','?filter='+encodeURIComponent('userName eq "'+overflow.userName+'"'));
  assert.equal((await absent.json()).totalResults,0);
  const departing=people.find(person=>person.userName==='roster-1@fictional-company.example');
  const departure={...activePatch(false),Operations:[{op:'Replace',value:{displayName:'Robin Trial',active:false}}]};
  const retired=await directory(token.token,'PATCH','/'+departing.id,departure);
  assert.equal(retired.status,200);
  const retiredUser=await retired.json();
  assert.deepEqual([retiredUser.displayName,retiredUser.active],['Robin Trial',false]);
  const roster=async(access,after,teamId,includeChildren=false)=>{
    const params=new URLSearchParams({directoryRoster:access});
    if(teamId)params.set('teamId',teamId);
    if(includeChildren)params.set('includeChildren','1');
    if(after)params.set('after',after);
    const res=await request('/api/workspaces?'+params,{headers:{cookie:ownerCookie}});
    assert.equal(res.status,200);return res.json();
  };
  const inactive=await roster('inactive');
  assert.deepEqual(inactive.employees.map(row=>row.id),[departing.id]);
  assert.equal(inactive.employees[0].memberId,undefined);
  assert.equal(inactive.employees[0].displayName,'Robin Trial');
  assert.equal(inactive.next,null);
  const expectedViewers=people.filter(person=>person.id!==departing.id).map(person=>person.id).sort();
  const viewerIds=[];
  let cursor;
  do{
    const page=await roster('viewer',cursor);
    assert.ok(page.employees.length>0&&page.employees.length<=25);
    viewerIds.push(...page.employees.map(row=>row.id));
    cursor=page.next;
    assert.ok(viewerIds.length<=expectedViewers.length);
  }while(cursor);
  assert.deepEqual(viewerIds,expectedViewers);
  if(process.env.HARBOR_TEST_DIRECTORY_UI==='true')await withDirectoryPage(origin,ownerCookie,async page=>{
    await page.getByText('Check company directory access',{exact:true}).click();
    await page.getByLabel('Find employees by').selectOption('viewer');
    await page.getByRole('button',{name:'Check access'}).click();
    const rosterPanel=page.locator('details.portable-access-direct').filter({has:page.getByLabel('Find employees by')}).getByRole('status');
    const firstEmail=people.find(person=>person.id===expectedViewers[0]).userName;
    await rosterPanel.getByText(firstEmail,{exact:true}).waitFor();
    await rosterPanel.getByRole('button',{name:'Next employees'}).click();
    await rosterPanel.getByText('Page 2',{exact:true}).waitFor();
    assert.equal(await rosterPanel.getByText(firstEmail,{exact:true}).count(),0);
    await rosterPanel.getByRole('button',{name:'Previous employees'}).click();
    await rosterPanel.getByText(firstEmail,{exact:true}).waitFor();
  });
  const filteredUsers=async(filter,params={},credential=token.token)=>{
    const res=await directory(credential,'GET','?'+new URLSearchParams({filter,...params}));
    assert.equal(res.status,200);return res.json();
  };
  assert.deepEqual((await filteredUsers('active eq false')).Resources.map(row=>row.id),[departing.id]);
  assert.equal((await filteredUsers('active eq false',{},second.token)).totalResults,0);
  const tail=await filteredUsers('roles.value eq "viewer"',{startIndex:'101'});
  assert.equal(tail.totalResults,149);
  assert.deepEqual(tail.Resources.map(row=>row.id),expectedViewers.slice(100));
  assert.equal((await filteredUsers('active eq true',{count:'0'})).totalResults,149);
  const invalid=await directory(token.token,'GET','?filter='+encodeURIComponent('active eq "false"'));
  assert.equal(invalid.status,400);
  assert.equal((await invalid.json()).scimType,'invalidFilter');
  assert.equal((await filteredUsers('roles.value eq "admin"')).totalResults,0);
  const claimSeat=name=>directory(token.token,'POST','',{...employeeInput,
    userName:'roster-'+name+'@fictional-company.example',externalId:crypto.randomUUID()});
  const claims=await Promise.all([claimSeat('east'),claimSeat('west')]);
  assert.deepEqual(claims.map(response=>response.status).sort(),[201,409]);
  assert.equal((await claims.find(response=>response.status===409).json()).detail,'No seats available.');
  assert.equal((await state(ownerCookie)).viewers.length,150);
  const teamId=crypto.randomUUID(),externalId=crypto.randomUUID();
  const teamMembers=expectedViewers.filter(id=>id!==created.id).slice(0,115);
  const division=crypto.randomUUID(),region=crypto.randomUUID(),sibling=crypto.randomUUID();
  for(const [id,name,parentId] of [[division,'Commercial',null],[region,'East',division],[sibling,'West',division],
    [teamId,'Fictional field sales',region]]){
    assert.equal((await grant(ownerCookie,{action:'team_create',id,name,parentId})).status,200);
  }
  assert.equal((await grant(ownerCookie,{action:'directory_group_map',teamId,externalId})).status,200);
  const pushed=await request('/scim/v2/Groups?attributes=id',{method:'POST',headers:{
    authorization:'Bearer '+token.token,'content-type':'application/scim+json'},body:JSON.stringify({
    schemas:['urn:ietf:params:scim:schemas:core:2.0:Group'],displayName:'Regional sales team',externalId,
    members:teamMembers.map(value=>({value}))})});
  assert.equal(pushed.status,201,await pushed.clone().text());
  const groupFilter='groups.value eq "'+(await pushed.json()).id+'"';
  const teamViewers='active eq true AND '+groupFilter+' and '+type+':roles.value eq "viewer"';
  assert.equal((await filteredUsers(teamViewers,{count:'0'})).totalResults,115);
  assert.equal((await filteredUsers(teamViewers,{},second.token)).totalResults,0);
  assert.equal((await filteredUsers('active eq true and active eq false')).totalResults,0);
  for(const badFilter of ['active eq true or active eq false','active eq true and','active eq true and ignored eq "x"','roles.value eq "admin" and nonsense']){
    const denied=await directory(token.token,'GET','?filter='+encodeURIComponent(badFilter));
    assert.equal(denied.status,400);assert.equal((await denied.json()).scimType,'invalidFilter');
  }
  const teamEditor=teamMembers[0];
  const promotion={schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'roles',value:[{value:'editor'}]}]};
  assert.equal((await directory(token.token,'PATCH','/'+teamEditor,promotion)).status,200);
  const remainingViewers=await filteredUsers(teamViewers,{startIndex:101,attributes:'id'});
  assert.equal(remainingViewers.totalResults,114);
  assert.deepEqual(remainingViewers.Resources.map(row=>row.id),teamMembers.slice(101));
  assert.deepEqual((await filteredUsers(groupFilter+' and roles.value eq "editor"')).Resources.map(row=>row.id),[teamEditor]);
  const teamPage=await roster('viewer',undefined,teamId);
  assert.deepEqual(teamPage.employees.map(row=>row.id),teamMembers.slice(1,26));
  assert.deepEqual((await roster('viewer',teamPage.next,teamId)).employees.map(row=>row.id),teamMembers.slice(26,51));
  assert.deepEqual((await roster('viewer',undefined,division)).employees,[]);
  assert.deepEqual((await roster('viewer',undefined,sibling,true)).employees,[]);
  const branchIds=[];
  let branchCursor;
  do{
    const branch=await roster('viewer',branchCursor,division,true);
    branchIds.push(...branch.employees.map(row=>row.id));
    branchCursor=branch.next;
    assert.ok(branchIds.length<=teamMembers.length);
  }while(branchCursor);
  assert.deepEqual(branchIds,teamMembers.slice(1));
  const foreignRoster=await request('/api/workspaces?directoryRoster=viewer&includeChildren=1&teamId='+division,{headers:{cookie:secondOwner}});
  assert.equal(foreignRoster.status,200);assert.deepEqual((await foreignRoster.json()).employees,[]);
  assert.ok((await roster('viewer',undefined,'unassigned')).employees.every(row=>row.team===null));
  if(process.env.HARBOR_TEST_DIRECTORY_UI==='true')await withDirectoryPage(origin,ownerCookie,async page=>{
    await page.getByText('Check company directory access',{exact:true}).click();
    await page.getByLabel('Find employees by').selectOption('editor');
    const accessPanel=page.locator('details.portable-access-direct').filter({has:page.getByLabel('Find employees by')});
    const primaryTeam=accessPanel.getByRole('combobox',{name:/^Primary team/});
    await primaryTeam.selectOption(teamId);
    await page.getByRole('button',{name:'Check access'}).click();
    const status=accessPanel.getByRole('status');
    await status.getByText(people.find(person=>person.id===teamEditor).userName,{exact:true}).waitFor();
    await primaryTeam.selectOption(division);
    await page.getByRole('button',{name:'Check access'}).click();
    await status.getByText('No matching directory employees on this page.').waitFor();
    await accessPanel.getByLabel('Include child teams').check();
    await page.getByRole('button',{name:'Check access'}).click();
    await status.getByText(people.find(person=>person.id===teamEditor).userName,{exact:true}).waitFor();
    await primaryTeam.selectOption('unassigned');
    assert.equal(await accessPanel.getByLabel('Include child teams').count(),0);
    await page.getByRole('button',{name:'Check access'}).click();
    await status.getByText('No matching directory employees on this page.').waitFor();
  });
  const moved=await grant(ownerCookie,{action:'team_edit',id:teamId,revision:1,name:'Fictional field sales',parentId:sibling});
  assert.equal(moved.status,200);
  assert.deepEqual((await roster('editor',undefined,region,true)).employees,[]);
  assert.deepEqual((await roster('editor',undefined,sibling,true)).employees.map(row=>row.id),[teamEditor]);
  for(const startIndex of [1,101]){
    const page=await filteredUsers(groupFilter,{startIndex,attributes:'id'});
    assert.equal(page.totalResults,115);
    assert.deepEqual(page.Resources.map(row=>row.id),teamMembers.slice(startIndex-1,startIndex+99));
  }
  assert.equal((await grant(ownerCookie,{action:'directory_group_unmap',teamId,externalId})).status,200);
  assert.equal((await filteredUsers(groupFilter)).totalResults,0);
  assert.equal((await filteredUsers(teamViewers)).totalResults,0);
  // Release the fictional seats before the remaining role and team membership checks.
  await sql`DELETE FROM login_identities WHERE directory_authority=${workspace} AND email LIKE 'roster-%@fictional-company.example'`;
  const rep=await login('microsoft',{oid:employeeObj,preferred_username:'untrusted@example.test'});
  assert.ok((await grant(rep,{action:'accept_invite',id:oldInvite.id})).status>=400);
  assert.equal((await member()).role,'viewer');assert.equal((await member()).viewScope,'owned');
  const lookup=async()=>{const response=await grant(ownerCookie,{action:'lookup_directory_employee',email:employee});
    assert.equal(response.status,200);return (await response.json()).employees;};
  const [directoryEntry]=await lookup();
  const directoryActor=(await member()).actorId;
  assert.ok(directoryActor);
  assert.deepEqual(directoryEntry,{actorId:directoryActor,provider:'Microsoft Entra ID',team:null,memberId:(await member()).id,role:'viewer'});
  const accessPage='/?view=settings&section=properties&member='+directoryEntry.memberId;
  assert.equal((await request(accessPage,{headers:{cookie:ownerCookie}})).status,200);
  assert.equal((await grant(ownerCookie,{action:'record_scope',id:(await member()).id,viewScope:'all',editScope:'all'})).status,200);
  const rolePatch=value=>({...activePatch(true),Operations:[{op:'replace',path:'roles',value:[{value}]}]});
  assert.equal((await directory(token.token,'PATCH',id,rolePatch('admin'))).status,400);
  for(const query of ['attributes=roles&excludedAttributes=groups','attributes=roles&attributes=userName','attributes=roles,,active']){
    assert.equal((await directory(token.token,'PATCH',id+'?'+query,rolePatch('editor'))).status,400);
    assert.equal((await member()).role,'viewer');
  }
  const updated=await directory(token.token,'PATCH',id+'?attributes='+type+':roles.VALUE',rolePatch('editor'));
  assert.equal(updated.status,200);
  assert.deepEqual(await updated.json(),{schemas:[type],id:created.id,roles:[{value:'editor'}]});
  assert.deepEqual((await roster('editor')).employees.map(row=>row.id),[created.id]);
  assert.deepEqual((await filteredUsers('roles.value eq "editor"')).Resources.map(row=>row.id),[created.id]);
  const clear={...rolePatch('editor'),Operations:[{op:'Replace',value:{roles:[]}}]};
  const cleared=await directory(token.token,'PATCH',id,clear);
  assert.equal(cleared.status,200);
  assert.deepEqual((await cleared.json()).roles,[{value:'viewer'}]);
  assert.equal((await member()).role,'viewer');
  assert.equal((await directory(token.token,'PATCH',id,rolePatch('editor'))).status,200);
  const promoted=await member();
  assert.deepEqual([promoted.role,promoted.viewScope,promoted.editScope],['editor','all','owned']);
  const edit=await json('/api/crm?workspaceId='+workspace+'&grantId='+promoted.id,
    {action:'save',kind:'contacts',id:record.id,expectedRevision:record.revision,data:{name:'Directory scope check'}},rep);
  assert.ok([403,404].includes(edit.status),String(edit.status));
  assert.equal((await read(rep,workspace,record.id)).status,200);
  const peerRecord=await json('/api/crm',{action:'save',kind:'contacts',data:{name:'Second company contact'}},secondOwner);
  assert.equal(peerRecord.status,201);const peer=(await peerRecord.json()).record.id;
  const secondInvite=await grant(secondOwner,{action:'invite',email:employee,role:'viewer'});
  const invite=(await secondInvite.json()).sent.find(row=>row.email===employee);
  assert.equal((await grant(rep,{action:'accept_invite',id:invite.id})).status,200);
  const peerWorkspace=(await state(secondOwner)).owned;
  assert.equal((await directory(second.token,'PATCH',id,activePatch(false))).status,404);
  let fileLink;
  if(hasFiles){
    const fileId=crypto.randomUUID(),versionId=crypto.randomUUID(),bytes='Fictional rep attachment';
    const endpoint='/api/record-attachments?recordId='+record.id+'&fileId='+fileId;
    const upload=await request(endpoint+'&versionId='+versionId,{method:'POST',headers:{cookie:ownerCookie,origin,'x-harbor-file-name':'trial.txt'},body:bytes});
    assert.equal(upload.status,200,await upload.clone().text());
    assert.equal((await grant(ownerCookie,{action:'contact_files',id:(await member()).id,enabled:true})).status,200);
    fileLink=endpoint+'&workspaceId='+workspace;
    const attachment=await request(fileLink,{headers:{cookie:rep}});
    assert.equal(attachment.status,200);assert.equal(await attachment.text(),bytes);
  }
  const groupLifecycle=await directoryGroupLifecycle({request,json,sql,ownerCookie,secondOwner,rep,member,state,read,workspace,
    peerEmail,employee,userId:created.id,token:token.token,foreignToken:second.token,recordToken:records.token});
  // Directory deactivation releases only this organization's conversations.
  const claimForEmployee=async(scope,manager)=>{
    const membership=async()=>(await state(manager)).viewers.find(row=>row.email===employee);
    if((await membership()).role!=='editor'){
      assert.equal((await grant(manager,{action:'role',id:(await membership()).id,role:'editor'})).status,200);
    }
    assert.equal((await grant(manager,{action:'record_scope',id:(await membership()).id,viewScope:'all',editScope:'all'})).status,200);
    const threadId=crypto.randomUUID();
    await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject)
      VALUES (${scope},${threadId},'support@example.test','customer@example.test','Directory claim')`;
    const response=await json('/api/team-inbox?workspaceId='+scope+'&grantId='+(await membership()).id,
      {action:'claim',revision:1,id:threadId},rep);
    assert.equal(response.status,200,await response.clone().text());
    return threadId;
  };
  const claim=await claimForEmployee(workspace,ownerCookie),peerClaim=await claimForEmployee(peerWorkspace,secondOwner);
  const [{id:repId}]=await sql`SELECT id FROM login_identities WHERE email=${employee}`;
  const lead=await json('/api/leads',{action:'save',assigneeId:repId,data:{name:'Directory departure handoff'}},ownerCookie);
  assert.equal(lead.status,201);
  const leadId=(await lead.json()).id;
  const handoffs=async()=>(await (await request('/api/leads?owner=needs-routing&search=Directory+departure',
    {headers:{cookie:ownerCookie}})).json()).records.map(row=>row.id);
  assert.deepEqual(await handoffs(),[]);
  const current=await member();
  assert.equal((await grant(ownerCookie,{action:'backup_admin',id:current.id,enabled:true})).status,200);
  assert.equal((await roster('editor')).employees.find(row=>row.id===created.id).backupAdmin,true);
  for(const value of ['False',false])assert.equal((await directory(token.token,'PATCH',id,activePatch(value))).status,200);
  assert.equal(await member(),undefined);
  assert.deepEqual(await handoffs(),[leadId]);
  const queue=async(params,cookie)=>{
    const response=await request('/api/team-inbox?'+params,{headers:{cookie}});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).items;
  };
  assert.ok((await queue('claim=unclaimed',ownerCookie)).some(row=>row.id===claim&&row.revision===3));
  assert.ok((await queue('workspaceId='+peerWorkspace+'&claim=mine',rep)).some(row=>row.id===peerClaim&&row.revision===2));
  assert.equal((await request('/api/team-inbox?id='+claim+'&workspaceId='+workspace,{headers:{cookie:rep}})).status,403);
  await groupLifecycle.checkInactive();
  if(fileLink)assert.equal((await request(fileLink,{headers:{cookie:rep}})).status,403);
  assert.ok([403,404].includes((await read(rep,workspace,record.id)).status));
  assert.ok([403,404].includes((await json('/api/crm?workspaceId='+workspace+'&grantId='+current.id,
    {action:'save',kind:'contacts',data:{name:'Stale session edit'}},rep)).status));
  assert.equal((await read(rep,peerWorkspace,peer)).status,200);
  assert.equal((await grant(ownerCookie,{action:'invite',email:employee,role:'editor'})).status,409);
  assert.equal((await (await directory(token.token,'GET',id)).json()).active,false);
  assert.deepEqual(await lookup(),[{actorId:directoryActor,provider:'Microsoft Entra ID',team:null,role:null}]);
  assert.equal((await request(accessPage,{headers:{cookie:ownerCookie}})).status,404);
  const restored=await directory(token.token,'PATCH',id,activePatch('True'));
  assert.equal(restored.status,200);assert.equal((await restored.json()).id,created.id);
  const newGrant=await member();
  assert.notEqual(newGrant.id,current.id);assert.equal(newGrant.role,'viewer');assert.equal(newGrant.viewScope,'owned');
  assert.ok(!(await roster('inactive')).employees.some(row=>row.id===created.id));
  assert.equal((await roster('viewer')).employees.find(row=>row.id===created.id).memberId,newGrant.id);
  await groupLifecycle.checkReactivated();
  assert.equal((await directory(token.token,'DELETE',id)).status,204);
  assert.equal((await directory(token.token,'GET',id)).status,404);
  assert.equal((await read(rep,peerWorkspace,peer)).status,200);
  const independent=await login('microsoft',{oid:employeeObj});
  assert.equal((await read(independent,peerWorkspace,peer)).status,200);
  const lastGrant=(await state(secondOwner)).viewers.find(row=>row.email===employee);
  assert.equal((await grant(secondOwner,{action:'revoke',id:lastGrant.id})).status,200);
  for(const cookie of [rep,independent]){
    assert.equal((await request('/api/workspaces',{headers:{cookie}})).status,401);
    assert.equal((await json('/api/crm',{action:'save',kind:'contacts',data:{name:'Fictional denied private record'}},cookie)).status,401);
  }
  await assertLoginDenied();
  if(process.env.HARBOR_TEST_DIRECTORY_UI==='true')await verifyOwnerGroupControls(origin,ownerCookie);
  assert.equal((await json('/api/api-tokens',{action:'revoke',id:token.info.id},ownerCookie)).status,200);
  assert.equal((await directory(token.token)).status,401);
}
