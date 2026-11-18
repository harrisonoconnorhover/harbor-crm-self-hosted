import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableQuotes({request,origin,headers,other,contact,company,sql}){
  const write=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,
    'content-type':'application/json'},body:JSON.stringify(body)});
  const api='/api/quotes',id=randomUUID(),detail=api+'?id='+id;
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const created=await write('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional draft source'},
    primaryContactId:contact.id,companyId:company.id});
  assert.equal(created.status,201);
  const {record:deal}=await created.json();
  const item={id:randomUUID(),name:'Fictional draft item',sku:'',description:'',unitPriceCents:2500,
    billingFrequency:'one_time',termPayments:null,quantity:2,discountBps:0};
  const lines={dealId:deal.id,revision:0,expectedUpdatedAt:deal.updatedAt,expectedAmount:0,updateAmount:false,items:[item]};
  assert.equal((await write('/api/deal-line-items',lines)).status,200);
  const input={action:'create',id,dealId:deal.id,expectedUpdatedAt:deal.updatedAt,lineRevision:1};
  assert.equal((await write(api,input,other)).status,404);
  assert.equal((await write(api,{...input,lineRevision:0})).status,409);
  const attempts=await Promise.all([write(api,input),write(api,input)]);
  assert.deepEqual(await Promise.all(attempts.map(response=>response.json())),[{ok:true,id},{ok:true,id}]);
  const read=(path,auth=headers)=>request(path,{headers:auth});
  assert.equal((await read(detail,other)).status,404);
  const original=await (await read(detail)).json();
  assert.equal(original.quote.status,'draft');
  assert.equal(original.quote.data.buyer.name,contact.data.name);
  assert.equal(original.quote.data.items[0].unitPriceCents,2500);
  assert.notEqual(original.quote.data.items[0].id,item.id);
  assert.equal(original.quote.data.items[0].productId,null);
  assert.equal((await write(api,{...input,lineRevision:2})).status,409);
  assert.equal((await write(api,{action:'publish',id,revision:0})).status,400);
  assert.equal((await read(detail+'&download=true')).status,400);
  const edited={action:'save',id,revision:1,data:{...original.quote.data,title:'Revised fictional proposal',terms:'Fictional terms'}};
  await sql`ALTER TABLE portable_quote_events ADD CONSTRAINT fixture_quote_event_failure CHECK (revision<>2)`;
  try{
    assert.equal((await write(api,edited)).status,500);
    assert.deepEqual(await (await read(detail)).json(),original);
  }finally{await sql`ALTER TABLE portable_quote_events DROP CONSTRAINT fixture_quote_event_failure`;}
  const raced=await Promise.all([write(api,edited),write(api,edited)]);
  assert.deepEqual(raced.map(response=>response.status).sort(),[200,409]);
  const final=await (await read(detail)).json();
  assert.deepEqual(final.history.map(row=>[row.revision,row.action]),[[2,'save'],[1,'create']]);
  assert.ok(final.history.every(row=>row.actorName));
  assert.equal((await (await read(api+'?q=revised+fictional')).json()).items[0].id,id);
  assert.match(await (await read('/quotes?id='+id)).text(),/Revised fictional proposal/);
  assert.doesNotMatch(await (await read('/quotes',other)).text(),/Revised fictional proposal/);
  assert.equal((await write('/api/deal-line-items',{...lines,revision:1,items:[{...item,unitPriceCents:3000}]})).status,200);
  assert.deepEqual(await (await read(detail)).json(),final);

  const mutate=(action,revision,auth=headers)=>write(api,{action,id,revision},auth);
  const firstDownload=detail+'&version=1&download=true';
  const secondDownload=detail+'&version=2&download=true';
  assert.equal((await mutate('publish',2,other)).status,404);
  assert.equal((await read(firstDownload,{})).status,401);
  assert.equal((await read(firstDownload,other)).status,404);
  assert.equal((await read(detail+'&version=1&version=2')).status,400);
  const invalid={...final.quote.data,expiresOn:'2000-01-01'};
  assert.equal((await write(api,{action:'save',id,revision:2,data:invalid})).status,200);
  const rejected=await mutate('publish',3);
  assert.equal(rejected.status,400);
  assert.match((await rejected.json()).error,/Expiration must be today or later/);
  const historicalData={...final.quote.data,terms:'Old fictional terms <script>alert(1)</script>'};
  assert.equal((await write(api,{action:'save',id,revision:3,data:historicalData})).status,200);
  const beforePublish=await (await read(detail)).json();
  await sql`ALTER TABLE portable_quote_versions ADD CONSTRAINT fixture_quote_snapshot_failure CHECK (version<>1)`;
  try{
    assert.equal((await mutate('publish',4)).status,500);
    assert.deepEqual(await (await read(detail)).json(),beforePublish);
  }finally{await sql`ALTER TABLE portable_quote_versions DROP CONSTRAINT fixture_quote_snapshot_failure`;}

  const publications=await Promise.all([mutate('publish',4),mutate('publish',4)]);
  assert.deepEqual(publications.map(response=>response.status),[200,200]);
  const first=await (await read(detail)).json();
  assert.equal(first.quote.status,'published');
  assert.equal(first.quote.number,1);
  assert.equal(first.quote.version,1);
  assert.equal(first.quote.revision,5);
  assert.equal(first.published.snapshot.revenue.tcvCents,5000);
  assert.equal(first.published.snapshot.data.items[0].unitPriceCents,2500);
  assert.equal(first.versions.length,1);
  assert.equal(first.history.filter(row=>row.action==='publish').length,1);
  assert.equal((await write(api,{action:'save',id,revision:5,data:historicalData})).status,409);
  const rendered=await read('/quotes?id='+id);
  const page=await rendered.text();
  assert.match(page,/Q-0001 · v1/);
  assert.match(page,/Download HTML/);
  const downloaded=await read(firstDownload);
  assert.equal(downloaded.status,200);
  assert.equal(downloaded.headers.get('content-disposition'),'attachment; filename="Harbor-Q-1-v1.html"');
  assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
  assert.match(downloaded.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
  const firstHTML=await downloaded.text();
  assert.match(firstHTML,/PUBLISHED — pending acceptance/);
  assert.match(firstHTML,/Old fictional terms &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(firstHTML,/<script>/);

  assert.equal((await mutate('recall',5)).status,200);
  assert.equal((await mutate('recall',5)).status,200);
  const recalled=await (await read(detail)).json();
  assert.equal(recalled.quote.status,'draft');
  assert.equal(recalled.quote.publishedAt,null);
  assert.equal(recalled.quote.number,1);
  assert.equal(recalled.published,null);
  assert.match(await (await read(firstDownload)).text(),/RECALLED — awaiting a revised published quote/);
  const recalledList=await (await read(api+'?status=draft&dealId='+deal.id)).json();
  assert.deepEqual(recalledList.items.map(item=>[item.id,item.status]),[[id,'draft']]);
  const v2Data={...historicalData,terms:'Revised fictional terms',items:[{...historicalData.items[0],unitPriceCents:4000}]};
  assert.equal((await write(api,{action:'save',id,revision:6,data:v2Data})).status,200);
  const anotherId=randomUUID();
  assert.equal((await write(api,{...input,id:anotherId,lineRevision:2})).status,200);
  assert.deepEqual((await Promise.all([mutate('publish',7),write(api,{action:'publish',id:anotherId,revision:1})]))
    .map(response=>response.status),[200,200]);
  assert.equal((await (await read(api+'?id='+anotherId)).json()).quote.number,2);
  const result=await (await read(detail)).json();
  assert.equal(result.quote.number,1);
  assert.equal(result.quote.version,2);
  assert.equal(result.published.snapshot.revenue.tcvCents,8000);
  assert.deepEqual(result.versions.map(row=>row.version),[2,1]);
  assert.deepEqual((await (await read(detail+'&version=1')).json()).published,first.published);
  assert.deepEqual((await (await read(detail+'&versionBefore=2')).json()).versions.map(row=>row.version),[1]);
  const v1=await (await read(firstDownload)).text();
  const v2=await (await read(secondDownload)).text();
  assert.match(v1,/SUPERSEDED — replaced by version 2/);
  assert.match(v1,/Old fictional terms/);
  assert.doesNotMatch(v1,/Revised fictional terms/);
  assert.match(v2,/Revised fictional terms/);
  assert.equal((await read(detail+'&version=3')).status,404);
  assert.equal((await read(firstDownload,other)).status,404);

  const accept={action:'accept',id,revision:result.quote.revision,name:'Fictional <Buyer>',
    date:result.published.publishedAt.slice(0,10),note:'Accepted offline by phone'};
  const invoiceSource=quoteId=>'/api/invoices?source=quote&sourceId='+quoteId;
  const staleBeforeAcceptance=await (await read(invoiceSource(id))).json();
  assert.equal((await write(api,accept,other)).status,404);
  assert.equal((await write(api,{...accept,date:'2000-01-01'})).status,400);
  assert.equal((await write(api,{...accept,date:'2099-01-01'})).status,400);
  assert.match(await (await read('/quotes?id='+id)).text(),/Record offline acceptance/);
  await sql`ALTER TABLE portable_quote_events ADD CONSTRAINT fixture_quote_acceptance_failure CHECK (action<>'accept')`;
  try{
    assert.equal((await write(api,accept)).status,500);
    assert.deepEqual(await (await read(detail)).json(),result);
  }finally{await sql`ALTER TABLE portable_quote_events DROP CONSTRAINT fixture_quote_acceptance_failure`;}
  const acceptedAttempts=await Promise.all([write(api,accept),write(api,accept)]);
  assert.deepEqual(acceptedAttempts.map(response=>response.status),[200,200]);
  assert.equal((await write(api,{...accept,note:'Different note'})).status,409);
  assert.equal((await write(api,{...accept,name:'Different buyer'})).status,409);
  const accepted=await (await read(detail)).json();
  assert.equal(accepted.quote.status,'accepted');
  assert.deepEqual(accepted.quote.acceptance,{name:accept.name,date:accept.date,note:accept.note});
  assert.deepEqual(accepted.published,result.published);
  assert.equal(accepted.history[0].note,accept.note);
  assert.ok(accepted.history[0].actorName);
  assert.equal(accepted.history.filter(event=>event.action==='accept').length,1);
  assert.equal((await write(api,{action:'recall',id,revision:accepted.quote.revision})).status,409);
  assert.equal((await write(api,{action:'void',id,revision:accepted.quote.revision})).status,409);
  const acceptedHTML=await (await read(secondDownload)).text();
  assert.match(acceptedHTML,/ACCEPTED — recorded offline for Fictional &lt;Buyer&gt;/);
  assert.doesNotMatch(acceptedHTML,/Fictional <Buyer>/);
  const tryInvoice=source=>write('/api/invoices',{action:'create',id:randomUUID(),source,recurring:'exclude'});
  assert.equal((await tryInvoice(staleBeforeAcceptance.source)).status,409);
  const acceptedSource=await read(invoiceSource(id));
  assert.equal(acceptedSource.status,200);
  assert.equal((await acceptedSource.json()).totalCents,8000);

  const another=api+'?id='+anotherId;
  const beforeDecline=await (await read(another)).json();
  const staleBeforeDecline=await (await read(invoiceSource(anotherId))).json();
  const decline={action:'decline',id:anotherId,revision:beforeDecline.quote.revision,note:'Fictional buyer declined'};
  assert.equal((await write(api,decline)).status,200);
  assert.equal((await write(api,decline)).status,200);
  assert.equal((await write(api,{...decline,note:'Different decline note'})).status,409);
  const declined=await (await read(another)).json();
  assert.equal(declined.quote.status,'declined');
  assert.equal(declined.history[0].note,decline.note);
  assert.deepEqual(declined.published,beforeDecline.published);
  const declinedList=await (await read(api+'?status=declined&dealId='+deal.id)).json();
  assert.deepEqual(declinedList.items.map(item=>[item.id,item.status]),[[anotherId,'declined']]);
  assert.match(await (await read(another+'&download=true')).text(),/DECLINED — this proposal was declined/);
  assert.equal((await read(invoiceSource(anotherId))).status,409);
  assert.equal((await tryInvoice(staleBeforeDecline.source)).status,409);
  assert.equal((await write(api,{...accept,id:anotherId,revision:declined.quote.revision})).status,409);
  assert.equal((await write(api,{action:'recall',id:anotherId,revision:declined.quote.revision})).status,200);
  const declinedRecall=await (await read(another)).json();
  assert.equal(declinedRecall.quote.status,'draft');
  assert.equal((await write(api,{action:'publish',id:anotherId,revision:declinedRecall.quote.revision})).status,200);
  const publishedAgain=await (await read(another)).json();
  const staleBeforeVoid=await (await read(invoiceSource(anotherId))).json();
  const voidInput={action:'void',id:anotherId,revision:publishedAgain.quote.revision,note:'Fictional offer withdrawn'};
  assert.equal((await write(api,voidInput)).status,200);
  assert.equal((await write(api,voidInput)).status,200);
  assert.equal((await write(api,{...voidInput,note:'Different void note'})).status,409);
  const voided=await (await read(another)).json();
  assert.equal(voided.quote.status,'voided');
  assert.equal(voided.history[0].note,voidInput.note);
  assert.deepEqual(voided.published,publishedAgain.published);
  const voidedHTML=await (await read(another+'&download=true')).text();
  assert.match(voidedHTML,/VOID — this quote is no longer valid/);
  assert.equal((await write(api,{action:'recall',id:anotherId,revision:voided.quote.revision})).status,409);
  assert.equal((await tryInvoice(staleBeforeVoid.source)).status,409);
  assert.equal((await read(invoiceSource(anotherId))).status,409);

  const draftId=randomUUID();
  assert.equal((await write(api,{...input,id:draftId,lineRevision:2})).status,200);
  assert.equal((await write(api,{action:'void',id:draftId,revision:1})).status,200);
  const voidDraft=await (await read(api+'?id='+draftId)).json();
  assert.equal(voidDraft.quote.status,'voided');
  assert.equal(voidDraft.quote.number,null);
  assert.deepEqual(voidDraft.versions,[]);
  const voidedList=await (await read(api+'?status=voided&dealId='+deal.id)).json();
  assert.deepEqual(voidedList.items.map(item=>[item.id,item.status]),[anotherId,draftId].sort().map(id=>[id,'voided']));
  assert.equal((await read(api+'?id='+draftId+'&download=true')).status,400);
  assert.equal((await read(secondDownload,other)).status,404);

  const marker=`="Fictional quote status, ${randomUUID()}"`;
  const csvPath=params=>api+'?'+new URLSearchParams({export:'csv',...Object.fromEntries(params)});
  const csvIds=csv=>csv.trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0].slice(1,-1));
  const csvHeader='"Quote ID","Quote number","Title","Status","Deal","Expires (UTC)","Published version"';
  const [todayId,...expiredIds]=Array.from({length:27},()=>randomUUID()).sort();
  const tooEarly='00000000-0000-4000-8000-000000000001',tooLate='00000000-0000-4000-8000-000000000002';
  const undated='00000000-0000-4000-8000-000000000003',draft='00000000-0000-4000-8000-000000000004';
  const expiresFrom='2000-02-29',expiresThrough='2000-03-01';
  const fixtureIds=[todayId,tooEarly,tooLate,undated,draft,...expiredIds];
  const capIds=Array.from({length:475},()=>randomUUID());
  const today=new Date().toISOString().slice(0,10);
  const insertQuotes=ids=>sql`INSERT INTO portable_quotes (workspace_id,id,deal_id,deal_created_at,deal_name,revision,creation_key,
    published_at,data,created_at,updated_at)
    SELECT workspace_id,fixture.id,deal_id,deal_created_at,deal_name,1,fixture.id::text,
      CASE WHEN fixture.id=${draft}::uuid THEN NULL ELSE published_at END,
      data||jsonb_build_object('title',${marker}::text,'terms','Fictional private quote terms',
        'expiresOn',CASE fixture.id
          WHEN ${todayId}::uuid THEN ${today}::text
          WHEN ${tooEarly}::uuid THEN '2000-02-28'
          WHEN ${tooLate}::uuid THEN '2000-03-02'
          WHEN ${undated}::uuid THEN ''
          WHEN ${expiredIds[0]}::uuid THEN ${expiresFrom}::text
          ELSE ${expiresThrough}::text END),created_at,updated_at
    FROM portable_quotes CROSS JOIN unnest(${ids}::uuid[]) AS fixture(id)
    WHERE portable_quotes.id=${id}`;
  try{
    // Date and status exclusions sort before the first page of 26 matches.
    await insertQuotes(fixtureIds);
    const scope=new URLSearchParams({q:marker,dealId:deal.id,status:'expired',expiresFrom,expiresThrough});
    const firstResponse=await read(api+'?'+scope);
    assert.equal(firstResponse.status,200,await firstResponse.clone().text());
    assert.equal(firstResponse.headers.get('cache-control'),'private, no-store');
    const firstPage=await firstResponse.json();
    assert.deepEqual(firstPage.items.map(item=>[item.id,item.status]),expiredIds.slice(0,25).map(id=>[id,'expired']));
    assert.deepEqual([...new Set(firstPage.items.map(item=>item.expiresOn))],[expiresFrom,expiresThrough]);
    assert.equal(firstPage.next,expiredIds[24]);
    const html=await (await read('/quotes?'+scope)).text();
    assert.match(html,/<select name="status">/);
    assert.match(html,/<input (?=[^>]*type="date")(?=[^>]*name="expiresFrom")(?=[^>]*value="2000-02-29")/);
    assert.match(html,/<input (?=[^>]*type="date")(?=[^>]*name="expiresThrough")(?=[^>]*value="2000-03-01")/);
    assert.match(html,/>Export CSV<\/button>/);
    const next=html.match(/href="([^"]+)">Next quotes<\/a>/)?.[1];
    assert.ok(next,'Filtered quote list links to a second page.');
    const nextPath=next.replaceAll('&amp;','&');
    const nextQuery=new URL(nextPath,origin).searchParams;
    assert.deepEqual(Object.fromEntries(nextQuery),{...Object.fromEntries(scope),after:expiredIds[24]});
    const secondPage=await (await read(api+'?'+nextQuery)).json();
    assert.deepEqual(secondPage.items.map(item=>[item.id,item.status]),[[expiredIds[25],'expired']]);
    assert.equal(secondPage.next,null);
    assert.doesNotMatch(await (await read(nextPath)).text(),/>Next quotes<\/a>/);
    const published=new URLSearchParams({q:marker,dealId:deal.id,status:'published',expiresFrom:today});
    const stillPublished=await (await read(api+'?'+published)).json();
    assert.deepEqual(stillPublished.items.map(item=>[item.id,item.status]),[[todayId,'published']]);
    const unmatched=new URLSearchParams(scope);
    unmatched.set('q','No mentions of this fictional quote');
    assert.deepEqual(await (await read(api+'?'+unmatched)).json(),{items:[],next:null});
    unmatched.set('q',marker);
    unmatched.set('dealId',randomUUID());
    assert.deepEqual(await (await read(api+'?'+unmatched)).json(),{items:[],next:null});
    assert.deepEqual(await (await read(api+'?'+scope,other)).json(),{items:[],next:null});
    assert.equal((await read(api+'?'+scope,{})).status,401);
    const lowerOnly=new URLSearchParams({q:marker,dealId:deal.id,status:'expired',expiresFrom:'2000-03-02'});
    assert.deepEqual((await (await read(api+'?'+lowerOnly)).json()).items.map(item=>item.id),[tooLate]);
    assert.equal((await read('/quotes?'+lowerOnly+'&expiresThrough=')).status,200);

    const download=csvPath(scope);
    const csvResponse=await read(download);
    assert.equal(csvResponse.status,200,await csvResponse.clone().text());
    assert.equal(csvResponse.headers.get('cache-control'),'private, no-store');
    assert.equal(csvResponse.headers.get('x-content-type-options'),'nosniff');
    assert.equal(csvResponse.headers.get('content-type'),'text/csv; charset=utf-8');
    assert.equal(csvResponse.headers.get('content-disposition'),'attachment; filename="harbor-quotes.csv"');
    const csv=await csvResponse.text();
    assert.equal(csv.split('\r\n')[0],csvHeader);
    assert.deepEqual(csvIds(csv),expiredIds);
    assert.match(csv,/"'=""Fictional quote status, /);
    assert.match(csv,/,"Expired","Fictional draft source","2000-02-29",""/);
    assert.ok(!csv.includes('Fictional private quote terms')&&!csv.includes(contact.data.name));
    assert.equal((await read(download,{})).status,401);
    const isolated=await read(download,other);
    assert.equal(isolated.status,200,await isolated.clone().text());
    assert.equal((await isolated.text()).trimEnd(),csvHeader);
    assert.equal((await (await read(csvPath(unmatched))).text()).trimEnd(),csvHeader);
    const upperOnly=new URLSearchParams(scope);
    upperOnly.delete('expiresFrom');
    upperOnly.set('expiresThrough',expiresFrom);
    assert.deepEqual(csvIds(await (await read(csvPath(upperOnly))).text()),[tooEarly,expiredIds[0]]);
    const head=await request(download,{method:'HEAD',headers});
    assert.equal(head.status,200);
    assert.equal(head.headers.get('content-disposition'),csvResponse.headers.get('content-disposition'));
    assert.equal(await head.text(),'');
    for(const invalid of [download+'&status=draft',download+'&after='+todayId,download+'&id='+id,
      download+'&download=true',download+'&version=1',api+'?export=html']){
      assert.equal((await read(invalid)).status,400);
    }

    await insertQuotes(capIds.slice(0,474));
    const atLimit=await read(download);
    assert.equal(atLimit.status,200,await atLimit.clone().text());
    assert.deepEqual(csvIds(await atLimit.text()),[...expiredIds,...capIds.slice(0,474)].sort());
    await insertQuotes(capIds.slice(474));
    const overLimit=await read(download);
    assert.equal(overLimit.status,413,await overLimit.clone().text());
    assert.equal(overLimit.headers.get('cache-control'),'private, no-store');
    assert.match((await overLimit.json()).error,/Narrow your filters/);

    for(const invalid of ['status=unknown','status=expired&status=draft','id='+id+'&status=all','id='+id+'&expiresFrom='+expiresFrom,
      'expiresFrom=1900-02-29','expiresThrough=2000-04-31','expiresFrom=2000-2-29',
      `expiresFrom=${expiresThrough}&expiresThrough=${expiresFrom}`,`expiresFrom=${expiresFrom}&expiresFrom=${expiresFrom}`]){
      assert.equal((await read(api+'?'+invalid)).status,400);
      assert.equal((await read('/quotes?'+invalid)).status,404);
      assert.equal((await read(api+'?export=csv&'+invalid)).status,400);
    }
  }finally{
    await sql`DELETE FROM portable_quotes WHERE id=ANY(${[...fixtureIds,...capIds]}::uuid[])`;
  }

  return async (restored,owner,outsider)=>{
    assert.deepEqual(await (await restored(detail,{headers:owner})).json(),accepted);
    assert.deepEqual(await (await restored(another,{headers:owner})).json(),voided);
    assert.deepEqual((await (await restored(detail+'&version=1',{headers:owner})).json()).published,first.published);
    assert.equal(await (await restored(firstDownload,{headers:owner})).text(),v1);
    assert.equal(await (await restored(secondDownload,{headers:owner})).text(),acceptedHTML);
    assert.equal(await (await restored(another+'&download=true',{headers:owner})).text(),voidedHTML);
    assert.equal((await restored(detail,{headers:outsider})).status,404);
    assert.equal((await restored(firstDownload,{headers:outsider})).status,404);
  };
}
