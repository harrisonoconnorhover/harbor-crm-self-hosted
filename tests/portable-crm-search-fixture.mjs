import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableCrmSearch({request,origin,headers,other,sql,sharing,company,deal}){
  const path='/api/crm/search';
  const post=(body,auth=headers,site=origin,url=path)=>request(url,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const marker='Global fixture café_%';
  const ids=Array.from({length:9},()=>randomUUID());
  const {workspaceId}=sharing;
  const [foreign]=await sql`SELECT w.id FROM private_workspaces w JOIN login_identities i ON i.id=w.owner_id
    WHERE i.email='other@example.test'`;
  const foreignId=randomUUID(),archivedId=randomUUID(),ticketId=randomUUID();
  const ticketName='Fictional search ticket '+ticketId;
  try{
    for(const [i,id] of ids.entries())await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspaceId},${id},1,${sql.json({name:'Search sample '+(i+1),custom:{fixture:marker}})},now(),now())`;
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${foreign.id},${foreignId},1,${sql.json({name:marker})},now(),now())`;
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,archived_at,created_at,updated_at)
      VALUES (${workspaceId},${archivedId},1,${sql.json({name:marker})},now(),now(),now())`;
    await sql`INSERT INTO portable_tickets(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspaceId},${ticketId},1,${sql.json({name:ticketName,ticketStatus:'New'})},now(),now())`;
    assert.match(await (await request('/',{headers})).text(),/Find in Harbor/);
    assert.equal((await post({query:marker},{})).status,401);
    assert.equal((await post({query:marker},headers,'https://elsewhere.example.test')).status,403);
    assert.equal((await post({query:marker,kind:'files'})).status,400);
    const shared=path+'?workspaceId='+workspaceId;
    assert.equal((await post({query:marker},other,origin,shared+'&workspaceId='+workspaceId)).status,400);
    for(const query of ['',marker]){
      assert.equal((await post({query},other,origin,path+'?workspaceId='+randomUUID())).status,404);
    }
    assert.equal((await post({query:'x'.repeat(5000)})).status,400);

    const special=String.raw`Référence_70%\west`;
    await sql`UPDATE contacts SET data=data || ${sql.json({nested:[false,914326,[special,'bridgeOne','bridgeTwo','λ']]})}::jsonb
      WHERE workspace_id=${workspaceId} AND id=${ids[0]}`;
    for(const query of [special.toUpperCase(),'914326','λ']){
      const hit=await (await post({query,kind:'contacts'})).json();
      assert.ok(hit.results.some(row=>row.id===ids[0]),query);
    }
    for(const query of [special.replace('_','X'),special.replace('%','many'),special.replace('\\',''),'bridgeOne\nbridgeTwo']){
      assert.equal((await (await post({query,kind:'contacts'})).json()).total,0,query);
    }
    await sql`UPDATE contacts SET data=data-'nested' WHERE workspace_id=${workspaceId} AND id=${ids[0]}`;
    assert.equal((await (await post({query:special,kind:'contacts'})).json()).total,0);

    const response=await post({query:'  GLOBAL FIXTURE CAFÉ_%  '});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    const first=await response.json();
    assert.deepEqual([first.total,first.counts.contacts,first.size,first.page],[9,9,8,0]);
    assert.deepEqual(first.results,ids.slice(0,8).map((id,i)=>({id,kind:'contacts',name:'Search sample '+(i+1),detail:''})));
    const teammate=await post({query:marker},other,origin,shared);
    assert.equal(teammate.status,200,await teammate.clone().text());
    assert.deepEqual(await teammate.json(),first);
    const sharedNext=await (await post({query:marker,page:1},other,origin,shared)).json();
    assert.deepEqual(sharedNext.results.map(row=>row.id),ids.slice(8));
    const second=await (await post({query:marker,kind:'contacts',page:1_000_000})).json();
    assert.deepEqual([second.page,second.results.map(row=>row.id)],[1,ids.slice(8)]);
    const noWildcard=await (await post({query:marker.replace('_%','a%')})).json();
    assert.equal(noWildcard.total,0);
    const otherPage=await (await post({query:marker},other)).json();
    assert.deepEqual(otherPage.results.map(row=>row.id),[foreignId]);

    for(const [kind,id,query] of [['companies',company.id,company.data.name],['deals',deal.id,deal.data.name],
      ['leads',sharing.leads.converted.id,sharing.leads.converted.data.name],['tasks',sharing.task.id,sharing.task.data.name],
      ['tickets',ticketId,ticketName]]){
      for(const response of [await post({kind,query}),await post({kind,query},other,origin,shared)]){
        assert.equal(response.status,200);
        assert.ok((await response.json()).results.some(row=>row.kind===kind&&row.id===id),kind);
      }
    }
  }finally{
    await sql`DELETE FROM contacts WHERE id IN ${sql([...ids,foreignId,archivedId])}`;
    await sql`DELETE FROM portable_tickets WHERE workspace_id=${workspaceId} AND id=${ticketId}`;
    await reset();
  }
}
