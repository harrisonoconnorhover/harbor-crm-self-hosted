import assert from 'node:assert/strict';

const endpoint='/api/property-groups';
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

export async function verifyPortablePropertyGroups({request,origin,headers,other,sql}){
  const {owned:workspaceId}=await (await request('/api/workspaces',{headers})).json();
  const post=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=(kind='contacts',auth=headers)=>request(endpoint+'?kind='+kind,{headers:auth});
  const write=(revision,change,kind='contacts',auth=headers)=>post(endpoint,{kind,revision,change},auth);
  const defaultState=kind=>({kind,revision:0,groups:[],assignments:{}});
  const prefix='Fictional group '+crypto.randomUUID();
  const group={id:crypto.randomUUID(),name:prefix+' original'};
  const createGroup={action:'create',...group};
  const savedFields=[];
  let contactId;
  await resetBudget(sql);
  try{
    async function field(kind){
      const response=await post('/api/custom-properties',{action:'create',kind,label:prefix,type:'text'});
      assert.equal(response.status,201,await response.clone().text());
      const {property}=await response.json();
      savedFields.push(property.id);
      return property;
    }
    const contactProperty=await field('contacts'),companyProperty=await field('companies');
    const custom='custom:'+contactProperty.id;
    const createdContact=await post('/api/crm',{action:'save',kind:'contacts',
      data:{name:prefix,phone:'202-555-0108',custom:{[contactProperty.id]:'Fictional unchanged value'}}});
    assert.equal(createdContact.status,201,await createdContact.clone().text());
    const {record}=await createdContact.json();
    contactId=record.id;
    assert.equal((await read('contacts',{})).status,401);
    assert.equal((await read('tickets')).status,400);
    assert.equal((await request(endpoint+'?kind=contacts&kind=deals',{headers})).status,400);
    assert.equal((await request(endpoint+'?kind=contacts&workspaceId='+workspaceId,{headers:other})).status,403);
    assert.equal((await post(endpoint,{kind:'contacts',revision:0,change:createGroup},headers,'https://outside.example.test')).status,403);
    const empty=await read();
    assert.equal(empty.status,200);
    assert.equal(empty.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await empty.json(),defaultState('contacts'));
    const created=await write(0,createGroup);
    assert.equal(created.status,200,await created.clone().text());
    const revisionOne={kind:'contacts',revision:1,groups:[group],assignments:{}};
    assert.deepEqual(await created.json(),revisionOne);
    assert.deepEqual(await (await write(0,createGroup)).json(),revisionOne);
    assert.equal((await write(1,{...createGroup,id:crypto.randomUUID(),name:group.name.toUpperCase()})).status,400);
    assert.equal((await write(1,{action:'rename',id:'default:custom',name:'Fictional default edit'})).status,400);
    assert.equal((await write(0,{action:'rename',id:group.id,name:'Wrong workspace'},'contacts',other)).status,400);
    assert.deepEqual(await (await read('contacts',other)).json(),defaultState('contacts'));
    assert.deepEqual(await (await read('companies')).json(),defaultState('companies'));

    const candidates=await Promise.all(['first','second'].map(suffix=>write(1,
      {action:'rename',id:group.id,name:prefix+' '+suffix})));
    assert.deepEqual(candidates.map(response=>response.status).sort(),[200,409]);
    const renamed=await candidates.find(response=>response.status===200).json();
    assert.equal(renamed.revision,2);
    assert.equal(renamed.groups[0].id,group.id);
    const move={action:'move',group:group.id,fields:[custom,'phone','postalCode']};
    assert.equal((await write(2,{...move,fields:['custom:'+companyProperty.id]})).status,400);
    assert.equal((await write(2,{...move,fields:['amount']})).status,400);
    assert.equal((await write(2,{...move,fields:[custom,custom]})).status,400);
    const moved=await write(2,move);
    assert.equal(moved.status,200,await moved.clone().text());
    assert.deepEqual(await moved.json(),{...renamed,revision:3,assignments:{[custom]:group.id,phone:group.id,postalCode:group.id}});
    assert.equal((await write(3,{action:'delete',id:group.id})).status,400);
    assert.equal((await write(3,{action:'delete',id:'default:custom'})).status,400);
    const propertyList=await (await request('/api/custom-properties?kind=contacts',{headers})).json();
    assert.deepEqual(propertyList.properties.find(property=>property.id===contactProperty.id),contactProperty);
    const current=await (await request('/api/crm?kind=contacts&id='+contactId,{headers})).json();
    assert.deepEqual(current,record,'Group edits must preserve values and record revision.');
    const detail=await (await request('/?contact='+contactId,{headers})).text();
    const dialog=detail.match(/<dialog[^>]*class="portable-properties-dialog"[\s\S]*?<\/dialog>/)?.[0];
    assert.ok(dialog,'The record provides a dedicated read-only property browser.');
    const sections=dialog.split('</section>');
    assert.ok(sections.some(section=>section.includes('<h3>'+renamed.groups[0].name+'</h3>')&&
      section.includes('<dt>Phone</dt>')&&section.includes('Fictional unchanged value')));
    const restoredDefault=await write(3,{...move,group:'default:custom',fields:[custom]});
    assert.deepEqual(await restoredDefault.json(),{...renamed,revision:4,assignments:{phone:group.id,postalCode:group.id}});
    assert.equal((await write(4,{...move,group:'default:contact_information',fields:['phone']})).status,200);
    assert.equal((await write(5,{...move,group:'default:address',fields:['postalCode']})).status,200);
    assert.deepEqual(await (await write(6,{action:'delete',id:group.id})).json(),
      {...defaultState('contacts'),revision:7});
    assert.deepEqual(await (await read()).json(),{...defaultState('contacts'),revision:7});

    const legacyGroup={id:crypto.randomUUID(),name:'Contact information'};
    const legacy={groups:[legacyGroup],assignments:{[custom]:legacyGroup.id}};
    await sql`UPDATE portable_property_organizations SET revision=8,config=${sql.json(legacy)}
      WHERE workspace_id=${workspaceId} AND kind='contacts'`;
    assert.deepEqual(await (await write(0,{action:'create',...legacyGroup})).json(),{kind:'contacts',revision:8,...legacy});
    assert.equal((await write(8,{action:'create',id:crypto.randomUUID(),name:legacyGroup.name})).status,400);
    for(const [kind,standard] of [['companies','domain'],['deals','amount']]){
      assert.equal((await write(0,createGroup,kind)).status,200);
      const moved=await write(1,{...move,fields:[standard]},kind);
      assert.equal(moved.status,200,await moved.clone().text());
      assert.deepEqual((await moved.json()).assignments,{[standard]:group.id});
    }
    const homepage=await (await request('/',{headers})).text();
    assert.match(homepage,/Manage properties/);
  }finally{
    await sql`DELETE FROM portable_property_organizations WHERE workspace_id=${workspaceId} AND kind IN ('contacts','companies','deals')`;
    if(contactId){
      await sql`DELETE FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${contactId}`;
      await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=${contactId}`;
    }
    if(savedFields.length)await sql`DELETE FROM portable_custom_properties WHERE workspace_id=${workspaceId}
      AND id=ANY(${savedFields}::uuid[])`;
    await resetBudget(sql);
  }
}
