import assert from 'node:assert/strict';

const sources=[
  ['contacts','contacts','email'],['companies','companies','domain'],['deals','deals','name'],
  ['leads','portable_leads','name'],['tickets','portable_tickets','description'],
];

export async function verifyRecordListSearch({request,headers,other,origin,sql,signIn,listSearchEmails}){
  async function workspace(auth){
    const saved=await request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',data:{name:'List search rehearsal'}})});
    assert.equal(saved.status,201,await saved.clone().text());
    return (await (await request('/api/workspaces',{headers:auth})).json()).owned;
  }
  const mine=await workspace(headers),theirs=await workspace(other);
  const shared=await request('/api/workspaces',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'grant',email:'other@example.test'})});
  assert.equal(shared.status,200,await shared.clone().text());
  const marker='Marigold',literal='30%_A\\ref';
  const expectedByKind=new Map();
  for(const [kind,table,field] of sources){
    // Measure both plans against identical data on the runner's disposable database.
    const indexName=table+'_list_search';
    const [index]=await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=${indexName}`;
    assert.ok(index,indexName);
    await sql`DROP INDEX ${sql(indexName)}`;
    const ids=await seed(mine,50000);
    expectedByKind.set(kind,ids);
    const otherIds=await seed(theirs,5);
    await sql`VACUUM (ANALYZE) ${sql(table)}`;
    async function seed(workspaceId,count){
      const ids=[crypto.randomUUID(),crypto.randomUUID()].sort();
      const defaults={tickets:{ticketStatus:'New',ticketPriority:'Medium'},leads:{leadStage:'New'}}[kind]??{};
      await sql`INSERT INTO ${sql(table)}(workspace_id,id,revision,data,archived_at,created_at,updated_at)
        SELECT ${workspaceId},CASE i WHEN 1 THEN ${ids[0]}::uuid WHEN 2 THEN ${ids[1]}::uuid ELSE gen_random_uuid() END,1,
          ${sql.json(defaults)}::jsonb||jsonb_build_object('name','Fictional record '||i)||CASE
            WHEN i IN (1,3) THEN jsonb_build_object('name',${marker+' '+literal}::text)
            WHEN i=2 THEN jsonb_build_object(${field}::text,${'marigold@example.test'}::text)
            WHEN i=4 THEN jsonb_build_object('name','30XXAref','notes','Hidden marigold')
            ELSE '{}'::jsonb END,CASE WHEN i=3 THEN now() END,now(),now() FROM generate_series(1,${count}::int) i`;
      return ids;
    }
    const endpoint=['leads','tickets'].includes(kind)?'/api/'+kind:'/api/crm';
    async function list(search,params={},auth=headers){
      const url=new URLSearchParams({...(endpoint==='/api/crm'?{kind}:{}),search,...params});
      const path=endpoint+'?'+url;
      let response=await request(path,{headers:auth});
      // Sequential benchmarks share the owner's normal read allowance.
      if(response.status===429){
        const seconds=Number(response.headers.get('retry-after'));
        assert.ok(seconds>0&&seconds<=60);
        await response.body?.cancel();
        await new Promise(resolve=>setTimeout(resolve,seconds*1000));
        response=await request(path,{headers:auth});
      }
      assert.equal(response.status,200,await response.clone().text());
      return response.json();
    }
    async function measure(){
      const times=[];
      for(let i=0;i<6;i++){
        const start=performance.now();
        const page=await list('MARIGOLD');
        if(i)times.push(performance.now()-start);
        assert.deepEqual(page.records.map(row=>row.id),ids,kind);
      }
      return Math.round(times.sort((a,b)=>a-b)[2]);
    }
    const lists=kind==='contacts'?await savedContactLists({request,origin,headers,other,ids,sql,workspaceId:mine}):null;
    const before=await measure();
    await sql.unsafe(index.indexdef);
    if(lists)await lists(index.indexdef);
    const after=await measure();
    const [size]=await sql`SELECT pg_size_pretty(pg_relation_size(${indexName}::regclass)) space`;
    console.log(kind+' selective list search, 50,000 fictional records, median of five: '+before+' to '+after+' ms. Index: '+size.space);
    let used=false;
    for(let attempt=0;attempt<12&&!used;attempt++){
      const [stats]=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname=${indexName}`;
      used=Number(stats?.idx_scan)>0;
      if(!used){
        await new Promise(resolve=>setTimeout(resolve,200));
        await list(marker);
      }
    }
    assert.ok(used,indexName+' must serve the actual list request');
    assert.deepEqual((await list(marker,{workspaceId:mine},other)).records.map(r=>r.id),ids);
    assert.deepEqual((await list(literal.toLowerCase())).records.map(r=>r.id),[ids[0]]);
    assert.deepEqual((await list('%_')).records.map(r=>r.id),[ids[0]]);
    assert.deepEqual((await list(marker,{},other)).records.map(r=>r.id),otherIds);
    const first=await list(marker,{limit:'1'});
    assert.equal(first.next,ids[0]);
    const second=await list(marker,{limit:'1',after:first.next});
    assert.deepEqual(second.records.map(r=>r.id),[ids[1]]);
    assert.equal(second.next,null);
  }
  await concurrentReaders({request,origin,headers,other,signIn,listSearchEmails,mine,sql,expectedByKind});
}

