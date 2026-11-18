import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableLineItems({request,origin,headers,other,sql,sharing}){
  const write=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,
    'content-type':'application/json'},body:JSON.stringify(body)});
  const raw=await write('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional item bundle',amount:2}});
  assert.equal(raw.status,201);
  const {record:deal}=await raw.json();
  const endpoint='/api/deal-line-items',path=endpoint+'?dealId='+deal.id;
  const read=(url=path,auth=headers)=>request(url,{headers:auth});
  const initial=(await (await read()).json());
  assert.equal(initial.revision,0);
  assert.equal(initial.deal.amount,2);
  assert.deepEqual(initial.items,[]);
  assert.equal((await read(path,other)).status,404);
  assert.equal((await read(path+'&dealId='+deal.id)).status,400);
  assert.match(await (await read('/?kind=deals&record='+deal.id)).text(),/Line items/);

  const productId=randomUUID(),product={name:'Fictional service',sku:'DEAL-ITEM',description:'Fictional description',
    unitPriceCents:2500,billingFrequency:'monthly',termPayments:12};
  assert.equal((await write('/api/products',{action:'save',id:productId,revision:0,data:product})).status,200);
  const item={id:randomUUID(),productId,productRevision:1,...product,quantity:2,discountBps:0};
  const input={dealId:deal.id,revision:0,expectedUpdatedAt:initial.deal.updatedAt,expectedAmount:2,
    updateAmount:true,amountMetric:'tcv',items:[item]};
  assert.equal((await write(endpoint,input,other)).status,404);
  assert.equal((await write(endpoint,{...input,items:[{...item,productId:randomUUID()}]})).status,409);

  await sql`ALTER TABLE portable_line_item_sets ADD CONSTRAINT fixture_fail_set CHECK (revision<>1)`;
  try{
    assert.equal((await write(endpoint,input)).status,500);
    assert.deepEqual(await (await read()).json(),initial);
    const [receipt]=await sql`SELECT count(*)::int AS count FROM deal_events WHERE workspace_id=${sharing.workspaceId} AND deal_id=${deal.id}`;
    assert.equal(receipt.count,1);
  }finally{await sql`ALTER TABLE portable_line_item_sets DROP CONSTRAINT fixture_fail_set`;}
  const raced=await Promise.all([write(endpoint,input),write(endpoint,input)]);
  assert.deepEqual(raced.map(response=>response.status).sort(),[200,409]);
  const saved=await (await read()).json();
  assert.deepEqual([saved.revision,saved.deal.amount,saved.totals.netCents,saved.revenue.tcvCents],[1,600,5000,60000]);
  assert.deepEqual(saved.items,[item]);

  assert.equal((await write('/api/products',{action:'archive',id:productId,revision:1,archived:true})).status,200);
  const retained={...input,revision:saved.revision,expectedUpdatedAt:saved.deal.updatedAt,expectedAmount:600,updateAmount:false};
  assert.equal((await write(endpoint,{...retained,items:[{...item,id:randomUUID()}]})).status,409);
  assert.equal((await write(endpoint,{...retained,items:[{...item,quantity:3}]})).status,200);
  const final=await (await read()).json();
  assert.deepEqual([final.revision,final.deal.amount,final.items[0].unitPriceCents],[2,600,2500]);
  return async (request,owner,outsider)=>{
    assert.deepEqual(await (await request(path,{headers:owner})).json(),final);
    assert.equal((await request(path,{headers:outsider})).status,404);
  };
}
