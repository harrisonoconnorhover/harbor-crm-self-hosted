import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';

export async function verifyAccessCsv({get,send,ok,sql,workspaceId,headers,other,origin,info,auth}){
  const {parseCSV}=await tsImport('../lib/csv-import.ts',import.meta.url);
  const ids=[randomUUID(),randomUUID()];
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspaceId},id,1,'{"name":"Fictional CSV review"}',now(),now() FROM unnest(${ids}::uuid[]) id`;
  await ok(send('/api/v1/records/contacts/batch/read',{inputs:ids.map(id=>({id}))},auth));
  await ok(send('/api/api-tokens',{action:'revoke',id:info.id}));
  await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
  const q='view=record-access&kind=contacts&operation=read&token='+info.id+'&record='+ids[0];
  const api='/api/workspaces?export=csv&';
  const path=api+q;
  const response=await ok(get(path));
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.match(response.headers.get('content-disposition'),/attachment/);
  const text=await response.text(),parsed=parseCSV(text);
  assert.equal(parsed.rows.length,1);
  const event=Object.fromEntries(parsed.headers.map((h,i)=>[h,parsed.rows[0][i]]));
  assert.deepEqual(event['Record IDs'].split(' ').sort(),ids.toSorted());
  assert.equal(event['API token ID'],info.id);
  assert.equal(event['API token name'],"'"+info.name);
  assert.equal(event['Record count'],'2');
  assert.equal(event['Actor email'],'owner@example.test');
  assert.equal(event['API operation'],'read');
  assert.ok(!text.includes('Fictional CSV review')&&!text.includes(auth.authorization.slice(7)));
  assert.equal((await get(path,{})).status,401);
  assert.equal((await get(path,auth)).status,401);
  assert.equal((await (await ok(get(path,other))).text()).trim().split('\r\n').length,1);
  assert.equal((await get(path+'&workspaceId='+workspaceId,other)).status,400);
  assert.equal((await get(path+'&kind=contacts')).status,400);
  assert.equal((await get(path+'&from=2026-11-03&through=2026-11-01')).status,400);
  assert.equal((await get(path+'&eventIds=bad')).status,400);
  assert.equal(await (await ok(get(path,headers,'HEAD'))).text(),'');

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();await page.goto(origin+'/?'+q+'&event='+event['Event ID']);
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download event (CSV)'}).click()]);
    assert.equal(download.suggestedFilename(),'harbor-record-access.csv');
    const bytes=[];
    for await(const chunk of await download.createReadStream())bytes.push(chunk);
    assert.equal(Buffer.concat(bytes).toString(),text);
  }finally{await browser.close();}

  // Even with a tied timestamp, a page download stays fixed to the rows the owner saw.
  const filter='view=record-access&email=former-auditor%40example.test';
  const seed=n=>sql`INSERT INTO portable_record_access_events(workspace_id,actor_id,actor_email,kind,action,record_ids,occurred_at)
    SELECT ${workspaceId},'former-auditor','former-auditor@example.test','contacts','csv',ARRAY[gen_random_uuid()],12345
    FROM generate_series(1,${n}::integer)`;
  await seed(500);
  assert.equal(parseCSV(await (await ok(get(api+filter))).text(),{maxRows:500,maxBytes:2000000}).rows.length,500);
  const screen=await (await ok(get('/?'+filter))).text();
  const downloadPath=screen.match(/href="([^"]+)"[^>]*>Download this page \(CSV\)/)?.[1].replaceAll('&amp;','&');
  assert.ok(downloadPath);
  const selected=new URL(downloadPath,origin).searchParams.get('eventIds').split(',');
  await seed(1);
  const tooLarge=await get(api+filter);
  assert.equal(tooLarge.status,413);assert.ok(!(await tooLarge.text()).includes(selected[0]));
  const exactPage=parseCSV(await (await ok(get(downloadPath))).text());
  assert.deepEqual(exactPage.rows.map(row=>row[0]),selected);
  const olderPath=screen.match(/href="([^"]+)"[^>]*>Older activity/)?.[1].replaceAll('&amp;','&');
  assert.ok(olderPath);
  const older=await (await ok(get(olderPath))).text();
  const olderPage=older.match(/href="([^"]+)"[^>]*>Download this page \(CSV\)/)?.[1].replaceAll('&amp;','&');
  assert.ok(olderPage);
  assert.equal(new URL(olderPage,origin).searchParams.has('afterId'),false);
  const olderRows=parseCSV(await (await ok(get(olderPage))).text()).rows;
  assert.equal(olderRows.length,25);
  assert.ok(olderRows.every(row=>!selected.includes(row[0])));
  await seed(502);
  const expected=await sql`SELECT id FROM portable_record_access_events WHERE workspace_id=${workspaceId}
    AND actor_email='former-auditor@example.test' ORDER BY occurred_at DESC,id DESC`;
  assert.equal(expected.length,1003);
  const partsBrowser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await partsBrowser.newContext(),[name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?'+filter);
    await page.getByRole('link',{name:'Export in parts of up to 500 events'}).click();
    const collected=[];
    for(const [index,count] of [500,500,3].entries()){
      const part=index+1;
      await page.getByRole('heading',{name:'Part '+part,exact:true}).waitFor();
      const prepared=(await page.locator('input[name=eventIds]').inputValue()).split(',');
      assert.equal(prepared.length,count);
      if(part===1){
        // A newer event arriving after preview cannot displace the oldest event of this part.
        await sql`INSERT INTO portable_record_access_events(workspace_id,actor_id,actor_email,kind,action,record_ids,occurred_at)
          VALUES (${workspaceId},'former-auditor','former-auditor@example.test','contacts','csv',ARRAY[gen_random_uuid()],12346)`;
        const formUrl=await page.locator('form[method=post]').getAttribute('action');
        const post=async(addresses,auth)=>page.request.post(origin+formUrl,{form:{eventIds:addresses.join(',')},headers:{...auth,origin}});
        assert.equal((await post(prepared,other)).status(),409);
        assert.equal((await post([...prepared,randomUUID()],headers)).status(),400);
        assert.equal((await post([randomUUID()],headers)).status(),409);
      }
      const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download part '+part+' (CSV)'}).click()]);
      assert.equal(file.suggestedFilename(),'harbor-record-access-part-'+part+'.csv');
      const chunks=[];
      for await(const chunk of await file.createReadStream())chunks.push(chunk);
      const rows=parseCSV(Buffer.concat(chunks).toString(),{maxRows:500,maxBytes:2000000}).rows;
      assert.deepEqual(rows.map(row=>row[0]),prepared);
      assert.ok(rows.every(row=>row[3]==='former-auditor@example.test'));
      collected.push(...prepared);
      if(part<3)await page.getByRole('link',{name:'Next export part'}).click();
    }
    assert.deepEqual(collected,expected.map(row=>row.id));
    assert.equal(await page.getByRole('link',{name:'Next export part'}).count(),0);
    await page.getByText('Final part',{exact:true}).waitFor();
    const back=new URL(await page.getByRole('link',{name:'Back to filtered history'}).getAttribute('href'),origin);
    assert.equal(back.searchParams.get('email'),'former-auditor@example.test');
    assert.equal(back.searchParams.has('afterAt'),false);
  }finally{await partsBrowser.close();}

}
