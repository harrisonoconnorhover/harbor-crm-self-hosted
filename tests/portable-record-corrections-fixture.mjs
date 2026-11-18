import assert from 'node:assert/strict';

// Exercise the owner-facing import protocol against the same web app and Postgres
// as regular record edits. The two deals intentionally share a display name.
export async function verifyPortableRecordCorrections({request,origin,headers,other,sql,workspaceId}){
  const marker='CSV team '+crypto.randomUUID(),ids=[],receipts=[],pipelines=[];
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async(kind,id)=>(await (await request('/api/crm?'+new URLSearchParams({kind,id}),{headers})).json());
  const create=async(kind,data,auth=headers,extra={})=>{
    const response=await post('/api/crm',{action:'save',kind,data,...extra},auth);
    assert.equal(response.status,201,await response.clone().text());
    const {record}=await response.json();ids.push(record.id);return record;
  };
  const preview=async(kind,csv)=>{
    const response=await post('/api/crm/import',{action:'preview',kind,csv,reviewMatches:true});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const apply=(kind,csv,review,selected,opts={})=>{
    const requestId=opts.requestId??crypto.randomUUID();
    receipts.push(requestId);
    return post('/api/crm/import',{action:'import',kind,csv,review:review.review,reviewMatches:true,
      updateRows:selected,includeNew:false,requestId,...opts});
  };
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  try{
    const one=await create('companies',{name:marker,domain:'team-sheet.example.test',city:'Tulsa',industry:'Design'});
    const foreign=await create('companies',{name:marker+' elsewhere',domain:'team-sheet.example.test'},other);
    const sheet='Domain,City,Industry\nTEAM-SHEET.EXAMPLE.TEST,Boston,';
    const cmp=await preview('companies',sheet);
    assert.deepEqual(cmp.rows[0].changes,[{field:'city',label:'City',before:'Tulsa',after:'Boston'}]);
    assert.equal((await apply('companies',sheet,cmp,[])).status,400);
    assert.equal((await apply('companies',sheet,cmp,[2])).status,201);
    assert.equal((await read('companies',one.id)).data.industry,'Design');
    assert.equal((await read('companies',one.id)).data.city,'Boston');
    assert.equal((await preview('companies',sheet)).updates,0);
    const duplicate=await create('companies',{name:marker+' second',domain:'team-sheet.example.test'});
    assert.equal((await preview('companies',sheet)).errors,1);
    const exact=`Record ID,City\n${one.id},Portland`,scoped=await preview('companies',exact);
    assert.equal(scoped.updates,1);
    assert.equal((await apply('companies',exact,scoped,[2])).status,201);
    assert.notEqual((await read('companies',duplicate.id)).data.city,'Portland');
    assert.equal((await preview('companies',`Record ID,City\n${foreign.id},Hidden`)).errors,1);
    assert.equal((await preview('companies',`Record ID,Domain,City\n${one.id},wrong.example.test,Hidden`)).errors,1);

    const built=await post('/api/pipeline',{name:marker,stages:[{name:'Discovery',outcome:'open'},
      {name:'Signed',outcome:'won',requiredProperties:[{field:'closeDate',required:true}]},{name:'Lost',outcome:'lost'}]});
    assert.equal(built.status,201,await built.clone().text());
    const {pipeline}=await built.json();pipelines.push(pipeline.id);
    const target=await create('deals',{name:marker,amount:100},{...headers},{pipelineId:pipeline.id,stageId:pipeline.stages[0].id,companyId:one.id});
    const twin=await create('deals',{name:marker,amount:200});
    const source=`Record ID,Amount\n${target.id.toUpperCase()},0`;
    const change=await preview('deals',source);
    assert.deepEqual(change.rows[0].changes,[{field:'amount',label:'Amount',before:100,after:0}]);
    const intervene=await post('/api/crm',{action:'save',kind:'deals',id:target.id,expectedRevision:1,data:{name:marker,amount:150}});
    assert.equal(intervene.status,200,await intervene.clone().text());
    assert.equal((await apply('deals',source,change,[2])).status,409);
    const approved=await preview('deals',source),requestId=crypto.randomUUID();
    assert.equal(approved.rows[0].changes[0].before,150);
    const results=await Promise.all([apply('deals',source,approved,[2],{requestId}),apply('deals',source,approved,[2],{requestId})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
    const after=await read('deals',target.id);
    assert.deepEqual([after.data.amount,after.pipelineId,after.stageId,after.companyId],[0,pipeline.id,pipeline.stages[0].id,one.id]);
    assert.equal((await read('deals',twin.id)).data.amount,200);
    const missing=await preview('deals',`Record ID,Stage\n${target.id},Signed`);
    assert.match(missing.rows[0].message,/Close date/i);
    const move=`Record ID,Stage,Close date\n${target.id},Signed,2027-03-01`,stage=await preview('deals',move);
    assert.ok(stage.rows[0].changes.some(c=>c.field==='stage'&&c.before==='Discovery'&&c.after==='Signed'));
    assert.equal((await apply('deals',move,stage,[2])).status,201);
    assert.equal((await read('deals',target.id)).stageId,pipeline.stages[1].id);
    const [event]=await sql`SELECT previous_stage_id,stage_id,company_id FROM deal_events WHERE deal_id=${target.id} ORDER BY revision DESC LIMIT 1`;
    assert.deepEqual([event.previous_stage_id,event.stage_id,event.company_id],[pipeline.stages[0].id,pipeline.stages[1].id,one.id]);
    const staleIds=await preview('deals',`Record ID,Amount\n${one.id},1\n${target.id},2\n${target.id},3`);
    assert.equal(staleIds.errors,3);
  }finally{
    await sql`DELETE FROM portable_contact_import_receipts WHERE request_id=ANY(${receipts}::uuid[])`;
    await sql`DELETE FROM deal_events WHERE deal_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM deals WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM company_events WHERE company_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM companies WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM deal_pipeline_stages WHERE pipeline_id=ANY(${pipelines}::uuid[])`;
    await sql`DELETE FROM deal_pipelines WHERE id=ANY(${pipelines}::uuid[])`;
    await reset();
  }
}
