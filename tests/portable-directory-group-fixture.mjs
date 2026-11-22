import assert from 'node:assert/strict';

export async function directoryGroupLifecycle({request,json,sql,ownerCookie,secondOwner,rep,member,state,read,workspace,
  peerEmail,employee,userId,token,foreignToken,recordToken}){
  const groups='/scim/v2/Groups',teams='/api/workspaces';
  const sales=crypto.randomUUID(),otherTeam=crypto.randomUUID(),externalId=crypto.randomUUID();
  const create={schemas:['urn:ietf:params:scim:schemas:core:2.0:Group'],displayName:'Fictional sales department',externalId,members:[]};
  const scim=(method,suffix='',body,credential=token)=>request(groups+suffix,{method,
    headers:{authorization:'Bearer '+credential,'content-type':'application/scim+json'},body:body&&JSON.stringify(body)});
  const check=async(pending,status=200)=>{
    const response=await pending;
    assert.equal(response.status,status,await response.clone().text());
    return status===204?null:response.json();
  };
  const change=body=>check(json(teams,body,ownerCookie));
  const map={action:'directory_group_map',teamId:sales,externalId};
  const unmap={...map,action:'directory_group_unmap'};
  const assign=(id,teamId,previousTeamId=null)=>change({action:'team_assign',id,teamId,previousTeamId});
  for(const [id,name] of [[sales,'Directory sales'],[otherTeam,'Manual support']]){
    await change({action:'team_create',id,name,parentId:null});
  }
  assert.equal((await request(groups,{headers:{cookie:ownerCookie}})).status,401);
  assert.equal((await scim('GET','',undefined,recordToken)).status,403);
  assert.equal((await json(teams,map,rep)).status,403);
  await check(scim('POST','',create),403);
  await change(map);
  const mappings=async()=>(await state(ownerCookie)).directoryGroupMappings.filter(m=>m.teamId===sales);
  assert.deepEqual((await mappings()).map(m=>m.externalId),[externalId]);
  const entraCreate={...create,schemas:[...create.schemas,'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group'],meta:{resourceType:'Group'}};
  const group=await check(scim('POST','',entraCreate),201);
  assert.deepEqual(group.schemas,create.schemas);
  const suffix='/'+group.id;
  assert.equal(group.externalId,externalId);
  await check(scim('POST','',create),409);
  const list=await check(scim('GET','?filter='+encodeURIComponent('externalId eq "'+externalId+'"')));
  assert.deepEqual(list.Resources.map(g=>g.id),[group.id]);
  assert.deepEqual((await check(scim('GET','?filter='+encodeURIComponent('externalId eq "'+externalId+'"'),undefined,foreignToken))).Resources,[]);
  const groupSearch={schemas:['urn:ietf:params:scim:api:messages:2.0:SearchRequest'],filter:'externalId eq "'+externalId+'"',excludedAttributes:['members']};
  const scopedSearch=(params,credential)=>check(scim('POST','/.search',params,credential));
  const found=await scopedSearch(groupSearch,token);
  assert.equal(found.totalResults,1);
  assert.equal(found.Resources[0].id,group.id);
  assert.ok(!Object.hasOwn(found.Resources[0],'members'));
  assert.deepEqual((await scopedSearch(groupSearch,foreignToken)).Resources,[]);
  for(const bounds of [{count:0},{startIndex:2,count:1}]){
    const beyond=await scopedSearch({...groupSearch,...bounds},token);
    assert.deepEqual([beyond.totalResults,beyond.itemsPerPage,beyond.Resources],[1,0,[]]);
  }
  await check(scim('GET',suffix,undefined,foreignToken),404);
  const patch=(op,path,value)=>({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op,path,...(value===undefined?{}:{value})}]});
  const add=patch('add','members',[{value:userId}]);
  const remove=patch('remove',create.schemas[0]+':members[value eq "'+userId+'"]');
  async function membershipPage(kind,resourceId,options={},credential=token){
    const field=kind==='Users'?'groups.value':create.schemas[0]+':members.value';
    const params=new URLSearchParams({filter:field+' eq "'+resourceId+'"',attributes:'id',...options});
    const page=await check(request('/scim/v2/'+kind+'?'+params,{headers:{authorization:'Bearer '+credential}}));
    return {total:page.totalResults,ids:page.Resources.map(record=>record.id)};
  }
  async function verifyMembership(groupId,assigned){
    assert.deepEqual(await membershipPage('Groups',userId),{total:assigned?1:0,ids:assigned?[groupId]:[]});
    assert.deepEqual(await membershipPage('Users',groupId),{total:assigned?1:0,ids:assigned?[userId]:[]});
    const groupCheck={...groupSearch,filter:'id eq "'+groupId+'" AND members.value eq "'+userId+'"'};
    const result=await scopedSearch({...groupCheck,count:0},token);
    assert.deepEqual([result.totalResults,result.Resources],[assigned?1:0,[]]);
    const userCheck={filter:'id eq "'+userId+'" and active eq true and groups.value eq "'+groupId+'"'};
    assert.deepEqual(await membershipPage('Users',groupId,userCheck),{total:assigned?1:0,ids:assigned?[userId]:[]});
  }
  const members=async()=>(await check(scim('GET',suffix))).members.map(m=>m.value);
  const supportExternalId=crypto.randomUUID();
  await change({action:'directory_group_map',teamId:otherTeam,externalId:supportExternalId});
  const duplicateName={...create,externalId:supportExternalId,displayName:create.displayName.toUpperCase()};
  assert.equal((await check(scim('POST','',duplicateName),409)).scimType,'uniqueness');
  const supportResponse=await scim('POST','?attributes=displayName',{...duplicateName,displayName:'Fictional support desk'});
  const support=await check(supportResponse,201);
  assert.deepEqual(support,{schemas:create.schemas,id:support.id,displayName:'Fictional support desk'});
  assert.ok(supportResponse.headers.get('location').endsWith(groups+'/'+support.id));
  const rename=patch('replace','displayName',create.displayName.toLowerCase());
  assert.equal((await check(scim('PATCH','/'+support.id,rename),409)).scimType,'uniqueness');
  assert.equal((await check(scim('GET','/'+support.id))).displayName,support.displayName);
  // An employee can belong to two groups in Entra. Harbor has one primary team.
  const candidates=[{id:group.id,team:sales},{id:support.id,team:otherTeam}];
  const attempts=await Promise.all(candidates.map(candidate=>scim('PATCH','/'+candidate.id,add)));
  assert.deepEqual(attempts.map(response=>response.status).sort(),[200,409]);
  const winner=attempts.findIndex(response=>response.ok);
  assert.equal((await member()).teamId,candidates[winner].team);
  for(const [index,candidate] of candidates.entries()){
    const roster=await check(scim('GET','/'+candidate.id));
    assert.deepEqual(roster.members.map(m=>m.value),index===winner?[userId]:[]);
  }
  await check(scim('PATCH','/'+candidates[winner].id,remove));
  await change({action:'directory_group_unmap',teamId:otherTeam,externalId:supportExternalId});
  await check(scim('PATCH',suffix,add,foreignToken),404);

  const peerGrant=sharing=>sharing.viewers.find(row=>row.email===peerEmail);
  let peer=peerGrant(await change({action:'grant',email:peerEmail}));
  peer=peerGrant(await assign(peer.id,sales));
  peer=peerGrant(await change({action:'role',id:peer.id,role:'editor'}));
  peer=peerGrant(await change({action:'backup_admin',id:peer.id,enabled:true}));
  const delegated=teams+'?'+new URLSearchParams({workspaceId:workspace,grantId:peer.id});
  await check(request(delegated,{headers:{cookie:secondOwner}}));
  for(const body of [map,unmap])await check(json(delegated,body,secondOwner),403);
  const subjectIds=Object.fromEntries((await sql`SELECT email,id FROM login_identities WHERE email IN (${peerEmail},${employee})`)
    .map(row=>[row.email,row.id]));
  const {property}=await check(json('/api/custom-properties',{action:'create',kind:'contacts',type:'text',
    label:'Directory-only sales terms',audience:sales},ownerCookie),201);
  const value='Fictional sales terms';
  const contact=async(name,assigneeId)=>(await check(json('/api/crm',{action:'save',kind:'contacts',
    data:{name,custom:{[property.id]:value}},assigneeId},ownerCookie),201)).record;
  const mine=await contact('Directory rep contact',subjectIds[employee]);
  const theirs=await contact('Directory peer contact',subjectIds[peerEmail]);
  await change({action:'record_scope',id:(await member()).id,viewScope:'team',editScope:'owned'});
  const verifyScope=async(inSales)=>{
    const own=await check(read(rep,workspace,mine.id));
    assert.equal(own.data.custom?.[property.id],inSales?value:undefined);
    const colleague=await read(rep,workspace,theirs.id);
    assert.equal(colleague.status,inSales?200:404);
    if(inSales)assert.equal((await colleague.json()).data.custom[property.id],value);
  };
  await verifyScope(false);
  const replacementName='Fictional national sales';
  const fullRoster={...group,displayName:replacementName,members:[{value:userId}]};
  for(let attempt=0;attempt<2;attempt++){
    const saved=await check(scim('PUT',suffix,fullRoster));
    assert.equal(saved.id,group.id);
    assert.equal(saved.externalId,externalId);
    assert.equal(saved.displayName,replacementName);
    assert.deepEqual(saved.members.map(m=>m.value),[userId]);
    assert.equal(saved.members[0].type,'User');
    const employeeResource=await check(request('/scim/v2/Users/'+userId,{headers:{authorization:'Bearer '+token}}));
    assert.deepEqual(employeeResource.groups,[{value:group.id,display:replacementName,type:'direct',$ref:saved.meta.location}]);
    await verifyScope(true);
  }
  await verifyMembership(group.id,true);
  const exactSeat='members.value eq "'+userId+'"';
  for(const filter of [exactSeat+' and id eq "'+support.id+'"',exactSeat+' and members.value eq "'+crypto.randomUUID()+'"']){
    assert.equal((await scopedSearch({...groupSearch,filter},token)).totalResults,0);
  }
  assert.equal((await scopedSearch({...groupSearch,filter:exactSeat+' and id eq "'+group.id+'"'},foreignToken)).totalResults,0);
  const invalid=await check(scim('POST','/.search',{...groupSearch,filter:'id eq "unknown" and unsupported eq "x"'}),400);
  assert.equal(invalid.scimType,'invalidFilter');
  for(const [kind,id] of [['Users',group.id],['Groups',userId]]){
    assert.deepEqual(await membershipPage(kind,id,{count:'0'}),{total:1,ids:[]});
    assert.deepEqual(await membershipPage(kind,id,{startIndex:'2'}),{total:1,ids:[]});
    assert.deepEqual(await membershipPage(kind,id,{},foreignToken),{total:0,ids:[]});
    assert.deepEqual(await membershipPage(kind,'not-a-resource-id'),{total:0,ids:[]});
  }
  // A client that requested excludedAttributes=members can round-trip the group name.
  const projected=await check(scim('GET',suffix+'?excludedAttributes=members'));
  assert.equal(projected.members,undefined);
  const minimal=await check(scim('GET',suffix+'?excludedAttributes=id,schemas,externalId,displayName,meta,members.$ref,members.type'));
  assert.deepEqual(minimal,{schemas:create.schemas,id:group.id,members:[{value:userId}]});
  const team=await check(scim('GET','?filter='+encodeURIComponent('displayName eq "'+replacementName+'"')+'&attributes=displayName,members.value'));
  assert.deepEqual(team.Resources,[{schemas:create.schemas,id:group.id,displayName:replacementName,members:[{value:userId}]}]);
  await check(scim('PUT',suffix,{...projected,displayName:create.displayName}));
  assert.deepEqual(await members(),[userId]);
  await check(scim('PUT',suffix,fullRoster,foreignToken),404);
  assert.equal((await check(scim('PUT',suffix,{...fullRoster,externalId:crypto.randomUUID()}),400)).scimType,'mutability');
  await check(scim('PUT',suffix,{...fullRoster,members:[{value:crypto.randomUUID()}]}),400);
  const afterInvalid=await check(scim('GET',suffix));
  assert.equal(afterInvalid.displayName,create.displayName);
  assert.deepEqual(afterInvalid.members.map(m=>m.value),[userId]);
  await verifyScope(true);
  await check(scim('PUT',suffix,{...afterInvalid,members:[]}));
  assert.deepEqual(await members(),[]);
  const person=await check(request('/scim/v2/Users/'+userId+'?attributes=groups.value',{headers:{authorization:'Bearer '+token}}));
  assert.deepEqual(person,{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],id:userId,groups:[]});
  await verifyScope(false);
  assert.equal(peerGrant(await state(ownerCookie)).teamId,sales);
  // A pre-existing manual assignment must survive an unsuccessful synchronization.
  for(const manual of [sales,otherTeam]){
    await assign((await member()).id,manual);
    await check(scim('PATCH',suffix,add),409);
    assert.deepEqual(await members(),[]);
    assert.equal((await member()).teamId,manual);
    await assign((await member()).id,null,manual);
  }
  const badMember=await scim('PATCH',suffix,patch('add','members',[{value:userId},{value:peer.id}]));
  assert.ok([400,404,409].includes(badMember.status));
  assert.deepEqual(await members(),[],'Reject mixed directory and manual membership atomically');
  for(let i=0;i<2;i++)await check(scim('PATCH',suffix,add));
  assert.deepEqual(await members(),[userId]);
  await verifyScope(true);
  for(let i=0;i<2;i++)await check(scim('PATCH',suffix,remove));
  assert.deepEqual(await members(),[]);
  await verifyScope(false);
  await check(scim('PATCH',suffix,add));
  await check(scim('DELETE',suffix),204);
  await check(scim('GET',suffix),404);
  await verifyScope(false);
  assert.deepEqual((await mappings()).map(m=>m.externalId),[externalId]);

  const replacement=await check(scim('POST','',create),201);
  assert.notEqual(replacement.id,group.id);
  assert.deepEqual(replacement.members,[]);
  await check(scim('PATCH',suffix,add),404);
  await check(scim('PATCH','/'+replacement.id,add));
  await verifyScope(true);
  return {
    async checkInactive(){
      await verifyMembership(replacement.id,false);
      assert.deepEqual((await check(scim('GET','/'+replacement.id))).members,[]);
      for(const change of [add,patch('replace','members',[{value:userId}])]){
        const denied=await scim('PATCH','/'+replacement.id,change);
        assert.ok([400,404,409].includes(denied.status));
      }
      for(let i=0;i<2;i++){
        const confirmed=await check(scim('PATCH','/'+replacement.id,remove));
        assert.deepEqual(confirmed.members,[]);
      }
    },
    async checkReactivated(){
      await verifyMembership(replacement.id,false);
      assert.deepEqual((await check(scim('GET','/'+replacement.id))).members,[]);
      assert.equal((await member()).teamId,null);
      await verifyScope(false);
      await check(scim('PATCH','/'+replacement.id,add));
      assert.equal((await member()).teamId,sales);
      await verifyMembership(replacement.id,true);
      // Joining Sales restores property visibility while the new grant remains owned-only.
      const own=await check(read(rep,workspace,mine.id));
      assert.equal(own.data.custom[property.id],value);
      assert.equal((await read(rep,workspace,theirs.id)).status,404);
      await change(unmap);
      await verifyMembership(replacement.id,false);
      assert.deepEqual(await mappings(),[]);
      await check(scim('GET','/'+replacement.id),404);
      assert.equal(peerGrant(await state(ownerCookie)).teamId,sales);
      await verifyScope(false);
    },
  };
}
