import assert from 'node:assert/strict';

const endpoint='/api/custom-properties';
const post=(request,path,headers,origin,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const definition=(kind,label,type='text',options)=>({action:'create',kind,label,type,...(options?{options}:{})});
const readPath=(kind,id)=>'/api/crm?'+new URLSearchParams({kind,id});
const historyPath=(kind,id,property,options={})=>'/api/crm?'+new URLSearchParams({kind,history:id,field:'custom:'+property,...options});
const changes=page=>page.items.map(item=>[item.revision,item.previous,item.value]);
const listPath=(kind,workspaceId)=>endpoint+'?'+new URLSearchParams({kind,...(workspaceId?{workspaceId}:{})});
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

export async function verifyPortableCustomProperties({request,origin,headers,other,sql}){
  const prefix='Fixture property '+crypto.randomUUID();
  const {owned:workspaceId}=await (await request('/api/workspaces',{headers})).json();
  const scope='?workspaceId='+workspaceId;
  const save=(kind,data,edit={},auth=headers,path='/api/crm')=>post(request,path,auth,origin,{action:'save',kind,data,...edit});
  const admin=(body,auth=headers,site=origin,path=endpoint)=>post(request,path,auth,site,body);
  const read=(kind,id,auth=headers,shared=false)=>request(readPath(kind,id)+(shared?'&workspaceId='+workspaceId:''),{headers:auth});
  const list=(kind,auth=headers,workspace)=>request(listPath(kind,workspace),{headers:auth});
  const grants=body=>post(request,'/api/workspaces',headers,origin,body);
  const defIds=[],recordIds={contacts:[],companies:[],deals:[]};
  let grantId,tokenId;
  await resetBudget(sql);
  async function add(kind,suffix,type,options,auth=headers){
    const response=await admin(definition(kind,prefix+' '+suffix,type,options),auth);
    assert.equal(response.status,201);
    const {property}=await response.json();
    defIds.push(property.id);
    return property;
  }
  async function createRecord(kind,data){
    const response=await save(kind,data);
    assert.equal(response.status,201);
    const {record}=await response.json();
    recordIds[kind].push(record.id);
    return record;
  }
  try{
    assert.equal((await list('contacts',{})).status,401);
    assert.equal((await list('contacts',other,workspaceId)).status,404);
    assert.equal((await request(endpoint+'?kind=contacts&kind=deals',{headers})).status,400);
    assert.equal((await admin(definition('contacts',prefix),headers,'https://outside.example.test')).status,403);
    assert.equal((await admin(definition('contacts',prefix,'select',['Red','red']))).status,400);
    assert.equal((await admin(definition('contacts',prefix,'checkbox',['Not valid']))).status,400);
    for(const options of [[],['North','north'],['Semi;colon'],Array.from({length:51},(_,i)=>'Choice '+i)]){
      assert.equal((await admin(definition('contacts',prefix,'multiselect',options))).status,400);
    }
    assert.equal((await admin(definition('contacts',prefix,'url',['Not valid']))).status,400);

    const score=await add('contacts','score','number');
    const enabled=await add('contacts','enabled','checkbox');
    const deadline=await add('contacts','date','date');
    const status=await add('contacts','status','select',['New','Ready']);
    const description=await add('contacts','description','textarea');
    const url=await add('contacts','resource','url');
    const email=await add('contacts','business email','email');
    const datetime=await add('contacts','meeting time','datetime');
    const choices=['Fictional north','Fictional alpha','Fictional other'];
    const tags=await add('contacts','labels','multiselect',choices);
    const companyField=await add('companies','company note');
    const companyDescription=await add('companies','company description','textarea');
    const companyTags=await add('companies','company labels','multiselect',choices);
    const dealField=await add('deals','deal note','textarea');
    const dealUrl=await add('deals','deal resource','url');
    const dealDateTime=await add('deals','deal appointment','datetime');
    const dealTags=await add('deals','deal labels','multiselect',choices);
    const foreign=await add('contacts','foreign','text',undefined,other);
    assert.equal((await admin(definition('contacts',score.label.toUpperCase(),'text'))).status,409);
    assert.deepEqual((await (await list('contacts',other)).json()).properties,[foreign]);
    const ownList=await list('contacts');
    assert.equal(ownList.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(new Set((await ownList.json()).properties.map(property=>property.id)),new Set([score,enabled,deadline,status,description,url,email,datetime,tags].map(field=>field.id)));
    const rename={action:'rename',kind:'contacts',id:score.id,label:prefix+' renamed',expectedRevision:1};
    assert.equal((await admin(rename,other)).status,404);
    assert.equal((await admin({...rename,kind:'companies'})).status,404);
    const renamedResponse=await admin(rename);
    assert.equal(renamedResponse.status,200);
    const {property:renamed}=await renamedResponse.json();
    assert.deepEqual(renamed,{...score,label:rename.label,revision:2});
    assert.equal((await admin(rename)).status,409);
    assert.equal((await admin({...rename,expectedRevision:2,label:enabled.label})).status,409);

    const scalarInput={
      [description.id]:'Fictional line one\r\nLine two <script>literal</script>',
      [url.id]:'EXAMPLE.TEST/resources',[email.id]:' Sales+Tag@EXAMPLE.TEST ',
      [datetime.id]:'2026-11-01T01:30:23.456-04:00',
      [tags.id]:['fictional alpha','FICTIONAL NORTH','Fictional alpha'],
    };
    const scalarValues={...scalarInput,[url.id]:'https://example.test/resources',[email.id]:'Sales+Tag@example.test',
      [datetime.id]:'2026-11-01T05:30:23.456Z',[tags.id]:choices.slice(0,2)};
    const existingValues={[score.id]:0,[enabled.id]:false,[deadline.id]:'2026-11-09',[status.id]:'Ready'};
    const contactValues={...existingValues,...scalarValues};
    const contact=await createRecord('contacts',{name:prefix+' contact',custom:{...existingValues,...scalarInput}});
    assert.deepEqual(contact.data.custom,contactValues);
    const fullDescription='A'.repeat(65_534)+'\nB';
    const company=await createRecord('companies',{name:prefix+' company',
      custom:{[companyField.id]:'Company typed text',[companyDescription.id]:fullDescription,[companyTags.id]:[choices[2]]}});
    assert.equal(company.data.custom[companyDescription.id],fullDescription);
    assert.deepEqual(company.data.custom[companyTags.id],[choices[2]]);
    assert.equal((await save('companies',{name:company.data.name,custom:{[companyDescription.id]:fullDescription+'X'}},
      {id:company.id,expectedRevision:1})).status,400);
    assert.equal((await save('companies',{name:company.data.name,custom:{[companyField.id]:'A'.repeat(2001)}},
      {id:company.id,expectedRevision:1})).status,400);
    const deal=await createRecord('deals',{name:prefix+' deal',
      custom:{[dealField.id]:'Deal typed text',[dealDateTime.id]:'2026-11-01T01:30:23.456-05:00',
        [dealTags.id]:choices[2]+';'+choices[0]}});
    assert.equal(deal.data.custom[dealDateTime.id],'2026-11-01T06:30:23.456Z');
    assert.deepEqual(deal.data.custom[dealTags.id],[choices[0],choices[2]]);
    const edit={id:contact.id,expectedRevision:contact.revision};
    for(const custom of [{[score.id]:'0'},{[enabled.id]:'false'},{[deadline.id]:'2026-02-30'},{[status.id]:'Missing'},
      {[foreign.id]:'No access'},{[companyField.id]:'Wrong object'},{[crypto.randomUUID()]:true},{invalid:true},
      {[description.id]:true},{[url.id]:'javascript:alert(1)'},{[url.id]:'https://user:pw@example.test'},
      {[email.id]:'not an email'},{[datetime.id]:'2026-11-01T01:30:23.456'},{[datetime.id]:'2026-11-01T01:30:23.4567Z'},
      {[tags.id]:['Missing option']},{[tags.id]:Array(51).fill(choices[0])},{[tags.id]:['x'.repeat(81)]},
      {[tags.id]:[true]},{[tags.id]:true},{[tags.id]:';'+choices[2]},{[score.id]:[choices[0]]}]){
      assert.equal((await save('contacts',{name:contact.data.name,custom},edit)).status,400);
    }
    assert.equal((await save('contacts',{name:contact.data.name,custom:contactValues},edit,other)).status,404);
    assert.deepEqual(await (await read('contacts',contact.id)).json(),contact,'Rejected writes leave the revision untouched.');
    const legacy=await save('contacts',{name:prefix+' legacy edit'},edit);
    assert.equal(legacy.status,200);
    const {record:edited}=await legacy.json();
    assert.deepEqual(edited.data.custom,contactValues);
    assert.equal((await save('contacts',{name:contact.data.name,custom:{[score.id]:1}},edit)).status,409);
    const clear=await save('contacts',{name:edited.data.name,custom:{[deadline.id]:null,[status.id]:'',
      [tags.id]:[...choices.slice(0,2)].reverse().map(label=>label.toUpperCase())}},
      {id:edited.id,expectedRevision:edited.revision});
    assert.equal(clear.status,200);
    const {record:cleared}=await clear.json();
    assert.deepEqual(cleared.data.custom,{...scalarValues,[score.id]:0,[enabled.id]:false});
    const events=await sql`SELECT revision,data FROM contact_events WHERE workspace_id=${workspaceId}
      AND contact_id=${contact.id} ORDER BY revision`;
    assert.deepEqual(events.map(event=>[event.revision,event.data.custom]),[[1,contactValues],[2,contactValues],[3,cleared.data.custom]]);

    const scoreHistory=historyPath('contacts',contact.id,score.id);
    const enabledHistory=historyPath('contacts',contact.id,enabled.id);
    const deadlineHistory=historyPath('contacts',contact.id,deadline.id);
    const history=async(path,auth=headers)=>{
      const response=await request(path,{headers:auth});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      return response.json();
    };
    assert.deepEqual(changes(await history(scoreHistory)),[[1,null,0]]);
    assert.deepEqual(await history(historyPath('contacts',contact.id,score.id.toUpperCase())),await history(scoreHistory));
    assert.deepEqual(changes(await history(enabledHistory)),[[1,null,false]]);
    assert.deepEqual(changes(await history(deadlineHistory)),[[3,'2026-11-09',null],[1,null,'2026-11-09']]);
    const tagsHistory=historyPath('contacts',contact.id,tags.id);
    assert.deepEqual(changes(await history(tagsHistory)),[[1,null,choices.slice(0,2)]],
      'Reordered and case-varied choices do not produce another property change.');
    assert.deepEqual(changes(await history(historyPath('contacts',contact.id,status.id))),[[3,'Ready',null],[1,null,'Ready']]);
    assert.equal((await request(scoreHistory,{headers:{}})).status,401);
    assert.equal((await request(scoreHistory,{headers:other})).status,404);
    assert.equal((await request(scoreHistory+'&field=custom:'+foreign.id,{headers})).status,400);
    assert.equal((await request(historyPath('contacts',contact.id,'not-a-uuid'),{headers})).status,400);
    for(const id of [foreign.id,companyField.id,crypto.randomUUID()]){
      assert.equal((await request(historyPath('contacts',contact.id,id),{headers})).status,404);
    }

    const homepage=await (await request('/',{headers})).text();
    assert.match(homepage,/Manage properties/);
    for(const label of ['Multi-line text','URL','Email','Date and time','Multi-select'])assert.ok(homepage.includes(label));
    const contactPage=await (await request('/?contact='+contact.id,{headers})).text();
    assert.match(contactPage,/Edit all properties/);
    assert.doesNotMatch(contactPage,/<form class="portable-record-editor"/);
    assert.match(contactPage,/href="https:\/\/example.test\/resources"/);
    assert.match(contactPage,/href="mailto:Sales%2BTag@example.test"/);
    assert.match(contactPage,/<time dateTime="2026-11-01T05:30:23.456Z"/i);
    assert.match(contactPage,/Fictional north; Fictional alpha/);
    assert.match(contactPage,/&lt;script&gt;literal&lt;\/script&gt;/);

    // New linked deals open directly in the same editor a teammate opens from a saved record.
    const newDeal=await request('/?kind=deals&companyId='+company.id+'&add=1',{headers});
    assert.equal(newDeal.status,200);
    const editPage=await newDeal.text();
    assert.match(editPage,/<form class="portable-record-editor"/);
    assert.match(editPage,new RegExp('<textarea[^>]*name="custom:'+dealField.id+'"'));
    assert.match(editPage,new RegExp('<input(?=[^>]*inputMode="url")(?=[^>]*name="custom:'+dealUrl.id+'")','i'));
    assert.match(editPage,/type="datetime-local"/);
    assert.match(editPage,/class="multiple-choice"/);
    assert.match(editPage,/Clear selections/);
    assert.match(editPage,new RegExp('name="custom:'+dealTags.id+'"[^>]*value="'+String.raw`\[\]`+'"'));
    assert.match(editPage,new RegExp('name="custom:'+dealDateTime.id+'"[^>]*value=""'));

    const tokenResponse=await post(request,'/api/api-tokens',headers,origin,
      {name:'Fictional property read',objects:['contacts'],permission:'read',days:30});
    assert.equal(tokenResponse.status,201);
    const {token,info}=await tokenResponse.json();
    tokenId=info.id;
    const external=await request('/api/v1/records/contacts/'+contact.id,{headers:{authorization:'Bearer '+token}});
    assert.equal(external.status,200);
    assert.deepEqual((await external.json()).properties.custom,cleared.data.custom);
    const csv=await request('/api/crm?kind=contacts&export=csv&search='+encodeURIComponent(cleared.data.name),{headers});
    assert.equal(csv.status,200);
    const csvBody=await csv.text();
    assert.ok(csvBody.includes(cleared.data.name));
    assert.ok(!csvBody.includes(description.label));
    assert.ok(!csvBody.includes(scalarValues[url.id]));
    assert.ok(!csvBody.includes(tags.label));
    assert.ok(!csvBody.includes(choices[0]));
    for(const [kind,record,field] of [['companies',company,companyField],['deals',deal,dealField]]){
      assert.deepEqual((await (await read(kind,record.id)).json()).data.custom,record.data.custom);
      const page=await (await request('/?kind='+kind+'&record='+record.id,{headers})).text();
      assert.match(page,/Custom properties/);
      assert.ok(page.includes(field.label));
      assert.match(page,new RegExp('value="custom:'+field.id+'"[^>]*>'+field.label));
      const updated=await save(kind,{name:record.data.name,custom:{[field.id]:null}},
        {id:record.id,expectedRevision:1});
      assert.equal(updated.status,200);
      const remaining={...record.data.custom};
      delete remaining[field.id];
      assert.deepEqual((await updated.json()).record.data.custom,remaining);
      assert.deepEqual(changes(await history(historyPath(kind,record.id,field.id))),
        [[2,record.data.custom[field.id],null],[1,null,record.data.custom[field.id]]]);
    }

    await resetBudget(sql);
    const granted=await grants({action:'grant',email:'other@example.test'});
    assert.equal(granted.status,200);
    [{id:grantId}]=(await granted.json()).viewers;
    assert.equal((await list('contacts',other,workspaceId)).status,200);
    const viewer=await (await read('contacts',contact.id,other,true)).json();
    assert.deepEqual(viewer.data.custom,cleared.data.custom);
    const viewerPage=await (await request('/'+scope+'&contact='+contact.id,{headers:other})).text();
    assert.match(viewerPage,/Custom properties/);
    assert.doesNotMatch(viewerPage,/Manage properties/);
    assert.match(viewerPage,new RegExp('value="custom:'+score.id+'"[^>]*>'+rename.label));
    assert.match(viewerPage,/href="https:\/\/example.test\/resources"/);
    assert.match(viewerPage,/href="mailto:Sales%2BTag@example.test"/);
    assert.match(viewerPage,/<time dateTime="2026-11-01T05:30:23.456Z"/i);
    assert.match(viewerPage,/white-space:pre-wrap/);
    assert.match(viewerPage,/Fictional north; Fictional alpha/);
    const sharedHistory=enabledHistory+'&workspaceId='+workspaceId;
    assert.deepEqual(changes(await history(sharedHistory,other)),[[1,null,false]]);
    const scoped=()=>'/api/crm'+scope+'&grantId='+grantId;
    const sharedEdit={id:contact.id,expectedRevision:cleared.revision};
    const data={name:cleared.data.name,custom:{[enabled.id]:true,[url.id]:null,
      [datetime.id]:'2026-11-01T01:30:23.456-05:00',[tags.id]:[]}};
    assert.equal((await save('contacts',data,sharedEdit,other,scoped())).status,403);
    const promoted=await grants({action:'role',id:grantId,role:'editor'});
    assert.equal(promoted.status,200);
    [{id:grantId}]=(await promoted.json()).viewers;
    assert.equal((await admin({...rename,expectedRevision:2},other,origin,endpoint+scope)).status,403);
    const sharedSaved=await save('contacts',data,sharedEdit,other,scoped());
    assert.equal(sharedSaved.status,200);
    const sharedCustom={...scalarValues,[score.id]:0,[enabled.id]:true,[datetime.id]:'2026-11-01T06:30:23.456Z'};
    delete sharedCustom[url.id];
    delete sharedCustom[tags.id];
    assert.deepEqual((await sharedSaved.json()).record.data.custom,sharedCustom);
    const sharedTags=historyPath('contacts',contact.id,tags.id,{workspaceId});
    assert.deepEqual(changes(await history(sharedTags,other)),[[4,choices.slice(0,2),null],[1,null,choices.slice(0,2)]]);
    const sharedTime=historyPath('contacts',contact.id,datetime.id,{workspaceId});
    assert.deepEqual(changes(await history(sharedTime,other)),
      [[4,'2026-11-01T05:30:23.456Z','2026-11-01T06:30:23.456Z'],[1,null,'2026-11-01T05:30:23.456Z']]);
    assert.deepEqual(changes(await history(historyPath('contacts',contact.id,url.id))),
      [[4,'https://example.test/resources',null],[1,null,'https://example.test/resources']]);
    const editedHistory=await history(sharedHistory,other);
    assert.deepEqual(changes(editedHistory),[[4,false,true],[1,null,false]]);
    const [member]=await sql`SELECT full_name FROM login_identities WHERE email='other@example.test'`;
    assert.equal(editedHistory.items[0].actorName,member.full_name);
    assert.equal((await grants({action:'revoke',id:grantId})).status,200);
    const oldScope=scoped();
    grantId=undefined;
    assert.equal((await list('contacts',other,workspaceId)).status,404);
    assert.equal((await read('contacts',contact.id,other,true)).status,404);
    assert.equal((await save('contacts',data,{id:contact.id,expectedRevision:4},other,oldScope)).status,403);
    assert.equal((await request(sharedHistory,{headers:other})).status,404);
    assert.equal((await request(sharedTime,{headers:other})).status,404);
    assert.equal((await request(sharedTags,{headers:other})).status,404);
    assert.deepEqual(changes(await history(enabledHistory)),[[4,false,true],[1,null,false]]);

    // Page an actual series of saved custom edits without loading the full history.
    await resetBudget(sql);
    for(let revision=2;revision<28;revision++){
      const next=await save('deals',{name:deal.data.name,custom:{[dealField.id]:'Fictional revision '+(revision+1)}},
        {id:deal.id,expectedRevision:revision});
      assert.equal(next.status,200);
    }
    const newest=await history(historyPath('deals',deal.id,dealField.id));
    assert.equal(newest.items.length,25);
    assert.deepEqual(changes(newest)[0],[28,'Fictional revision 27','Fictional revision 28']);
    assert.equal(newest.next,4);
    const older=await history(historyPath('deals',deal.id,dealField.id,{before:newest.next}));
    assert.deepEqual(changes(older),[[3,null,'Fictional revision 3'],[2,'Deal typed text',null],[1,null,'Deal typed text']]);
    assert.equal(older.next,null);
  }finally{
    if(tokenId){
      await post(request,'/api/api-tokens',headers,origin,{action:'revoke',id:tokenId});
      await sql`DELETE FROM portable_api_tokens WHERE id=${tokenId}`;
    }
    if(grantId)await grants({action:'revoke',id:grantId});
    await sql`DELETE FROM contact_events WHERE contact_id=ANY(${recordIds.contacts}::uuid[])`;
    await sql`DELETE FROM company_events WHERE company_id=ANY(${recordIds.companies}::uuid[])`;
    await sql`DELETE FROM deal_events WHERE deal_id=ANY(${recordIds.deals}::uuid[])`;
    await sql`DELETE FROM contacts WHERE id=ANY(${recordIds.contacts}::uuid[])`;
    await sql`DELETE FROM companies WHERE id=ANY(${recordIds.companies}::uuid[])`;
    await sql`DELETE FROM deals WHERE id=ANY(${recordIds.deals}::uuid[])`;
    await sql`DELETE FROM portable_custom_properties WHERE id=ANY(${defIds}::uuid[])`;
    await resetBudget(sql);
  }
}

export async function seedCustomPropertyRecovery({request,origin,headers}){
  const suffix=crypto.randomUUID();
  const cases=[
    ['number','score',0,0],['textarea','notes','Fictional first line\nSecond line','Fictional first line\nSecond line'],
    ['url','resource','EXAMPLE.TEST','https://example.test/'],['email','contact','Pilot@EXAMPLE.TEST','Pilot@example.test'],
    ['datetime','appointment','2026-11-09T07:00:18.901-05:00','2026-11-09T12:00:18.901Z'],
    ['multiselect','labels',['alpha','NORTH','alpha'],['North','Alpha'],['North','Alpha','South']],
  ];
  const properties=[],custom={},expectedValues={};
  for(const [type,label,value,expected,options] of cases){
    const created=await post(request,endpoint,headers,origin,definition('contacts','Fictional restore '+label+' '+suffix,type,options));
    assert.equal(created.status,201);
    const {property}=await created.json();
    properties.push(property);
    custom[property.id]=value;
    expectedValues[property.id]=expected;
  }
  const contact=await post(request,'/api/crm',headers,origin,{action:'save',kind:'contacts',
    data:{name:'Fictional property recovery contact',custom}});
  assert.equal(contact.status,201);
  const {record}=await contact.json();
  assert.deepEqual(record.data.custom,expectedValues);
  return {properties,record,expectedValues};
}

export async function verifyRestoredCustomProperty({restored,owner,other,expected,source,target,workspaceId}){
  const {properties,record,expectedValues}=expected;
  const path=readPath('contacts',record.id);
  assert.deepEqual(await (await restored(path,{headers:owner})).json(),record);
  assert.equal((await restored(path,{headers:other})).status,404);
  const ownList=await (await restored(listPath('contacts'),{headers:owner})).json();
  const otherList=await (await restored(listPath('contacts'),{headers:other})).json();
  const history=db=>db`SELECT actor_id,revision,data FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${record.id}`;
  const restoredEvents=Array.from(await history(target));
  assert.deepEqual(restoredEvents,Array.from(await history(source)));
  assert.deepEqual(restoredEvents[0].data.custom,expectedValues);
  for(const property of properties){
    assert.ok(!otherList.properties.some(item=>item.id===property.id));
    assert.deepEqual(ownList.properties.find(item=>item.id===property.id),property);
    const propertyHistory=historyPath('contacts',record.id,property.id);
    const response=await restored(propertyHistory,{headers:owner});
    assert.equal(response.status,200);
    assert.deepEqual(changes(await response.json()),[[1,null,expectedValues[property.id]]]);
    assert.equal((await restored(propertyHistory,{headers:other})).status,404);
  }
}
