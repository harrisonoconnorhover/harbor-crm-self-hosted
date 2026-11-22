import {subscriptionLinkFetch,verifySubscriptionLink} from './portable-subscription-link-fixture.mjs';
import assert from 'node:assert/strict';
import {access,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';

async function waitForFile(path){
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    try{await access(path);return;}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Timed out waiting for fixture checkpoint.');
}

const readKey=['rk_','test_','FictionalInvoiceReadOnly'].join('');
const hosted='https://invoice.stripe.com/i/fictional-trial';
const email='fictional-buyer@example.test';

export async function stripeInvoiceFetch(url,options){
  const file=process.env.HARBOR_TEST_STRIPE_STATE;
  assert.ok(file,'Stripe HTTP is available only inside the invoice fixture.');
  assert.equal(options.method,'GET');
  await appendFile(file+'.calls',url.pathname+'\n');
  const state=JSON.parse(await readFile(file,'utf8'));
  if(url.pathname.startsWith('/v1/payment_links/')||url.pathname==='/v1/checkout/sessions')return subscriptionLinkFetch(url,options,state);
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+readKey);
  if(state.failure)return Response.json({error:{message:'private provider detail'}},{status:503});
  if(url.pathname==='/v1/invoices/search'){
    assert.equal(url.searchParams.get('query'),"metadata['harbor_workspace_id']:'"+state.workspaceId+"' AND metadata['harbor_invoice_id']:'"+state.id+"'");
    assert.equal(url.searchParams.get('limit'),'2');
    return Response.json({object:'search_result',data:state.ids.map(id=>({id})),has_more:state.more??false});
  }
  assert.equal(url.pathname,'/v1/invoices/in_trial');
  if(state.hold){
    await writeFile(file+'.reading','');
    await waitForFile(file+'.resume');
  }
  return Response.json(state.bill);
}

async function invoiceFromSignedQuote({post,get,origin,headers,deal}){
  const quoteId=crypto.randomUUID(),quotePath='/quotes?id='+quoteId;
  await post('/api/quotes',{action:'create',id:quoteId,dealId:deal.id,expectedUpdatedAt:deal.updatedAt,lineRevision:1});
  await post('/api/quotes',{action:'publish',id:quoteId,revision:1});
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const seller=await browser.newPage(),buyer=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await seller.context().addCookies([{name,value,url:origin}]);
    await seller.goto(origin+quotePath);
    await seller.getByRole('button',{name:'Create signing link'}).click();
    const signingLink=await seller.getByRole('textbox',{name:'Private signing link'}).inputValue();
    await buyer.goto(signingLink);
    await buyer.getByRole('button',{name:'Review quote'}).click();
    await buyer.getByLabel('Full name').fill('Fictional invoice buyer');
    await buyer.getByRole('checkbox').check();
    await buyer.getByRole('button',{name:'Sign quote'}).click();
    await buyer.getByRole('heading',{name:'Signature receipt'}).waitFor();
    await seller.reload();
    await seller.getByText('Fictional invoice buyer',{exact:true}).first().waitFor();
    await seller.getByRole('button',{name:'Review invoice draft'}).click();
    await seller.getByRole('button',{name:'Create invoice draft'}).click();
    await seller.waitForURL(url=>url.searchParams.has('invoiceId'));
    const id=new URL(seller.url()).searchParams.get('invoiceId');
    const {invoice}=await (await get('/api/invoices?id='+id)).json();
    assert.equal(invoice.quoteId,quoteId);
    assert.equal(invoice.quoteVersion,1);
    assert.equal(invoice.dealId,deal.id);
    assert.equal(invoice.data.buyer.email,email);
    assert.equal(invoice.totalCents,5000);
    assert.equal(await seller.getByRole('link',{name:'Source quote version 1'}).getAttribute('href'),quotePath+'&version=1');
    return id;
  }finally{await browser.close();}
}

