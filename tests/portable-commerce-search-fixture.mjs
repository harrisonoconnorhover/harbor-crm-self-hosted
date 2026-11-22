import assert from 'node:assert/strict';
import {verifyPortableProducts} from './portable-products-fixture.mjs';
import {verifyProductPaging} from './portable-product-paging-fixture.mjs';

export async function verifyCommerceSearch({request,origin,headers,other,sql}){
  const needle='Orchid 30%_A\\ref';
  // Both workspaces have the same special marker. Only the owner has the large catalog.
  async function seed(auth,count){
    const response=await request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'deals',data:{name:'Fictional search rehearsal'}})});
    assert.equal(response.status,201,await response.clone().text());
    const {record}=await response.json();
    const [deal]=await sql`SELECT workspace_id,created_at FROM deals WHERE id=${record.id}`;
    const workspace=deal.workspace_id;
    if(auth===headers){
      const verifySaved=await verifyPortableProducts({request,origin,headers,other,sharing:{workspaceId:workspace},sql});
      await verifySaved(request,headers,other);
      const removed=await sql`DELETE FROM portable_products WHERE workspace_id=${workspace} AND data->>'sku'='FIXTURE-100' RETURNING id`;
      assert.equal(removed.length,1);
      await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
    }
    // Put the marker in the last record, and a wildcard lookalike in the first.
    return sql.begin(async tx=>{
      await tx`CREATE TEMP TABLE search_seed ON COMMIT DROP AS SELECT i,gen_random_uuid() id,
        CASE WHEN i=${count} THEN ${needle} WHEN i=1 THEN 'Orchid 30XXAref' ELSE 'Code '||i END code
        FROM generate_series(1,${count}::int) i`;
      await tx`INSERT INTO portable_products(workspace_id,id,revision,data,created_at,updated_at)
        SELECT ${workspace},id,1,jsonb_build_object('name','Product '||i,'sku',code,'billingFrequency','one_time',
          'description','Out of scope phrase','unitPriceCents',1200,'termPayments',null),now(),now() FROM search_seed`;
      await tx`INSERT INTO portable_quotes(workspace_id,id,deal_id,deal_created_at,deal_name,revision,creation_key,data,created_at,updated_at)
        SELECT ${workspace},id,${record.id},${deal.created_at},code,1,id::text,
          jsonb_build_object('title','Quote '||i,'buyer',jsonb_build_object('name','Buyer '||i),'notes','Out of scope phrase'),
          now(),now() FROM search_seed`;
      await tx`INSERT INTO portable_invoices(workspace_id,id,deal_id,deal_created_at,deal_name,source_note,revision,creation_key,
          data,total_cents,created_at,updated_at)
        SELECT ${workspace},id,${record.id},${deal.created_at},'Source deal','Source',1,id::text,
          jsonb_build_object('title','Invoice '||i,'buyer',jsonb_build_object('name','Buyer '||i),'reference',code,
          'notes','Out of scope phrase'),1200,now(),now() FROM search_seed`;
      const [last]=await tx`SELECT id FROM search_seed WHERE i=${count}`;
      const [source]=await tx`SELECT id FROM search_seed WHERE i=1`;
      await tx`INSERT INTO portable_quote_versions(workspace_id,quote_id,version,snapshot,published_at)
        VALUES(${workspace},${source.id},1,'{}',now())`;
      await tx`UPDATE portable_invoices SET quote_id=${source.id},quote_version=1 WHERE workspace_id=${workspace} AND id=${last.id}`;
      return {id:last.id,workspace,deal:record.id,quote:source.id};
    });
  }

  const owner=await seed(headers,50000),peer=await seed(other,2);
  const mine=owner.id,theirs=peer.id;
  const receiptCount=async()=>(await sql`SELECT count(*)::int AS n FROM portable_record_access_events WHERE action='csv'`)[0].n;
  for(const kind of ['products','quotes','invoices']){
    await sql`VACUUM (ANALYZE) ${sql('portable_'+kind)}`;
    const search=async(q,auth=headers,options={})=>{
      const response=await request('/api/'+kind+'?'+new URLSearchParams({q,...options}),{headers:auth});
      assert.equal(response.status,200,await response.clone().text());
      if(options.export)return (await response.text()).trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0].slice(1,-1));
      return (await response.json()).items.map(row=>row.id);
    };
    assert.deepEqual(await search(needle.toLowerCase()),[mine]);
    assert.deepEqual(await search('%_'),[mine]);
    assert.deepEqual(await search('Out of scope phrase'),[]);
    assert.deepEqual(await search(needle,other),[theirs]);
    await verifyCommerceReads({request,sql,headers,other,kind,owner,peer,needle});

    assert.deepEqual(await search(needle,headers,{export:'csv'}),[mine]);
    assert.deepEqual(await search(needle,other,{export:'csv'}),[theirs]);
    for(const [seeded,email] of [[owner,'owner@example.test'],[peer,'other@example.test']]){
      const [entry]=await sql`SELECT record_ids,id FROM portable_record_access_events WHERE action='csv' AND kind=${kind}
        AND actor_email=${email} AND workspace_id=${seeded.workspace} AND ${seeded.id}::uuid=ANY(record_ids)`;
      assert.deepEqual(entry.record_ids,[seeded.id]);
      const history='/?view=record-access&action=csv&kind='+kind+'&event='+entry.id;
      const auth=seeded===owner?headers:other;
      const page=await request(history,{headers:auth});
      assert.equal(page.status,200);
      const detail=kind==='invoices'?'/?view=invoices&amp;invoiceId=':'/'+kind+'?id=';
      assert.ok((await page.text()).includes('href="'+detail+seeded.id+'"'));
      const foreign=await request(history,{headers:seeded===owner?other:headers});
      assert.match(await foreign.text(),/No matching access events/);
    }
    if(kind==='invoices'){
      const linked=await sql`SELECT record_ids FROM portable_record_access_events WHERE kind='quotes' AND action='csv'
        AND actor_email='owner@example.test' AND workspace_id=${owner.workspace} AND ${owner.quote}::uuid=ANY(record_ids)`;
      assert.ok(linked.some(row=>row.record_ids.length===1));
    }
    const label={products:'Product',quotes:'Quote',invoices:'Invoice'}[kind];
    assert.deepEqual(await search(label+' 50000'),[mine]);
    if(kind!=='products')assert.deepEqual(await search('Buyer 50000'),[mine]);
    // The first field ends with this number. A multi-field match would be incorrect.
    const nextField=kind==='products'?needle:'Buyer 50000';
    assert.deepEqual(await search('50000\u001f'+nextField),[]);
    const excluded={products:{billingFrequency:'monthly'},quotes:{expiresFrom:'2028-01-01'},invoices:{dueFrom:'2028-01-01'}}[kind];
    assert.deepEqual(await search(needle,headers,excluded),[]);
    assert.deepEqual(await search(needle,headers,{...excluded,export:'csv'}),[]);
    // These 111 records span multiple pages. Exports must agree with screen order.
    const group=label+' 450';
    const all=await search(group,headers,{export:'csv'});
    assert.equal(all.length,111);
    const [exported]=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${owner.workspace}
      AND action='csv' AND kind=${kind} AND cardinality(record_ids)=111`;
    assert.deepEqual(exported.record_ids,all);
    if(kind!=='products'){
      const [links]=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${owner.workspace}
        AND kind='deals' AND action='csv' ORDER BY occurred_at DESC,id DESC LIMIT 1`;
      assert.deepEqual(links.record_ids,[owner.deal]);
    }
    const before=await receiptCount();
    const endpoint='/api/'+kind+'?export=csv';
    assert.equal((await request(endpoint,{headers})).status,413);
    assert.equal((await request(endpoint+'&q='+encodeURIComponent(needle),{method:'HEAD',headers})).status,200);
    assert.deepEqual(await search('No matching commerce record',headers,{export:'csv'}),[]);
    if(kind==='products'){
      await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_deny_export CHECK (kind<>'products') NOT VALID`;
    }else{
      // The primary quote or invoice receipt must roll back if its linked deal receipt is rejected.
      await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_deny_export CHECK (kind<>'deals') NOT VALID`;
    }
    try{
      const failed=await request(endpoint+'&q='+encodeURIComponent(needle),{headers});
      assert.equal(failed.status,500);
      assert.ok(!(await failed.text()).includes(mine));
    }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_deny_export`;}
    assert.equal(await receiptCount(),before);
    const first=await search(group);
    const second=await search(group,headers,kind==='products'?{page:'1'}:{after:first.at(-1)});
    assert.equal(first.length,25);
    assert.equal(second.length,25);
    assert.deepEqual([...first,...second],all.slice(0,50));
    const elapsed=[];
    for(let pass=0;pass<5;pass++){
      const start=performance.now();
      assert.deepEqual(await search(needle),[mine]);
      elapsed.push(performance.now()-start);
    }
    console.log(kind+' selective search, 50,000 fictional records, median of five: '+Math.round(elapsed.sort((a,b)=>a-b)[2])+' ms');
    const indexName='portable_'+kind+'_text_search';
    let scanCount=0;
    for(let probe=0;probe<12&&!scanCount;probe++){
      const [stats]=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname=${indexName}`;
      scanCount=Number(stats?.idx_scan);
      if(!scanCount){
        await new Promise(resolve=>setTimeout(resolve,200));
        await search(needle);
      }
    }
    assert.ok(scanCount>0,indexName+' must serve an actual search');
  }
  // The independent paging walkthrough reuses the same fictional owner.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_read'`;
  await verifyProductPaging({request,origin,headers,other,sql,workspace:owner.workspace});
}

