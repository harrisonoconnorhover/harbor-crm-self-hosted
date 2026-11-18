import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const path='/api/crm/import';
const sha256=value=>createHash('sha256').update(value).digest('base64url');
const post=(request,origin,headers,body,target=path)=>request(target,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const resetBudget=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
const payload=(kind,csv,review)=>({action:'import',kind,csv,review,requestId:crypto.randomUUID()});
const rowsPath=(kind,search)=>'/api/crm?'+new URLSearchParams({kind,search});
const readPath=(kind,id)=>'/api/crm?'+new URLSearchParams({kind,id});

export async function verifyPortableAdditionalImports({request,origin,headers,other,sql,workspaceId}){
  const marker='Additional import '+crypto.randomUUID();
  const ownerDomain='existing-import.example.test',foreignDomain='foreign-import.example.test',raceDomain='race-import.example.test';
  const failedCompany='Fixture company import rollback',failedDeal='Fixture deal import rollback';
  const ids=[],pipelines=[];
  const call=(body,auth=headers,target=path,site=origin)=>post(request,site,auth,body,target);
  const preview=async(kind,csv,auth=headers)=>{
    const response=await call({action:'preview',kind,csv},auth);
    assert.equal(response.status,200);
    return response.json();
  };
  const importBody=(kind,csv,review)=>{
    const body=payload(kind,csv,review);
    ids.push(body.requestId);
    return body;
  };
  const save=(kind,data,auth=headers)=>call({action:'save',kind,data},auth,'/api/crm');
  const query=async(kind,search,auth=headers)=>(await (await request(rowsPath(kind,search),{headers:auth})).json()).records;
  const newPipeline=async(auth,ending)=>{
    const response=await call({name:marker+' '+ending,stages:[{name:'Fixture open',outcome:'open'},
      {name:'Fixture won',outcome:'won'},{name:'Fixture lost',outcome:'lost'}]},auth,'/api/pipeline');
    assert.equal(response.status,201);
    const {pipeline}=await response.json();
    pipelines.push(pipeline.id);
    return pipeline;
  };
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const [jobs]=await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}`;
  await resetBudget(sql);

  try{
    // A committed request from the Contacts-only release still replays without a kind field.
    const legacy=importBody('contacts','Name\nFictional legacy contact','a'.repeat(43));
    const legacyHash=sha256(JSON.stringify([sha256(legacy.csv),legacy.review]));
    await sql`INSERT INTO portable_contact_import_receipts (workspace_id,request_id,request_hash,result,created_at)
      VALUES (${workspaceId},${legacy.requestId},${legacyHash},${sql.json({created:1,skipped:0})},now())`;
    const oldRequest={action:legacy.action,csv:legacy.csv,review:legacy.review,requestId:legacy.requestId};
    const oldReplay=await call(oldRequest);
    assert.equal(oldReplay.status,200);
    assert.deepEqual(await oldReplay.json(),{created:1,skipped:0});
    assert.equal((await call({...legacy,kind:'companies'})).status,409);

    assert.equal((await save('companies',{name:marker+' existing',domain:ownerDomain})).status,201);
    assert.equal((await save('companies',{name:marker+' foreign',domain:foreignDomain},other)).status,201);
    const companies=['Company Name,Company Domain,Website URL,Description,Associated contact email',
      `${marker} duplicate,${ownerDomain.toUpperCase()},,,`,
      `${marker} create,${foreignDomain},https://fictional.example.test,Fixture description,ignored@example.test`,
      `${marker} repeated,${foreignDomain.toUpperCase()},,,`,
      ',derived-company-import.example.test,,,',
    ].join('\r\n');
    assert.equal((await call({action:'preview',kind:'companies',csv:companies},{})).status,401);
    assert.equal((await call({action:'preview',kind:'companies',csv:companies},other,path+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await call({action:'preview',kind:'companies',csv:companies},headers,path,'https://outside.example.test')).status,403);
    assert.match(await (await request('/?kind=companies',{headers})).text(),/>Import Companies CSV</);
    assert.doesNotMatch(await (await request('/?kind=companies&workspaceId='+workspaceId,{headers:other})).text(),/>Import Companies CSV</);
    const badCompanies=companies+`\r\n${marker} invalid,,javascript:alert(1),,`;
    const badPreview=await preview('companies',badCompanies);
    assert.equal(badPreview.errors,1);
    assert.equal((await call(importBody('companies',badCompanies,badPreview.review))).status,400);
    assert.deepEqual((await query('companies',marker)).map(record=>record.data.domain),[ownerDomain]);

    const reviewed=await preview('companies',companies);
    assert.deepEqual([reviewed.created,reviewed.skipped,reviewed.errors],[2,2,0]);
    assert.deepEqual(reviewed.rows.map(row=>row.state),['skip','create','skip','create']);
    assert.equal(reviewed.rows[3].name,'derived-company-import.example.test');
    assert.equal(reviewed.columns.at(-1).field,null);
    const companyBody=importBody('companies',companies,reviewed.review);
    assert.equal((await call(companyBody,other)).status,409);
    const companyRuns=await Promise.all([call(companyBody),call(companyBody)]);
    assert.deepEqual(companyRuns.map(response=>response.status).sort(),[200,201]);
    const [createdCompany]=await query('companies',marker+' create');
    assert.deepEqual([createdCompany.data.domain,createdCompany.data.description,createdCompany.data.website],
      [foreignDomain,'Fixture description','https://fictional.example.test']);
    assert.equal((await request(readPath('companies',createdCompany.id),{headers:other})).status,404);
    const [companyHistory]=await sql`SELECT actor_id,revision FROM company_events
      WHERE workspace_id=${workspaceId} AND company_id=${createdCompany.id}`;
    assert.deepEqual([companyHistory.actor_id,companyHistory.revision],[owner.owner_id,1]);

    const raceCsv=`Name,Domain\n${marker} raced,${raceDomain}\n${marker} rest,`;
    const beforeRace=await preview('companies',raceCsv);
    assert.equal((await save('companies',{name:marker+' meanwhile',domain:raceDomain})).status,201);
    assert.equal((await call(importBody('companies',raceCsv,beforeRace.review))).status,409);
    const afterRace=await preview('companies',raceCsv);
    assert.deepEqual([afterRace.created,afterRace.skipped],[1,1]);
    assert.equal((await call(importBody('companies',raceCsv,afterRace.review))).status,201);

    const ownPipeline=await newPipeline(headers,'owner pipeline'),foreignPipeline=await newPipeline(other,'foreign pipeline');
    const [open,won]=ownPipeline.stages;
    const deals=['Deal Name,Pipeline,Deal Stage,Amount,Close Date',
      `${marker} labels,${ownPipeline.name},${won.name},250,2026-11-09`,
      `${marker} IDs,${ownPipeline.id},${open.id},0,`,
      `${marker} built in,,Qualified to buy,42,`,
      `${marker} first stage,${ownPipeline.id},,100,`,
    ].join('\r\n');
    const badDeals=deals+`\r\n${marker} foreign pipeline,${foreignPipeline.id},${foreignPipeline.stages[0].id},,\r\n${marker} foreign stage,${ownPipeline.id},${foreignPipeline.stages[0].id},,`;
    const rejected=await preview('deals',badDeals);
    assert.equal(rejected.errors,2);
    assert.equal((await call(importBody('deals',badDeals,rejected.review))).status,400);
    assert.deepEqual(await query('deals',marker),[]);
    const valid=await preview('deals',deals);
    assert.deepEqual(valid.rows.map(row=>[row.pipeline,row.stage]),[
      [ownPipeline.name,won.name],[ownPipeline.name,open.name],['Sales pipeline','Qualified to buy'],[ownPipeline.name,open.name],
    ]);
    const dealBody=importBody('deals',deals,valid.review);
    assert.equal((await call(dealBody,other)).status,409);
    assert.equal((await call(dealBody)).status,201);
    assert.equal((await call(dealBody)).status,200);
    assert.match(await (await request('/?kind=deals',{headers})).text(),/>Import Deals CSV</);
    const [createdDeal]=await query('deals',marker+' labels');
    assert.deepEqual([createdDeal.pipelineId,createdDeal.stageId,createdDeal.data.stage,createdDeal.data.amount,createdDeal.data.closeDate],
      [ownPipeline.id,won.id,won.name,250,'2026-11-09']);
    assert.equal((await request(readPath('deals',createdDeal.id),{headers:other})).status,404);
    const [dealHistory]=await sql`SELECT actor_id,revision,pipeline_id,stage_id FROM deal_events
      WHERE workspace_id=${workspaceId} AND deal_id=${createdDeal.id}`;
    assert.deepEqual([dealHistory.actor_id,dealHistory.revision,dealHistory.pipeline_id,dealHistory.stage_id],
      [owner.owner_id,1,ownPipeline.id,won.id]);

    const mappedCompany=`Source Label,Customer Host\n${marker} mapped company,mapped-company.example.test`;
    const mappedDeal=`Source Label,Board,Column,Value\n${marker} mapped deal,${ownPipeline.name},${won.name},350`;
    for(const [kind,csv,mapping] of [['companies',mappedCompany,['name','domain']],
      ['deals',mappedDeal,['name','pipelineId','stage','amount']]]){
      const response=await call({action:'preview',kind,csv,mapping});
      assert.equal(response.status,200);
      const review=await response.json();
      assert.deepEqual([review.created,review.errors],[1,0]);
      assert.equal((await call({...importBody(kind,csv,review.review),mapping})).status,201);
    }
    assert.equal((await query('companies',marker+' mapped company'))[0].data.domain,'mapped-company.example.test');
    const [remappedDeal]=await query('deals',marker+' mapped deal');
    assert.deepEqual([remappedDeal.pipelineId,remappedDeal.stageId,remappedDeal.data.amount],[ownPipeline.id,won.id,350]);

    const stageCsv=`Name,Pipeline ID,Stage ID\n${marker} stale stage,${ownPipeline.id},${open.id}`;
    const beforeStage=await preview('deals',stageCsv);
    assert.equal(beforeStage.rows[0].stage,open.name);
    const updated=await call({id:ownPipeline.id,expectedRevision:ownPipeline.revision,name:ownPipeline.name,
      stages:ownPipeline.stages.map(stage=>stage.id===open.id?{...stage,name:'Renamed fixture open'}:stage)},headers,'/api/pipeline');
    assert.equal(updated.status,200);
    assert.equal((await call(importBody('deals',stageCsv,beforeStage.review))).status,409);
    const afterStage=await preview('deals',stageCsv);
    assert.equal(afterStage.rows[0].stage,'Renamed fixture open');
    assert.equal((await call(importBody('deals',stageCsv,afterStage.review))).status,201);
    assert.equal((await call(dealBody)).status,200,'An exact receipt still replays after a catalog change.');

    for(const [kind,failedName] of [['companies',failedCompany],['deals',failedDeal]]){
      const csv=`Name\n${marker} atomic ${kind}\n${failedName}`;
      const body=importBody(kind,csv,(await preview(kind,csv)).review);
      const eventTable=sql(kind==='companies'?'company_events':'deal_events');
      await sql`ALTER TABLE ${eventTable} ADD CONSTRAINT fixture_rollback_import
        CHECK (data->>'name' <> 'Fixture company import rollback' AND data->>'name' <> 'Fixture deal import rollback')`;
      try{
        assert.equal((await call(body)).status,503);
        assert.deepEqual(await query(kind,marker+' atomic'),[]);
        assert.equal((await sql`SELECT count(*)::int AS count FROM portable_contact_import_receipts
          WHERE workspace_id=${workspaceId} AND request_id=${body.requestId}`)[0].count,0);
      }finally{await sql`ALTER TABLE ${eventTable} DROP CONSTRAINT fixture_rollback_import`;}
      assert.equal((await call(body)).status,201);
    }
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}`)[0].count,jobs.count);
  }finally{
    const rows=await sql`SELECT id FROM companies WHERE data->>'name' LIKE ${marker+'%'}
      OR data->>'name' IN (${failedCompany},'derived-company-import.example.test')`;
    const dealRows=await sql`SELECT id FROM deals WHERE data->>'name' LIKE ${marker+'%'} OR data->>'name'=${failedDeal}`;
    const companyIds=rows.map(row=>row.id),dealIds=dealRows.map(row=>row.id);
    await sql`DELETE FROM company_events WHERE company_id=ANY(${companyIds}::uuid[])`;
    await sql`DELETE FROM deal_events WHERE deal_id=ANY(${dealIds}::uuid[])`;
    await sql`DELETE FROM companies WHERE id=ANY(${companyIds}::uuid[])`;
    await sql`DELETE FROM deals WHERE id=ANY(${dealIds}::uuid[])`;
    await sql`DELETE FROM deal_pipeline_stages WHERE pipeline_id=ANY(${pipelines}::uuid[])`;
    await sql`DELETE FROM deal_pipelines WHERE id=ANY(${pipelines}::uuid[])`;
    await sql`DELETE FROM portable_contact_import_receipts WHERE request_id=ANY(${ids}::uuid[])`;
    await resetBudget(sql);
  }
}

export async function seedAdditionalImportRecovery({request,origin,headers}){
  const results=[];
  for(const kind of ['contacts','companies','deals']){
    const name='Fictional restored '+kind+' '+crypto.randomUUID();
    const created=await post(request,origin,headers,{action:'create',kind,label:name,type:'checkbox'},'/api/custom-properties');
    assert.equal(created.status,201,await created.clone().text());
    const {property}=await created.json();
    const csv='Name,Custom choice\n'+name+',No',mapping=['name','custom:'+property.id];
    const reviewed=await post(request,origin,headers,{action:'preview',kind,csv,mapping});
    assert.equal(reviewed.status,200);
    const review=await reviewed.json();
    assert.deepEqual(review.rows[0].custom,[{label:property.label,value:false}]);
    const body={...payload(kind,csv,review.review),mapping};
    assert.equal((await post(request,origin,headers,body)).status,201);
    const {records:[record]}=await (await request(rowsPath(kind,name),{headers})).json();
    assert.equal(record.data.custom[property.id],false);
    results.push({kind,name,record,body});
  }
  return results;
}

export async function verifyRestoredAdditionalImports({restored,origin,owner,other,imports,source,target,workspaceId}){
  for(const {kind,name,record,body} of imports){
    assert.deepEqual(await (await restored(readPath(kind,record.id),{headers:owner})).json(),record);
    assert.equal((await restored(readPath(kind,record.id),{headers:other})).status,404);
    const replay=await post(restored,origin,owner,body);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),{created:1,skipped:0});
    const {records}=await (await restored(rowsPath(kind,name),{headers:owner})).json();
    assert.deepEqual(records,[record]);
    const [eventTable,recordColumn]={contacts:['contact_events','contact_id'],companies:['company_events','company_id'],
      deals:['deal_events','deal_id']}[kind];
    const history=db=>db`SELECT actor_id,revision,data FROM ${db(eventTable)}
      WHERE workspace_id=${workspaceId} AND ${db(recordColumn)}=${record.id}`;
    const events=Array.from(await history(target));
    assert.deepEqual(events,Array.from(await history(source)));
    assert.equal(events[0].revision,1);
  }
}
