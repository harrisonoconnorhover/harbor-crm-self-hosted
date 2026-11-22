import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyCustomObjectImport({api,send,ok,origin,headers,other,sql,workspace,grantId}){
  const objectId=randomUUID(),quantity=randomUUID(),subscribed=randomUUID(),types=randomUUID(),existing=randomUUID(),workflow=randomUUID();
  const fields=[{id:quantity,label:'Units',type:'number',required:true,options:[]},
    {id:subscribed,label:'Active',type:'checkbox',required:false,options:[]},
    {id:types,label:'Categories',type:'multiselect',required:false,options:['Office','IT']}];
  await ok(send(api,{action:'define',id:objectId,revision:0,definition:{name:'Hardware orders',fields}}));
  const original={action:'save',objectId,id:existing,revision:0,schemaRevision:1,name:'Existing order',values:{[quantity]:1,[subscribed]:false,[types]:['IT']}};
  await ok(send(api,original));
  await ok(send('/api/workflows',{action:'save',id:workflow,revision:0,definition:{name:'Inspect hardware',trigger:'custom_record_created',
    objectId,actionKind:'task',delayMinutes:0,task:{name:'Inspect delivery'}}}));
  await ok(send('/api/workflows',{action:'setEnabled',id:workflow,revision:1,enabled:true}));
  const preview=csv=>({action:'preview_csv',csv,objectId});
  const apply=(csv,review)=>({action:'apply_csv',csv,review,objectId,requestId:randomUUID()});
  const csv='Record ID,Name,Property: Units,Active\n'+existing+',,2,\n,"Desk, west",0,No';
  assert.equal((await send(api,preview(csv),other)).status,404);
  assert.equal((await send(api+'?workspaceId='+workspace+'&grantId='+grantId,preview(csv),other)).status,403);
  const emptyChoices=await ok(send(api,preview('Record ID,Units,Categories\n'+existing+',2, ; ')));
  assert.equal(emptyChoices.rows[0].state,'error');
  const count=()=>sql`SELECT count(*)::int AS n FROM portable_object_records WHERE workspace_id=${workspace} AND object_id=${objectId}`.then(r=>r[0].n);
  const invalid='Name,Units\nValid,1\nMissing units,';
  const rejected=await ok(send(api,preview(invalid)));
  assert.deepEqual(rejected.rows.map(r=>r.state),['create','error']);
  assert.equal((await send(api,apply(invalid,rejected.review))).status,400);
  assert.equal(await count(),1);
  const old=await ok(send(api,preview(csv)));
  await ok(send(api,{...original,revision:1,name:'=Revised order'}));
  assert.equal((await send(api,apply(csv,old.review))).status,409);
  assert.equal(await count(),1);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=custom-objects&objectId='+objectId);
    await page.getByRole('link',{name:'Import CSV',exact:true}).click();
    await page.getByLabel('CSV file').setInputFiles({name:'orders.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.getByRole('button',{name:'Preview changes'}).click();
    const review=page.getByRole('region',{name:'Import preview'});
    await review.getByText('Units: 1 → 2',{exact:true}).waitFor();
    await review.getByRole('rowheader',{name:'Desk, west'}).waitFor();
    assert.equal(await count(),1);
    let hideResponse=true;
    await page.route('**/api/custom-objects',async route=>{
      if(hideResponse&&route.request().postDataJSON()?.action==='apply_csv'){
        hideResponse=false;
        const response=await route.fetch();
        assert.equal(response.status(),200);
        await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Import confirmation interrupted.'})});
      }else await route.continue();
    });
    const submitted=page.waitForRequest(r=>r.url().endsWith(api)&&r.postDataJSON()?.action==='apply_csv');
    await review.getByRole('button',{name:'Apply import'}).click();
    const body=(await submitted).postDataJSON();
    await page.getByRole('alert').filter({hasText:'Import confirmation interrupted.'}).waitFor();
    assert.equal(await page.getByLabel('CSV contents').isDisabled(),true);
    await review.getByRole('button',{name:'Retry the same import'}).click();
    await page.getByText('Imported 1 new, updated 1, skipped 0.').waitFor();
    await page.getByRole('link',{name:'View records',exact:true}).click();
    await page.getByRole('link',{name:'Desk, west',exact:true}).waitFor();
    assert.deepEqual(await ok(send(api,body)),{created:1,updated:1,skipped:0});
    assert.equal((await send(api,{...body,csv:csv+' '})).status,409);
    assert.equal(await count(),2);
    const [prior]=await sql`SELECT data,revision FROM portable_object_records WHERE workspace_id=${workspace} AND object_id=${objectId} AND id=${existing}`;
    assert.deepEqual(prior.data.values,{[quantity]:2,[subscribed]:false,[types]:['IT']});
    assert.equal(prior.revision,3);
    const exported=await (await page.request.get(origin+api+'?objectId='+objectId+'&export=csv')).text();
    const roundTrip=await ok(send(api,preview(exported)));
    assert.deepEqual(roundTrip.rows.map(r=>r.state),['skip','skip']);
    const runs=await sql`SELECT custom_task_id FROM portable_workflow_runs WHERE workspace_id=${workspace} AND workflow_id=${workflow}`;
    assert.equal(runs.length,1);assert.ok(runs[0].custom_task_id);
    const batch='Name,Units\nPacking station,1\nDispatch station,3';
    const accepted=apply(batch,(await ok(send(api,preview(batch)))).review);
    await sql`ALTER TABLE portable_object_records ADD CONSTRAINT fixture_hold_second_import_row CHECK (name<>'Dispatch station') NOT VALID`;
    try{
      assert.equal((await send(api,accepted)).status,503);
      assert.equal(await count(),2);
      assert.equal((await sql`SELECT id FROM portable_workflow_runs WHERE workflow_id=${workflow}`).length,1);
    }finally{await sql`ALTER TABLE portable_object_records DROP CONSTRAINT fixture_hold_second_import_row`;}
    const results=await Promise.all([ok(send(api,accepted)),ok(send(api,accepted))]);
    assert.deepEqual(results,[{created:2,updated:0,skipped:0},{created:2,updated:0,skipped:0}]);
    assert.equal(await count(),4);
    assert.equal((await sql`SELECT id FROM portable_workflow_runs WHERE workflow_id=${workflow}`).length,3);
  }finally{await browser.close();}
}
