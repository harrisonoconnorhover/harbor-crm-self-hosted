import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import postgres from 'postgres';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
import {verifyPortableQuotes} from './portable-quotes-fixture.mjs';
import {localFileFixture} from './portable-files-fixture.mjs';

export async function verifyQuoteSigning({request,origin,headers,other,sql,env,fixture,directory}){
  const api='/api/quotes';
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=(path,auth=headers)=>request(path,{headers:auth});
  const ok=async call=>{const response=await call;assert.ok(response.ok,await response.clone().text());return response;};
  const form=(data,source=origin)=>request('/quote-sign',{method:'POST',headers:{origin:source,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});
  const party=async kind=>(await (await ok(post('/api/crm',{action:'save',kind,data:{name:'Fictional '+kind}}))).json()).record;
  await verifyPortableQuotes({request,origin,headers,other,contact:await party('contacts'),company:await party('companies'),sql});
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const deal=(await (await ok(post('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional installation'}}))).json()).record;
  const id=randomUUID(),path='/quotes?id='+id;
  const detail=async()=>(await (await ok(read(api+'?id='+id))).json());
  const save=(action,revision,more={})=>post(api,{id,revision,action,...more});
  await ok(post(api,{action:'create',id,dealId:deal.id,expectedUpdatedAt:deal.updatedAt,lineRevision:0}));
  const draft=await detail(),data={...draft.quote.data,buyer:{name:'Fictional Buyer',email:'buyer@example.test',address:''},terms:'Install at the fictional site.',
    items:[{id:randomUUID(),name:'Test installation',sku:'',description:'',unitPriceCents:5000,billingFrequency:'one_time',termPayments:null,quantity:2,discountBps:0}]};
  const cmd=(action,revision,version,expectedLink)=>({id,action,revision,version,expectedLink});
  assert.equal((await post(api,cmd('issue-signing-link',1,1,null))).status,409);
  await ok(save('save',1,{data}));await ok(save('publish',2));
  const issue=cmd('issue-signing-link',3,1,null);
  assert.equal((await post(api,issue,other)).status,404);
  assert.equal((await post(api,issue,{})).status,401);
  const a=await (await ok(post(api,issue))).json();
  const b=await (await ok(post(api,{...issue,expectedLink:a.linkId}))).json();
  assert.equal((await post(api,issue)).status,409);
  const review=token=>form({action:'review',token});
  assert.equal((await review(a.token)).status,404);
  const preview=await ok(review(b.token));
  assert.match(await preview.text(),/Install at the fictional site/);
  await ok(post(api,cmd('revoke-signing-link',3,1,b.linkId)));
  assert.equal((await review(b.token)).status,404);
  const c=await (await ok(post(api,issue))).json();
  await ok(save('recall',3));
  assert.equal((await review(c.token)).status,404);
  await ok(save('save',4,{data:{...data,terms:'Revised fictional terms <only>.'}}));
  await ok(save('publish',5));
  assert.equal((await review(c.token)).status,404);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const seller=await browser.newContext(),buyer=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await seller.addCookies([{name,value,url:origin}]);
    const crm=await seller.newPage();await crm.goto(origin+path);
    await crm.getByRole('button',{name:'Create signing link'}).click();
    const link=await crm.getByRole('textbox',{name:'Private signing link'}).inputValue();
    const token=new URL(link).hash.slice(1);
    assert.equal(token.length,43);
    const page=await buyer.newPage();await page.goto(link);
    await page.getByRole('button',{name:'Review quote'}).click();
    await page.getByText('Revised fictional terms <only>.',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const digest=await page.locator('input[name=digest]').inputValue();
    const downloadButton=page.getByRole('button',{name:'Download signed quote'});
    assert.equal(await downloadButton.count(),0);
    const downloadRequest=()=>form({action:'download',token});
    assert.equal((await downloadRequest()).status,409);
    const payload={action:'sign',token,name:'Jordan Buyer',consent:'yes',digest};
    assert.equal((await form({...payload,consent:'no'})).status,400);
    assert.equal((await form({...payload,digest:'f'.repeat(64)})).status,409);
    assert.equal((await form(payload,'https://elsewhere.example')).status,403);
    assert.equal((await detail()).quote.status,'published');
    await sql`UPDATE portable_quote_versions SET snapshot=jsonb_set(snapshot,'{data,expiresOn}','"2001-01-01"') WHERE quote_id=${id} AND version=2`;
    try{assert.equal((await form(payload)).status,404);}
    finally{await sql`UPDATE portable_quote_versions SET snapshot=jsonb_set(snapshot,'{data,expiresOn}',to_jsonb(${data.expiresOn}::text)) WHERE quote_id=${id} AND version=2`;}
    await sql`ALTER TABLE portable_quote_signature_receipts ADD CONSTRAINT deny_signature CHECK (false) NOT VALID`;
    try{assert.equal((await form(payload)).status,503);assert.equal((await detail()).quote.status,'published');}
    finally{await sql`ALTER TABLE portable_quote_signature_receipts DROP CONSTRAINT deny_signature`;}
    await page.getByLabel('Full name').fill(payload.name);await page.getByRole('checkbox').check();
    await Promise.all([page.getByRole('button',{name:'Sign quote'}).click(),ok(form(payload))]);
    await page.getByRole('heading',{name:'Signature receipt'}).waitFor();
    const signed=await detail(),receipt=signed.signature;
    assert.equal(signed.quote.status,'accepted');assert.equal(signed.quote.revision,7);
    assert.equal(signed.quote.acceptance.method,'electronic');
    assert.equal(receipt.digest,digest);assert.equal(receipt.signedName,'Jordan Buyer');
    assert.equal((await form({...payload,name:'Someone Else'})).status,409);
    assert.equal((await ok(form(payload))).status,200);
    await crm.reload();await crm.getByText('Jordan Buyer',{exact:true}).first().waitFor();
    await crm.getByRole('listitem').filter({hasText:'Signed electronically · Jordan Buyer'}).waitFor();
    const document=await (await ok(read(api+'?id='+id+'&version=2&download=true'))).text();
    for(const expected of [receipt.id,digest,'signed electronically by Jordan Buyer','Revised fictional terms &lt;only&gt;'])assert.ok(document.includes(expected));
    const [download]=await Promise.all([page.waitForEvent('download'),downloadButton.click()]);
    assert.equal(download.suggestedFilename(),'Harbor-Q-'+signed.quote.number+'-v2.html');
    const savedPath=join(directory,download.suggestedFilename());
    await download.saveAs(savedPath);
    const buyerCopy=await readFile(savedPath,'utf8');
    assert.equal(buyerCopy,document);
    assert.ok(buyerCopy.includes(receipt.consent)&&buyerCopy.includes(new Date(receipt.signedAt).toISOString()));
    assert.ok(!buyerCopy.includes(token));
    assert.doesNotMatch(buyerCopy,/<(?:form|script)\b/i);
    await page.goto(link);
    await page.getByRole('button',{name:'Review quote'}).click();
    await downloadButton.waitFor();
    const old=await (await ok(read(api+'?id='+id+'&version=1&download=true'))).text();
    assert.ok(!old.includes(receipt.id)&&old.includes('SUPERSEDED'));
    const file=api+'?id='+id+'&version=2&download=true';
    assert.equal((await request(file,{headers,method:'HEAD'})).status,200);
    assert.equal((await read(file,other)).status,404);
    assert.equal((await read(api+'?id='+id+'&version=99&download=true')).status,404);
    const documents=await sql`SELECT actor_email,record_ids FROM portable_record_access_events
      WHERE kind='quotes' AND action='document' AND ${id}::uuid=ANY(record_ids)`;
    assert.equal(documents.length,2);
    assert.ok(documents.every(row=>row.actor_email==='owner@example.test'&&row.record_ids.length===1));

    await assert.rejects(sql`DELETE FROM portable_quote_signature_receipts WHERE quote_id=${id}`,/append-only/);
    const target=new URL(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL);
    assert.equal(target.hostname,'127.0.0.1');
    assert.match(target.pathname,/^\/harbor_restore_test(?:_[a-z0-9]+)?$/);
    assert.notEqual(target.port,new URL(env.DATABASE_URL).port);
    const files=localFileFixture(process.env.HARBOR_TEST_RESTORE_S3_ENDPOINT);
    const restored=postgres(target.href,{onnotice:()=>{}});
    try{
      for(const storage of [fixture,files])await storage.storage.send(new CreateBucketCommand({Bucket:storage.bucket}));
      const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs',bundle=join(directory,'signed-quote-backup');
      for(const [operation,settings] of [['backup',env],['restore',{...env,...files.env,DATABASE_URL:target.href}]]){
        execFileSync(process.execPath,[command,operation,bundle],{env:settings,cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:60000,stdio:'pipe'});
      }
      assert.equal((await restored`SELECT 1 FROM portable_quote_signing_links LIMIT 1`).length,0);
      const [copy]=await restored`SELECT id,digest,signed_name FROM portable_quote_signature_receipts WHERE quote_id=${id}`;
      assert.deepEqual([copy.id,copy.digest,copy.signed_name],[receipt.id,digest,payload.name]);
    }finally{await restored.end();files.storage.destroy();}
    await ok(post(api,cmd('revoke-signing-link',7,2,signed.signingLinkId)));
    assert.equal((await review(token)).status,404);
    assert.equal((await downloadRequest()).status,404);
    await buyer.setOffline(true);
    await page.goto(pathToFileURL(savedPath).href);
    await page.getByRole('heading',{name:'Signature receipt'}).waitFor();
    await page.getByText(digest,{exact:true}).waitFor();
    await page.getByText('Revised fictional terms <only>.',{exact:true}).waitFor();
    assert.equal((await detail()).signature.id,receipt.id);
    assert.equal((await read(api+'?id='+id,other)).status,404);
  }finally{await browser.close();}
}
