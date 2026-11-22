import assert from 'node:assert/strict';

export async function verifyImportAccess({send,get,sql,ok,workspaceId,other}){
  const save=async(kind,data)=>(await (await ok(send('/api/crm',{action:'save',kind,data}))).json()).record.id;
  const contact=await save('contacts',{name:'Briar Mills',email:'briar@example.test',city:'Dover'});
  const company=await save('companies',{name:'Dockyard Research',domain:'dockyard.example.test'});
  const deal=await save('deals',{name:'Dockyard renewal',amount:1200});
  const path='/api/crm/import';
  const preview=(kind,csv,options={})=>({action:'preview',kind,csv,...options});
  const request=async input=>(await ok(send(path,input))).json();
  const events=()=>sql`SELECT kind,record_ids,actor_email FROM portable_record_access_events
    WHERE action='import_preview' AND workspace_id=${workspaceId} ORDER BY kind,occurred_at,id`;
  const mixed=preview('contacts',[
    'Name,Email,City,Company ID',',briar@example.test,Boston,',
    'Lee,lee@example.test,,'+company,'Sam,sam@example.test,,'+company,
  ].join('\n'),{reviewMatches:true,mapping:['name','email','city','primaryCompanyId']});
  await request({kind:'contacts',action:'columns',csv:mixed.csv,reviewMatches:true});
  const denied=await send(path+'?workspaceId='+workspaceId,mixed,other);
  assert.equal(denied.status,403);
  assert.deepEqual([...(await events())],[]);
  const result=await request(mixed);
  assert.deepEqual(result.rows[0].changes,[{field:'city',label:'City',before:'Dover',after:'Boston'}]);
  assert.deepEqual(result.rows.slice(1).map(row=>row.company),['Dockyard Research','Dockyard Research']);
  assert.deepEqual((await events()).map(row=>[row.kind,row.record_ids,row.actor_email]),[
    ['companies',[company],'owner@example.test'],['contacts',[contact],'owner@example.test'],
  ]);
  const same=await request(preview('deals','Record ID,Amount\n'+deal+',1200',{reviewMatches:true}));
  assert.match(same.rows[0].message,/No changes.*Dockyard renewal/);
  await request(preview('companies','Record ID,City\n'+company+',Bristol',{reviewMatches:true}));
  const pair=await request(preview('paired','Contact name,Contact email,Company name,Company domain\nJo,jo@example.test,Dockyard,dockyard.example.test',
    {mapping:['contacts/name','contacts/email','companies/name','companies/domain']}));
  assert.equal(pair.paired.reusedCompanies,1);
  assert.deepEqual((await events()).map(row=>[row.kind,row.record_ids]),[
    ['companies',[company]],['companies',[company]],['companies',[company]],['contacts',[contact]],['deals',[deal]],
  ]);
  const history=await ok(get('/?view=record-access&action=import_preview&record='+deal));
  const historyRows=(await history.text()).match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(historyRows?.includes('Import preview')&&historyRows.includes(deal));
  await sql`UPDATE companies SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${company}`;
  const invalid=await request(preview('contacts','Name,Company ID\nAvery,'+company,{mapping:['name','primaryCompanyId']}));
  assert.equal(invalid.errors,1);
  assert.ok(!JSON.stringify(invalid).includes('Dockyard Research'));
  assert.equal((await events()).length,5);
  await sql`UPDATE companies SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${company}`;
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_deny_import_company
    CHECK (action<>'import_preview' OR kind<>'companies') NOT VALID`;
  try{
    const blocked=await send(path,mixed);
    assert.equal(blocked.status,503);
    assert.ok(!(await blocked.text()).includes('Dover'));
    assert.equal((await events()).length,5,'A failed company receipt rolls back the contact receipt.');
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_deny_import_company`;}
  const commit={...mixed,action:'import',requestId:crypto.randomUUID(),review:result.review,includeNew:false,updateRows:[2]};
  assert.equal((await send(path,commit)).status,201);
  assert.equal((await send(path,commit)).status,200);
  assert.equal((await events()).length,5,'Applying and replaying an import only return totals.');
}
