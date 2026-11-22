import assert from 'node:assert/strict';

export async function verifyFileSearch({request,headers,other,origin,sql}){
  async function createWorkspace(auth){
    const response=await request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'contacts',data:{name:'File library fixture'}})});
    assert.ok(response.ok,await response.clone().text());
    return (await (await request('/api/workspaces',{headers:auth})).json()).owned;
  }
  const workspace=await createWorkspace(headers),foreign=await createWorkspace(other);
  const term='Marigold',literal='30%_A\\ref';
  async function seed(space,size){
    await sql`WITH seeded AS (
      INSERT INTO contacts(workspace_id,id,revision,data,archived_at,created_at,updated_at)
      SELECT ${space},gen_random_uuid(),1,jsonb_build_object('name',
        CASE WHEN n IN (1,2) THEN 'Marigold customer ' ELSE 'Ordinary customer ' END||n),
        CASE WHEN n=2 THEN now() END,now(),now() FROM generate_series(1,${size}::int) n
      RETURNING workspace_id,id,data)
      INSERT INTO contact_file_versions(workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
      SELECT workspace_id,id,gen_random_uuid(),gen_random_uuid(),1,
        CASE WHEN data->>'name'='Marigold customer 1' AND f=1 THEN ${term+' '+literal+'.pdf'}::text
          WHEN (split_part(data->>'name',' ',3))::int BETWEEN 3 AND 29 AND f=1 THEN 'Marigold proposal.pdf'
          ELSE 'Proposal '||f||'.pdf' END,20,repeat('0',64),now()-f*interval '1 microsecond'
      FROM seeded CROSS JOIN generate_series(1,3) f`;
  }
  await seed(workspace,20000);await seed(foreign,3);
  const [replaced]=await sql`SELECT contact_id,file_id FROM contact_file_versions
    WHERE workspace_id=${workspace} AND name='Marigold proposal.pdf' LIMIT 1`;
  await sql`INSERT INTO contact_file_versions(workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
    VALUES(${workspace},${replaced.contact_id},${replaced.file_id},gen_random_uuid(),2,'Renewed proposal.pdf',20,repeat('0',64),now()),
    (${workspace},${replaced.contact_id},gen_random_uuid(),gen_random_uuid(),NULL,'Marigold pending.pdf',20,repeat('0',64),now())`;
  await sql`VACUUM (ANALYZE) contacts`;
  await sql`VACUUM (ANALYZE) contact_file_versions`;
  const pagePath=(search,sort='default')=>'/?'+new URLSearchParams({view:'files',search,sort});
  async function read(path,auth=headers){
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200);
    const html=(await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    const files=[...html.matchAll(/href="(\/api\/record-attachments\?[^"]+)"/g)].map(match=>
      new URL(match[1].replaceAll('&amp;','&'),origin).searchParams.get('fileId'));
    const next=html.match(/href="([^"]+)">Next page<\/a>/)?.[1].replaceAll('&amp;','&');
    return {files,next};
  }
  const scans=async()=>Object.fromEntries((await sql`SELECT indexrelname,idx_scan FROM pg_stat_user_indexes
    WHERE indexrelname IN ('contact_file_name_search','contacts_list_search')`).map(row=>[row.indexrelname,Number(row.idx_scan)]));
  const expected=async(space,sort='default')=>sql`SELECT v.file_id FROM contact_file_versions v JOIN contacts c
    ON (c.workspace_id,c.id)=(v.workspace_id,v.contact_id)
    WHERE v.workspace_id=${space} AND c.archived_at IS NULL AND v.revision=1
      AND (v.name LIKE 'Marigold%' OR c.data->>'name' LIKE 'Marigold%') AND v.file_id<>${replaced.file_id}
    ORDER BY ${sort==='name'?sql`lower(v.name) COLLATE "C",`:sort==='newest'?sql`v.created_at DESC,`:sql``} v.contact_id,v.file_id`;
  for(const sort of ['default','name','newest']){
    const first=await read(pagePath(term,sort));
    assert.equal(first.files.length,25);assert.ok(first.next);
    const last=await read(first.next);
    const matches=(await expected(workspace,sort)).map(r=>r.file_id);
    assert.equal(matches.length,29);
    assert.deepEqual([...first.files,...last.files],matches);
    assert.equal(last.next,undefined);
  }
  const [match]=await sql`SELECT contact_id,file_id FROM contact_file_versions
    WHERE workspace_id=${workspace} AND name=${term+' '+literal+'.pdf'}`;
  const folder=crypto.randomUUID();
  await sql`INSERT INTO portable_file_folders(workspace_id,id,name,name_key) VALUES(${workspace},${folder},'Agreements','agreements')`;
  await sql`INSERT INTO portable_file_locations(workspace_id,contact_id,file_id,folder_id,revision)
    VALUES(${workspace},${match.contact_id},${match.file_id},${folder},1)`;
  assert.deepEqual((await read(pagePath(literal.toLowerCase()))).files,[match.file_id]);
  assert.deepEqual((await read(pagePath(term)+'&folder='+folder+'&contactId='+match.contact_id)).files,[match.file_id]);
  assert.deepEqual((await read(pagePath(literal)+'&folder=root')).files,[]);
  assert.deepEqual((await read(pagePath(term)+'&contactId='+replaced.contact_id)).files,[]);
  assert.deepEqual((await read(pagePath('30ZZZA'))).files,[]);
  assert.deepEqual((await read(pagePath(term),other)).files.sort(),(await expected(foreign)).map(r=>r.file_id).sort());
  const change=async body=>{
    const response=await request('/api/workspaces',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).viewers.find(member=>member.email==='other@example.test');
  };
  let rep=await change({action:'grant',email:'other@example.test'});
  rep=await change({action:'role',id:rep.id,role:'editor'});
  rep=await change({action:'record_scope',id:rep.id,viewScope:'owned',editScope:'owned'});
  rep=await change({action:'contact_files',id:rep.id,enabled:true});
  const [identity]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const assigned=await request('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',id:match.contact_id,expectedRevision:1,
      data:{name:'Marigold customer 1'},assigneeId:identity.id})});
  assert.equal(assigned.status,200,await assigned.clone().text());
  const visible=await sql`SELECT file_id FROM contact_file_versions WHERE workspace_id=${workspace} AND contact_id=${match.contact_id}`;
  const reads=[];
  for(let i=0;i<6;i++){
    const start=performance.now();
    const result=await read(pagePath(term)+'&workspaceId='+workspace,other);
    if(i)reads.push(performance.now()-start);
    assert.deepEqual(result.files.sort(),visible.map(file=>file.file_id).sort());
    assert.equal(result.next,undefined);
  }
  console.log('Shared Files, 60,000 original attachments, owned contacts,',Math.round(reads.sort((a,b)=>a-b)[2]),'ms median HTTP read');
  await change({action:'contact_files',id:rep.id,enabled:false});
  assert.equal((await request(pagePath(term)+'&workspaceId='+workspace,{headers:other})).status,404);
  const before=await scans();
  for(const [query,count] of [['marigold customer',3],['marigold proposal',25],['renewed proposal',1]]){
    const times=[];
    for(let i=0;i<6;i++){
      const started=performance.now(),result=await read(pagePath(query));
      assert.equal(result.files.length,count);
      if(i)times.push(performance.now()-started);
    }
    console.log('File library, 60,000 original attachments,',query,Math.round(times.sort((a,b)=>a-b)[2]),'ms median HTTP read');
  }
  // The fixture connection reads usage counters from the web server's connections.
  for(let i=0;i<15;i++){
    const after=await scans();
    if(after.contact_file_name_search>before.contact_file_name_search&&after.contacts_list_search>before.contacts_list_search)return;
    await new Promise(resolve=>setTimeout(resolve,150));
    await read(pagePath('renewed proposal'));
  }
  assert.fail('Expected both search indexes to be used by file library HTTP requests');
}
