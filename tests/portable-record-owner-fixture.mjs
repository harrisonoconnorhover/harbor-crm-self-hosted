import assert from 'node:assert/strict';

const recordKinds=['contacts','companies','deals'];
const ownerEmail='owner@example.test';
const editorEmail='other@example.test';
const recordPath=(kind,id,workspaceId)=>'/api/crm?'+new URLSearchParams({kind,id,...(workspaceId?{workspaceId}:{})});
const historyPath=(kind,id,workspaceId)=>'/api/crm?'+new URLSearchParams({
  kind,history:id,field:'owner',...(workspaceId?{workspaceId}:{}),
});
const changes=page=>page.items.map(({revision,previous,value})=>[revision,previous,value]);
const post=(request,path,headers,origin,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN (${ownerEmail},${editorEmail}))`;

async function checkedJson(response,status){
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}

export async function verifyPortableRecordOwners({request,origin,headers,other,sql,sharing}){
  const {workspaceId}=sharing;
  const identities=await sql`SELECT id,email,full_name FROM login_identities WHERE email IN (${ownerEmail},${editorEmail})`;
  const {id:ownerId,full_name:ownerLabel}=identities.find(identity=>identity.email===ownerEmail);
  const {id:editorId,full_name:editorLabel}=identities.find(identity=>identity.email===editorEmail);
  // A label-only comparison would silently drop the owner-to-editor change.
  assert.ok(ownerLabel);
  assert.equal(editorLabel,ownerLabel);
  const assignment=userId=>({userId,workspaceId,label:ownerLabel});
  const read=(path,auth=headers)=>request(path,{headers:auth});
  const unavailablePath=(kind,filters={})=>'/api/crm?'+new URLSearchParams({kind,owner:'unavailable',...filters});
  const unavailable=async(kind,filters,auth=headers)=>checkedJson(await read(unavailablePath(kind,filters),auth),200);
  const ids=page=>page.records.map(record=>record.id);
  const sharedWrite=grantId=>'/api/crm?'+new URLSearchParams({workspaceId,grantId});
  const save=(kind,data,extra={},auth=headers,path='/api/crm')=>post(request,path,auth,origin,{action:'save',kind,data,...extra});
  const changeGrant=async change=>{
    const result=await post(request,'/api/workspaces',headers,origin,change);
    const {viewers}=await checkedJson(result,200);
    const current=viewers.find(viewer=>viewer.email===editorEmail);
    if(current)sharing.grantId=current.id;
    return current;
  };
  const grants=async role=>{
    const current=await changeGrant({action:'role',id:sharing.grantId,role});
    assert.equal(current.role,role);
    return current;
  };
  const restoreGrant=async previous=>{
    let current=await changeGrant({action:'grant',email:editorEmail});
    if(current.role!==previous.role)current=await grants(previous.role);
    for(const [field,action] of [['contactFiles','contact_files'],['scheduledNotes','scheduled_notes'],
      ['contactOutreach','contact_outreach'],['recordActivities','record_activities']]){
      if(current[field]!==previous[field])current=await changeGrant({action,id:sharing.grantId,enabled:previous[field]});
    }
  };
  const tokenRequest=body=>post(request,'/api/api-tokens',headers,origin,body);
  const current=(record,expectedRevision=record.revision)=>({id:record.id,expectedRevision});
  const cases=[];
  let tokenId,demoted=false,revokedGrant;
  await resetBudget(sql);
  try{
    for(const kind of recordKinds){
      const data={name:'Fictional record owner '+kind};
      const {record:created}=await checkedJson(await save(kind,data,{assigneeId:ownerId}),201);
      assert.deepEqual(created.data.recordOwner,assignment(ownerId));
      assert.deepEqual((await checkedJson(await read(recordPath(kind,created.id,workspaceId),other),200)).data.recordOwner,
        assignment(ownerId));
      assert.equal((await read(recordPath(kind,created.id),other)).status,404);
      assert.equal((await save(kind,data,{...current(created),assigneeId:editorId},other)).status,404);
      assert.equal((await save(kind,{...data,recordOwner:assignment(editorId)},current(created))).status,400);

      const {record:assigned}=await checkedJson(await save(kind,data,{...current(created),assigneeId:editorId},
        other,sharedWrite(sharing.grantId)),200);
      assert.deepEqual(assigned.data.recordOwner,assignment(editorId));
      assert.equal((await save(kind,data,{...current(created),assigneeId:null})).status,409);
      const {record:retained}=await checkedJson(await save(kind,{name:data.name+' renamed'},current(assigned)),200);
      assert.deepEqual(retained.data.recordOwner,assignment(editorId));
      const {record:cleared}=await checkedJson(await save(kind,data,{...current(retained),assigneeId:null}),200);
      assert.ok(!Object.hasOwn(cleared.data,'recordOwner'));
      const {record:latest}=await checkedJson(await save(kind,data,{...current(cleared),assigneeId:editorId}),200);
      const expectedChanges=[[latest.revision,null,ownerLabel],[cleared.revision,ownerLabel,null],
        [assigned.revision,ownerLabel,ownerLabel],[created.revision,null,ownerLabel]];
      const history=await checkedJson(await read(historyPath(kind,created.id)),200);
      assert.deepEqual(changes(history),expectedChanges);
      assert.equal(history.next,null);
      assert.deepEqual(changes(await checkedJson(await read(historyPath(kind,created.id,workspaceId),other),200)),expectedChanges);
      cases.push({kind,id:created.id,data,revision:latest.revision,assignment:assignment(editorId),expectedChanges});
      assert.deepEqual(await unavailable(kind,{search:data.name}),{records:[],next:null});
    }

    const contact=cases.find(record=>record.kind==='contacts');
    const followUp={name:contact.data.name+' follow-up'};
    const {record:extra}=await checkedJson(await save('contacts',followUp,{assigneeId:editorId}),201);
    const oldGrant=sharing.grantId;
    await grants('viewer');
    demoted=true;
    for(const {kind,id,data,revision,assignment,expectedChanges} of cases){
      const edit={id,expectedRevision:revision,assigneeId:null};
      assert.equal((await save(kind,data,edit,other,sharedWrite(oldGrant))).status,403);
      assert.equal((await save(kind,data,edit,other,sharedWrite(sharing.grantId))).status,403);
      assert.equal((await save(kind,data,{...edit,assigneeId:editorId})).status,409);
      const named=await checkedJson(await read(recordPath(kind,id,workspaceId),other),200);
      assert.equal(named.revision,revision);
      assert.deepEqual(named.data.recordOwner,assignment);
      assert.deepEqual(changes(await checkedJson(await read(historyPath(kind,id)),200)),expectedChanges);
      const [stored]=await sql`SELECT revision,data->'recordOwner' AS assignment FROM ${sql(kind)}
        WHERE workspace_id=${workspaceId} AND id=${id}`;
      assert.deepEqual(stored,{revision,assignment});
      const filters={search:data.name};
      const matches=kind==='contacts'?[id,extra.id].sort():[id];
      assert.deepEqual(ids(await unavailable(kind,filters)),matches);
      assert.deepEqual(ids(await unavailable(kind,{...filters,workspaceId},other)),matches);
      assert.deepEqual(await unavailable(kind,filters,other),{records:[],next:null});
      const exported=await read(unavailablePath(kind,{...filters,export:'csv'}));
      assert.equal(exported.status,200);
      assert.equal(exported.headers.get('content-type'),'text/csv; charset=utf-8');
      assert.deepEqual((await exported.text()).trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0]),
        matches.map(recordId=>'"'+recordId+'"'));
      assert.equal((await read(unavailablePath(kind,{...filters,workspaceId,export:'csv'}),other)).status,403);
    }
    const first=await unavailable('contacts',{search:contact.data.name,limit:'1'});
    assert.equal(first.records.length,1);
    assert.equal(first.next,first.records[0].id);
    const second=await unavailable('contacts',{search:contact.data.name,limit:'1',after:first.next});
    assert.deepEqual([...ids(first),...ids(second)],[contact.id,extra.id].sort());
    assert.equal(second.next,null);
    assert.deepEqual(ids(await unavailable('contacts',{search:followUp.name})),[extra.id]);
    assert.equal((await read(unavailablePath('contacts',{id:contact.id}))).status,400);
    const page=await read('/?'+new URLSearchParams({owner:'unavailable',search:followUp.name,workspaceId}),other);
    assert.equal(page.status,200);
    const html=(await page.text()).replaceAll('<!-- -->','');
    assert.match(html,/<option(?=[^>]*value="unavailable")(?=[^>]*\bselected)[^>]*>Unavailable owners<\/option>/);
    assert.match(html,/Shared workspace · View only/);
    assert.ok(html.includes(followUp.name));
    assert.ok(!html.includes('contact='+contact.id));
    const {record:cleared}=await checkedJson(await save('contacts',followUp,{...current(extra),assigneeId:null}),200);
    assert.ok(!Object.hasOwn(cleared.data,'recordOwner'));
    assert.deepEqual(ids(await unavailable('contacts',{search:contact.data.name})),[contact.id]);

    const currentGrant=await grants('editor');
    demoted=false;
    for(const {kind,data} of cases)assert.deepEqual(await unavailable(kind,{search:data.name}),{records:[],next:null});

    revokedGrant=currentGrant;
    assert.equal(await changeGrant({action:'revoke',id:currentGrant.id}),undefined);
    for(const {kind,id,data} of cases){
      assert.deepEqual(ids(await unavailable(kind,{search:data.name})),[id]);
      assert.equal((await read(unavailablePath(kind,{workspaceId}),other)).status,404);
    }
    await restoreGrant(revokedGrant);
    revokedGrant=undefined;
    assert.deepEqual(await unavailable('contacts',{search:contact.data.name}),{records:[],next:null});

    const {token,info}=await checkedJson(await tokenRequest({name:'Fictional owner redaction check',
      objects:recordKinds,permission:'read',days:30}),201);
    tokenId=info.id;
    const bearer={authorization:'Bearer '+token};
    for(const {kind,id,data} of cases){
      const path='/api/v1/records/'+kind;
      const single=await checkedJson(await read(path+'/'+id,bearer),200);
      const batch=await checkedJson(await post(request,path+'/batch/read',bearer,origin,{inputs:[{id}]}),200);
      for(const {properties} of [single,batch.results[0]]){
        assert.equal(properties.name,data.name);
        assert.ok(!Object.hasOwn(properties,'recordOwner'));
        assert.ok(!Object.hasOwn(properties,'owner'));
      }
    }
    return cases;
  }finally{
    if(demoted)await grants('editor');
    if(revokedGrant)await restoreGrant(revokedGrant);
    if(tokenId)assert.equal((await tokenRequest({action:'revoke',id:tokenId})).status,200);
    await resetBudget(sql);
  }
}

export async function verifyRestoredRecordOwners({request,owner,other,cases,workspaceId}){
  for(const {kind,id,revision,assignment,expectedChanges} of cases){
    const record=await checkedJson(await request(recordPath(kind,id),{headers:owner}),200);
    assert.equal(record.revision,revision);
    assert.deepEqual(record.data.recordOwner,assignment);
    const history=await checkedJson(await request(historyPath(kind,id),{headers:owner}),200);
    assert.deepEqual(changes(history),expectedChanges);
    assert.equal((await request(recordPath(kind,id,workspaceId),{headers:other})).status,404);
    assert.equal((await request(historyPath(kind,id,workspaceId),{headers:other})).status,404);
  }
}
