import assert from 'node:assert/strict';

export async function verifyPortableLeads({request,origin,headers,other,sql,sharing,contact,company,otherContact}){
  const path='/api/leads';
  const get=(query='',auth=headers)=>request(path+query,{headers:auth});
  const post=(data,auth=headers,query='',source=origin)=>request(path+query,{method:'POST',
    headers:{...auth,origin:source,'content-type':'application/json'},body:JSON.stringify(data)});
  const input={action:'save',data:{name:'Fictional lead % research',leadType:'New business',leadLabel:'Warm'},
    companyId:company.id,contactId:contact.id};
  assert.equal((await get('',{})).status,401);
  assert.equal((await get('?limit=1&limit=2')).status,400);
  assert.equal((await get('?limit=51')).status,400);
  assert.equal((await post(input,headers,'','https://elsewhere.example.test')).status,403);
  assert.equal((await post(input,other)).status,404);
  assert.equal((await post({...input,contactId:otherContact.id})).status,404);
  assert.equal((await post(input,other,'?workspaceId='+sharing.workspaceId)).status,403);
  const created=await post(input);
  assert.equal(created.status,201,await created.clone().text());
  const {id}=await created.json();
  const byId='?id='+id;
  assert.equal((await get(byId,other)).status,404);
  assert.equal((await get(byId+'&workspaceId='+sharing.workspaceId,other)).status,200,'workspace members read shared Leads');
  const lead=await (await get(byId)).json();
  assert.deepEqual([lead.revision,lead.data.leadStage,lead.contactId,lead.companyId,lead.contactName,lead.companyName],
    [1,'New',contact.id,company.id,contact.data.name,company.data.name]);
  const html=await request('/?kind=leads&record='+id,{headers});
  assert.equal(html.status,200);
  assert.match(await html.text(),/Fictional lead % research/);
  assert.equal((await request('/?kind=leads&record='+id,{headers:other})).status,404);

  const stale={action:'save',id,expectedRevision:1,data:{name:lead.data.name,leadStage:'Disqualified',
    disqualificationCategory:'Bad timing',disqualificationReason:'Review next quarter.'}};
  assert.equal((await post(stale)).status,200);
  assert.equal((await post(stale)).status,409);
  const conversion={action:'convert',id,expectedRevision:2,dealName:'Converted fictional lead'};
  assert.equal((await post(conversion)).status,409);
  const disqualified=await (await get('?stage=Disqualified&search=%25')).json();
  assert.deepEqual(disqualified.records.map(record=>record.id),[id]);
  assert.equal(disqualified.records[0].data.leadLabel,'Warm');
  assert.equal(disqualified.records[0].data.disqualificationCategory,'Bad timing');
  assert.equal((await post({...stale,expectedRevision:2,data:{name:lead.data.name,leadStage:'Connected'}})).status,200);
  assert.equal((await post(conversion)).status,409);

  const accepted={...conversion,expectedRevision:3};
  // A failure after deal insertion must roll back both the deal and its audit event.
  await sql`ALTER TABLE portable_leads ADD CONSTRAINT fixture_block_conversion CHECK (deal_id IS NULL)`;
  try{
    assert.equal((await post(accepted)).status,500);
    assert.equal((await sql`SELECT id FROM deals WHERE data->>'name'=${accepted.dealName}`).length,0);
    const unchanged=await (await get(byId)).json();
    assert.deepEqual([unchanged.revision,unchanged.data.leadStage,unchanged.dealId],[3,'Connected',null]);
  }finally{await sql`ALTER TABLE portable_leads DROP CONSTRAINT fixture_block_conversion`;}
  const races=await Promise.all([post(accepted),post(accepted)]);
  assert.deepEqual(races.map(response=>response.status).sort(),[200,201]);
  const [one,two]=await Promise.all(races.map(response=>response.json()));
  assert.ok(one.dealId);
  assert.equal(one.dealId,two.dealId);
  const converted=await (await get(byId)).json();
  assert.deepEqual([converted.revision,converted.data.leadStage,converted.dealId],[4,'Qualified',one.dealId]);
  const dealPath='/api/crm?kind=deals&id='+one.dealId;
  const deal=await (await request(dealPath,{headers})).json();
  assert.deepEqual([deal.revision,deal.data.name,deal.primaryContactId,deal.companyId],
    [1,accepted.dealName,contact.id,company.id]);
  assert.equal((await request(dealPath,{headers:other})).status,404);
  assert.deepEqual(Array.from(await sql`SELECT revision FROM deal_events WHERE deal_id=${deal.id}`),[{revision:1}]);
  assert.equal((await sql`SELECT id FROM deals WHERE data->>'name'=${accepted.dealName}`).length,1);
  const otherLead=await post({action:'save',data:{name:'Fictional lead secondary'}});
  assert.equal(otherLead.status,201);
  const first=await (await get('?search=Fictional+lead&limit=1')).json();
  assert.equal(first.records.length,1);
  assert.equal(first.next,first.records[0].id);
  const last=await (await get('?search=Fictional+lead&limit=1&after='+first.next)).json();
  assert.equal(last.records.length,1);
  assert.notEqual(last.records[0].id,first.records[0].id);
  assert.equal(last.next,null);
  assert.deepEqual((await (await get('',other)).json()).records,[]);
  return {converted,deal,accepted};
}

export async function verifyRestoredLead({restored,origin,owner,other,leads}){
  const {converted,deal,accepted}=leads;
  const path='/api/leads?id='+converted.id;
  assert.deepEqual(await (await restored(path,{headers:owner})).json(),converted);
  assert.equal((await restored(path,{headers:other})).status,404);
  const retry=await restored('/api/leads',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
    body:JSON.stringify(accepted)});
  assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{id:converted.id,dealId:deal.id,created:false});
  assert.deepEqual(await (await restored('/api/crm?kind=deals&id='+deal.id,{headers:owner})).json(),deal);
}
