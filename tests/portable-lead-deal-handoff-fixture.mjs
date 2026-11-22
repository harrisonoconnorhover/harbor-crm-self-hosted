import assert from 'node:assert/strict';

export async function verifyLeadDealHandoff({browser,page,origin,owner,rep,ownerId,workspaceId,changeGrant,sql,write}){
  await changeGrant({action:'role',role:'editor'});
  const ownerPage=await browser.newPage({viewport:{width:1350,height:900}});
  const [name,value]=owner.cookie.split('=');
  await ownerPage.context().addCookies([{name,value,url:origin}]);
  const {record:contact}=await write('/api/crm',{action:'save',kind:'contacts',data:{name:'Handoff contact'}});
  const {record:company}=await write('/api/crm',{action:'save',kind:'companies',data:{name:'Handoff company'}});
  const createLead=(name,assigneeId)=>write('/api/leads',{action:'save',data:{name},assigneeId,contactId:contact.id,companyId:company.id});
  const leadPath=id=>origin+'/?kind=leads&record='+id;
  const {id}=await createLead('Convert my assigned lead',null);
  await ownerPage.goto(leadPath(id));
  const edit=ownerPage.getByRole('form',{name:'Edit lead'});
  await edit.getByLabel('Assignee').selectOption(rep);
  const label=await edit.getByLabel('Assignee').locator('option:checked').innerText();
  await edit.getByRole('button',{name:'Save lead'}).click();
  await ownerPage.getByText('Lead saved.',{exact:true}).waitFor();

  const sharedList=await page.goto(origin+'/?kind=leads&workspaceId='+workspaceId);
  assert.equal(sharedList.status(),200);
  const filters=page.getByRole('form',{name:'Lead filters'});
  await filters.locator('select[name="owner"]').selectOption({label:'My leads'});
  await filters.getByRole('button',{name:'Apply'}).click();
  await page.getByRole('link',{name:'Convert my assigned lead',exact:true}).click();
  await page.getByText('Convert to deal',{exact:true}).click();
  const convert=page.getByRole('form',{name:'Convert lead to deal'});
  await convert.getByText('Deal owner: '+label,{exact:true}).waitFor();
  await convert.getByRole('button',{name:'Create deal'}).click();
  await page.getByRole('link',{name:'Open converted deal'}).click();
  const dealId=new URL(page.url()).searchParams.get('record');
  assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
  const displayedOwner=page.getByRole('region',{name:'Key information'}).locator('dt').filter({hasText:/^Record owner$/}).locator('+ dd');
  assert.equal(await displayedOwner.innerText(),label);
  const [saved]=await sql`SELECT company_id,primary_contact_id,data->'recordOwner'->>'userId' AS assignee FROM deals WHERE workspace_id=${workspaceId} AND id=${dealId}`;
  assert.deepEqual({...saved},{company_id:company.id,primary_contact_id:contact.id,assignee:rep});

  // The actor and the intended deal owner can be different. Concurrent clicks reuse the same linked deal.
  const second=await createLead('Owner converts for a teammate',rep);
  const input={action:'convert',id:second.id,expectedRevision:1,dealName:'Deal for a teammate'};
  const results=await Promise.all([write('/api/leads',input),write('/api/leads',input)]);
  assert.equal(results[0].dealId,results[1].dealId);
  assert.deepEqual(results.map(row=>row.created).sort(),[false,true]);
  const [delegated]=await sql`SELECT data->'recordOwner'->>'userId' AS assignee FROM deals WHERE workspace_id=${workspaceId} AND id=${results[0].dealId}`;
  assert.equal(delegated.assignee,rep);
  const empty=await createLead('Intentionally unassigned lead',null);
  const unassigned=await write('/api/leads',{...input,id:empty.id,dealName:'Intentionally unassigned deal'});
  const [unowned]=await sql`SELECT data->'recordOwner'->>'userId' AS assignee FROM deals WHERE workspace_id=${workspaceId} AND id=${unassigned.dealId}`;
  assert.equal(unowned.assignee,null);

  const stale=await createLead('Owner left before conversion',rep);
  await ownerPage.goto(leadPath(stale.id));
  await ownerPage.getByText('Convert to deal',{exact:true}).click();
  await changeGrant({action:'role',role:'viewer'});
  await ownerPage.getByRole('form',{name:'Convert lead to deal'}).getByRole('button',{name:'Create deal'}).click();
  await ownerPage.getByRole('alert').filter({hasText:'Reassign this lead'}).waitFor();
  const [unchanged]=await sql`SELECT assignee_id,deal_id,revision,data->>'leadStage' AS stage,
    (SELECT count(*)::int FROM deals WHERE workspace_id=${workspaceId} AND data->>'name'='Owner left before conversion') AS created
    FROM portable_leads WHERE workspace_id=${workspaceId} AND id=${stale.id}`;
  assert.deepEqual({...unchanged},{assignee_id:rep,deal_id:null,revision:1,stage:'New',created:0});
  await ownerPage.reload();
  await edit.getByLabel('Assignee').selectOption(ownerId);
  await edit.getByRole('button',{name:'Save lead'}).click();
  await ownerPage.getByText('Lead saved.',{exact:true}).waitFor();
  await ownerPage.getByText('Convert to deal',{exact:true}).click();
  await ownerPage.getByRole('form',{name:'Convert lead to deal'}).getByRole('button',{name:'Create deal'}).click();
  await ownerPage.getByRole('link',{name:'Open converted deal'}).waitFor();
  await ownerPage.close();
}
