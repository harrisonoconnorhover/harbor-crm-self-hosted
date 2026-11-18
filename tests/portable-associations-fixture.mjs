import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyPortableAssociations({request,origin,headers,other,contact,company,deal,foreignContact,workspaceId,sql}){
  const source={kind:'contacts',id:contact.id},organization={kind:'companies',id:company.id},opportunity={kind:'deals',id:deal.id};
  const path=value=>'/api/associations?'+new URLSearchParams(value);
  const read=(value,auth=headers)=>request(path(value),{headers:auth});
  const write=(value,action,auth=headers,site=origin)=>request(path(value),{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(action)});
  const link=(target,labels=[])=>({action:'link',target,labels});
  const page=async value=>{
    const response=await read(value);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return response.json();
  };
  assert.equal((await read(source,{})).status,401);
  assert.equal((await read(source,other)).status,404);
  assert.equal((await read({...source,workspaceId},other)).status,200);
  assert.equal((await write(source,link(source))).status,400);
  assert.equal((await write(source,link({kind:'contacts',id:foreignContact.id}))).status,404);
  assert.equal((await write(source,link(organization),headers,'https://outside.example.test')).status,403);
  assert.equal((await request(path(source)+'&id='+foreignContact.id,{headers})).status,400);

  const linked=await Promise.all([
    write(source,link(organization,['Partner','Advisor','Partner'])),
    write(organization,link(source,['Advisor','Partner'])),
  ]);
  assert.deepEqual(linked.map(response=>response.status),[200,200]);
  const forward=await page(source),reverse=await page(organization);
  assert.deepEqual(forward.items,[{id:reverse.items[0].id,target:{...organization,name:company.data.name},labels:['Advisor','Partner']}]);
  assert.deepEqual(reverse.items,[{id:forward.items[0].id,target:{...source,name:contact.data.name},labels:['Advisor','Partner']}]);
  assert.equal((await write(source,link(organization,['Different label']))).status,409);
  assert.equal((await write(opportunity,link(source,['Decision maker']))).status,200);
  const removable=(await page(opportunity)).items[0].id;
  assert.equal((await write(opportunity,{action:'unlink',linkId:forward.items[0].id})).status,200);
  assert.equal((await page(source)).items.length,2,'unlink must address the record on the link');
  assert.equal((await write(source,{action:'unlink',linkId:removable})).status,200);
  assert.deepEqual((await page(opportunity)).items,[]);
  assert.equal((await write(opportunity,link(source,['Decision maker']))).status,200);
  assert.equal((await write(source,{action:'unlink',linkId:removable})).status,200);
  assert.equal((await page(source)).items.length,2,'stale unlink does not remove a recreated link');

  const seeded=Array.from({length:25},()=>crypto.randomUUID());
  await sql`INSERT INTO companies(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspaceId},id,1,'{"name":"Fictional association page"}',now(),now()
    FROM unnest(${seeded}::uuid[]) AS id`;
  try{
    await sql`INSERT INTO portable_associations(workspace_id,id,first_kind,first_id,second_kind,second_id,labels)
      SELECT ${workspaceId},gen_random_uuid(),'companies',id,'contacts',${contact.id},'[]'
      FROM unnest(${seeded}::uuid[]) AS id`;
    const first=await page(source),second=await page({...source,after:first.next});
    assert.equal(first.items.length,25);
    assert.equal(second.items.length,2);
    assert.equal(second.next,null);
    assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,27);
    assert.deepEqual(await (await read({...source,workspaceId},other)).json(),first);
    assert.deepEqual(await (await read({...source,workspaceId,after:first.next},other)).json(),second);
  }finally{
    await sql`DELETE FROM portable_associations WHERE workspace_id=${workspaceId} AND first_kind='companies' AND first_id=ANY(${seeded}::uuid[])`;
    await sql`DELETE FROM companies WHERE workspace_id=${workspaceId} AND id=ANY(${seeded}::uuid[])`;
  }
  assert.match(await (await request('/?contact='+contact.id,{headers})).text(),/aria-label="Additional associations"/);
  const ownerPage=await page(source);
  const grantId=await verifySharedAssociationAccess({request,origin,headers,other,sql,workspaceId,source,organization,opportunity,
    foreignContact,ownerPage});
  const currentContact=await (await request('/api/crm?id='+contact.id,{headers})).json();
  const currentDeal=await (await request('/api/crm?kind=deals&id='+deal.id,{headers})).json();
  assert.equal(currentContact.primaryCompanyId,contact.primaryCompanyId);
  assert.deepEqual([currentDeal.companyId,currentDeal.primaryContactId],[deal.companyId,deal.primaryContactId]);
  return {path:path(source),page:ownerPage,grantId,organization,opportunity};
}

function associationScope({request,origin,headers,other,workspaceId}){
  const path=value=>'/api/associations?'+new URLSearchParams({...value,workspaceId});
  const read=value=>request(path(value),{headers:other});
  const write=(value,action,grantId)=>request(path(value)+(grantId?'&grantId='+grantId:''),{method:'POST',
    headers:{...other,origin,'content-type':'application/json'},body:JSON.stringify(action)});
  async function change(action){
    const response=await request('/api/workspaces',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify(action)});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).viewers.find(grant=>grant.email==='other@example.test');
  }
  return {path,read,write,change};
}

