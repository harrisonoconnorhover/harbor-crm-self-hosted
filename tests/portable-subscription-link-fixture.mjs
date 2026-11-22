import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

const key=['rk_','test_','FictionalSubscriptionRead'].join(''),linkId='plink_ExamplePlan';
const hosted='https://buy.stripe.com/test_fictional_recurring';
export async function subscriptionLinkFetch(url,options,state){
  assert.equal(options.method,'GET');
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+key);
  if(url.pathname==='/v1/checkout/sessions'){
    assert.equal(url.searchParams.get('payment_link'),linkId);
    assert.equal(url.searchParams.get('status'),'complete');assert.equal(url.searchParams.get('limit'),'25');
    assert.deepEqual([...url.searchParams].filter(([key])=>key.startsWith('expand[')).map(([,value])=>value),['data.subscription']);
    if(state.denied)return Response.json({error:{message:'private Stripe account detail'}},{status:403});
    const after=url.searchParams.get('starting_after');
    if(after)assert.equal(after,'cs_test_fixture24');
    const rows=(after?[25]:Array.from({length:25},(_,n)=>n)).map(n=>({
      id:'cs_test_fixture'+n,mode:'subscription',status:'complete',payment_link:state.wrongLink?'plink_other':linkId,livemode:false,
      customer_details:{email:'reader'+n+'@example.test'},metadata:{internal:'private metadata'},
      subscription:{object:'subscription',id:'sub_fixture'+n,livemode:false,status:n===25?'canceled':state.status??'active',
        cancel_at_period_end:n===0,cancel_at:null}
    }));
    return Response.json({object:'list',data:rows,has_more:!after});
  }
  if(url.pathname==='/v1/payment_links/'+linkId){
    return Response.json(state.link);
  }
  assert.equal(url.pathname,'/v1/payment_links/'+linkId+'/line_items');
  assert.equal(url.searchParams.get('limit'),'2');
  return Response.json({data:[{quantity:1,currency:'usd',price:state.price}],has_more:state.more??false});
}

