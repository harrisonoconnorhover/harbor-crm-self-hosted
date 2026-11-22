import assert from 'node:assert/strict';

export async function verifyRecentTicketQueue({sql,request,origin,headers,other,workspaceId}){
  const stamp='2040-01-01T00:00:00Z';
  // Four tickets per millisecond, with unequal microseconds underneath the public cursor.
  await sql`INSERT INTO portable_tickets(workspace_id,id,revision,data,created_at,updated_at,archived_at)
    SELECT ${workspaceId},gen_random_uuid(),1,jsonb_build_object('name','Fictional case '||i,'ticketStatus','New'),
      '2039-01-01'::timestamptz,${stamp}::timestamptz + (i/4)*interval '1 millisecond' + (i%4)*interval '100 microseconds',
      CASE WHEN i%11=0 THEN ${stamp}::timestamptz END
    FROM generate_series(1,100000) i`;
  await sql`VACUUM (ANALYZE) portable_tickets`;
  async function post(path,body,auth=headers){
    const r=await request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(r.ok,await r.clone().text());
    return r.json();
  }
  const foreign=(await post('/api/tickets',{action:'save',data:{name:'Private elsewhere'}},other)).record;
  await sql`UPDATE portable_tickets SET updated_at='2041-01-01' WHERE id=${foreign.id}`;
  const expected=await sql`SELECT id FROM portable_tickets WHERE workspace_id=${workspaceId} AND archived_at IS NULL
    ORDER BY date_trunc('milliseconds',updated_at) DESC,id DESC LIMIT 100`;
  async function scanCount(){
    const [stats]=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='portable_tickets_recent_page'`;
    return Number(stats.idx_scan);
  }
  const initialScans=await scanCount();
  async function walk(auth=headers,scope={}){
    const seen=[];
    let params=new URLSearchParams({sort:'updated',limit:'25',...scope});
    const times=[];
    for(let i=0;i<4;i++){
      const start=performance.now();
      const response=await request('/api/tickets?'+params,{headers:auth});
      assert.equal(response.status,200,await response.clone().text());
      const page=await response.json();
      times.push(Math.round(performance.now()-start));
      seen.push(...page.records.map(record=>record.id));
      params=new URLSearchParams({sort:'updated',limit:'25',after:page.next,afterUpdatedAt:page.nextUpdatedAt,...scope});
    }
    assert.deepEqual(seen,expected.map(row=>row.id));
    return times;
  }
  const grant=(await post('/api/workspaces',{action:'grant',email:'other@example.test'})).viewers.find(v=>v.email==='other@example.test');
  await walk(other,{workspaceId});
  // Two authenticated sessions concurrently request both private and shared pages.
  const start=performance.now(),firstPage=expected.slice(0,25).map(row=>row.id);
  const times=await Promise.all(Array.from({length:100},async(_,i)=>{
    const sent=performance.now(),shared=i%2===1;
    const res=await request('/api/tickets?sort=updated&limit=25'+(shared?'&workspaceId='+workspaceId:''),{headers:shared?other:headers});
    assert.equal(res.status,200,await res.clone().text());
    assert.deepEqual((await res.json()).records.map(row=>row.id),firstPage);
    return performance.now()-sent;
  }));
  console.log('100 simultaneous ticket queue reads across two sessions: '+Math.round(performance.now()-start)+' ms total, p95 '+
    Math.round(times.sort((a,b)=>a-b)[94])+' ms');
  await post('/api/workspaces',{action:'revoke',id:grant.id});
  const revoked=await request('/api/tickets?sort=updated&workspaceId='+workspaceId,{headers:other});
  assert.ok([403,404].includes(revoked.status)||(revoked.ok&&(await revoked.json()).records.length===0));
  const personal=await request('/api/tickets?sort=updated&limit=1',{headers:other});
  assert.deepEqual((await personal.json()).records.map(row=>row.id),[foreign.id]);
  await walk();
  console.log('100,000 support tickets, four warm recently updated pages (ms): '+(await walk()).join(', '));
  // Confirm the production query used the index. Elapsed time varies between machines.
  for(let attempt=0;attempt<12;attempt++){
    if(await scanCount()>initialScans)return;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.fail('Recently updated ticket pages did not use their queue index.');
}