async function verifySharedAssociationAccess({request,origin,headers,other,sql,workspaceId,source,organization,opportunity,
  foreignContact,ownerPage}){
  const {path,read,write,change}=associationScope({request,origin,headers,other,workspaceId});
  const [owner,guest]=await Promise.all([
    sql`SELECT id FROM login_identities WHERE email='owner@example.test'`,
    sql`SELECT id FROM login_identities WHERE email='other@example.test'`,
  ]);
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (${owner[0].id},${guest[0].id})`;
  await resetBudgets();
  const current=(await (await request('/api/workspaces',{headers})).json()).viewers.find(grant=>grant.email==='other@example.test');
  assert.equal(current.role,'editor');
  const link={action:'link',target:organization,labels:['Fictional shared link']};
  const existing=ownerPage.items.find(item=>item.target.id===organization.id);
  const unlink={action:'unlink',linkId:existing.id};

  const viewer=await change({action:'role',id:current.id,role:'viewer'});
  assert.deepEqual(await (await read(source)).json(),ownerPage);
  assert.equal((await write(source,unlink,viewer.id)).status,403);
  assert.equal((await write(opportunity,link,viewer.id)).status,403);
  assert.equal((await write(opportunity,link,current.id)).status,403);
  assert.equal((await write(opportunity,link)).status,403);
  assert.equal((await request(path(source)+'&workspaceId='+crypto.randomUUID(),{headers:other})).status,400);
  const recordPage='/?contact='+source.id+'&workspaceId='+workspaceId;
  const viewerPage=await request(recordPage,{headers:other});
  assert.equal(viewerPage.status,200);
  const viewerHtml=await viewerPage.text();
  assert.match(viewerHtml,/aria-label="Additional associations"/);
  assert.doesNotMatch(viewerHtml,/>Link record<|>Remove link</);

  const editor=await change({action:'role',id:viewer.id,role:'editor'});
  assert.notEqual(editor.id,viewer.id);
  assert.equal((await write(opportunity,link,viewer.id)).status,403);
  assert.equal((await write(opportunity,{...link,target:{kind:'contacts',id:foreignContact.id}},editor.id)).status,404);
  assert.equal((await read({kind:'contacts',id:foreignContact.id})).status,404);
  const editorPage=await request(recordPage,{headers:other});
  assert.equal(editorPage.status,200);
  assert.match(await editorPage.text(),/>Link record</);
  assert.equal((await write(opportunity,link,editor.id)).status,200);
  assert.equal((await write(organization,{...link,target:opportunity},editor.id)).status,200);
  const linked=(await (await read(opportunity)).json()).items.filter(item=>item.target.id===organization.id);
  assert.equal(linked.length,1);
  assert.deepEqual(linked[0].labels,link.labels);
  assert.equal((await write(opportunity,{action:'unlink',linkId:linked[0].id},editor.id)).status,200);
  assert.deepEqual(await (await read(source)).json(),ownerPage);

  // The write sees the old grant before the uncommitted revoke. It must wait
  // for the grant row and then reject the request with no new link.
  let pending;
  await sql.begin(async tx=>{
    await tx`DELETE FROM portable_workspace_viewers WHERE id=${editor.id}`;
    pending=write(opportunity,link,editor.id);
    let waiting=false;
    for(let attempt=0;attempt<40&&!waiting;attempt++){
      const [row]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%portable_workspace_viewers%' AND query LIKE '%for share%') AS waiting`;
      waiting=row.waiting;
      if(!waiting)await delay(30);
    }
    assert.ok(waiting,'The prepared association write must wait for the grant row.');
  });
  assert.equal((await pending).status,403);
  assert.equal((await read(source)).status,404);
  assert.equal((await request(recordPage,{headers:other})).status,404);
  assert.equal((await write(source,unlink,editor.id)).status,403);
  const privateDeal='/api/associations?'+new URLSearchParams(opportunity);
  const ownerDeal=await (await request(privateDeal,{headers})).json();
  assert.ok(ownerDeal.items.every(item=>item.target.id!==organization.id));

  let regranted=await change({action:'grant',email:'other@example.test'});
  regranted=await change({action:'role',id:regranted.id,role:'editor'});
  for(const [flag,action] of [['contactFiles','contact_files'],['scheduledNotes','scheduled_notes'],['contactOutreach','contact_outreach']]){
    if(current[flag])regranted=await change({action,id:regranted.id,enabled:true});
  }
  assert.notEqual(regranted.id,editor.id);
  assert.equal((await write(source,unlink,editor.id)).status,403);
  assert.deepEqual(await (await read(source)).json(),ownerPage);
  await resetBudgets();
  return regranted.id;
}

export async function verifyRestoredSharedAssociations({request,origin,owner,other,workspaceId,associations}){
  const {path:privatePath,page,grantId,organization,opportunity}=associations;
  const source=Object.fromEntries(new URL(privatePath,origin).searchParams);
  const {read,write,change}=associationScope({request,origin,headers:owner,other,workspaceId});
  const link={action:'link',target:organization,labels:['Restore access check']};
  assert.equal((await read(source)).status,404);
  assert.equal((await write(opportunity,link,grantId)).status,403);
  let grant=await change({action:'grant',email:'other@example.test'});
  try{
    assert.deepEqual(await (await read(source)).json(),page);
    assert.equal((await write(opportunity,link,grant.id)).status,403);
    grant=await change({action:'role',id:grant.id,role:'editor'});
    assert.notEqual(grant.id,grantId);
    assert.equal((await write(opportunity,link,grantId)).status,403);
    assert.equal((await write(opportunity,link,grant.id)).status,200);
    const linked=(await (await read(opportunity)).json()).items.find(item=>item.target.id===organization.id);
    assert.deepEqual(linked.labels,link.labels);
    assert.equal((await write(opportunity,{action:'unlink',linkId:linked.id},grant.id)).status,200);
    assert.deepEqual(await (await read(source)).json(),page);
  }finally{await change({action:'revoke',id:grant.id});}
  assert.equal((await read(source)).status,404);
}
