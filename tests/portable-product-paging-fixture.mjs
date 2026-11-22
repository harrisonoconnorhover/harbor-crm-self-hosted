import assert from 'node:assert/strict';

export async function verifyProductPaging({request,origin,headers,other,sql,workspace}){
  const read=async(params,auth=headers)=>{
    const response=await request('/api/products?'+new URLSearchParams(params),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const ids=page=>page.items.map(row=>row.id);
  const anchor=await read({page:'1799'});
  const times=[[],[]];
  for(let run=0;run<5;run++){
    const pages=[];
    for(const [i,params] of [{page:'1800'},{after:anchor.next}].entries()){
      const start=performance.now();
      pages.push(await read(params));
      times[i].push(performance.now()-start);
    }
    assert.deepEqual(ids(pages[0]),ids(pages[1]));
    assert.equal(pages[1].total,null);
    assert.deepEqual(ids(await read({before:pages[1].previous})),ids(anchor));
  }
  const [numbered,positioned]=times.map(values=>Math.round(values.sort((a,b)=>a-b)[2]));
  console.log('50,000 products, page 1,801, median of five API reads: numbered '+numbered+' ms, cursor '+positioned+' ms');

  // Equal names across page boundaries must retain Postgres's UUID tiebreaker.
  const q='Catalog duplicate',filters={q,billingFrequency:'monthly'};
  await sql`INSERT INTO portable_products(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspace},gen_random_uuid(),1,jsonb_build_object('name','Café & 東京 / test','sku',${q}::text,
      'description','','unitPriceCents',100,'billingFrequency','monthly','termPayments',2),now(),now()
    FROM generate_series(1,57)`;
  const all=await sql`SELECT id FROM portable_products WHERE workspace_id=${workspace} AND data->>'sku'=${q} ORDER BY id`;
  const ordered=all.map(row=>row.id);
  const first=await read(filters),second=await read({...filters,after:first.next}),third=await read({...filters,after:second.next});
  assert.deepEqual([...ids(first),...ids(second),...ids(third)],ordered);
  assert.equal(first.previous,null);
  assert.equal(third.next,null);
  assert.deepEqual(ids(await read({...filters,before:third.previous})),ids(second));
  assert.deepEqual(ids(await read({...filters,after:first.next},other)),[]);
  for(const params of [{after:'broken'},{after:first.next,before:second.previous},{after:first.next,page:'1'}]){
    assert.equal((await request('/api/products?'+new URLSearchParams(params),{headers})).status,400);
  }
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    const start='/products?'+new URLSearchParams(filters);
    await page.goto(origin+start);
    await page.getByRole('link',{name:'Next products'}).click();
    const next=page.url();
    assert.equal(new URL(next).searchParams.get('after'),first.next);
    const login=await request(new URL(next).pathname+new URL(next).search,{redirect:'manual'});
    assert.equal(new URL(login.headers.get('location'),origin).searchParams.get('return_to'),next.slice(origin.length));
    await page.getByRole('link',{name:'Café & 東京 / test',exact:true}).first().click();
    await page.getByRole('link',{name:'Back to products'}).click();
    assert.equal(page.url(),next);
    await page.getByRole('link',{name:'Previous products'}).click();
    assert.deepEqual(await page.locator('tbody tr td:first-child a').evaluateAll(links=>links.map(link=>new URL(link.href).searchParams.get('id'))),ids(first));
    await page.getByRole('link',{name:'First products'}).click();
    assert.equal(page.url(),origin+start);
  }finally{await browser.close();}
  await sql`UPDATE portable_products SET archived_at=now() WHERE workspace_id=${workspace} AND id IN ${sql(ordered.slice(0,27))}`;
  assert.deepEqual(ids(await read({...filters,after:first.next})),ordered.slice(27,52));
  const archived=await read({...filters,archived:'true'});
  assert.deepEqual(ids(await read({...filters,archived:'true',after:archived.next})),ordered.slice(25,27));
  // Archived timestamps vary across a real catalog; exercise ordering across archive dates.
  await sql`UPDATE portable_products SET archived_at=created_at + (data->>'unitPriceCents')::int*interval '1 second'
    + (substring(data->>'name' from '[0-9]+$'))::int*interval '1 minute'
    WHERE workspace_id=${workspace} AND data->>'name' ~ '^Product [0-9]+$'
    AND (substring(data->>'name' from '[0-9]+$'))::int<=20000`;
  await sql`VACUUM (ANALYZE) portable_products`;
  const previousArchive=await read({archived:'true',page:'718'});
  const numberedArchive=await read({archived:'true',page:'719'});
  const archiveTimes=[];
  for(let pass=0;pass<5;pass++){
    const start=performance.now();
    assert.deepEqual(ids(await read({archived:'true',after:previousArchive.next})),ids(numberedArchive));
    archiveTimes.push(performance.now()-start);
  }
  const last=previousArchive.items.at(-1);
  const [explain]=await sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM portable_products
    WHERE workspace_id=${workspace} AND archived_at IS NOT NULL
    AND (lower(data->>'name'),id) > (lower(${last.name}::text),${last.id}::uuid)
    ORDER BY lower(data->>'name'),id LIMIT 26`;
  const plan=explain['QUERY PLAN'][0].Plan;
  const scan=plan.Plans[0];
  assert.equal(scan['Index Name'],'portable_products_archive_catalog');
  assert.equal(scan['Actual Rows'],26);
  console.log('Archived catalog cursor, median of five: '+Math.round(archiveTimes.sort((a,b)=>a-b)[2])+
    ' ms; index returned '+scan['Actual Rows']+' rows.');
}
