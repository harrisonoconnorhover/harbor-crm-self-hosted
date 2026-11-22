import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableProducts({request,origin,headers,other,sharing,sql}){
  const path='/api/products',id=randomUUID(),detail=path+'?id='+id;
  const read=(url,auth=headers)=>request(url,{headers:auth});
  const post=(body,auth=headers,site=origin)=>request(path,{method:'POST',headers:{...auth,origin:site,
    'content-type':'application/json'},body:JSON.stringify(body)});
  const input={action:'save',id,revision:0,data:{name:'Fictional support % plan',sku:'FIXTURE-100',description:'Local product',
    unitPriceCents:12500,billingFrequency:'monthly',termPayments:12}};
  assert.equal((await read(path,{})).status,401);
  for(const bookmark of ['/products?q=Fictional+%25&archived=true&billingFrequency=monthly&page=2',
    '/products?id='+id,'/products?add=1']){
    const redirect=await request(bookmark,{headers:{},redirect:'manual'});
    assert.equal(redirect.status,307);
    assert.equal(new URL(redirect.headers.get('location'),origin).searchParams.get('return_to'),bookmark);
  }
  const longSearch='/products?q='+encodeURIComponent('界'.repeat(200));
  const longRedirect=await request(longSearch,{headers:{},redirect:'manual'});
  assert.equal(longRedirect.status,307);
  assert.equal(new URL(longRedirect.headers.get('location'),origin).searchParams.get('return_to'),'/products');
  assert.equal((await post(input,headers,'https://outside.example.test')).status,403);
  assert.equal((await post({...input,data:{...input.data,billingFrequency:'one_time'}})).status,400);
  const first=await Promise.all([post(input),post(input)]);
  assert.deepEqual(await Promise.all(first.map(response=>response.json())),[{ok:true,id,revision:1},{ok:true,id,revision:1}]);
  assert.equal((await post({...input,data:{...input.data,sku:'CONFLICT'}})).status,409);
  assert.equal((await read(detail,other)).status,404);
  assert.equal((await read(detail+'&id='+id)).status,400);
  assert.equal((await read(detail+'&billingFrequency=monthly')).status,400);
  assert.equal((await read(path+'?workspaceId='+sharing.workspaceId,other)).status,400);
  assert.equal((await post({action:'archive',id,revision:1,archived:true},other)).status,404);
  const fetched=await read(detail);
  assert.equal(fetched.headers.get('cache-control'),'private, no-store');
  const original=await fetched.json();
  assert.deepEqual([original.unitPriceCents,original.billingFrequency,original.termPayments],[12500,'monthly',12]);
  assert.equal((await (await read(path+'?q=fixture-100')).json()).items[0].id,id);
  assert.equal((await (await read(path+'?q=%25')).json()).total,1);
  assert.equal((await (await read(path+'?billingFrequency=')).json()).total,1);
  assert.equal((await (await read(path+'?billingFrequency=one_time')).json()).total,0);
  assert.equal((await (await read(path+'?billingFrequency=monthly',other)).json()).total,0);
  const html=await (await read('/products')).text();
  assert.match(html,/Fictional support % plan/);
  assert.match(html,/Export CSV/);
  assert.doesNotMatch(await (await read('/products',other)).text(),/Fictional support % plan/);
  const csv=path+'?export=csv';
  assert.equal((await read(csv,{})).status,401);
  for(const invalid of ['&page=1','&id='+id,'&workspaceId='+sharing.workspaceId,'&export=csv',
    '&billingFrequency=weekly&billingFrequency=monthly','&billingFrequency=daily']){
    assert.equal((await read(csv+invalid)).status,400);
  }
  assert.equal((await read(path+'?export=json')).status,400);
  const exported=await read(csv+'&q=fixture-100');
  assert.equal(exported.status,200);
  assert.match(exported.headers.get('content-type'),/^text\/csv/);
  assert.equal(exported.headers.get('content-disposition'),'attachment; filename="harbor-products.csv"');
  assert.equal(exported.headers.get('cache-control'),'private, no-store');
  const download=await exported.text();
  assert.ok(download.includes('"FIXTURE-100","Local product","125.00","Monthly","12","Active"'));
  assert.equal((await (await read(csv,other)).text()).split('\r\n').length,2);
  const ids=Array.from({length:27},()=>randomUUID());
  await sql`INSERT INTO portable_products(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${sharing.workspaceId},id,1,jsonb_build_object('name','Fictional page ' || n,'sku','','description','=SUM(1,2)',
      'unitPriceCents',0,'billingFrequency',CASE WHEN n=1 THEN 'monthly' ELSE 'one_time' END,
      'termPayments',CASE WHEN n=1 THEN 12 ELSE null END),now(),now()
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS entries(id,n)`;
  const pageOne=await (await read(path+'?q=Fictional+page')).json();
  const pageTwo=await (await read(path+'?q=Fictional+page&page=9')).json();
  assert.deepEqual([pageOne.total,pageOne.page,pageOne.items.length],[27,0,25]);
  assert.deepEqual([pageTwo.total,pageTwo.page,pageTwo.items.length],[27,1,2]);
  assert.equal(new Set([...pageOne.items,...pageTwo.items].map(item=>item.id)).size,27);
  const catalogRows=(await (await read(csv+'&q=Fictional+page')).text()).split('\r\n').slice(1,-1);
  assert.equal(catalogRows.length,27,'Export includes all matching products across list pages.');
  assert.ok(catalogRows.every(row=>row.includes('"\'=SUM(1,2)"')));
  assert.deepEqual(catalogRows.map(row=>row.split(',')[0]),[...pageOne.items,...pageTwo.items].map(item=>'"'+item.id+'"'));
  const oneTime='q=Fictional+page&billingFrequency=one_time';
  const filteredOne=await (await read(path+'?'+oneTime)).json();
  const filteredTwo=await (await read(path+'?'+oneTime+'&page=1')).json();
  assert.deepEqual([filteredOne.total,filteredOne.items.length,filteredTwo.items.length],[26,25,1]);
  const filteredIds=[...filteredOne.items,...filteredTwo.items].map(item=>item.id);
  assert.ok(!filteredIds.includes(ids[0]));
  const filteredHtml=await (await read('/products?'+oneTime)).text();
  assert.match(filteredHtml,/name="billingFrequency"[^>]*>[\s\S]*?<option value="one_time" selected="">One-time<\/option>/);
  assert.match(filteredHtml,/href="\/products\?[^"]*billingFrequency=one_time&amp;after=[^"]+">Next products<\/a>/);
  const listPage='/products?'+oneTime+'&page=1';
  const selectedProduct=listPage+'&id='+filteredTwo.items[0].id;
  assert.ok((await (await read(listPage)).text()).includes('href="'+selectedProduct.replaceAll('&','&amp;')+'"'));
  const productPage=await read(selectedProduct);
  assert.equal(productPage.status,200);
  assert.ok((await productPage.text()).includes('href="'+listPage.replaceAll('&','&amp;')+'">Back to products</a>'));
  assert.equal((await read(selectedProduct,other)).status,404);
  const filteredRows=(await (await read(csv+'&'+oneTime)).text()).split('\r\n').slice(1,-1);
  assert.deepEqual(filteredRows.map(row=>row.split(',')[0]),filteredIds.map(id=>'"'+id+'"'));
  await sql`DELETE FROM portable_products WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql(ids)}`;

  const overflowIds=Array.from({length:501},()=>randomUUID());
  await sql`INSERT INTO portable_products(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${sharing.workspaceId},id,1,jsonb_build_object('name','Fictional catalog overflow '|| n,'sku','','description','',
      'unitPriceCents',0,'billingFrequency','one_time','termPayments',null),now(),now()
    FROM unnest(${overflowIds}::uuid[]) WITH ORDINALITY AS entries(id,n)`;
  try{
    const overflow=await read(csv+'&q=catalog+overflow');
    assert.equal(overflow.status,413);
    assert.match((await overflow.json()).error,/500 products/);
    assert.equal(overflow.headers.has('content-disposition'),false);
  }finally{
    await sql`DELETE FROM portable_products WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql(overflowIds)}`;
  }

  const edits=await Promise.all(['Renamed % plan','Updated % plan'].map(name=>post({...input,revision:1,data:{...input.data,name}})));
  assert.deepEqual(edits.map(response=>response.status).sort(),[200,409]);
  assert.equal((await post({action:'archive',id,revision:2,archived:true})).status,200);
  assert.equal((await (await read(path)).json()).total,0);
  assert.equal((await (await read(path+'?archived=true')).json()).items[0].id,id);
  assert.equal((await (await read(csv)).text()).split('\r\n').length,2);
  const archivedCsv=await (await read(csv+'&archived=true&q=fixture-100&billingFrequency=monthly')).text();
  assert.ok(archivedCsv.includes('"' + id + '"'));
  assert.match(archivedCsv,/"Archived"\r\n$/);
  assert.equal((await post({action:'archive',id,revision:3,archived:false})).status,200);
  const record=await (await read(detail)).json();
  assert.equal(record.revision,4);
  assert.equal(record.archivedAt,null);
  return async (request,owner,outsider)=>{
    assert.deepEqual(await (await request(detail,{headers:owner})).json(),record);
    assert.equal((await request(detail,{headers:outsider})).status,404);
  };
}
