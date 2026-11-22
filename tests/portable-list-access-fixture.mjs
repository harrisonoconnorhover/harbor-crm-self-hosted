import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyListAccess({get,send,other,ok,sql,workspaceId,origin,headers}){
  const prefix='List membership audit';
  const contacts=[];
  for(const suffix of ['Member A','Member B','Candidate A','Candidate B']){
    const {record}=await(await ok(send('/api/crm',{action:'save',kind:'contacts',data:{name:prefix+' '+suffix}}))).json();
    contacts.push(record.id);
  }
  const active=randomUUID(),saved=randomUUID();
  for(const [id,mode] of [[active,'active'],[saved,'static']]){
    await ok(send('/api/segments',{action:'save',segment:{id,revision:0,name:mode+' access test',kind:'contacts',mode,
      criteria:{groups:[[{field:'name',operator:'contains',value:prefix+' Member'}]]},...(mode==='static'?{initialMembers:'snapshot'}:{})}}));
  }
  const api='/api/segments?id=',screen='/?view=segments&segment=';
  const entries=()=>sql`SELECT id,record_ids,action,actor_email,workspace_id FROM portable_record_access_events
    WHERE kind='contacts' AND record_ids && ${contacts}::uuid[] ORDER BY occurred_at,id`;
  const before=await entries();
  await ok(get('/api/segments'));
  await ok(get(api+active+'&q=NoMatchingMember'));
  await ok(get(api+saved+'&candidates=true',headers,'HEAD'));
  await ok(get(screen+active,headers,'HEAD'));
  assert.equal((await get(api+saved,other)).status,404);
  assert.deepEqual(await entries(),before);

  const memberIds=contacts.slice(0,2).sort();
  const first=await(await ok(get(api+active+'&limit=1'))).json();
  assert.equal(first.total,'2');
  assert.equal(first.next,memberIds[0]);
  const last=await(await ok(get(api+active+'&limit=1&after='+first.next))).json();
  assert.deepEqual(last.items.map(row=>row.id),[memberIds[1]]);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+screen+saved);
    await page.getByRole('button',{name:'Add contacts',exact:true}).click();
    const picker=page.getByRole('table',{name:'Contacts to add'});
    await picker.waitFor();
    const initialCandidates=await picker.getByRole('link').evaluateAll(links=>links.map(a=>new URL(a.href).searchParams.get('contact')));
    await page.getByLabel('Search contacts to add').fill(prefix+' Candidate');
    await page.getByRole('button',{name:'Search contacts',exact:true}).click();
    await picker.getByRole('link',{name:prefix+' Candidate A',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('table[aria-label="Contacts to add"] tbody tr').length===2);
    const newEvents=(await entries()).filter(row=>!before.some(prior=>prior.id===row.id));
    const expected=[['list',[memberIds[0]]],['list',[memberIds[1]]],['list',memberIds]];
    if(initialCandidates.some(id=>contacts.includes(id)))expected.push(['list',initialCandidates]);
    expected.push(['search',contacts.slice(2).sort()]);
    // Multiple responses may share a millisecond; only the order within each page matters.
    assert.deepEqual(newEvents.map(row=>JSON.stringify([row.action,row.record_ids])).sort(),expected.map(row=>JSON.stringify(row)).sort());
    assert.ok(newEvents.every(row=>row.workspace_id===workspaceId&&row.actor_email==='owner@example.test'));
    const searchEvent=newEvents.find(row=>row.action==='search');
    await page.goto(origin+'/?view=record-access&event='+searchEvent.id);
    const history=page.getByRole('table');
    for(const id of contacts.slice(2))await history.getByRole('link',{name:id,exact:true}).waitFor();
    assert.equal(await history.getByRole('link',{name:memberIds[0],exact:true}).count(),0);
  }finally{await browser.close();}
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_block_list_access CHECK (action<>'list') NOT VALID`;
  try{
    const blocked=await get(api+saved);
    assert.equal(blocked.status,500);
    assert.ok(!(await blocked.text()).includes(memberIds[0]));
    await ok(get(api+saved,headers,'HEAD'));
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_block_list_access`;}
}
