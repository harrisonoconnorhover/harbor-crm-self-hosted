import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const endpoint='/api/invoices';
const detail=id=>endpoint+'?id='+id;
const screen=id=>'/?view=invoices'+(id?'&invoiceId='+id:'');
const previewPath=(source,sourceId,recurring='exclude')=>endpoint+'?'+new URLSearchParams({source,sourceId,recurring});
export async function verifyPortableInvoices({request,origin,headers,other,sql,company,workspaceId}){
  const post=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const list=async (query,auth=headers)=>{
    const response=await get(endpoint+'?'+new URLSearchParams(query),auth);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const csvPath=query=>endpoint+'?'+new URLSearchParams({export:'csv',...query});
  const invoiceCsv=async(query,auth=headers)=>{
    const response=await get(csvPath(query),auth);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('content-disposition'),'attachment; filename="harbor-invoices.csv"');
    assert.equal(response.headers.get('content-type'),'text/csv; charset=utf-8');
    return response.text();
  };
  const csvIds=csv=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0].slice(1,-1));
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudget();
  const buyer=(await (await post('/api/crm',{action:'save',kind:'contacts',
    data:{name:'Fictional invoice buyer',email:'invoice-buyer@example.test'}})).json()).record;
  const deal=(await (await post('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional invoice deal'},
    primaryContactId:buyer.id,companyId:company.id})).json()).record;
  const charge={id:randomUUID(),name:'Fictional one-time charge',sku:'',description:'',unitPriceCents:5000,
    billingFrequency:'one_time',termPayments:null,quantity:1,discountBps:0};
  const subscription={...charge,id:randomUUID(),name:'Fictional monthly item',unitPriceCents:300,billingFrequency:'monthly',termPayments:12};
  const lines={dealId:deal.id,revision:0,expectedUpdatedAt:deal.updatedAt,expectedAmount:0,updateAmount:false,items:[charge,subscription]};
  assert.equal((await post('/api/deal-line-items',lines)).status,200);
  const dealSource=previewPath('deal',deal.id);
  assert.equal((await get(dealSource,{})).status,401);
  assert.equal((await get(dealSource,other)).status,404);
  assert.equal((await get(dealSource+'&source=quote')).status,400);
  const preview=(await (await get(dealSource)).json());
  assert.equal(preview.totalCents,5000);
  assert.equal(preview.data.buyer.name,buyer.data.name);
  assert.equal(preview.recurringCount,1);
  const optional=await (await get(previewPath('deal',deal.id,'one_payment'))).json();
  assert.equal(optional.totalCents,5300);
  assert.ok(optional.data.items.every(item=>item.billingFrequency==='one_time'&&item.termPayments===null));
  assert.match(optional.data.items[1].description,/One payment of monthly pricing/);
  const dealPage=await get('/?kind=deals&record='+deal.id);
  assert.match(await dealPage.text(),/Review invoice draft/);
  assert.match(await (await get('/')).text(),/href="\/\?view=invoices"/);
  const draftId=randomUUID(),dealInput={action:'create',id:draftId,source:preview.source,recurring:'exclude'};
  assert.equal((await post(endpoint,dealInput,other)).status,404);
  assert.equal((await post(endpoint,dealInput,headers,'https://outside.example.test')).status,403);
  const updatedBuyer=await post('/api/crm',{action:'save',kind:'contacts',id:buyer.id,expectedRevision:buyer.revision,
    data:{...buyer.data,name:'Fictional renamed invoice buyer'}});
  assert.equal(updatedBuyer.status,200);
  assert.equal((await post(endpoint,dealInput)).status,409);
  assert.equal((await post('/api/deal-line-items',{...lines,revision:1,items:[{...charge,unitPriceCents:5100},subscription]})).status,200);
  const revised=await (await get(dealSource)).json();
  assert.equal(revised.totalCents,5100);
  assert.equal(revised.data.buyer.name,'Fictional renamed invoice buyer');
  const create={...dealInput,source:revised.source};
  const simultaneous=await Promise.all([post(endpoint,create),post(endpoint,create)]);
  assert.deepEqual(simultaneous.map(response=>response.status),[200,200]);
  assert.deepEqual(await Promise.all(simultaneous.map(response=>response.json())),[{ok:true,id:draftId},{ok:true,id:draftId}]);
  assert.equal((await post(endpoint,{...create,recurring:'one_payment'})).status,409);
  const first=await (await get(detail(draftId))).json();
  assert.equal(first.invoice.status,'draft');
  assert.equal(first.invoice.number,null);
  assert.equal(first.invoice.snapshot,null);
  assert.equal(first.invoice.quoteId,null);
  assert.equal(first.invoice.totalCents,5100);
  assert.equal(first.invoice.data.items[0].productId,null);
  assert.notEqual(first.invoice.data.items[0].id,charge.id);
  assert.deepEqual(first.history.map(({revision,action})=>[revision,action]),[[1,'create']]);

  const quoteId=randomUUID();
  assert.equal((await post('/api/quotes',{action:'create',id:quoteId,dealId:deal.id,expectedUpdatedAt:deal.updatedAt,lineRevision:2})).status,200);
  const quoteSource=previewPath('quote',quoteId);
  assert.equal((await get(quoteSource)).status,409);
  assert.equal((await post('/api/quotes',{action:'publish',id:quoteId,revision:1})).status,200);
  const published=await get('/quotes?id='+quoteId);
  assert.match(await published.text(),/Review invoice draft/);
  assert.equal((await get(quoteSource,other)).status,404);
  assert.equal((await post('/api/deal-line-items',{...lines,revision:2,items:[{...charge,unitPriceCents:7000},subscription]})).status,200);
  assert.deepEqual(await (await post(endpoint,create)).json(),{ok:true,id:draftId});
  const quotePreview=await (await get(quoteSource)).json();
  assert.equal(quotePreview.totalCents,5100);
  const fromQuoteId=randomUUID(),fromQuote={action:'create',id:fromQuoteId,source:quotePreview.source,recurring:'exclude'};
  assert.equal((await post(endpoint,fromQuote)).status,200);
  const quoteInvoice=await (await get(detail(fromQuoteId))).json();
  assert.equal(quoteInvoice.invoice.quoteId,quoteId);
  assert.equal(quoteInvoice.invoice.quoteVersion,1);
  assert.equal(quoteInvoice.invoice.totalCents,5100);
  assert.equal((await post('/api/quotes',{action:'recall',id:quoteId,revision:2})).status,200);
  assert.equal((await post(endpoint,{...fromQuote,id:randomUUID()})).status,409);
  assert.equal((await post('/api/quotes',{action:'publish',id:quoteId,revision:3})).status,200);
  assert.equal((await post(endpoint,{...fromQuote,id:randomUUID()})).status,409);
  assert.deepEqual(await (await post(endpoint,fromQuote)).json(),{ok:true,id:fromQuoteId});
  assert.deepEqual(await (await get(detail(fromQuoteId))).json(),quoteInvoice);

  const edit={action:'save',id:draftId,revision:1,data:{...first.invoice.data,title:'Fictional revised invoice',
    reference:'=Fictional PO 123, "approved"',terms:'Fictional terms <script>alert(1)</script>',items:[{...first.invoice.data.items[0],unitPriceCents:8000}]}};
  assert.equal((await post(endpoint,edit,other)).status,404);
  await sql`ALTER TABLE portable_invoice_events ADD CONSTRAINT fixture_invoice_event_failure CHECK (revision<>2)`;
  try{
    assert.equal((await post(endpoint,edit)).status,500);
    assert.deepEqual(await (await get(detail(draftId))).json(),first);
  }finally{await sql`ALTER TABLE portable_invoice_events DROP CONSTRAINT fixture_invoice_event_failure`;}
  const saves=await Promise.all([post(endpoint,edit),post(endpoint,edit)]);
  assert.deepEqual(saves.map(response=>response.status).sort(),[200,409]);
  const revisedInvoice=await (await get(detail(draftId))).json();
  assert.equal(revisedInvoice.invoice.totalCents,8000);
  assert.deepEqual(revisedInvoice.history.map(({revision,action})=>[revision,action]),[[2,'save'],[1,'create']]);
  assert.ok(revisedInvoice.history.every(row=>row.actorName));
  assert.equal((await get(detail(draftId),other)).status,404);
  assert.equal((await get(screen(draftId),other)).status,404);
  assert.deepEqual(await (await get(endpoint,other)).json(),{items:[],next:null});
  assert.equal((await post(endpoint,{action:'finalize',id:draftId,revision:0})).status,400);
  assert.equal((await get('/api/v1/invoices')).status,404);
  assert.equal((await get(detail(draftId)+'&download=true')).status,400);
  assert.match(await (await get(screen(draftId))).text(),/Fictional revised invoice/);
  assert.equal((await (await get(endpoint+'?q=fIctIonal+pO')).json()).items[0].id,draftId);
  assert.equal((await (await get(endpoint+'?quoteId='+quoteId)).json()).items[0].id,fromQuoteId);
  assert.deepEqual((await (await get(endpoint+'?dealId='+deal.id)).json()).items.map(item=>item.id).sort(),[draftId,fromQuoteId].sort());

  const voidDecoy='00000000-0000-4000-8000-000000000001';
  const tooEarly='00000000-0000-4000-8000-000000000002',tooLate='00000000-0000-4000-8000-000000000003';
  const undated='00000000-0000-4000-8000-000000000004';
  const dueFrom='2096-02-29',dueThrough='2096-03-01';
  const rangeIds=Array.from({length:26},()=>randomUUID());
  const paginationIds=[voidDecoy,tooEarly,tooLate,undated,...rangeIds];
  await sql`INSERT INTO portable_invoices(workspace_id,id,deal_id,deal_created_at,deal_name,source_note,revision,creation_key,
    data,total_cents,created_at,updated_at)
    SELECT ${workspaceId},ids.id,deal_id,deal_created_at,deal_name,source_note,revision,creation_key,
      jsonb_set(data,'{dueOn}',to_jsonb(CASE ids.id
        WHEN ${tooEarly}::uuid THEN '2096-02-28'::text
        WHEN ${tooLate}::uuid THEN '2096-03-02'::text
        WHEN ${undated}::uuid THEN ''::text
        WHEN ${rangeIds[0]}::uuid THEN ${dueFrom}::text
        ELSE ${dueThrough}::text END)),total_cents,created_at,updated_at
    FROM portable_invoices CROSS JOIN unnest(${paginationIds}::uuid[]) AS ids(id)
    WHERE workspace_id=${workspaceId} AND portable_invoices.id=${draftId}`;
  try{
    await sql`UPDATE portable_invoices SET void_reason='Fictional filter exclusion' WHERE workspace_id=${workspaceId} AND id=${voidDecoy}`;
    const page=await (await get(endpoint)).json();
    assert.equal(page.items.length,25);
    assert.equal(page.next,page.items.at(-1).id);
    const next=await (await get(endpoint+'?after='+page.next)).json();
    assert.equal(next.items.length,7);
    assert.equal(next.next,null);
    assert.deepEqual([...page.items,...next.items].map(item=>item.id),[...paginationIds,draftId,fromQuoteId].sort());

    assert.deepEqual(await list({status:'all'}),page);
    const firstDrafts=await list({status:'draft'});
    assert.equal(firstDrafts.items.length,25,'Status is applied before choosing the first 25 rows.');
    assert.equal(firstDrafts.next,firstDrafts.items.at(-1).id);
    const lastDrafts=await list({status:'draft',after:firstDrafts.next});
    assert.equal(lastDrafts.next,null);
    const drafts=[...firstDrafts.items,...lastDrafts.items];
    assert.ok(drafts.every(item=>item.status==='draft'));
    assert.deepEqual(drafts.map(item=>item.id),[...paginationIds.slice(1),draftId,fromQuoteId].sort());
    assert.deepEqual(await list({status:'draft'},other),{items:[],next:null});
    const invoiceScreen=await get(screen()+'&status=draft');
    assert.equal(invoiceScreen.status,200);
    const filteredHtml=await invoiceScreen.text();
    assert.match(filteredHtml,/<select name="status">/);
    assert.match(filteredHtml,/>Export CSV<\/button>/);
    assert.deepEqual(csvIds(await invoiceCsv({status:'draft',dealId:deal.id})),drafts.map(item=>item.id));
    assert.deepEqual(csvIds(await invoiceCsv({status:'draft',quoteId})),[fromQuoteId]);
    assert.deepEqual(csvIds(await invoiceCsv({status:'draft'},other)),[]);
    assert.equal((await get(csvPath({status:'draft'}),{})).status,401);
    for(const query of [{after:firstDrafts.next},{id:draftId},{workspaceId},{export:'pdf'},{status:'unknown'}]){
      assert.equal((await get(csvPath(query))).status,400);
    }
    assert.equal((await get(csvPath({status:'draft'})+'&status=void')).status,400);
    const draftCsv=await invoiceCsv({q:'FiCtIoNaL Po',status:'draft',dealId:deal.id});
    assert.ok(csvIds(draftCsv).includes(draftId));
    assert.ok(!csvIds(draftCsv).includes(fromQuoteId));
    assert.ok(draftCsv.includes(`"'=Fictional PO 123, ""approved"""`));
    assert.ok(draftCsv.includes(`"USD","80.00","0.00","","${deal.id}",""`));
    assert.doesNotMatch(draftCsv,/Fictional terms|invoice-buyer@example\.test/);
    assert.match(filteredHtml,/href="\/\?view=invoices&amp;status=draft&amp;after=/);
    for(const query of ['status=invalid','status=draft&status=void','id='+draftId+'&status=draft']){
      assert.equal((await get(endpoint+'?'+query)).status,400);
    }

    const range={dealId:deal.id,q:'FiCtIoNaL PO',status:'draft',dueFrom,dueThrough};
    const firstInRange=await list(range);
    assert.equal(firstInRange.items.length,25);
    assert.equal(firstInRange.next,firstInRange.items.at(-1).id);
    const lastInRange=await list({...range,after:firstInRange.next});
    assert.equal(lastInRange.next,null);
    const inRange=[...firstInRange.items,...lastInRange.items];
    assert.deepEqual(inRange.map(item=>item.id),rangeIds.toSorted());
    assert.deepEqual([...new Set(inRange.map(item=>item.dueOn))].sort(),[dueFrom,dueThrough]);
    assert.deepEqual(csvIds(await invoiceCsv(range)),rangeIds.toSorted());
    assert.deepEqual(await list(range,other),{items:[],next:null});
    assert.deepEqual(csvIds(await invoiceCsv(range,other)),[]);
    assert.deepEqual(await list({...range,quoteId}),{items:[],next:null});
    assert.deepEqual(csvIds(await invoiceCsv({quoteId,dueFrom:quoteInvoice.invoice.data.dueOn})),[fromQuoteId]);
    assert.deepEqual((await list({dueFrom:'2096-03-02'})).items.map(item=>item.id),[tooLate]);
    assert.deepEqual(csvIds(await invoiceCsv({dealId:deal.id,status:'draft',q:range.q,dueThrough:dueFrom})),
      [tooEarly,rangeIds[0],draftId].sort());

    const rangeParams=new URLSearchParams(range);
    const rangeScreen=await get(screen()+'&'+rangeParams);
    assert.equal(rangeScreen.status,200);
    const rangeHtml=await rangeScreen.text();
    assert.match(rangeHtml,/<input (?=[^>]*type="date")(?=[^>]*name="dueFrom")(?=[^>]*value="2096-02-29")/);
    assert.match(rangeHtml,/<input (?=[^>]*type="date")(?=[^>]*name="dueThrough")(?=[^>]*value="2096-03-01")/);
    rangeParams.set('after',firstInRange.next);
    assert.ok(rangeHtml.includes(`href="${screen()}&amp;${rangeParams.toString().replaceAll('&','&amp;')}"`));
    assert.equal((await get(screen()+'&dueFrom=&dueThrough='+dueThrough)).status,200);
    for(const query of ['dueFrom=2095-02-29','dueThrough=2096-04-31','dueFrom=2096-2-29','dueFrom=0000-01-01',
      `dueFrom=${dueThrough}&dueThrough=${dueFrom}`,`dueFrom=${dueFrom}&dueFrom=${dueFrom}`]){
      assert.equal((await get(endpoint+'?'+query)).status,400);
      assert.equal((await get(endpoint+'?export=csv&'+query)).status,400);
    }
    assert.equal((await get(detail(draftId)+'&dueFrom='+dueFrom)).status,400);
    assert.equal((await get(dealSource+'&dueThrough='+dueThrough)).status,400);
  }finally{await sql`DELETE FROM portable_invoices WHERE workspace_id=${workspaceId} AND id=ANY(${paginationIds}::uuid[])`;}

  const capIds=Array.from({length:501},()=>randomUUID());
  const limitFilter={q:'Fictional invoice export cap',status:'draft',dealId:deal.id};
  const insertLimitRows=ids=>sql`INSERT INTO portable_invoices(workspace_id,id,deal_id,deal_created_at,deal_name,source_note,revision,creation_key,
    data,total_cents,created_at,updated_at)
    SELECT ${workspaceId},ids.id,deal_id,deal_created_at,deal_name,source_note,revision,creation_key,
      jsonb_set(data,'{title}','"Fictional invoice export cap"'::jsonb),total_cents,created_at,updated_at
    FROM portable_invoices CROSS JOIN unnest(${ids}::uuid[]) AS ids(id)
    WHERE workspace_id=${workspaceId} AND portable_invoices.id=${draftId}`;
  try{
    await insertLimitRows(capIds.slice(0,500));
    assert.deepEqual(csvIds(await invoiceCsv(limitFilter)),capIds.slice(0,500).sort());
    await insertLimitRows(capIds.slice(500));
    const overflow=await get(csvPath(limitFilter));
    assert.equal(overflow.status,413);
    assert.equal(overflow.headers.get('cache-control'),'private, no-store');
    assert.match((await overflow.json()).error,/More than 500 invoices match/);
  }finally{await sql`DELETE FROM portable_invoices WHERE workspace_id=${workspaceId} AND id=ANY(${capIds}::uuid[])`;}

  const issue={action:'finalize',id:draftId,revision:2};
  const issueQuote={action:'finalize',id:fromQuoteId,revision:1};
  assert.equal((await post(endpoint,{...issue,revision:1})).status,409);
  assert.equal((await post(endpoint,issue,other)).status,404);
  assert.equal((await post(endpoint,issue,headers,'https://outside.example.test')).status,403);
  await sql`ALTER TABLE portable_invoice_events ADD CONSTRAINT fixture_invoice_issue_failure CHECK (action<>'finalize')`;
  try{
    assert.equal((await post(endpoint,issue)).status,500);
    assert.deepEqual(await (await get(detail(draftId))).json(),revisedInvoice);
  }finally{await sql`ALTER TABLE portable_invoice_events DROP CONSTRAINT fixture_invoice_issue_failure`;}
  const issuedResponses=await Promise.all([post(endpoint,issue),post(endpoint,issue),post(endpoint,issueQuote)]);
  assert.deepEqual(issuedResponses.map(response=>response.status),[200,200,200]);
  assert.deepEqual(await Promise.all(issuedResponses.map(response=>response.json())),[
    {ok:true,id:draftId},{ok:true,id:draftId},{ok:true,id:fromQuoteId},
  ]);
  const issued=await (await get(detail(draftId))).json();
  const issuedQuote=await (await get(detail(fromQuoteId))).json();
  assert.deepEqual([issued.invoice.number,issuedQuote.invoice.number].sort(),[1,2]);
  assert.equal(issued.invoice.status,'open');
  const openInvoices=await list({status:'open',quoteId});
  assert.deepEqual(openInvoices.items.map(item=>[item.id,item.status]),[[fromQuoteId,'open']]);
  assert.equal(issued.invoice.revision,3);
  assert.ok(issued.invoice.finalizedAt);
  assert.deepEqual(issued.invoice.snapshot.data,revisedInvoice.invoice.data);
  assert.equal(issued.invoice.snapshot.totals.netCents,8000);
  assert.equal(issuedQuote.invoice.snapshot.totals.netCents,5100);
  assert.equal(issuedQuote.invoice.quoteVersion,1);
  assert.deepEqual(issued.history.map(event=>[event.revision,event.action]),[[3,'finalize'],[2,'save'],[1,'create']]);
  assert.ok(issued.history[0].actorName);
  assert.equal((await post(endpoint,{...edit,revision:3})).status,409);
  assert.equal((await post(endpoint,{...issue,revision:3})).status,409);
  assert.deepEqual(await (await get(detail(draftId))).json(),issued);

  const download=detail(draftId)+'&download=true';
  const exportResponse=await get(download);
  assert.equal(exportResponse.status,200);
  assert.equal(exportResponse.headers.get('content-disposition'),`attachment; filename="Harbor-INV-${issued.invoice.number}.html"`);
  assert.equal(exportResponse.headers.get('cache-control'),'private, no-store');
  assert.match(exportResponse.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(exportResponse.headers.get('x-content-type-options'),'nosniff');
  const exported=await exportResponse.text();
  assert.match(exported,/Fictional terms &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(exported,/<script>/);
  assert.equal((await get(download,other)).status,404);
  assert.equal((await get(download,{})).status,401);
  const issuedScreen=await (await get(screen(draftId))).text();
  assert.match(issuedScreen,/Download HTML/);
  assert.doesNotMatch(issuedScreen,/>Edit draft</);
  assert.doesNotMatch(issuedScreen,/>Finalize invoice</);

  const paymentDate=issued.invoice.data.issuedOn;
  const payment={action:'payment',id:draftId,revision:3,paymentId:randomUUID(),
    data:{amountCents:2000,receivedOn:paymentDate,method:'check',reference:'Fictional check 12',note:'Recorded from receipt'}};
  assert.equal((await post(endpoint,payment,other)).status,404);
  assert.equal((await post(endpoint,payment,headers,'https://outside.example.test')).status,403);
  assert.equal((await post(endpoint,{...payment,data:{...payment.data,amountCents:0}})).status,400);
  assert.equal((await post(endpoint,{...payment,data:{...payment.data,receivedOn:'2099-01-01'}})).status,400);
  assert.equal((await post(endpoint,{...payment,data:{...payment.data,receivedOn:'2000-01-01'}})).status,400);
  await sql`ALTER TABLE portable_invoice_events ADD CONSTRAINT fixture_invoice_payment_failure CHECK (action<>'payment')`;
  try{
    assert.equal((await post(endpoint,payment)).status,500);
    assert.deepEqual(await (await get(detail(draftId))).json(),issued);
  }finally{await sql`ALTER TABLE portable_invoice_events DROP CONSTRAINT fixture_invoice_payment_failure`;}
  const repeated=await Promise.all([post(endpoint,payment),post(endpoint,payment)]);
  assert.deepEqual(repeated.map(response=>response.status),[200,200]);
  assert.deepEqual(await Promise.all(repeated.map(response=>response.json())),[
    {ok:true,id:draftId,applied:true},{ok:true,id:draftId,applied:true},
  ]);
  const partial=await (await get(detail(draftId))).json();
  assert.equal(partial.invoice.paidCents,2000);
  assert.equal(partial.invoice.revision,4);
  assert.equal(partial.payments.length,1);
  assert.deepEqual(partial.invoice.snapshot,issued.invoice.snapshot);
  assert.equal((await post(endpoint,{...payment,id:fromQuoteId,revision:issuedQuote.invoice.revision})).status,409);

  const racing=[randomUUID(),randomUUID()].map(paymentId=>({...payment,paymentId,revision:4,
    data:{...payment.data,amountCents:6000,method:'bank_transfer',reference:'Fictional transfer'}}));
  const race=await Promise.all(racing.map(entry=>post(endpoint,entry)));
  assert.deepEqual(race.map(response=>response.status).sort(),[200,409]);
  const winner=racing[race.findIndex(response=>response.ok)];
  assert.equal((await post(endpoint,{...winner,paymentId:randomUUID(),revision:5,data:{...winner.data,amountCents:1}})).status,400);
  assert.equal((await post(endpoint,{...winner,data:{...winner.data,note:'Different payload'}})).status,409);
  const paid=await (await get(detail(draftId))).json();
  assert.equal(paid.invoice.paidCents,8000);
  assert.equal(paid.invoice.revision,5);
  assert.equal(paid.payments.length,2);
  const setDueOn=dueOn=>sql`UPDATE portable_invoices SET data=jsonb_set(data,'{dueOn}',to_jsonb(${dueOn}::text))
    WHERE workspace_id=${workspaceId} AND id=${draftId}`;
  await setDueOn('2000-01-01');
  try{
    const listPaid=await list({q:'Fictional PO',status:'paid'});
    assert.deepEqual(listPaid.items.map(item=>[item.id,item.status]),[[draftId,'paid']]);
    assert.deepEqual(await list({q:'Fictional PO',status:'overdue'}),{items:[],next:null});
  }finally{await setDueOn(paid.invoice.data.dueOn);}
  assert.match(await (await get(screen(draftId))).text(),/Fictional transfer/);

  const undo={action:'unapply',id:draftId,revision:5,paymentId:payment.paymentId,reason:'Fictional duplicate bookkeeping entry'};
  assert.equal((await post(endpoint,{...undo,revision:4})).status,409);
  assert.equal((await post(endpoint,{...undo,id:fromQuoteId,revision:issuedQuote.invoice.revision})).status,404);
  await sql`ALTER TABLE portable_invoice_events ADD CONSTRAINT fixture_invoice_unapply_failure CHECK (action<>'unapply')`;
  try{
    assert.equal((await post(endpoint,undo)).status,500);
    assert.deepEqual(await (await get(detail(draftId))).json(),paid);
  }finally{await sql`ALTER TABLE portable_invoice_events DROP CONSTRAINT fixture_invoice_unapply_failure`;}
  assert.deepEqual(await (await post(endpoint,undo)).json(),{ok:true,id:draftId,applied:false});
  assert.deepEqual(await (await post(endpoint,undo)).json(),{ok:true,id:draftId,applied:false});
  assert.equal((await post(endpoint,{...undo,reason:'Different reason'})).status,409);
  assert.deepEqual(await (await post(endpoint,payment)).json(),{ok:true,id:draftId,applied:false});
  const ledger=await (await get(detail(draftId))).json();
  assert.equal(ledger.invoice.paidCents,6000);
  assert.equal(ledger.invoice.revision,6);
  assert.deepEqual(ledger.invoice.snapshot,issued.invoice.snapshot);
  assert.equal(ledger.payments.find(item=>item.id===payment.paymentId).unapplyReason,undo.reason);
  assert.equal(ledger.history[0].action,'unapply');
  assert.ok(ledger.history[0].actorName);
  assert.match(ledger.history[0].note,/Fictional duplicate bookkeeping entry/);
  const listPartial=await list({q:'Fictional PO',status:'partially_paid'});
  assert.deepEqual(listPartial.items.map(item=>[item.id,item.status]),[[draftId,'partially_paid']]);
  await setDueOn('2000-01-01');
  try{
    const overdue=await list({dealId:deal.id,q:'Fictional PO',status:'overdue'});
    assert.deepEqual(overdue.items.map(item=>[item.id,item.status,item.paidCents]),[[draftId,'overdue',6000]]);
    assert.deepEqual(await list({q:'Fictional PO',status:'partially_paid'}),{items:[],next:null});
    const overdueCsv=await invoiceCsv({dealId:deal.id,q:'Fictional PO',status:'overdue'});
    assert.deepEqual(csvIds(overdueCsv),[draftId]);
    assert.ok(overdueCsv.includes(`"USD","80.00","60.00","20.00","${deal.id}",""`));
    assert.doesNotMatch(overdueCsv,/Fictional transfer|Recorded from receipt|Fictional duplicate bookkeeping entry/);
    assert.deepEqual(csvIds(await invoiceCsv({q:'Fictional PO',status:'partially_paid'})),[]);
  }finally{await setDueOn(ledger.invoice.data.dueOn);}
  const oldReceipt=await (await get(detail(draftId)+'&paymentsBefore=5')).json();
  assert.deepEqual(oldReceipt.payments,ledger.payments.filter(item=>item.revision<5));
  const ledgerHTML=await (await get(download)).text();
  assert.match(ledgerHTML,/Payments recorded \$60\.00/);

  const restoreDraftId=randomUUID();
  const currentSource=await (await get(dealSource)).json();
  assert.equal((await post(endpoint,{...dealInput,id:restoreDraftId,source:currentSource.source})).status,200);
  const restoreDraft=await (await get(detail(restoreDraftId))).json();
  assert.equal((await post(endpoint,{...payment,id:restoreDraftId,paymentId:randomUUID(),revision:1})).status,400);
  const future={...restoreDraft.invoice.data,issuedOn:new Date(Date.now()+86_400_000).toISOString().slice(0,10)};
  assert.equal((await post(endpoint,{action:'save',id:restoreDraftId,revision:1,data:future})).status,200);
  const invalidIssue=await post(endpoint,{action:'finalize',id:restoreDraftId,revision:2});
  assert.equal(invalidIssue.status,400);
  assert.match((await invalidIssue.json()).error,/Invoice date cannot be in the future/);
  assert.equal((await post(endpoint,{action:'save',id:restoreDraftId,revision:2,data:restoreDraft.invoice.data})).status,200);
  const unissued=await (await get(detail(restoreDraftId))).json();

  await resetBudget();
  const voidInvoice={action:'void',id:fromQuoteId,revision:issuedQuote.invoice.revision,reason:'Fictional billing correction'};
  assert.equal((await post(endpoint,{...voidInvoice,id:draftId,revision:ledger.invoice.revision})).status,409);
  assert.equal((await post(endpoint,{...voidInvoice,reason:'   '})).status,400);
  assert.equal((await post(endpoint,voidInvoice,other)).status,404);
  assert.equal((await post(endpoint,voidInvoice,headers,'https://outside.example.test')).status,403);
  await sql`ALTER TABLE portable_invoice_events ADD CONSTRAINT fixture_invoice_void_failure CHECK (action<>'void')`;
  try{
    assert.equal((await post(endpoint,voidInvoice)).status,500);
    assert.deepEqual(await (await get(detail(fromQuoteId))).json(),issuedQuote);
  }finally{await sql`ALTER TABLE portable_invoice_events DROP CONSTRAINT fixture_invoice_void_failure`;}

  const quotePayment={...payment,id:fromQuoteId,paymentId:randomUUID(),revision:voidInvoice.revision};
  assert.equal((await post(endpoint,quotePayment)).status,200);
  const quoteUndo={...undo,id:fromQuoteId,paymentId:quotePayment.paymentId,revision:voidInvoice.revision+1};
  const reversalRace=await Promise.all([post(endpoint,quoteUndo),post(endpoint,{...voidInvoice,revision:quoteUndo.revision})]);
  assert.deepEqual(reversalRace.map(response=>response.status),[200,409]);

  const raceVoid={...voidInvoice,revision:quoteUndo.revision+1};
  const racePayment={...quotePayment,paymentId:randomUUID(),revision:raceVoid.revision};
  const paymentVoidRace=await Promise.all([post(endpoint,raceVoid),post(endpoint,racePayment)]);
  assert.deepEqual(paymentVoidRace.map(response=>response.status).sort(),[200,409]);
  const finalVoid=paymentVoidRace[0].ok?raceVoid:{...raceVoid,revision:raceVoid.revision+2};
  if(paymentVoidRace[1].ok){
    assert.equal((await post(endpoint,{...quoteUndo,paymentId:racePayment.paymentId,revision:raceVoid.revision+1})).status,200);
    assert.equal((await post(endpoint,finalVoid)).status,200);
  }
  assert.deepEqual(await (await post(endpoint,{...finalVoid,reason:' '+finalVoid.reason+' '})).json(),{ok:true,id:fromQuoteId});
  assert.equal((await post(endpoint,{...finalVoid,reason:'Different reason'})).status,409);
  const voided=await (await get(detail(fromQuoteId))).json();
  assert.equal(voided.invoice.status,'void');
  assert.equal(voided.invoice.voidReason,finalVoid.reason);
  assert.equal(voided.invoice.number,issuedQuote.invoice.number);
  assert.equal(voided.invoice.finalizedAt,issuedQuote.invoice.finalizedAt);
  assert.equal(voided.invoice.totalCents,issuedQuote.invoice.totalCents);
  assert.equal(voided.invoice.paidCents,0);
  assert.deepEqual(voided.invoice.data,issuedQuote.invoice.data);
  assert.deepEqual(voided.invoice.snapshot,issuedQuote.invoice.snapshot);
  assert.ok(voided.payments.every(receipt=>receipt.unappliedAt));
  assert.equal(voided.history.filter(event=>event.action==='void').length,1);
  assert.equal(voided.history[0].note,finalVoid.reason);
  assert.ok(voided.history[0].actorName);
  assert.equal((await post(endpoint,{...racePayment,paymentId:randomUUID(),revision:voided.invoice.revision})).status,400);
  assert.deepEqual(await (await post(endpoint,quoteUndo)).json(),{ok:true,id:fromQuoteId,applied:false});
  const listVoid=await list({quoteId,status:'void'});
  assert.deepEqual(listVoid.items.map(item=>[item.id,item.status]),[[fromQuoteId,'void']]);
  const voidCsv=await invoiceCsv({quoteId,status:'void'});
  assert.deepEqual(csvIds(voidCsv),[fromQuoteId]);
  assert.ok(voidCsv.includes(`"USD","51.00","0.00","0.00","${deal.id}","${quoteId}"`));
  assert.doesNotMatch(voidCsv,/Fictional billing correction/);
  const voidedPage=await (await get(screen(fromQuoteId))).text();
  assert.match(voidedPage,/Do not pay this invoice/i);
  assert.doesNotMatch(voidedPage,/>Record offline payment</);
  const quoteDownload=detail(fromQuoteId)+'&download=true';
  const voidedHTML=await (await get(quoteDownload)).text();
  assert.match(voidedHTML,/VOID — do not pay this invoice/);
  assert.match(voidedHTML,/Balance due <strong>\$0\.00 USD<\/strong>/);

  const voidDraftId=randomUUID();
  assert.equal((await post(endpoint,{...dealInput,id:voidDraftId,source:currentSource.source})).status,200);
  const voidDraft={...voidInvoice,id:voidDraftId,revision:1};
  assert.equal((await post(endpoint,voidDraft)).status,200);
  const voidedDraft=await (await get(detail(voidDraftId))).json();
  assert.equal(voidedDraft.invoice.status,'void');
  assert.equal(voidedDraft.invoice.number,null);
  assert.equal(voidedDraft.invoice.snapshot,null);
  assert.equal((await post(endpoint,{action:'finalize',id:voidDraftId,revision:2})).status,409);
  assert.equal((await post(endpoint,{action:'save',id:voidDraftId,revision:2,data:voidedDraft.invoice.data})).status,409);
  assert.equal((await get(detail(voidDraftId)+'&download=true')).status,400);

  const stableHTML=html=>html.replace(/Balance\/status as of [^<]+?\. Contact/,'Balance/status as of <timestamp>. Contact');

  await resetBudget();
  const archivedFallbackId=randomUUID(),archivedQuoteId=randomUUID();
  const publishedPath='/api/quotes?id='+quoteId;
  const publishedBeforeArchive=await (await get(publishedPath)).json();
  await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${buyer.id}`;
  try{
    const fallback=await (await get(dealSource)).json();
    assert.equal(fallback.source.buyerRevision,null);
    assert.equal(fallback.data.buyer.name,company.data.name);
    assert.equal(fallback.data.buyer.email,'');
    const archiveCreate={...dealInput,id:archivedFallbackId};
    assert.equal((await post(endpoint,{...archiveCreate,source:currentSource.source})).status,409);
    assert.equal((await post(endpoint,{...archiveCreate,source:fallback.source})).status,200);
    assert.deepEqual((await (await get(detail(archivedFallbackId))).json()).invoice.data.buyer,fallback.data.buyer);
    assert.equal((await post('/api/quotes',{action:'create',id:archivedQuoteId,dealId:deal.id,
      expectedUpdatedAt:fallback.source.updatedAt,lineRevision:fallback.source.lineRevision})).status,200);
    const quoteFallback=await (await get('/api/quotes?id='+archivedQuoteId)).json();
    assert.deepEqual(quoteFallback.quote.data.buyer,fallback.data.buyer);

    assert.deepEqual(await (await get(publishedPath)).json(),publishedBeforeArchive);
    const frozenSource=await (await get(quoteSource)).json();
    assert.deepEqual(frozenSource.data.buyer,publishedBeforeArchive.published.snapshot.data.buyer);
    assert.equal(frozenSource.data.buyer.email,buyer.data.email);
    assert.deepEqual(await (await post(endpoint,fromQuote)).json(),{ok:true,id:fromQuoteId});
    assert.deepEqual(await (await get(detail(fromQuoteId))).json(),voided);
    assert.equal(stableHTML(await (await get(quoteDownload)).text()),stableHTML(voidedHTML));
  }finally{
    await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${buyer.id}`;
  }
  const restoredSource=await (await get(dealSource)).json();
  assert.deepEqual(restoredSource.source,currentSource.source);
  assert.deepEqual(restoredSource.data.buyer,currentSource.data.buyer);

  const emptyDealResponse=await post('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional deal without line items'},
    primaryContactId:buyer.id,companyId:company.id});
  assert.equal(emptyDealResponse.status,201);
  const {record:emptyDeal}=await emptyDealResponse.json();
  const emptyPreviewResponse=await get(previewPath('deal',emptyDeal.id));
  assert.equal(emptyPreviewResponse.status,200);
  const emptyPreview=await emptyPreviewResponse.json();
  assert.equal(emptyPreview.source.lineRevision,0);
  const emptyDraftId=randomUUID();
  const emptyCreate={action:'create',id:emptyDraftId,source:emptyPreview.source,recurring:'exclude'};
  assert.equal((await post(endpoint,emptyCreate)).status,200);
  assert.deepEqual(await (await post(endpoint,emptyCreate)).json(),{ok:true,id:emptyDraftId});
  const emptyDraft=await (await get(detail(emptyDraftId))).json();
  assert.equal(emptyDraft.invoice.status,'draft');
  assert.equal(emptyDraft.invoice.totalCents,0);
  assert.deepEqual(emptyDraft.invoice.data.items,[]);
  assert.equal((await post(endpoint,{action:'finalize',id:emptyDraftId,revision:1})).status,400);

  return async (restored,owner,outsider,restoreOrigin)=>{
    assert.deepEqual(await (await restored(detail(emptyDraftId),{headers:owner})).json(),emptyDraft);
    assert.deepEqual(await (await restored(detail(draftId),{headers:owner})).json(),ledger);
    assert.deepEqual(await (await restored(detail(fromQuoteId),{headers:owner})).json(),voided);
    assert.deepEqual(await (await restored(detail(voidDraftId),{headers:owner})).json(),voidedDraft);
    assert.equal((await restored(quoteDownload,{headers:outsider})).status,404);
    assert.equal(stableHTML(await (await restored(download,{headers:owner})).text()),stableHTML(ledgerHTML));
    assert.equal((await restored(download,{headers:outsider})).status,404);
    assert.equal((await restored(detail(fromQuoteId),{headers:outsider})).status,404);
    const page=await restored(screen(fromQuoteId),{headers:owner});
    assert.equal(page.status,200);
    assert.match(await page.text(),/Source quote version/);
    assert.deepEqual(await (await restored(detail(restoreDraftId),{headers:owner})).json(),unissued);
    const restoredPost=body=>restored(endpoint,{method:'POST',
      headers:{...owner,origin:restoreOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.deepEqual(await (await restoredPost(finalVoid)).json(),{ok:true,id:fromQuoteId});
    assert.deepEqual(await (await restoredPost(voidDraft)).json(),{ok:true,id:voidDraftId});
    assert.deepEqual(await (await restored(detail(fromQuoteId),{headers:owner})).json(),voided);
    assert.equal(stableHTML(await (await restored(quoteDownload,{headers:owner})).text()),stableHTML(voidedHTML));
    assert.deepEqual(await (await restoredPost(undo)).json(),{ok:true,id:draftId,applied:false});
    assert.deepEqual(await (await restoredPost(payment)).json(),{ok:true,id:draftId,applied:false});
    assert.deepEqual(await (await restored(detail(draftId),{headers:owner})).json(),ledger);
    const targetUndo={...undo,revision:6,paymentId:winner.paymentId,reason:'Fictional target-only reversal'};
    assert.deepEqual(await (await restoredPost(targetUndo)).json(),{ok:true,id:draftId,applied:false});
    assert.deepEqual(await (await restoredPost(targetUndo)).json(),{ok:true,id:draftId,applied:false});
    const targetLedger=await (await restored(detail(draftId),{headers:owner})).json();
    assert.equal(targetLedger.invoice.paidCents,0);
    assert.equal(targetLedger.invoice.revision,7);
    assert.deepEqual(targetLedger.invoice.snapshot,issued.invoice.snapshot);
    assert.deepEqual(await (await get(detail(draftId))).json(),ledger);
    const finalizeOnRestore=()=>restoredPost({action:'finalize',id:restoreDraftId,revision:3});
    const replayed=await Promise.all([finalizeOnRestore(),finalizeOnRestore()]);
    assert.deepEqual(replayed.map(response=>response.status),[200,200]);
    const newest=await (await restored(detail(restoreDraftId),{headers:owner})).json();
    assert.equal(newest.invoice.number,3);
    assert.equal(newest.invoice.revision,4);
    assert.equal(newest.history.filter(event=>event.action==='finalize').length,1);
    assert.equal(newest.invoice.snapshot.totals.netCents,7000);
    assert.deepEqual(await (await get(detail(restoreDraftId))).json(),unissued);
  };
}