async function verifyCommerceReads({request,sql,headers,other,kind,owner,peer,needle}){
  const seen=async(action,id)=>Number((await sql`SELECT count(*) AS count FROM portable_record_access_events
    WHERE kind=${kind} AND action=${action} AND workspace_id=${owner.workspace}
      AND actor_email='owner@example.test' AND ${id}::uuid=ANY(record_ids)`)[0].count);
  const list='/api/'+kind+'?q='+encodeURIComponent(needle);
  const page=(kind==='invoices'?'/?view=invoices&':'/'+kind+'?')+'q='+encodeURIComponent(needle);
  const detail='/api/'+kind+'?id='+owner.id;
  const prior=await seen('list',owner.id);
  assert.ok(prior>=2);
  assert.equal((await request(page,{headers:{...headers,'x-harbor-page-method':'HEAD'}})).status,200);
  assert.equal(await seen('list',owner.id),prior+1,page);
  for(const route of [page,list]){
    assert.equal((await request(route,{headers,method:'HEAD'})).status,200);
    assert.equal(await seen('list',owner.id),prior+1,route);
  }
  const opened=await seen('detail',owner.id);
  assert.equal((await request(detail,{headers})).status,200);
  assert.equal((await request(detail,{headers,method:'HEAD'})).status,200);
  assert.equal((await request(detail,{headers:other})).status,404);
  assert.equal(await seen('detail',owner.id),opened+1);
  const foreign=await sql`SELECT id FROM portable_record_access_events WHERE workspace_id=${peer.workspace}
    AND kind=${kind} AND ${owner.id}::uuid=ANY(record_ids)`;
  assert.equal(foreign.length,0);
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_block_detail
    CHECK (action<>'detail') NOT VALID`;
  try{
    const failed=await request(detail,{headers});
    assert.equal(failed.status,500);
    assert.ok(!(await failed.text()).includes(owner.id));
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_block_detail`;}
  assert.equal(await seen('detail',owner.id),opened+1);
}
