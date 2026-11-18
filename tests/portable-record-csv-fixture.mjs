import assert from 'node:assert/strict';

export async function verifyPortableRecordCsv({request,headers,other,sql,workspaceId,contact,company,deal}){
  const route=(query)=>'/api/crm?'+new URLSearchParams(query);
  const download=(auth,kind,filters={},method='GET')=>request(route({export:'csv',kind,...filters}),{headers:auth,method});
  const resetReadBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetReadBudget();
  const marker='CSV fixture '+crypto.randomUUID();
  async function csv(response,kind){
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'text/csv; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'),`attachment; filename="harbor-${kind}.csv"`);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    return response.text();
  }

  try{
    assert.equal((await download({},'contacts')).status,401);
    for(const auth of [headers,other]){
      const denied=await download(auth,'contacts',{workspaceId});
      assert.equal(denied.status,403);
      assert.equal(denied.headers.get('content-disposition'),null);
    }
    for(const filters of [{limit:'1'},{id:contact.id},{after:contact.id},{pipelineId:'default'}]){
      assert.equal((await download(headers,'contacts',filters)).status,400);
    }
    assert.equal((await request('/api/crm?export=csv&search=First&search=Second',{headers})).status,400);

    const contacts=await csv(await download(headers,'contacts',{companyId:company.id,search:contact.data.name}),'contacts');
    assert.match(contacts,/"Record ID","Name","Email"/);
    assert.ok(contacts.includes(contact.id)&&contacts.includes(company.id));
    assert.doesNotMatch(contacts,/Other only|Owner second/);
    const foreign=await csv(await download(other,'contacts',{companyId:company.id}),'contacts');
    assert.equal(foreign,contacts.split('\r\n')[0]+'\r\n');
    const filteredDeals={companyId:company.id,pipelineId:'default',stage:deal.data.stage,closeMonth:'2026-12',search:'Owner Deal'};
    const deals=await csv(await download(headers,'deals',filteredDeals),'deals');
    assert.ok(deals.includes(deal.id)&&deals.includes(contact.id)&&deals.includes('"Review the proposal"'));
    assert.doesNotMatch(deals,/Other Deal|Owner Second Deal/);
    const emptyDeals=await csv(await download(headers,'deals',{...filteredDeals,closeMonth:'2027-01'}),'deals');
    assert.equal(emptyDeals,deals.split('\r\n')[0]+'\r\n');
    const primaryContact=await csv(await download(headers,'deals',{primaryContactId:contact.id}),'deals');
    assert.ok(primaryContact.includes(deal.id));
    assert.doesNotMatch(primaryContact,/Other Deal|Owner Second Deal/);
    const head=await download(headers,'contacts',{},'HEAD');
    assert.equal(await csv(head,'contacts'),'');

    const ownHtml=await (await request('/?kind=companies&search=Owner',{headers})).text();
    const sharedHtml=await (await request('/?kind=companies&workspaceId='+workspaceId,{headers:other})).text();
    assert.match(ownHtml,/>Export CSV</);
    assert.doesNotMatch(sharedHtml,/>Export CSV</);

    const companyData={name:marker+' =fixture',industry:'　＝SUM(1,2)',description:'Quoted "text", line\nnext',
      numberOfEmployees:0,targetAccount:false};
    await sql`INSERT INTO companies (workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspaceId},gen_random_uuid(),1,${sql.json(companyData)},now(),now())`;
    const escaped=await csv(await download(headers,'companies',{search:marker}),'companies');
    assert.ok(escaped.includes('"\'　＝SUM(1,2)"'));
    assert.ok(escaped.includes('"Quoted ""text"", line\nnext"'));
    assert.ok(escaped.includes('"Number of employees"')&&escaped.includes('"0"')&&escaped.includes('"false"'));
    const ownCompanies=await csv(await download(headers,'companies',{search:'Owner'}),'companies');
    assert.ok(ownCompanies.includes(company.id));
    assert.match(ownCompanies,/Owner Second Company/);
    assert.doesNotMatch(ownCompanies,/Other Company/);

    await sql`INSERT INTO companies (workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspaceId},gen_random_uuid(),1,jsonb_build_object('name',${marker}::text||' '||n),now(),now()
      FROM generate_series(1,499) AS n`;
    const atLimit=await csv(await download(headers,'companies',{search:marker}),'companies');
    assert.equal(atLimit.split('\r\n').length,502,'All 500 matches should download, plus a header.');
    await sql`INSERT INTO companies (workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspaceId},gen_random_uuid(),1,jsonb_build_object('name',${marker}::text||' 500'),now(),now())`;
    const overflow=await download(headers,'companies',{search:marker});
    assert.equal(overflow.status,413);
    assert.equal(overflow.headers.get('content-disposition'),null);
    assert.match((await overflow.json()).error,/more than 500.*Narrow/);
    const list=await (await request(route({kind:'companies',search:marker,limit:'1'}),{headers})).json();
    assert.equal(list.records.length,1);
    assert.ok(list.next,'Normal list cursors still page the same population.');
  }finally{
    await sql`DELETE FROM companies WHERE workspace_id=${workspaceId} AND data->>'name' LIKE ${marker+'%'}`;
    await resetReadBudget();
  }
}
