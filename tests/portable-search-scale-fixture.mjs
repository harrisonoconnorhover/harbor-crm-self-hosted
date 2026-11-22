import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Run on the disposable --search database. Timings are observations, never pass/fail thresholds.
export async function verifySearchScale({request,origin,headers,other,sql}){
  async function read(response){
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  const post=async(path,body,auth=headers)=>read(await request(path,{
    method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body),
  }));
  await post('/api/crm',{action:'save',kind:'contacts',data:{name:'Search rehearsal'}});
  const {owned:workspace,viewers}=await post('/api/workspaces',{action:'grant',email:'other@example.test'});
  const grant=viewers.find(member=>member.email==='other@example.test');
  await post('/api/workspaces',{action:'record_scope',id:grant.id,viewScope:'owned',editScope:'owned'});
  const [{id:rep}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  await verifySearchPaging({post,sql,workspace,rep,headers,other,origin});

  // Exercise the ordinary Tasks list through its own API. Only titles and notes are searchable.
  await sql`INSERT INTO portable_tasks(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspace}::uuid,gen_random_uuid(),1,jsonb_build_object(
      'name',CASE WHEN i=1 THEN 'Follow up Café 30%_A' ELSE 'Fictional callback '||i END,
      'notes',CASE WHEN i=2 THEN 'Reference CAFÉ 30%_a' WHEN i=3 THEN 'Café 30XXa' ELSE '' END,
      'status','Not started','priority','High','taskType','Call'),now(),now() FROM generate_series(1,70000) i`;
  await sql`VACUUM (ANALYZE) portable_tasks`;
  const taskList=async(search,extra={},auth=headers)=>read(await request(
    '/api/crm?'+new URLSearchParams({kind:'tasks',search,...extra}),{headers:auth}));
  const taskTimes=[];
  for(let i=0;i<5;i++){
    const start=performance.now();
    const first=await taskList('café 30%_a',{limit:'1'});
    if(i)taskTimes.push(Math.round(performance.now()-start));
    assert.equal(first.records.length,1);
    assert.ok(first.next);
    const second=await taskList('café 30%_a',{limit:'1',after:first.next});
    assert.equal(second.next,null);
    assert.deepEqual([first.records[0].data.name,second.records[0].data.name].sort(),['Fictional callback 2','Follow up Café 30%_A']);
  }
  assert.deepEqual((await taskList('Not started')).records,[]);
  assert.deepEqual((await taskList('café 30%_a',{},other)).records,[]);
  console.log('Tasks list, 70,000 rows, selective title/notes search:',taskTimes,'ms');
  let previous=0;
  for(const size of [70000,240000]){
    for(let start=previous+1;start<=size;start+=25000){
      await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
        SELECT ${workspace}::uuid,gen_random_uuid(),1,jsonb_strip_nulls(jsonb_build_object(
          'name','Fictional contact '||i,'email','contact'||i||'@example.test','city',CASE WHEN i%8=0 THEN 'Portland' ELSE 'Florence' END,
          'title','Sales manager','phone','+1-202-555-0101','lifecycle','Customer',
          'recordOwner',CASE WHEN i%10=0 THEN jsonb_build_object('workspaceId',${workspace}::text,'userId',${rep}::text,'label','Fictional rep') END)),
          now(),now() FROM generate_series(${start}::int,${Math.min(start+24999,size)}::int) i`;
      await sql`CHECKPOINT`;
    }
    await sql`ANALYZE contacts`;
    for(const [label,path,auth,cityCount] of [
      ['owner','/api/crm/search',headers,size/8],['rep','/api/crm/search?workspaceId='+workspace,other,size/40],
    ]){
      for(const [query,expected] of [['contact'+size+'@example.test',1],['portland',cityCount],['not-in-this-workspace',0]]){
        const times=[];
        for(let run=0;run<4;run++){
          const start=performance.now();
          const result=await post(path,{query,kind:'contacts'},auth);
          if(run)times.push(Math.round(performance.now()-start));
          assert.equal(result.total,expected);
          assert.equal(result.results.length,Math.min(8,expected));
        }
        console.log('Contact search:',size,label,query,'median',times.sort((a,b)=>a-b)[1],'ms');
      }
    }
    const timings=[];
    for(const [suffix,auth] of [['',headers],['?workspaceId='+workspace,other]]){
      // The address and city are in separate fields on the final rep-owned row.
      const terms={kind:'contacts',query:'Portland contact'+size+'@example.test'};
      assert.equal((await post('/api/crm/search'+suffix,terms,auth)).total,0);
      for(let run=0;run<4;run++){
        const start=performance.now();
        const result=await post('/api/crm/search'+suffix,{...terms,match:'words'},auth);
        if(run)timings.push(Math.round(performance.now()-start));
        assert.equal(result.total,1);
        assert.equal(result.results[0].name,'Fictional contact '+size);
      }
    }
    console.log('Cross-field search:',size,'contacts; three warm owner / three warm rep requests in ms:',timings);
    if(size===240000){
      for(const [actor,auth,suffix,count] of [['owner',headers,'',size/8],['rep',other,'?workspaceId='+workspace,size/40]]){
        const criteria={query:'manager Portland',match:'words',kind:'contacts'};
        const start=performance.now();
        const first=await post('/api/crm/search'+suffix,criteria,auth);
        const elapsed=Math.round(performance.now()-start);
        assert.equal(first.total,count);
        const next=await post('/api/crm/search'+suffix,{...criteria,cursor:first.next},auth);
        assert.equal(next.start,8);
        assert.equal(new Set([...first.results,...next.results].map(row=>row.id)).size,16);
        console.log('Cross-field broad search:',actor,count,'visible matches in',elapsed,'ms');
      }
    }
    previous=size;
  }
  const seek={query:'portland',kind:'contacts'};
  const deep=await post('/api/crm/search',{...seek,page:3000});
  const began=performance.now();
  const continuation=await post('/api/crm/search',{...seek,cursor:deep.next});
  const seekMs=Math.round(performance.now()-began);
  const numbered=await post('/api/crm/search',{...seek,page:3001});
  assert.deepEqual(continuation,numbered);
  assert.equal(continuation.start,24_008);
  console.log('Cursor continuation at result 24,009 among 30,000 matches:',seekMs,'ms');

  // Two real permission profiles issue distinct exact lookups against the same hot dataset.
  const burstStart=performance.now();
  await Promise.all(Array.from({length:50},async(_,i)=>{
    const n=69951+i,scoped=i%2===1;
    const result=await post('/api/crm/search'+(scoped?'?workspaceId='+workspace:''),
      {query:'contact'+n+'@example.test',kind:'contacts'},scoped?other:headers);
    assert.equal(result.total,scoped&&n%10!==0?0:1);
  }));
  console.log('50 simultaneous permission-checked lookups:',Math.round(performance.now()-burstStart),'ms');
  await sql`INSERT INTO portable_knowledge_articles(workspace_id,id,content,excerpt,search_text,revision,created_at,updated_at)
    SELECT ${workspace},gen_random_uuid(),jsonb_build_object('title','Fictional handbook '||i),'',
      'fictional handbook '||i||' reference '||md5(i::text)||' '||
      repeat('A teammate records the findings, checks the assignment and schedules the follow-up. ',3),1,i,i FROM generate_series(1,10000) i`;
  await sql`VACUUM (ANALYZE) portable_knowledge_articles`;
  const articlePath='/api/knowledge-base?q=handbook%209987';
  const articles=await read(await request(articlePath,{headers}));
  assert.deepEqual(articles.items.map(item=>item.title),['Fictional handbook 9987']);
  assert.deepEqual((await read(await request(articlePath,{headers:other}))).items,[]);
  // Observe index use by the real requests in this otherwise isolated database.
  for(const name of ['contacts_search_values','portable_knowledge_text_search','portable_tasks_search_values']){
    let scans=0;
    for(let attempt=0;attempt<20&&!scans;attempt++){
      const [index]=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname=${name}`;
      scans=Number(index.idx_scan);
      if(!scans){
        // Statistics from an app connection can remain pending until its next request.
        if(name==='portable_knowledge_text_search')await read(await request(articlePath,{headers}));
        await new Promise(resolve=>setTimeout(resolve,200));
      }
    }
    assert.ok(scans>0,name+' should have served a real search');
  }
}

async function verifySearchPaging({post,sql,workspace,rep,headers,other,origin}){
  const query='Fictional turnover';
  const ids=Array.from({length:18},()=>randomUUID());
  const owner={workspaceId:workspace,userId:rep,label:'Fictional rep'};
  async function insert(number,id){
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspace},${id},1,${sql.json({name:query+' '+String(number).padStart(2,'0'),recordOwner:owner})},now(),now())`;
  }
  for(const [i,id] of ids.entries())await insert(i+1,id);
  const endpoint='/api/crm/search?workspaceId='+workspace;
  const page=cursor=>post(endpoint,{query,cursor},other);
  const first=await page();
  assert.deepEqual(first.results.map(r=>r.id),ids.slice(0,8));
  assert.equal(first.previous,null);
  const earlier=randomUUID();
  await insert(0,earlier);
  const second=await page(first.next);
  assert.deepEqual(second.results.map(r=>r.id),ids.slice(8,16));
  assert.equal(second.start,9);
  await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspace} AND id IN (${earlier},${ids[7]},${ids[15]})`;
  const last=await page(second.next);
  assert.deepEqual(last.results.map(r=>r.id),ids.slice(16));
  assert.equal(last.next,null);
  const back=await page(second.previous);
  assert.deepEqual(back.results.map(r=>r.id),ids.slice(0,7));
  assert.deepEqual([back.previous,back.start,back.total],[null,0,16]);
  // A transferred record drops out of results even with a cursor from before the transfer.
  await sql`UPDATE contacts SET data=data-'recordOwner' WHERE workspace_id=${workspace} AND id=${ids[17]}`;
  assert.deepEqual((await page(second.next)).results.map(r=>r.id),[ids[16]]);
  assert.deepEqual((await post(endpoint,{query,page:999},other)).results.map(r=>r.id),ids.slice(9,15).concat(ids[16]));

  // The same UUID can identify two different custom objects' records with the same name.
  const tieId=randomUUID(),typeIds=Array.from({length:9},()=>randomUUID()).sort();
  for(const id of typeIds){
    await sql`INSERT INTO portable_object_types(workspace_id,id,definition,revision)
      VALUES (${workspace},${id},${sql.json({name:'Fictional type '+id,fields:[]})},1)`;
    await sql`INSERT INTO portable_object_records(workspace_id,object_id,id,name,data,revision)
      VALUES (${workspace},${id},${tieId},'Équal cursor fixture','{"values":{}}',1)`;
  }
  const tied=cursor=>post('/api/crm/search',{query:'cursor fixture',cursor});
  const tiedFirst=await tied();
  const tiedNext=await tied(tiedFirst.next);
  assert.deepEqual(tiedNext.results.map(r=>r.objectId),typeIds.slice(8));
  assert.deepEqual((await tied(tiedNext.previous)).results.map(r=>r.objectId),typeIds.slice(0,8));

  const sample=randomUUID(),token='Borealis',city='Café 50%_B';
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    VALUES (${workspace},${sample},1,${sql.json({name:token,city,description:'private margin',recordOwner:owner})},now(),now())`;
  const phrase='50%_B '+token;
  const search=(query,auth=other,kind='contacts')=>post(auth===other?endpoint:'/api/crm/search',{query,kind,match:'words'},auth);
  assert.equal((await post(endpoint,{query:phrase},other)).total,0);
  assert.deepEqual((await search(phrase)).results.map(r=>r.id),[sample]);
  assert.deepEqual((await search('café boreal')).results.map(r=>r.id),[sample]);
  assert.equal((await search('Borealis Borealis')).total,1);
  assert.equal((await search('Borealis 50%_X')).total,0);
  await post('/api/custom-properties',{action:'standardAccess',kind:'contacts',id:'description',expectedRevision:0,audience:'owner'});
  assert.equal((await search('margin Borealis')).counts.contacts,0);
  assert.equal((await search('margin Borealis',headers)).total,1);
  await sql`UPDATE portable_object_records SET data=${sql.json({values:{[randomUUID()]:'Case 82%_X',[randomUUID()]:true}})}
    WHERE workspace_id=${workspace} AND object_id=${typeIds[0]} AND id=${tieId}`;
  assert.equal((await search('cursor 82%_X YES',headers,'custom-objects')).total,1);
  assert.equal((await search('cursor 82%_X no',headers,'custom-objects')).total,0);
  assert.equal((await search('cursor 82%_X YES',other,'custom-objects')).total,0);

  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const tab=await browser.newPage();
      const [name,value]=headers.cookie.split('=');
      await tab.context().addCookies([{name,value,url:origin}]);
      await tab.goto(origin);
      await tab.getByText('Find in Harbor',{exact:true}).click();
      await tab.getByLabel('Search CRM records').fill(query);
      const results=tab.getByRole('region',{name:'CRM search results'});
      const next=results.getByRole('button',{name:'Next results'});
      await next.waitFor();
      await insert(0,randomUUID());
      await next.click();
      const record=results.locator('[data-search-result]').filter({hasText:query+' 10'});
      await record.waitFor();
      const firstResult=results.locator('[data-search-result]').first();
      assert.match(await firstResult.innerText(),/turnover 10/);
      await record.click();
      await tab.waitForURL(url=>url.searchParams.get('record')===ids[9]||url.href.includes(ids[9]));
      await tab.goBack();
      await record.waitFor();
      assert.match(await firstResult.innerText(),/turnover 10/);
      await results.getByRole('button',{name:'Previous results'}).click();
      await results.locator('[data-search-result]').filter({hasText:query+' 09'}).waitFor();
      await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspace} AND id IN ${sql(ids.slice(9))}`;
      await next.click();
      await results.getByRole('button',{name:'Show first results'}).click();
      await results.locator('[data-search-result]').filter({hasText:query+' 00'}).waitFor();
      await tab.getByLabel('Search CRM records').fill(phrase);
      await results.getByText('No matching records.').waitFor();
      await results.getByRole('combobox',{name:'Search object'}).selectOption('contacts');
      await results.getByRole('combobox',{name:'Match records'}).selectOption('words');
      await results.getByRole('link',{name:new RegExp(token)}).click();
      await tab.waitForURL(url=>url.href.includes(sample));
      await tab.goBack();
      await results.getByRole('link',{name:new RegExp(token)}).waitFor();
      assert.equal(await results.getByRole('combobox',{name:'Match records'}).inputValue(),'words');
      assert.equal(await results.getByRole('combobox',{name:'Search object'}).inputValue(),'contacts');
      await results.getByRole('combobox',{name:'Match records'}).selectOption('phrase');
      await results.getByText('No matching records.').waitFor();
    }finally{await browser.close();}
  }
}