async function shareActiveList(request,headers,origin,name,groups){
  async function write(body){
    const result=await request('/api/segments',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(result.ok,await result.clone().text());
    return result.json();
  }
  const {segment}=await write({action:'save',segment:{id:crypto.randomUUID(),revision:0,name,kind:'contacts',mode:'active',criteria:{groups}}});
  await write({action:'share',id:segment.id,revision:segment.revision,shared:true});
  return segment.id;
}

// Saved list member searches fetch an exact count and a cursor page. Exercise both
// member and candidate reads using the same 50,000 contacts as the CRM list.
async function savedContactLists({request,origin,headers,other,ids,sql,workspaceId}){
  async function save(mode){
    const id=crypto.randomUUID();
    const saved=await request('/api/segments',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',segment:{id,revision:0,name:mode+' scale trial',kind:'contacts',mode,criteria:{groups:[]}}})});
    assert.equal(saved.status,201,await saved.clone().text());
    return id;
  }
  const active=await save('active'),picker=await save('static');
  async function read(id,params,auth=headers){
    return request('/api/segments?'+new URLSearchParams({id,...params}),{headers:auth});
  }
  async function measure(id,params,auth=headers){
    const times=[];
    for(let i=0;i<6;i++){
      const start=performance.now();
      const r=await read(id,params,auth);
      assert.equal(r.status,200,await r.clone().text());
      const page=await r.json();
      if(i)times.push(performance.now()-start);
      assert.deepEqual(page.items.map(item=>item.id),ids);
      assert.equal(page.total,'2');
    }
    return Math.round(times.sort((a,b)=>a-b)[2]);
  }
  const shared=await shareActiveList(request,headers,origin,'Shared selective audience',[
    [{field:'name',operator:'contains',value:'30%_A\\ref'}],
    [{field:'email',operator:'contains',value:'MARIGOLD'}],
  ]);
  const sharedBefore=await measure(shared,{workspaceId},other);
  const cases=[[active,{q:'MARIGOLD'},'Member'],[picker,{candidates:'true',q:'MARIGOLD'},'Candidate']];
  const before=[];
  for(const [id,params] of cases)before.push(await measure(id,params));
  async function verifyIndexReads(id,params,auth){
    for(let i=0;i<12;i++){
      const [stats]=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='contacts_list_search'`;
      if(Number(stats.idx_scan)>0)return;
      await new Promise(resolve=>setTimeout(resolve,200));
      const result=await read(id,params,auth);
      assert.equal(result.status,200);
      await result.body?.cancel();
    }
    assert.fail('Saved List reads did not use the contact name and email index.');
  }
  return async indexDefinition=>{
    // Until this check completes, only shared saved rules can use the fresh index.
    const sharedAfter=await measure(shared,{workspaceId},other);
    console.log('Shared saved rules with count, 50,000 contacts, median of five: '+sharedBefore+' to '+sharedAfter+' ms.');
    const first=await (await read(shared,{workspaceId,limit:'1'},other)).json();
    assert.equal(first.next,ids[0]);
    const last=await (await read(shared,{workspaceId,limit:'1',after:first.next},other)).json();
    assert.equal(last.total,'2');
    assert.deepEqual(last.items.map(item=>item.id),[ids[1]]);
    assert.equal(last.next,null);
    await verifyIndexReads(shared,{workspaceId},other);
    // Isolate the independent in-list search check below on the disposable database.
    await sql`DROP INDEX contacts_list_search`;
    await sql.unsafe(indexDefinition);
    for(const [i,[id,params,label]] of cases.entries()){
      console.log(label+' search with count, 50,000 contacts, median of five: '+before[i]+' to '+await measure(id,params)+' ms.');
      const first=await (await read(id,{...params,q:'marigold',limit:'1'})).json();
      assert.equal(first.next,ids[0]);
      const second=await (await read(id,{...params,q:'marigold',limit:'1',after:first.next})).json();
      assert.equal(second.total,'2');
      assert.deepEqual(second.items.map(row=>row.id),[ids[1]]);
      const literal=await (await read(id,{...params,q:'%_'})).json();
      assert.deepEqual(literal.items.map(row=>row.id),[ids[0]]);
      assert.equal((await read(id,params,other)).status,404);
    }
    await verifyIndexReads(active,{q:'marigold'},headers);
  };
}

async function concurrentReaders({request,origin,headers,other,signIn,listSearchEmails,mine,sql,expectedByKind}){
  // Each browser session goes through Harbor's ordinary callback with the local Google fixture.
  const readers=[{auth:headers,scope:'personal'},{auth:other,scope:'all'}];
  const teammates=['invitee@example.test',...listSearchEmails];
  async function pacedLogin(path,options){
    let response=await request(path,options);
    while(path.startsWith('/auth/google/start?')&&response.status===429){
      const seconds=Number(response.headers.get('retry-after'));
      assert.ok(seconds>0&&seconds<=60,'Expected a bounded sign-in retry interval');
      await response.body?.cancel();
      await new Promise(resolve=>setTimeout(resolve,seconds*1000));
      response=await request(path,options);
    }
    return response;
  }
  for(const [i,email] of teammates.entries()){
    readers.push({auth:await signIn(email,pacedLogin),email,scope:i%2?'all':'owned'});
  }
  assert.equal(readers.length,100);
  assert.equal(new Set(readers.map(reader=>reader.auth.cookie)).size,100);
  // Give half the simulated teammates owned-only access and one matching Contact apiece.
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,view_scope,edit_scope)
    SELECT ${mine},u.id,gen_random_uuid(),'editor',CASE WHEN t.n%2=1 THEN 'owned' ELSE 'all' END,'owned'
    FROM unnest(${teammates}::text[]) WITH ORDINALITY t(email,n) JOIN login_identities u ON u.email=t.email`;
  const ownedEmails=readers.filter(reader=>reader.scope==='owned').map(reader=>reader.email);
  const ownedContacts=await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${mine},gen_random_uuid(),1,jsonb_build_object('name','Quarterly follow-up','email',u.email,
      'recordOwner',jsonb_build_object('workspaceId',${mine}::text,'userId',u.id,'label','Fixture rep')),now(),now()
      FROM login_identities u WHERE u.email=ANY(${ownedEmails}::text[]) RETURNING id,data->>'email' AS email`;
  const byRep=new Map(ownedContacts.map(row=>[row.email,row.id]));
  assert.equal(byRep.size,ownedEmails.length);
  async function readList({auth,email,scope},i){
    const kind=scope==='owned'?'contacts':sources[i%sources.length][0];
    const crm=!['leads','tickets'].includes(kind);
    const path=crm?'/api/crm':'/api/'+kind;
    const params=new URLSearchParams({...(crm?{kind}:{}),...(scope==='personal'?{}:{workspaceId:mine}),search:scope==='owned'?'Quarterly follow-up':'marigold'});
    const response=await request(path+'?'+params,{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    const {records}=await response.json();
    const expected=scope==='owned'?[byRep.get(email)]:expectedByKind.get(kind);
    assert.deepEqual(records.map(r=>r.id),expected);
  }
  for(const count of [50,100]){
    const start=performance.now();
    const latencies=await Promise.all(readers.slice(0,count).map(async(reader,i)=>{
      const sent=performance.now();
      await readList(reader,i);
      return performance.now()-sent;
    }));
    const elapsed=Math.round(performance.now()-start);
    latencies.sort((a,b)=>a-b);
    console.log(count+' distinct sessions, simultaneous scoped list reads: '+elapsed+' ms total, p95 '+
      Math.round(latencies[Math.ceil(count*.95)-1])+' ms');
  }
  const listId=await shareActiveList(request,headers,origin,'Team follow-up',[[
    {field:'name',operator:'contains',value:'Quarterly follow-up'},
  ]]);
  const allIds=[...byRep.values()].sort();
  const start=performance.now();
  const latencies=await Promise.all(readers.map(async({auth,email,scope})=>{
    const sent=performance.now();
    const params=new URLSearchParams({id:listId,limit:'5',...(scope==='personal'?{}:{workspaceId:mine})});
    const response=await request('/api/segments?'+params,{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    const page=await response.json();
    const allowed=scope==='owned'?[byRep.get(email)]:allIds;
    assert.equal(page.total,String(allowed.length));
    assert.deepEqual(page.items.map(row=>row.id),allowed.slice(0,5));
    assert.equal(page.next,allowed.length>5?allowed[4]:null);
    return performance.now()-sent;
  }));
  console.log('100 distinct sessions opening the same saved active List, scoped counts and pages: '+
    Math.round(performance.now()-start)+' ms total, p95 '+Math.round(latencies.sort((a,b)=>a-b)[94])+' ms.');
  const {verifyMixedRecordTraffic}=await import('./portable-mixed-record-traffic-fixture.mjs');
  await verifyMixedRecordTraffic({request,origin,sql,readers,readList,workspaceId:mine,byRep});
  const {verifyTeamReorganization}=await import('./portable-team-reorganization-load-fixture.mjs');
  await verifyTeamReorganization({request,origin,sql,readers,workspaceId:mine});
}