export async function verifySubscriptionLink({origin,headers,other,get,post,sql,workspaceId,configure,configuration,file}){
  const id=crypto.randomUUID(),data={name:'Studio support plan',unitPriceCents:7500,billingFrequency:'quarterly',termPayments:null};
  const api='/api/products',lookup=api+'?view=subscription&id='+id+'&revision=';
  await post(api,{action:'save',id,revision:0,data});
  assert.equal((await get(lookup+1)).status,404);
  const configured={...configuration,HARBOR_STRIPE_SUBSCRIPTION_WORKSPACE_ID:workspaceId,HARBOR_STRIPE_SUBSCRIPTION_MODE:'test',
    HARBOR_STRIPE_SUBSCRIPTION_READ_KEY:key,HARBOR_STRIPE_SUBSCRIPTION_LINKS:JSON.stringify({[id]:linkId})};
  const directoryUrl='/?view=subscriptions',planUrl=directoryUrl+'&productId='+id;
  const single=crypto.randomUUID();
  await post(api,{action:'save',id:single,revision:0,data:{name:'One-time installation',unitPriceCents:2500,billingFrequency:'one_time',termPayments:null}});
  await sql`INSERT INTO portable_products(workspace_id,id,data,revision,created_at,updated_at)
    SELECT workspace_id,gen_random_uuid(),data||jsonb_build_object('name','Support level '||n),1,now(),now()
    FROM portable_products CROSS JOIN generate_series(1,26) n WHERE workspace_id=${workspaceId} AND id=${id}`;
  assert.equal((await get(directoryUrl+'&productId='+single)).status,404);
  assert.equal((await get(planUrl,other)).status,404);
  assert.equal((await get(directoryUrl+'&workspaceId='+workspaceId,other)).status,404);
  const subscribers=lookup.replace('view=subscription','view=subscribers');
  await configure(configured);
  assert.equal((await get(subscribers+1)).status,404);
  await configure({...configured,HARBOR_STRIPE_SUBSCRIBERS_ENABLED:'true'});
  const link={id:linkId,active:true,livemode:false,url:hosted};
  const price={active:true,livemode:false,billing_scheme:'per_unit',currency:'usd',unit_amount:7500,unit_amount_decimal:'7500',
    recurring:{interval:'month',interval_count:3,usage_type:'licensed'}};
  const stage=(patch={})=>writeFile(file,JSON.stringify({link,price,...patch}));
  await stage();
  const before=await readFile(file+'.calls','utf8');
  assert.equal((await get(lookup+1,other)).status,404);
  assert.equal((await get(lookup+2)).status,409);
  assert.equal((await get(subscribers+1,other)).status,404);
  assert.equal((await get(subscribers+2)).status,409);
  assert.equal((await get(subscribers+'1&after=invalid')).status,400);
  assert.equal(await readFile(file+'.calls','utf8'),before);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/products?id='+id);
    await page.getByRole('button',{name:'Open navigation'}).click();
    await page.getByRole('button',{name:'Revenue',exact:true}).click();
    await page.getByRole('link',{name:'Subscriptions',exact:true}).click();
    const table=page.getByRole('table');
    assert.equal(await table.locator('tbody tr').count(),25);
    assert.equal(await table.getByText('One-time installation').count(),0);
    await page.getByRole('link',{name:'Next plans'}).click();
    assert.equal(await table.locator('tbody tr').count(),2);
    await page.getByRole('link',{name:'Previous plans'}).click();
    await page.getByLabel('Search name or SKU').fill('Studio');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await table.getByText('Lookup enabled',{exact:true}).waitFor();
    assert.equal(await table.locator('tbody tr').count(),1);
    await table.getByRole('link',{name:data.name}).click();
    await page.getByRole('heading',{name:data.name,exact:true}).waitFor();
    assert.equal(new URL(await page.getByRole('link',{name:'Back to subscription plans'}).getAttribute('href'),origin).searchParams.get('q'),'Studio');
    assert.equal(await readFile(file+'.calls','utf8'),before);
    await page.getByRole('button',{name:'View subscribers'}).click();
    await page.getByText('reader0@example.test',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Open product',exact:true}).click();
    const checkout=page.getByRole('region',{name:'Subscription checkout'});
    await checkout.getByRole('button',{name:'Check subscription link'}).click();
    assert.equal(await checkout.getByRole('link',{name:'Open subscription checkout'}).getAttribute('href'),hosted);
    await checkout.getByText('Stripe test mode',{exact:false}).waitFor();
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
    await checkout.getByRole('button',{name:'Copy checkout link'}).click();
    await checkout.getByText('Checkout link copied.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),hosted);
    await stage({link:{...link,active:false}});
    await checkout.getByRole('button',{name:'Check subscription link'}).click();
    await checkout.getByRole('alert').waitFor();
    assert.equal(await checkout.getByRole('link').count(),0);
    const directory=page.getByRole('region',{name:'Stripe subscribers'});
    await directory.getByRole('button',{name:'View subscribers'}).click();
    await directory.getByText('reader0@example.test',{exact:true}).waitFor();
    await directory.getByText('Active · Cancels at period end',{exact:true}).waitFor();
    await directory.getByRole('button',{name:'Next subscribers'}).click();
    await directory.getByText('reader25@example.test',{exact:true}).waitFor();
    await directory.getByText('sub_fixture25',{exact:true}).waitFor();
    await directory.getByText('Canceled',{exact:true}).waitFor();
    assert.equal(await directory.getByText('reader0@example.test',{exact:true}).count(),0);
    await stage({status:'past_due'});
    await directory.getByRole('button',{name:'First subscribers'}).click();
    await directory.getByText('Past due · Cancels at period end',{exact:true}).waitFor();
    await stage({denied:true});
    await directory.getByRole('button',{name:'Refresh subscribers'}).click();
    await directory.getByRole('alert').waitFor();
    assert.equal(await directory.getByText('reader0@example.test',{exact:true}).count(),0);
    await stage();
    await directory.getByRole('button',{name:'Retry',exact:true}).click();
    await directory.getByText('Active · Cancels at period end',{exact:true}).waitFor();
  }finally{await browser.close();}
  for(const patch of [
    {price:{...price,unit_amount:8000}},{price:{...price,currency:'cad'}},{price:{...price,recurring:{...price.recurring,interval_count:1}}},
    {link:{...link,livemode:true}},{link:{...link,currency:'eur'}},{link:{...link,payment_method_types:['sepa_debit']}},{price:{...price,unit_amount_decimal:'7500.000000000001'}},{more:true},{link:{...link,url:'https://example.test/checkout'}},
  ]){
    await stage(patch);
    const response=await get(lookup+1);
    assert.equal(response.status,409);
    assert.ok(!(await response.text()).includes(hosted));
  }
  await stage();
  const result=await (await get(subscribers+1)).json();
  assert.equal(result.items.length,25);assert.equal(result.next,'cs_test_fixture24');
  assert.ok(!JSON.stringify(result).includes('private metadata'));
  await stage({wrongLink:true});
  const mismatched=await get(subscribers+1);
  assert.equal(mismatched.status,502);
  assert.ok(!(await mismatched.text()).includes('reader0'));
  await stage();
  const calls=await readFile(file+'.calls','utf8');
  await post(api,{action:'save',id,revision:1,data:{...data,termPayments:4}});
  assert.equal((await get(lookup+2)).status,409);
  await post(api,{action:'archive',id,revision:2,archived:true});
  assert.equal((await get(lookup+3)).status,409);
  assert.equal(await readFile(file+'.calls','utf8'),calls);
  assert.equal((await (await get(subscribers+3)).json()).items[0].status,'active');
  assert.match(await (await get(directoryUrl+'&archived=true')).text(),/Studio support plan/);
  assert.doesNotMatch(await (await get(directoryUrl+'&q=Studio')).text(),/Studio support plan/);
  const archived=await (await get(planUrl)).text();
  assert.match(archived,/View subscribers/);
  assert.doesNotMatch(archived,/Check subscription link/);
  await post(api,{action:'save',id,revision:3,data:{...data,billingFrequency:'one_time'}});
  assert.match(await (await get(directoryUrl+'&archived=true')).text(),/Studio support plan/);
  assert.equal((await (await get(subscribers+4)).json()).items[0].subscriptionId,'sub_fixture0');
  const checked=await readFile(file+'.calls','utf8');
  await configure({...configured,HARBOR_STRIPE_SUBSCRIBERS_ENABLED:'true',
    HARBOR_STRIPE_SUBSCRIPTION_LINKS:JSON.stringify({[id]:linkId,[crypto.randomUUID()]:linkId})});
  assert.equal((await get(subscribers+4)).status,404);
  const ambiguous=await (await get(planUrl)).text();
  assert.match(ambiguous,/Subscriber lookup is unavailable/);
  assert.doesNotMatch(ambiguous,/View subscribers/);
  assert.equal(await readFile(file+'.calls','utf8'),checked);
}