export async function verifyStripeInvoices({request,origin,headers,other,directory,configure,sql}){
  const get=(url,auth=headers)=>request(url,{headers:auth});
  async function post(url,body){
    const response=await request(url,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  const {record:buyer}=await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Invoice trial buyer',email}});
  const {record:deal}=await post('/api/crm',{action:'save',kind:'deals',data:{name:'Invoice trial deal'},primaryContactId:buyer.id});
  await post('/api/deal-line-items',{dealId:deal.id,revision:0,expectedUpdatedAt:deal.updatedAt,expectedAmount:0,updateAmount:false,
    items:[{id:crypto.randomUUID(),name:'Fictional design work',sku:'',description:'',unitPriceCents:5000,billingFrequency:'one_time',termPayments:null,quantity:1,discountBps:0}]});
  const {source}=await (await get('/api/invoices?source=deal&sourceId='+deal.id+'&recurring=exclude')).json();
  const id=await invoiceFromSignedQuote({post,get,origin,headers,deal});
  const detail='/api/invoices?id='+id,lookup='/api/invoices?view=stripe&id='+id;
  const {owned:workspaceId}=await (await get('/api/workspaces')).json();
  assert.ok(workspaceId);
  const metadata={harbor_workspace_id:workspaceId,harbor_invoice_id:id};
  const bill={id:'in_trial',metadata,livemode:false,currency:'usd',customer_email:email,total:5000,status:'open',
    amount_paid:0,amount_remaining:5000,hosted_invoice_url:hosted};
  const file=join(directory,'stripe-invoice.json');
  const stage=(overrides={},scenario={})=>writeFile(file,JSON.stringify({id,workspaceId,ids:['in_trial'],bill:{...bill,...overrides},...scenario}));
  await stage();
  await writeFile(file+'.calls','');
  const configuration={HARBOR_STRIPE_INVOICE_WORKSPACE_ID:workspaceId,HARBOR_STRIPE_INVOICE_MODE:'test',
    HARBOR_STRIPE_INVOICE_READ_KEY:readKey,HARBOR_TEST_STRIPE_STATE:file};
  const screen='/?view=invoices&invoiceId='+id;
  assert.equal((await get(lookup)).status,404);
  assert.doesNotMatch(await (await get(screen)).text(),/Check Stripe invoice/);
  await configure(configuration);
  assert.equal((await get(lookup)).status,409);
  const download=detail+'&download=true';
  assert.equal((await get(download)).status,400);
  await post('/api/invoices',{action:'finalize',id,revision:1});
  assert.equal((await request(download,{headers,method:'HEAD'})).status,200);
  assert.equal((await get(download,other)).status,404);
  const document=await get(download);
  assert.equal(document.status,200);
  assert.match(await document.text(),/Fictional design work/);
  const [event]=await sql`SELECT id,record_ids,count(*) OVER ()::int AS total FROM portable_record_access_events
    WHERE workspace_id=${workspaceId} AND actor_email='owner@example.test' AND action='document' AND kind='invoices'`;
  assert.equal(event.total,1);
  assert.deepEqual(event.record_ids,[id]);
  const history=await get('/?view=record-access&action=document&event='+event.id);
  assert.equal(history.status,200);
  assert.match(await history.text(),/Document download/);

  assert.equal((await get(lookup,other)).status,404);
  assert.equal((await get(lookup,{})).status,401);
  assert.equal(await readFile(file+'.calls','utf8'),'');
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    const document=await page.goto(origin+screen);
    assert.ok(!(await document.text()).includes(readKey));
    const panel=page.getByRole('region',{name:'Stripe invoice'});
    await stage({},{ids:[]});
    await panel.getByRole('button',{name:'Check Stripe invoice'}).click();
    await panel.getByText('No match yet.',{exact:false}).waitFor();
    await stage();
    await panel.getByRole('button',{name:'Check Stripe invoice'}).click();
    const link=panel.getByRole('link',{name:'Open Stripe payment page'});
    await link.waitFor();
    assert.equal(await link.getAttribute('href'),hosted);
    const copy=panel.getByRole('button',{name:'Copy payment link'});
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
    await copy.click();
    await panel.getByText('Payment link copied.').waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),hosted);
    await stage({status:'paid',amount_paid:5000,amount_remaining:0});
    await panel.getByRole('button',{name:'Check Stripe invoice'}).click();
    await panel.getByRole('link',{name:'View paid invoice on Stripe'}).waitFor();
    assert.equal(await copy.count(),0);
    await panel.getByRole('button',{name:'Check Stripe invoice'}).click();
    await panel.getByRole('link',{name:'View paid invoice on Stripe'}).waitFor();
    assert.equal((await (await get(detail)).json()).invoice.paidCents,0);
    await page.goto(origin+'/?view=payments');
    await page.getByText('No matching recorded payments.').waitFor();
  }finally{await browser.close();}
  for(const changes of [{customer_email:'different@example.test'},{total:4999},{currency:'eur'},{livemode:true},
    {metadata:{...metadata,harbor_workspace_id:crypto.randomUUID()}},{metadata:{...metadata,harbor_invoice_id:crypto.randomUUID()}}]){
    await stage(changes);
    assert.equal((await get(lookup)).status,409);
  }
  for(const scenario of [{ids:['in_trial','in_other']},{more:true}]){
    await stage({},scenario);
    assert.equal((await get(lookup)).status,409);
  }
  for(const changes of [{amount_remaining:4900},{hosted_invoice_url:'https://example.test/invoice'},{status:'void'},
    {status:'paid',amount_remaining:10},{status:'uncollectible'}]){
    await stage(changes);
    const response=await get(lookup);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal((await response.json()).invoice.page,null);
  }
  await stage({},{failure:true});
  const failed=await get(lookup);
  assert.equal(failed.status,502);
  assert.doesNotMatch(await failed.text(),/private provider detail/);
  // An offline payment recorded during a provider read must suppress the stale link.
  await stage({},{hold:true});
  const pending=get(lookup);
  const invoice=(await (await get(detail)).json()).invoice,paymentId=crypto.randomUUID();
  try{
    await waitForFile(file+'.reading');
    await post('/api/invoices',{action:'payment',id,revision:invoice.revision,paymentId,
      data:{amountCents:500,receivedOn:invoice.data.issuedOn,method:'check',reference:'Fictional partial check',note:''}});
  }finally{await writeFile(file+'.resume','');}
  assert.equal((await pending).status,409);
  await stage();
  assert.equal((await (await get(lookup)).json()).invoice.page,null);
  await stage({amount_remaining:4500,amount_paid:500});
  assert.equal((await (await get(lookup)).json()).invoice.page,hosted);
  await post('/api/invoices',{action:'unapply',id,revision:3,paymentId,reason:'Fictional bookkeeping reversal'});
  await post('/api/invoices',{action:'void',id,revision:4,reason:'Finished fictional provider check'});
  const calls=await readFile(file+'.calls','utf8');
  assert.equal((await get(lookup)).status,409);
  assert.equal(await readFile(file+'.calls','utf8'),calls);
  await verifyPaymentLedger({origin,headers,other,get,post,source,workspaceId,sql,receivedOn:invoice.data.issuedOn});
  assert.equal(await readFile(file+'.calls','utf8'),calls,'Reading the ledger never contacts Stripe.');
  await verifySubscriptionLink({origin,headers,other,get,post,sql,workspaceId,configure,configuration,file});
}

