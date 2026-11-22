import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyAccountDefaults({request,origin,headers,other,sql,signIn}){
  const api='/api/workspace-settings',settings='/?view=settings&section=account-defaults';
  const initial=await (await request(api,{headers})).json();
  const teammateInitial=await (await request(api,{headers:other})).json();
  const defaults={name:'Fictional Coast Studio',language:'de',numberFormat:'de-DE',dateFormat:'dmy',currency:'EUR',timeZone:'America/Los_Angeles'};
  const [workspace]=await sql`SELECT w.id,w.account_defaults,w.account_defaults_revision FROM private_workspaces w
    JOIN login_identities i ON i.id=w.owner_id WHERE i.email='owner@example.test'`;
  assert.ok(workspace);
  const post=(path,payload,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(payload)});
  const [{id:teammate}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function session(auth){
    const context=await browser.newContext({timezoneId:'UTC',locale:'en-US'});
    const [name,value]=auth.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    return context.newPage();
  }
  try{
    const page=await session(headers);
    await page.goto(origin+settings);
    const form=page.locator('form.portable-defaults-form');
    await form.getByLabel('Workspace name').fill(defaults.name);
    await form.getByLabel('Time zone').fill(defaults.timeZone);
    await form.getByLabel('Currency').selectOption(defaults.currency);
    await form.getByLabel('Language for dates and numbers').selectOption(defaults.language);
    await form.getByLabel('Date format').selectOption(defaults.dateFormat);
    await form.getByLabel('Number format').selectOption(defaults.numberFormat);
    await form.getByRole('button',{name:'Save account defaults'}).click();
    await form.getByText('Account defaults saved.').waitFor();
    const revision=initial.revision+1;
    const fresh=await signIn('owner@example.test');
    assert.deepEqual(await (await request(api,{headers:fresh})).json(),{defaults,revision});
    assert.equal((await post(api,{...defaults,revision:initial.revision})).status,409);
    for(const invalid of [{timeZone:'Atlantic/Atlantis'},{currency:'ZZZ'},{dateFormat:'other'}]){
      assert.equal((await post(api,{...defaults,revision,...invalid})).status,400);
    }
    assert.equal((await post(api+'?workspaceId='+workspace.id,{...defaults,revision},other)).status,403);
    assert.deepEqual(await (await request(api,{headers:other})).json(),teammateInitial);

    // Legacy imported contacts can have no name. Check the actual health card with
    // the browser in en-US and the workspace using German thousands separators.
    const batch=randomUUID();
    try{
      await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
        SELECT ${workspace.id},gen_random_uuid(),1,jsonb_build_object('name','','fixture',${batch}::text),now(),now()
        FROM generate_series(1,1234)`;
      const [{count}]=await sql`SELECT count(*)::int AS count FROM contacts WHERE workspace_id=${workspace.id}
        AND archived_at IS NULL AND coalesce(data->>'name','') !~ '[^[:space:]]'`;
      await page.goto(origin+'/?view=settings&section=data-quality');
      const missing=page.getByRole('region',{name:'Records',exact:true}).locator('dl div').filter({hasText:'Contacts missing a name'});
      assert.equal(await missing.locator('dd').innerText(),count.toLocaleString('de-DE'));
    }finally{
      await sql`DELETE FROM contacts WHERE workspace_id=${workspace.id} AND data->>'fixture'=${batch}`;
    }

    const duplicates=page.getByRole('region',{name:'Duplicates',exact:true});
    await duplicates.getByRole('button',{name:'Check suggested pairs'}).click();
    await duplicates.getByRole('status').filter({hasText:/contact pairs · .* company pairs/}).waitFor();

    const saved=await post('/api/crm',{action:'save',kind:'deals',assigneeId:teammate,
      data:{name:'Fictional regional rollout',stage:'Qualified to buy',amount:1234.56,closeDate:'2031-04-06'}});
    assert.equal(saved.status,201,await saved.clone().text());
    const {record}=await saved.json();
    const stamp='2026-01-07T03:15:00.000Z';
    const call=await post('/api/logged-activities?kind=deals&recordId='+record.id,{id:randomUUID(),kind:'Call',occurredAt:Date.parse(stamp),summary:'Fictional date boundary'});
    assert.equal(call.status,201,await call.clone().text());
    const objectId=randomUUID(),objectRecord=randomUUID(),units=randomUUID(),renewal=randomUUID(),received=randomUUID();
    const fields=[[units,'Units','number'],[renewal,'Renewal','date'],[received,'Received','datetime']]
      .map(([id,label,type])=>({id,label,type,options:[],required:false}));
    for(const payload of [
      {action:'define',id:objectId,revision:0,definition:{name:'Regional subscription',fields}},
      {action:'save',id:objectRecord,objectId,schemaRevision:1,revision:0,name:'Fictional subscription',assigneeId:teammate,
        values:{[units]:1234.56,[renewal]:'2031-04-06',[received]:stamp}},
    ]){
      const response=await post('/api/custom-objects',payload);
      assert.ok(response.ok,await response.clone().text());
    }
    const deepLink='/?kind=deals&record='+record.id;
    for(const [auth,suffix] of [[fresh,''],[other,'&workspaceId='+workspace.id]]){
      const recordPage=await session(auth);
      await recordPage.goto(origin+deepLink+suffix);
      const keyInfo=recordPage.getByRole('region',{name:'Key information'}).locator('dl');
      await keyInfo.getByText('1.234,56 €',{exact:true}).waitFor();
      await keyInfo.getByText('06/04/2031',{exact:true}).waitFor();
      assert.equal(await recordPage.locator('.workspace-switcher-name').first().textContent(),defaults.name);
      await recordPage.getByRole('button',{name:'View all properties',exact:true}).click();
      const dialog=recordPage.getByRole('dialog',{name:'All properties'}),search=dialog.getByRole('searchbox',{name:'Search properties'});
      for(const [query,display] of [['1.234,56','1.234,56 €'],['06/04/2031','06/04/2031'],['2031-04-06','06/04/2031']]){
        await search.fill(query);
        await dialog.getByText(display,{exact:true}).waitFor();
      }
      await dialog.getByRole('button',{name:'Close',exact:true}).click();
      if(!suffix){
        await recordPage.locator('time[datetime="'+stamp+'"]').filter({hasText:'06/01/2026 · 19:15'}).first().waitFor();
      }
      await recordPage.goto(origin+'/?view=custom-objects&objectId='+objectId+'&record='+objectRecord+suffix);
      for(const value of ['1.234,56','06/04/2031','06/01/2026 · 19:15'])await recordPage.getByText(value,{exact:true}).waitFor();
    }
  }finally{
    await browser.close();
    await sql`UPDATE private_workspaces SET account_defaults=${workspace.account_defaults===null?null:sql.json(workspace.account_defaults)},
      account_defaults_revision=${workspace.account_defaults_revision} WHERE id=${workspace.id}`;
  }
}
