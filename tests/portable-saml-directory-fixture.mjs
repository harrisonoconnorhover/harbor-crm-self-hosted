import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
import {randomUUID} from 'node:crypto';

export async function samlDirectoryLifecycle({request,json,get,checked,sql,env,startWeb,saml,expectReturn,disabled,google,
  ownerCookie,secondOwner,workspace,peerWorkspace,contact,peerContact,linkedFile,owner,employeeId}){
  const domain='fictional-directory.example',email='casey@'+domain,subject='Division:Sales and Support/Casey-01';
  const core='urn:ietf:params:scim:schemas:core:2.0:User',base='/scim/v2',users=base+'/Users',tokenPath='/api/api-tokens';
  const entraSubject=randomUUID(),entraEmail='entra@'+domain;
  Object.assign(env,{HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID:workspace,HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN:domain,
    HARBOR_LOGIN_MICROSOFT_TENANT_ID:randomUUID(),HARBOR_LOGIN_MICROSOFT_CLIENT_ID:randomUUID(),
    HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET:'fictional-entra-app',HARBOR_LOGIN_MICROSOFT_BINDINGS:JSON.stringify({[entraSubject]:entraEmail})});
  await startWeb();
  assert.ok(!Object.hasOwn(JSON.parse(env.HARBOR_LOGIN_SAML_BINDINGS),subject));

  const token=async(options,cookie=ownerCookie)=>(await checked(json(tokenPath,cookie,
    {name:'Fictional employee directory',days:30,...options}),201));
  const directory=await token({purpose:'saml_directory'}),entra=await token({purpose:'directory'});
  const records=await token({objects:['contacts'],permission:'read'});
  const api=(credential,path,method='GET',body)=>request(path,{method,
    headers:{authorization:'Bearer '+credential,'content-type':'application/scim+json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const scim=(path,method,body)=>api(directory.token,path,method,body);
  const list=(field,value)=>users+'?filter='+encodeURIComponent(field+' eq "'+value+'"');
  const create={schemas:[core],userName:email,externalId:subject,active:true};
  const patch=(path,value)=>({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'Replace',path,value}]});
  const state=()=>checked(get('/api/workspaces',ownerCookie));
  const memberships=async()=>(await state()).viewers.filter(row=>row.email===email);
  const lookupEmployee=(cookie=ownerCookie,address=email)=>json('/api/workspaces',cookie,{action:'lookup_directory_employee',email:address});
  const matches=async()=> (await checked(lookupEmployee(ownerCookie,email.toUpperCase()))).employees;
  assert.deepEqual(await matches(),[]);
  const previewPath=id=>'/?view=settings&section=properties&member='+id;
  async function currentPreview(){
    const [match]=await matches();
    const response=await get(previewPath(match.memberId),ownerCookie);
    assert.equal(response.status,200);
    return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replaceAll('<!-- -->','');
  }
  const initial=await state();
  assert.equal(initial.viewers.some(row=>row.email===email),false);
  assert.equal(initial.sent.some(row=>row.email===email),false);
  disabled(await (await saml(subject))());
  await checked(api(records.token,users),403);
  await checked(api(directory.token,'/api/v1/records/contacts'),403);
  const groups=base+'/Groups',groupCore='urn:ietf:params:scim:schemas:core:2.0:Group';
  assert.equal((await checked(scim(groups))).totalResults,0);
  const schemas=await checked(scim(base+'/Schemas'));
  assert.deepEqual(schemas.Resources.map(row=>row.id),[core,groupCore]);
  assert.equal(schemas.Resources[0].attributes.find(field=>field.name==='externalId').required,true);
  assert.equal(schemas.Resources[1].attributes.find(field=>field.name==='externalId').required,false);
  const discovery=await checked(scim(base+'/ServiceProviderConfig'));
  assert.equal(discovery.patch.supported,true);
  assert.equal(discovery.bulk.supported,false);
  const supported=await checked(scim(base+'/ResourceTypes'));
  assert.deepEqual(supported.Resources.map(item=>item.name),['User','Group']);
  assert.equal((await checked(scim(base+'/ResourceTypes/User'))).endpoint,'/Users');
  assert.equal((await checked(scim(base+'/ResourceTypes/Group'))).endpoint,'/Groups');
  const denied=async call=>{
    const r=await call;
    assert.ok([400,403,409].includes(r.status),'Expected a directory policy rejection; got '+r.status);
  };
  await denied(scim(users,'POST',{...create,userName:'casey@other.example'}));
  await denied(scim(users,'POST',{...create,userName:owner}));
  await denied(scim(users,'POST',{...create,externalId:employeeId}));
  await denied(scim(users,'POST',{...create,userName:entraEmail}));
  // Okta's custom-app create includes a password placeholder even with password sync off.
  const profile={name:{givenName:'Casey',familyName:'Trial'},displayName:'Casey Trial',locale:'en-US',
    emails:[{value:email,type:'work',primary:true}],groups:[]};
  const onboarding={...create,...profile,password:'fictional-ignored-placeholder'};
  await denied(scim(users,'POST',{...onboarding,externalId:undefined}));
  const [left,right]=await Promise.all([scim(users,'POST',onboarding),scim(users,'POST',onboarding)]);
  assert.deepEqual([left.status,right.status].sort(),[201,409]);
  const employee=await (left.status===201?left:right).json(),path=users+'/'+employee.id;
  assert.deepEqual([employee.externalId,employee.userName,employee.roles],[subject,email,[{value:'viewer'}]]);
  assert.equal(employee.displayName,profile.displayName);
  for(const field of ['externalId',core.toUpperCase()+':EXTERNALID']){
    const found=await checked(scim(list(field,subject)));
    assert.deepEqual(found.Resources.map(row=>row.id),[employee.id]);
    assert.equal((await checked(scim(list(field,subject.toLowerCase())))).totalResults,0);
  }
  const searchPath=users+'/.search',searchRequest={schemas:['urn:ietf:params:scim:api:messages:2.0:SearchRequest'],
    filter:'active eq true AnD '+core+':externalId eq "'+subject+'"',attributes:['userName','roles.value'],startIndex:1,count:10};
  const expected=await checked(scim(users+'?'+new URLSearchParams({filter:searchRequest.filter,attributes:'userName,roles.value',count:'10'})));
  assert.deepEqual(await checked(scim(searchPath,'POST',searchRequest)),expected);
  assert.equal(expected.Resources[0].id,employee.id);
  assert.deepEqual(Object.keys(expected.Resources[0]).sort(),['id','roles','schemas','userName']);
  assert.equal((await checked(scim(searchPath,'POST',{...searchRequest,filter:core+':externalId eq "'+subject.toLowerCase()+'"'}))).totalResults,0);
  await checked(api(records.token,searchPath,'POST',searchRequest),403);
  await checked(scim(searchPath,'GET'),405);
  for(const invalid of [create,{...searchRequest,excludedAttributes:['roles']},{...searchRequest,attributes:['userName,roles']}]){
    await checked(scim(searchPath,'POST',invalid),400);
  }
  await checked(scim(list(groupCore+':externalId',subject)),400);
  assert.deepEqual(await checked(scim(path+'?attributes=displayName')),{schemas:[core],id:employee.id,displayName:profile.displayName});
  assert.ok(!Object.hasOwn(employee,'password'));
  assert.ok(!JSON.stringify(await checked(scim(path))).includes(onboarding.password));
  const profileUpdate={schemas:[core],userName:email,id:employee.id,...profile,meta:{resourceType:'User'}};
  await denied(scim(path,'PUT',{...profileUpdate,userName:'different@'+domain}));
  await denied(scim(path,'PUT',{...profileUpdate,id:randomUUID()}));
  const replaced=await checked(scim(path,'PUT',{...create,id:employee.id,roles:[{value:'viewer'}]}));
  assert.equal(replaced.id,employee.id);
  assert.equal(replaced.displayName,profile.displayName,'An omitted display name keeps the saved value.');
  const removeName={...patch('displayName',null),Operations:[{op:'remove',path:core+':displayName'}]};
  for(let i=0;i<2;i++)assert.equal((await checked(scim(path,'PATCH',removeName))).displayName,undefined);
  assert.equal((await checked(scim(path,'PATCH',{...removeName,Operations:[{op:'add',path:'displayName',value:'Casey West'}]}))).displayName,'Casey West');
  await checked(scim(path,'PUT',{...profileUpdate,roles:[{value:'editor'}]}));
  const employeeActor=(await memberships())[0].actorId;
  assert.ok(employeeActor);
  assert.deepEqual(await matches(),[{actorId:employeeActor,displayName:profile.displayName,provider:'Company SSO',memberId:(await memberships())[0].id,role:'editor',team:null}]);
  const cleared=await checked(scim(path,'PUT',{...profileUpdate,roles:[]}));
  assert.deepEqual(cleared.roles,[{value:'viewer'}]);
  await denied(scim(path,'PUT',{...create,externalId:subject+'-retired'}));
  assert.equal((await memberships()).length,1);
  assert.equal((await state()).viewers.length,initial.viewers.length+1);
  assert.equal((await state()).sent.some(row=>row.email===email),false);
  assert.deepEqual((await checked(scim(list('externalId',subject)))).Resources.map(row=>row.id),[employee.id]);
  assert.equal((await checked(scim(list('externalId',subject.toLowerCase())))).totalResults,0);
  assert.deepEqual((await checked(scim(list('userName',email.toUpperCase())))).Resources.map(row=>row.id),[employee.id]);
  assert.deepEqual(employee.groups,[]);
  const firstTenant=env.HARBOR_LOGIN_MICROSOFT_TENANT_ID;
  env.HARBOR_LOGIN_MICROSOFT_TENANT_ID=randomUUID();
  await startWeb();
  await checked(api(entra.token,users),403);
  await checked(api(entra.token,base+'/Groups'),403);
  const nextTenantToken=await token({purpose:'directory'});
  assert.equal((await checked(api(nextTenantToken.token,users))).totalResults,0);
  assert.equal((await checked(scim(path))).id,employee.id);
  env.HARBOR_LOGIN_MICROSOFT_TENANT_ID=firstTenant;
  await startWeb();
  await checked(api(nextTenantToken.token,users),403);
  const originalIssuer=env.HARBOR_LOGIN_SAML_ISSUER;
  env.HARBOR_LOGIN_SAML_ISSUER=originalIssuer+'/replacement';
  await startWeb();
  await checked(scim(path),403);
  assert.equal((await get('/api/workspaces',ownerCookie)).status,401);
  env.HARBOR_LOGIN_SAML_ISSUER=originalIssuer;
  await startWeb();
  assert.equal((await checked(scim(path))).id,employee.id);
  assert.equal((await checked(api(entra.token,users))).totalResults,0);
  await checked(api(entra.token,path),404);
  await checked(api(entra.token,path,'PATCH',patch('active',false)),404);
  const entraUser=await checked(api(entra.token,users,'POST',{...create,userName:entraEmail,externalId:entraSubject}),201);
  await checked(scim(users+'/'+entraUser.id),404);

  disabled(await (await saml(subject.toLowerCase()))());
  disabled(await google(email));
  const rep=expectReturn(await (await saml(subject))());
  await checked(lookupEmployee(rep),403);
  const roster='/api/workspaces?directoryRoster=viewer';
  await checked(get(roster,rep),403);
  await checked(get(roster+'&workspaceId='+workspace,secondOwner),400);
  assert.deepEqual((await checked(get(roster,secondOwner))).employees,[]);
  const activeList=users+'?filter='+encodeURIComponent('active eq true');
  assert.deepEqual((await checked(scim(activeList))).Resources.map(row=>row.id),[employee.id]);
  assert.deepEqual((await checked(api(entra.token,activeList))).Resources.map(row=>row.id),[entraUser.id]);
  assert.deepEqual((await checked(lookupEmployee(secondOwner))).employees,[]);
  const joined=await checked(get('/api/workspaces',rep));
  assert.ok(joined.shared.some(row=>row.id===workspace));
  assert.equal(joined.samlGroupMappings,undefined);
  const [first]=await memberships();
  assert.deepEqual([first.role,first.viewScope],['viewer','owned']);
  const manage=body=>checked(json('/api/workspaces',ownerCookie,body));
  const sales=randomUUID(),support=randomUUID();
  const salesName='Harbor Sales',supportName='Harbor Support';
  for(const [id,name] of [[sales,salesName],[support,supportName]])await manage({action:'team_create',id,name,parentId:null});
  const pod=randomUUID(),podName='Enterprise reps';
  await manage({action:'team_create',id:pod,name:podName,parentId:sales});
  const salesGroup={schemas:[groupCore],displayName:salesName,members:[]};
  const supportGroup={schemas:[groupCore],displayName:supportName,externalId:'Group:Support/07'};
  await checked(scim(groups,'POST',salesGroup),403);
  await manage({action:'saml_group_map',teamId:sales,groupName:salesName});
  await manage({action:'saml_group_map',teamId:support,groupName:supportName});
  const pin={action:'saml_group_map',teamId:support,groupName:supportName,expectedExternalId:supportGroup.externalId};
  await manage(pin);
  await manage(pin);
  const pendingMapping=(await state()).samlGroupMappings.find(row=>row.teamId===support);
  assert.equal(pendingMapping.directoryId,supportGroup.externalId);
  assert.equal(pendingMapping.groupId,null);
  await checked(json('/api/workspaces',ownerCookie,{...pin,expectedExternalId:'Replacement'}),409);
  await checked(json('/api/workspaces',ownerCookie,{...pin,teamId:sales,groupName:salesName}),409);
  for(const externalId of [undefined,'Group:Support/08',supportGroup.externalId.toUpperCase()]){
    await checked(scim(groups,'POST',{...supportGroup,externalId,displayName:supportName.toUpperCase(),members:[{value:employee.id}]}),403);
  }
  assert.equal((await state()).viewers.find(m=>m.email===email).teamId,null);
  await checked(json('/api/workspaces',ownerCookie,{action:'saml_group_map',teamId:support,groupName:salesName}),409);
  await checked(scim(groups,'POST',{...salesGroup,members:[{value:entraUser.id}]}),400);
  assert.equal((await checked(scim(groups))).totalResults,0);
  const pushed=await checked(scim(groups,'POST',salesGroup),201),salesPath=groups+'/'+pushed.id;
  assert.equal(pushed.externalId,undefined);
  const otherGroup=await checked(scim(groups,'POST',supportGroup),201),supportPath=groups+'/'+otherGroup.id;
  const lookup=async(field,v)=>(await checked(scim(groups+'?filter='+encodeURIComponent(field+' eq "'+v+'"')))).Resources.map(row=>row.id);
  assert.deepEqual(await lookup('displayName',salesName.toUpperCase()),[pushed.id]);
  assert.deepEqual(await lookup('externalId',supportGroup.externalId),[otherGroup.id]);
  assert.deepEqual(await lookup('externalId',supportGroup.externalId.toUpperCase()),[]);
  const mapped=(await state()).samlGroupMappings.find(row=>row.teamId===support);
  assert.equal(mapped.groupName,supportName);
  assert.equal(mapped.groupId,otherGroup.id);
  assert.equal(mapped.directoryId,supportGroup.externalId);
  const peerToken=await token({purpose:'saml_directory'},secondOwner);
  for(const credential of [peerToken.token,entra.token]){
    await checked(api(credential,salesPath),404);
    await checked(api(credential,salesPath,'PATCH',patch('members',[])),404);
  }
  await checked(scim(salesPath,'PATCH',patch('members',[{value:entraUser.id}])),400);
  await checked(scim(salesPath,'PUT',{...pushed,displayName:supportName}),409);
  await checked(scim(supportPath,'PUT',{...otherGroup,externalId:'replacement'}),400);
  const renameGroup=(id,displayName)=>({...patch('displayName',displayName),Operations:[{op:'replace',value:{id,[groupCore+':displayName']:displayName}}]});
  assert.equal((await checked(scim(salesPath,'PATCH',renameGroup(otherGroup.id,'Wrong group')),400)).scimType,'mutability');
  const conflicting=renameGroup(pushed.id,'Proposed name');
  conflicting.Operations[0].value.displayName='Another name';
  assert.equal((await checked(scim(salesPath,'PATCH',conflicting),400)).scimType,'invalidPath');
  assert.equal((await checked(scim(salesPath))).displayName,salesName);
  const renamed=await checked(scim(salesPath,'PATCH',renameGroup(pushed.id,'North America Sales')));
  assert.equal(renamed.id,pushed.id);
  await checked(api(entra.token,users+'/'+entraUser.id,'PATCH',patch('roles',[{value:'editor'}])));
  const colleague=(await state()).viewers.find(member=>member.email===entraEmail);
  await manage({action:'team_assign',id:colleague.id,teamId:pod,previousTeamId:null});
  const [identity]=await sql`SELECT id FROM login_identities WHERE email=${entraEmail}`;
  await checked(json('/api/custom-properties',ownerCookie,{action:'standardAccess',kind:'contacts',id:'department',audience:'owner',expectedRevision:0}));
  const {record}=await checked(json('/api/crm',ownerCookie,{action:'save',kind:'contacts',assigneeId:identity.id,
    data:{name:'Sales team handover',department:'Partner renewals'}}),201);
  assert.equal(record.data.department,'Partner renewals');
  const colleagueContact='/api/crm?workspaceId='+workspace+'&kind=contacts&id='+record.id;
  const selfSettings='/?view=settings&workspaceId='+workspace;
  async function currentAccess(team,view,create,edit,remove){
    const response=await get(selfSettings,rep);
    assert.equal(response.status,200);
    const html=(await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replaceAll('<!-- -->','');
    assert.ok(html.includes('<dt>Primary team</dt><dd>'+team+'</dd>'),team);
    assert.ok(html.includes('<th scope="row">Contacts</th>'+[view,create,edit,remove].map(cell=>'<td>'+cell+'</td>').join('')),view);
    assert.ok(!html.includes('Partner renewals'));
    return html;
  }
  const findContact=async()=>(await checked(json('/api/crm/search?workspaceId='+workspace,rep,{kind:'contacts',query:record.data.name}))).total;
  const salesFileId=randomUUID(),salesFile='/api/record-attachments?recordId='+record.id+'&fileId='+salesFileId;
  const teamFile=salesFile+'&workspaceId='+workspace,fileBytes='Fictional Sales handover';
  await checked(request(salesFile+'&versionId='+randomUUID(),{method:'POST',
    headers:{cookie:ownerCookie,origin:env.HARBOR_LOGIN_ORIGIN,'x-harbor-file-name':'handover.txt'},body:fileBytes}));
  await manage({action:'contact_files',id:first.id,enabled:true});
  await manage({action:'record_scope',id:(await memberships())[0].id,viewScope:'team',editScope:'owned'});
  assert.equal((await get(colleagueContact,rep)).status,404);
  await currentAccess('No team','Your own records','No','None','None');
  assert.match(await currentPreview(),/<dt>Default view scope<\/dt><dd>Their own records<\/dd>/);
  const assign=patch('members',[{value:employee.id}]);
  for(let i=0;i<2;i++)await checked(scim(salesPath,'PUT',{schemas:[groupCore],displayName:renamed.displayName,members:[{value:employee.id,display:email}]}));
  const rosterPath='/api/workspaces?'+new URLSearchParams({view:'teammate-access',export:'csv',workspaceId:workspace});
  const download=await get(rosterPath,ownerCookie);
  assert.equal(download.status,200);
  const {parseCSV}=await tsImport('../lib/csv-import.ts',import.meta.url);
  const sheet=parseCSV(await download.text());
  const setting=(address,column)=>sheet.rows.find(row=>row[sheet.headers.indexOf('Email')]===address)?.[sheet.headers.indexOf(column)];
  assert.equal(setting(email,'Membership source'),'Company directory');
  assert.equal(setting(email,'Directory manages primary team'),'Yes');
  assert.equal(setting(entraEmail,'Membership source'),'Company directory');
  assert.equal(setting(entraEmail,'Directory manages primary team'),'No');
  const permitted=await checked(get(colleagueContact,rep));
  assert.equal(permitted.data.name,record.data.name);
  assert.equal(permitted.data.department,undefined);
  await currentAccess(salesName,'Your team and child teams','No','None','None');
  assert.equal(await findContact(),1);
  assert.equal((await get('/api/crm?kind=contacts&export=csv&workspaceId='+workspace,rep)).status,403);
  const allowedFile=await get(teamFile,rep);
  assert.equal(allowedFile.status,200);
  assert.equal(await allowedFile.text(),fileBytes);
  const teamPreview=await currentPreview();
  for(const [label,value] of [['Primary team',salesName],['Default view scope','Their team and child teams'],['Default edit scope','View only'],['Department','Hidden']])
    assert.ok(teamPreview.includes('<dt>'+label+'</dt><dd>'+value+'</dd>'),label);
  assert.ok(!teamPreview.includes('Partner renewals'));
  const branch=label=>'<li>'+label+'</li>';
  async function checkBranch(includesPod){
    const ownerView=await currentPreview();
    const memberView=await currentAccess(salesName,'Your team and child teams','No','None','None');
    for(const html of [ownerView,memberView]){
      assert.ok(html.includes(branch(salesName)));
      assert.equal(html.includes(branch(salesName+' / '+podName)),includesPod);
      assert.ok(!html.includes(branch(supportName+' / '+podName)));
      assert.ok(html.includes('<th scope="row">Tickets</th>'));
      assert.ok(html.includes('<th scope="row">Custom objects</th>'));
    }
    assert.ok(ownerView.includes('<th scope="row">Contacts</th><td>Their team and child teams</td><td>No</td><td>None</td><td>None</td>'));
  }
  await checkBranch(true);
  await manage({action:'team_edit',id:pod,name:podName,parentId:support,revision:1});
  await checkBranch(false);
  assert.equal(await findContact(),0);
  assert.equal((await get(colleagueContact,rep)).status,404);
  assert.equal((await get(teamFile,rep)).status,404);
  await manage({action:'team_edit',id:pod,name:podName,parentId:sales,revision:2});
  await checkBranch(true);
  assert.equal(await findContact(),1);
  const renameWithMembers=renameGroup(pushed.id,'Regional Sales');
  for(let i=0;i<2;i++){
    const roster=await checked(scim(salesPath,'PATCH',renameWithMembers));
    assert.deepEqual(roster.members.map(item=>item.value),[employee.id]);
  }
  await checked(get(colleagueContact,rep));
  const expectedGroup=[{value:pushed.id,display:'Regional Sales',type:'direct',$ref:renamed.meta.location}];
  assert.deepEqual((await checked(scim(path))).groups,expectedGroup);
  assert.deepEqual((await checked(scim(list('userName',email)))).Resources[0].groups,expectedGroup);
  assert.deepEqual((await checked(api(entra.token,users+'/'+entraUser.id))).groups,[],'A manually assigned team is outside directory group push.');
  const inTeam=(groupId,credential=directory.token)=>api(credential,groups+'/.search','POST',{
    schemas:searchRequest.schemas,filter:groupCore+':id eq "'+groupId+'" and members.value eq "'+employee.id+'"',attributes:['id']}).then(checked);
  assert.deepEqual((await inTeam(pushed.id)).Resources,[{schemas:[groupCore],id:pushed.id}]);
  assert.equal((await inTeam(otherGroup.id)).totalResults,0);
  assert.equal((await inTeam(pushed.id,entra.token)).totalResults,0);
  const usersInGroup=async(groupId)=>(await checked(scim(list('groups.value',groupId)))).Resources.map(row=>row.id);
  assert.deepEqual(await lookup('members.value',employee.id),[pushed.id]);
  assert.deepEqual(await usersInGroup(pushed.id),[employee.id]);
  assert.deepEqual(await lookup('members.value',entraUser.id),[]);
  assert.equal((await checked(api(entra.token,list('groups.value',pushed.id)))).totalResults,0);
  await checked(scim(supportPath,'PATCH',assign),409);
  await checked(scim(salesPath,'PATCH',patch('members',[])));
  await checked(scim(supportPath,'PATCH',assign));
  assert.deepEqual(await lookup('members.value',employee.id),[otherGroup.id]);
  assert.equal((await inTeam(pushed.id)).totalResults,0);
  assert.equal((await inTeam(otherGroup.id)).totalResults,1);
  assert.deepEqual(await usersInGroup(pushed.id),[]);
  assert.deepEqual(await usersInGroup(otherGroup.id),[employee.id]);
  assert.equal((await memberships())[0].teamId,support);
  assert.equal((await matches())[0].team,supportName);
  await currentAccess(supportName,'Your team and child teams','No','None','None');
  assert.equal(await findContact(),0);
  assert.equal((await get(teamFile,rep)).status,404);
  assert.deepEqual((await checked(scim(path))).groups.map(group=>group.value),[otherGroup.id]);
  assert.equal((await get(colleagueContact,rep)).status,404);
  assert.equal((await scim(salesPath,'DELETE')).status,204);
  await checked(scim(groups,'POST',salesGroup),403);
  assert.equal((await state()).samlGroupMappings.some(m=>m.teamId===sales),false);
  assert.equal((await state()).viewers.find(member=>member.email===entraEmail).teamId,pod);
  assert.equal((await api(entra.token,users+'/'+entraUser.id,'DELETE')).status,204);
  await checked(json('/api/workspaces',ownerCookie,{action:'record_scope',id:(await memberships())[0].id,viewScope:'all',editScope:'all'}));
  await checked(get(contact,rep));
  const readOnly=await json('/api/crm?workspaceId='+workspace,rep,{action:'save',kind:'contacts',data:{name:'Viewer edit'}});
  assert.equal(readOnly.status,403);
  const promoted=await checked(scim(path,'PATCH',patch('roles',[{value:'editor'}])));
  assert.deepEqual(promoted.roles,[{value:'editor'}]);
  const replacement={...create,roles:[{value:'editor'}]};
  assert.equal((await checked(scim(path,'PUT',replacement))).id,employee.id);
  await denied(scim(path,'PUT',{...replacement,externalId:subject.toLowerCase()}));
  const [beforeRefresh]=await memberships();
  const refreshed=await checked(scim(path,'PUT',profileUpdate));
  assert.deepEqual([refreshed.externalId,refreshed.active,refreshed.roles],[subject,true,[{value:'editor'}]]);
  const [editGrant]=await memberships();
  assert.equal(editGrant.id,beforeRefresh.id);
  await currentAccess(supportName,'All records','Yes','Your own records','Your own records');
  assert.deepEqual([editGrant.viewScope,editGrant.editScope],['all','owned']);
  assert.match(await currentPreview(),/<dt>Default edit scope<\/dt><dd>Their own records<\/dd>/);
  assert.equal((await get(previewPath(editGrant.id),secondOwner)).status,404);
  const write='/api/crm?workspaceId='+workspace+'&grantId='+editGrant.id;
  const own=(await checked(json(write,rep,{action:'save',kind:'contacts',data:{name:'Directory sales inquiry'}}),201)).record;
  await checked(json('/api/workspaces',ownerCookie,{action:'record_scope',id:editGrant.id,viewScope:'all',editScope:'all'}));
  await checked(scim(path,'PUT',replacement));
  assert.equal((await memberships())[0].editScope,'all');
  const clearRoles={...patch('roles',[]),Operations:[{op:'Remove',path:'roles'}]};
  const oldGrant=(await memberships())[0].id;
  assert.deepEqual((await checked(scim(path,'PATCH',clearRoles))).roles,[{value:'viewer'}]);
  const [viewGrant]=await memberships();
  assert.notEqual(viewGrant.id,oldGrant);
  assert.equal((await get(previewPath(oldGrant),ownerCookie)).status,404);
  assert.equal(viewGrant.teamId,support);
  const editAfterRemoval=await json('/api/crm?workspaceId='+workspace+'&grantId='+oldGrant,rep,
    {action:'save',kind:'contacts',id:own.id,expectedRevision:own.revision,data:{name:'Old editor grant'}});
  assert.ok([403,404].includes(editAfterRemoval.status));
  await checked(get(contact,rep));
  await checked(scim(path,'PATCH',patch('roles',[])));
  assert.equal((await memberships())[0].id,viewGrant.id,'Repeating a role clear must preserve the viewer grant.');
  await checked(scim(path,'PATCH',patch('roles',[{value:'editor'}])));
  const saved=await checked(json('/api/workspaces',secondOwner,{action:'invite',email,role:'viewer'}));
  const otherInvite=saved.sent.find(row=>row.email===email);
  const both=await checked(json('/api/workspaces',rep,{action:'accept_invite',id:otherInvite.id}));
  const independent=both.shared.find(row=>row.id===peerWorkspace);
  assert.ok(independent);await checked(get(peerContact,rep));

  await manage({action:'record_scope',id:(await memberships())[0].id,viewScope:'all',editScope:'owned'});
  await manage({action:'contact_files',id:(await memberships())[0].id,enabled:true});
  const attachment=await get(linkedFile,rep);
  assert.equal(attachment.status,200);
  assert.equal(await attachment.text(),'Fictional employee case file');

  const handoff=await checked(json('/api/leads',ownerCookie,{action:'save',assigneeId:own.data.recordOwner.userId,
    data:{name:'SSO departure handoff'}}),201);
  const waiting=async()=>(await checked(get('/api/leads?owner=needs-routing&search=SSO+departure',ownerCookie))).records.map(row=>row.id);
  assert.deepEqual(await waiting(),[]);
  const departureName='Casey West';
  const changes={...patch('active',false),Operations:[...patch(core+':active',false).Operations,...patch(core+':displayName',departureName).Operations]};
  await checked(scim(path,'PATCH',{...changes,Operations:[...changes.Operations,...patch(groupCore+':active',true).Operations]}),400);
  assert.equal((await checked(scim(path))).active,true);
  await checked(scim(path,'PATCH',{...changes,Operations:[...changes.Operations,...patch('id',randomUUID()).Operations]}),400);
  assert.equal((await checked(scim(path))).active,true);
  assert.equal((await checked(scim(path))).displayName,profile.displayName);
  for(let i=0;i<2;i++){
    const retired=await checked(scim(path,'PATCH',changes));
    assert.equal(retired.displayName,departureName);
    assert.equal(retired.active,false);
  }
  assert.ok([403,404].includes((await get(contact,rep)).status),'A name change delivered with deactivation must end the existing seat.');
  assert.ok([403,404].includes((await get(linkedFile,rep)).status),'The old attachment link must stop serving bytes.');
  const history='/api/workspaces?'+new URLSearchParams({view:'record-access',actor:employeeActor,action:'document',export:'csv'});
  const historyResponse=await get(history,ownerCookie);
  assert.equal(historyResponse.status,200);
  const entries=(await historyResponse.text()).trim().split('\r\n');
  assert.equal(entries.length,3);
  const fileId=new URLSearchParams(linkedFile.split('?')[1]).get('fileId');
  for(const id of [fileId,salesFileId]){
    assert.ok(id&&entries.slice(1).some(row=>row.includes(id)&&row.includes(email)));
  }
  assert.equal((await get(selfSettings,rep)).status,404);
  const peerHistory=await get(history,secondOwner);
  assert.equal(peerHistory.status,200);
  assert.equal((await peerHistory.text()).trim().split('\r\n').length,1);
  const deactivationReceipt=await checked(scim(path+'?attributes=active','PUT',{...profileUpdate,displayName:departureName,active:false}));
  assert.deepEqual(deactivationReceipt,{schemas:[core],id:employee.id,active:false});
  assert.deepEqual(await matches(),[{actorId:employeeActor,displayName:departureName,provider:'Company SSO',role:null,team:null}]);
  const clearInactive=await checked(scim(path,'PATCH',{...clearRoles,Operations:[...clearRoles.Operations,...patch('active',false).Operations]}));
  assert.deepEqual([clearInactive.active,clearInactive.roles,clearInactive.groups],[false,[],[]]);
  const inactive=await checked(scim(path,'PUT',profileUpdate));
  assert.deepEqual([inactive.externalId,inactive.active,inactive.roles],[subject,false,[]]);
  const reconciliation=await checked(scim(searchPath,'POST',{...searchRequest,filter:'userName eq "'+email+'"',attributes:['active','roles']}));
  assert.deepEqual(reconciliation.Resources,[{schemas:[core],id:employee.id,active:false,roles:[]}]);
  assert.deepEqual(await memberships(),[]);
  assert.deepEqual((await checked(scim(supportPath))).members,[]);
  await checked(scim(supportPath,'PATCH',assign),400);
  assert.deepEqual(await waiting(),[handoff.id]);
  assert.ok([403,404].includes((await get(contact,rep)).status));
  assert.ok([403,404].includes((await json(write,rep,{action:'save',kind:'contacts',id:own.id,
    expectedRevision:own.revision,data:{name:'Retired grant'}})).status));
  await checked(get(peerContact,rep));
  const reactivated=await checked(scim(path,'PUT',{...profileUpdate,active:true}));
  assert.equal(reactivated.id,employee.id);
  assert.deepEqual(await matches(),[{actorId:employeeActor,displayName:profile.displayName,provider:'Company SSO',memberId:(await memberships())[0].id,role:'viewer',team:null}]);
  const [fresh]=await memberships();
  assert.equal(fresh.teamId,null);
  assert.notEqual(fresh.id,editGrant.id);assert.deepEqual([fresh.role,fresh.viewScope],['viewer','owned']);
  await checked(scim(supportPath,'PATCH',assign));
  assert.equal((await memberships())[0].teamId,support);
  await manage({action:'saml_group_unmap',teamId:support,groupName:supportName});
  assert.equal((await memberships())[0].teamId,null);
  await checked(scim(supportPath),404);
  const ownPath='/api/crm?workspaceId='+workspace+'&id='+own.id;
  // The owner explicitly grants visibility again for this reinstated membership.
  await checked(json('/api/workspaces',ownerCookie,{action:'record_scope',id:fresh.id,viewScope:'all',editScope:'owned'}));
  assert.equal((await checked(get(ownPath,rep))).data.name,'Directory sales inquiry');
  assert.equal((await scim(path,'DELETE')).status,204);
  await checked(scim(path),404);assert.deepEqual(await memberships(),[]);assert.deepEqual(await matches(),[]);
  assert.ok([403,404].includes((await get(ownPath,rep)).status));
  await checked(get(peerContact,rep));
  const again=expectReturn(await (await saml(subject))());
  await checked(get(peerContact,again));
  await checked(json('/api/workspaces',secondOwner,{action:'revoke',id:independent.grantId}));
  assert.equal((await get('/api/workspaces',again)).status,401);
  disabled(await (await saml(subject))());
  await checked(json(tokenPath,ownerCookie,{action:'revoke',id:directory.info.id}));
  await checked(scim(users),401);
  await checked(scim(searchPath,'POST',searchRequest),401);
  return [email,entraEmail];
}