async function verifyPaymentLedger({origin,headers,other,get,post,source,workspaceId,sql,receivedOn}){
  const id=crypto.randomUUID();
  await post('/api/invoices',{action:'create',id,source,recurring:'exclude'});
  await post('/api/invoices',{action:'finalize',id,revision:1});
  // A full page of receipts sharing a received date exercises the cursor tie-breaker.
  for(let n=0;n<26;n++){
    const entry={action:'payment',id,revision:n+2,paymentId:crypto.randomUUID(),
      data:{amountCents:100,receivedOn,method:'cash',reference:'Counter receipt '+n,note:''}};
    await post('/api/invoices',entry);
    if(n===0)await post('/api/invoices',entry);
  }
  const root='/?view=payments';
  const ledgerReceipts=()=>sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspaceId}
    AND kind='invoices' AND action='list' AND ${id}::uuid=ANY(record_ids)`;
  assert.equal((await ledgerReceipts()).length,0);
  const firstPage=await get(root+'&status=applied');
  assert.equal(firstPage.status,200);
  assert.deepEqual((await ledgerReceipts()).map(row=>row.record_ids),[[id]]);

  assert.equal((await get(root+'&workspaceId='+workspaceId,other)).status,404);
  assert.equal((await get(root+'&beforeDate='+receivedOn)).status,404);
  const outside=await get(root,other);
  assert.equal(outside.status,200);
  assert.doesNotMatch(await outside.text(),/Counter receipt|Fictional partial check/);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=invoices');
    const nav=page.getByRole('navigation',{name:'Main navigation'});
    await nav.getByRole('button',{name:'Revenue',exact:true}).click();
    await nav.getByRole('link',{name:'Payments',exact:true}).click();
    const filter=page.getByRole('combobox',{name:/Payment status/});
    await filter.selectOption('applied');
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    const references=page.locator('tbody tr td:nth-child(6)');
    const first=await references.allTextContents();
    assert.equal(first.length,25);
    await page.getByRole('link',{name:'Older payments'}).click();
    await page.getByRole('link',{name:'Latest payments'}).waitFor();
    const rest=await references.allTextContents();
    assert.equal(rest.length,1);
    assert.equal(new Set([...first,...rest]).size,26);
    const bookmark=new URL(page.url());
    const login=await get(bookmark.pathname+bookmark.search,{});
    assert.equal(login.status,307);
    assert.equal(new URL(login.headers.get('location'),origin).searchParams.get('return_to'),bookmark.pathname+bookmark.search);
    const opened=async()=>Number((await sql`SELECT count(*) AS n FROM portable_record_access_events WHERE workspace_id=${workspaceId}
      AND kind='invoices' AND action='detail' AND ${id}::uuid=ANY(record_ids)`)[0].n);
    assert.equal(await opened(),0);
    await page.locator('tbody tr a').click();
    const receipt=page.getByRole('region',{name:'Offline payments'}).getByRole('listitem').first();
    await receipt.getByText('Reference '+rest[0],{exact:true}).waitFor();
    assert.equal(await opened(),1);
    await page.goBack();
    await filter.selectOption('unapplied');
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('cell',{name:'Fictional partial check',exact:true}).waitFor();
    assert.deepEqual(await references.allTextContents(),['Fictional partial check']);
    await page.locator('tbody tr a').click();
    await page.getByText('Unapplied · Fictional bookkeeping reversal',{exact:true}).waitFor();
  }finally{await browser.close();}
}
