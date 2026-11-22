import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyCallsNavigation({owner,nav,request,post,sql,other,workspaceId,grant}){
  const at=Date.now()-5000;
  const [{viewer_id:viewerId}]=await sql`SELECT viewer_id FROM portable_workspace_viewers WHERE id=${grant}`;
  const scope='/?view=calls&workspaceId='+workspaceId;
  const recordIds={};
  const receipts=()=>sql`SELECT kind,record_ids FROM portable_record_access_events WHERE workspace_id=${workspaceId}
    AND actor_id=${viewerId} AND action='related' ORDER BY occurred_at,id`;
  for(const kind of ['contacts','companies','deals']){
    const created=await (await post('/api/crm',{action:'save',kind,data:{name:'Call navigation '+kind}})).json();
    const id=created.record.id;recordIds[kind]=id;
    const path='/api/logged-activities?'+(kind==='contacts'?'contactId='+id:new URLSearchParams({kind,recordId:id}));
    const call=await post(path,{id:randomUUID(),kind:'Call',occurredAt:at,summary:'Discussed renewal with '+kind});
    assert.equal(call.status,201,await call.clone().text());
    if(kind==='contacts'){
      // Equal timestamps exercise the tie-break on the boundary between pages.
      await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
        SELECT workspace_id,gen_random_uuid(),contact_id,actor_id,'Call',${at-1000},recorded_at,'Earlier renewal callback '||n
        FROM portable_contact_activities CROSS JOIN generate_series(1,25) n WHERE workspace_id=${workspaceId} AND contact_id=${id} AND kind='Call'`;
    }
  }
  await nav.getByRole('button',{name:'CRM',exact:true}).click();
  await nav.getByRole('link',{name:'Calls',exact:true}).click();
  await owner.getByRole('heading',{name:'Calls',exact:true}).waitFor();
  const summaries=()=>owner.locator('.portable-call-list li p').allTextContents();
  const first=await summaries();
  assert.equal(first.length,25);
  const record=owner.locator('.portable-call-list').getByRole('link',{name:'Call navigation deals'}).first();
  await record.click();
  const history=owner.getByRole('link',{name:'View record access history',exact:true});
  const url=new URL(await history.getAttribute('href'),owner.url());
  assert.equal(url.searchParams.get('kind'),'deals');assert.equal(url.searchParams.get('record'),recordIds.deals);
  await history.click();
  await owner.getByRole('heading',{name:'Record access history'}).waitFor();
  assert.ok((await owner.locator('tbody').innerText()).includes('Linked record preview'));
  await owner.goBack();
  await owner.getByRole('link',{name:'Back to Calls',exact:true}).click();
  await owner.getByRole('link',{name:'Older calls'}).click();
  const rest=await summaries();
  assert.equal(rest.length,3);
  assert.equal(new Set([...first,...rest]).size,28);
  await owner.getByRole('link',{name:'Latest calls'}).click();
  const search=owner.getByRole('search',{name:'Call history'});
  await search.getByRole('searchbox').fill('ReNeWaL');
  await search.getByRole('button',{name:'Search',exact:true}).click();
  await owner.getByRole('link',{name:'Older calls'}).click();
  assert.equal(new URL(owner.url()).searchParams.get('search'),'ReNeWaL');
  assert.deepEqual(await summaries(),rest);
  const filteredPage=owner.url();
  await owner.locator('.portable-call-list a').first().click();
  await owner.getByRole('link',{name:'Back to Calls',exact:true}).click();
  assert.equal(owner.url(),filteredPage);
  await search.getByRole('searchbox').fill('DEALS discussed');
  await search.getByRole('button',{name:'Search',exact:true}).click();
  assert.deepEqual(await summaries(),['Discussed renewal with deals']);
  assert.equal(new URL(owner.url()).searchParams.has('after'),false);
  await owner.getByRole('link',{name:'Clear search'}).click();
  assert.equal((await summaries()).length,25);
  const before=await receipts();
  assert.equal((await request(scope,{headers:other})).status,404);
  assert.deepEqual(await receipts(),before);
  await sql`UPDATE portable_workspace_viewers SET contact_outreach=true WHERE id=${grant}`;
  try{
    assert.equal((await request(scope,{method:'HEAD',headers:other})).status,200);
    assert.deepEqual(await receipts(),before);
    const page=await request(scope,{headers:other});
    assert.equal(page.status,200);
    const body=await page.text();
    assert.ok(body.includes('Discussed renewal with contacts'));
    assert.ok(!body.includes('Discussed renewal with deals')&&!body.includes('Discussed renewal with companies'));
    assert.deepEqual((await receipts()).slice(before.length),[{kind:'contacts',record_ids:[recordIds.contacts]}]);
    await sql`UPDATE portable_workspace_viewers SET record_activities=true,contact_outreach=false WHERE id=${grant}`;
    const recordCalls=await (await request(scope,{headers:other})).text();
    assert.ok(recordCalls.includes('Discussed renewal with companies')&&recordCalls.includes('Discussed renewal with deals'));
    assert.ok(!recordCalls.includes('Discussed renewal with contacts'));
    await sql`UPDATE deals SET data=jsonb_set(data,'{recordOwner}',jsonb_build_object('workspaceId',workspace_id,'userId',${viewerId}::text))
      WHERE workspace_id=${workspaceId} AND data->>'name'='Call navigation deals'`;
    await sql`UPDATE portable_workspace_viewers SET view_scope='owned',edit_scope='owned' WHERE id=${grant}`;
    const denied=await request(scope+'&search=companies',{headers:other});
    assert.equal(denied.status,200);
    assert.match(await denied.text(),/No matching calls on this page/);
    const beforeLimited=(await receipts()).length;
    const limited=await (await request(scope,{headers:other})).text();
    assert.ok(limited.includes('Discussed renewal with deals')&&!limited.includes('Discussed renewal with companies'));
    assert.deepEqual((await receipts()).slice(beforeLimited),[{kind:'deals',record_ids:[recordIds.deals]}]);
    await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_block_call_preview
      CHECK (action<>'related' OR kind<>'deals') NOT VALID`;
    try{
      const failed=await request(scope,{headers:other});
      assert.ok(failed.status>=500);
      assert.ok(!(await failed.text()).includes('Discussed renewal with deals'));
      assert.equal((await receipts()).length,beforeLimited+1);
    }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_block_call_preview`;}
    const sharedDeal=await request('/?kind=deals&record='+recordIds.deals+'&workspaceId='+workspaceId,{headers:other});
    assert.equal(sharedDeal.status,200);
    assert.ok(!(await sharedDeal.text()).includes('View record access history'));
    const personal=await request('/?view=calls',{headers:other});
    assert.ok(!(await personal.text()).includes('Discussed renewal with contacts'));
  }finally{await sql`UPDATE portable_workspace_viewers SET contact_outreach=false,record_activities=false,view_scope='all',edit_scope='all' WHERE id=${grant}`;}
  // Seed older calls so a rare match in each store sits beyond the first unfiltered page.
  for(const [table,link,record] of [
    ['portable_contact_activities','contact_id',recordIds.contacts],
    ['portable_record_activities','company_id',recordIds.companies],
  ]){
    await sql`INSERT INTO ${sql(table)}(workspace_id,id,${sql(link)},actor_id,kind,occurred_at,recorded_at,summary)
      SELECT ${workspaceId},gen_random_uuid(),${record},${viewerId},'Call',${at}::bigint-n-2000,${at},
        CASE WHEN n=24000 THEN 'Meridian renewal callback' ELSE 'Routine follow up' END FROM generate_series(1,24000) n`;
    await sql`VACUUM (ANALYZE) ${sql(table)}`;
    const plan=await sql`EXPLAIN (FORMAT JSON) SELECT id FROM ${sql(table)} WHERE kind='Call'
      AND to_tsvector('simple'::regconfig,summary) @@ plainto_tsquery('simple'::regconfig,'renewal meridian')`;
    assert.match(JSON.stringify(plan),/portable_(contact|record)_call_summary_search/);
  }
  await owner.getByRole('searchbox',{name:'Search call summaries'}).fill('renewal meridian');
  await owner.getByRole('search',{name:'Call history'}).getByRole('button',{name:'Search',exact:true}).click();
  assert.deepEqual(await summaries(),['Meridian renewal callback','Meridian renewal callback']);
  assert.deepEqual((await owner.locator('.portable-call-list a').allTextContents()).sort(),['Call navigation companies','Call navigation contacts']);
}
