import assert from 'node:assert/strict';

export async function verifyTicketTags({browser,origin,request,headers,other,workspaceId,ticket}){
  const team=await browser.newContext();
  try{
    const [name,value]=other.cookie.split('=');
    await team.addCookies([{name,value,url:origin}]);
    const page=await team.newPage();
    const detail='/tickets?'+new URLSearchParams({id:ticket.id,workspaceId});
    await page.goto(origin+detail);
    await page.getByRole('button',{name:'Edit ticket'}).click();
    const field=page.locator('textarea[name="tags"]');
    await field.fill('Billing\nbilling');
    await page.getByRole('button',{name:'Save ticket'}).click();
    await page.getByRole('alert').getByText(/distinct tags/).waitFor();
    await field.fill('Billing\nInternal escalation');
    await page.getByRole('button',{name:'Save ticket'}).click();
    await page.getByRole('link',{name:'billing',exact:true}).click();
    const url=new URL(page.url());
    assert.equal(url.searchParams.get('workspaceId'),workspaceId);
    assert.equal(url.searchParams.get('tag'),'billing');
    await page.getByRole('link',{name:ticket.data.name,exact:true}).click();
    await page.getByRole('link',{name:'Back to tickets'}).click();
    assert.equal(new URL(page.url()).searchParams.get('tag'),'billing');

    const matching=async(auth,params)=>{
      const result=await request('/api/tickets?'+new URLSearchParams(params),{headers:auth});
      assert.equal(result.status,200);
      return (await result.json()).records.map(row=>row.id);
    };
    assert.deepEqual(await matching(headers,{tag:'BILLING'}),[ticket.id]);
    assert.deepEqual(await matching(other,{tag:'billing'}),[]);
    const download=await request('/api/tickets?export=csv&tag=INTERNAL+ESCALATION',{headers});
    assert.equal(download.status,200);
    const csv=await download.text();
    assert.ok(csv.includes(ticket.id)&&csv.includes('"billing\ninternal escalation"'));
    const record=await (await request('/api/tickets?id='+ticket.id,{headers})).json();
    assert.deepEqual(record.data.tags,['billing','internal escalation']);
    const save=async(revision,data)=>request('/api/tickets',{method:'POST',
      headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({action:'save',id:ticket.id,expectedRevision:revision,data:{name:ticket.data.name,...data}})});
    assert.equal((await save(ticket.revision,{tags:[]})).status,409);
    assert.equal((await save(record.revision,{tags:['too long'.repeat(8)]})).status,400);
    assert.equal((await save(record.revision,{tags:['urgent','URGENT']})).status,400);
    const legacyEdit=await save(record.revision,{description:ticket.data.description});
    assert.equal(legacyEdit.status,200);
    const retained=(await legacyEdit.json()).record;
    assert.deepEqual(retained.data.tags,record.data.tags);
    const cleared=await save(retained.revision,{tags:[]});
    assert.equal(cleared.status,200);
    assert.deepEqual(await matching(headers,{tag:'billing'}),[]);
    const restored=await save((await cleared.json()).record.revision,{tags:['internal escalation']});
    assert.equal(restored.status,200);
    return (await restored.json()).record;
  }finally{await team.close();}
}
