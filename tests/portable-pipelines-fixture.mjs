import assert from 'node:assert/strict';

export async function verifyPortablePipelines({request,origin,headers,other,sql,sharing}){
  const catalog='/api/pipeline';
  const records='/api/crm?kind=deals';
  const scope='workspaceId='+sharing.workspaceId;
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const post=(path,auth,data)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(data)});
  const save=(path,auth,data)=>post(path,auth,{action:'save',kind:'deals',...data});
  const draft={name:'Expansion',stages:[
    {name:'Discovery',outcome:'open'},{name:'Renewed',outcome:'won'},{name:'Churned',outcome:'lost'},
  ]};
  assert.equal((await get(catalog,{})).status,401);
  const {pipelines:initial}=await (await get(catalog)).json();
  assert.deepEqual(initial.map(p=>p.id),['default']);
  assert.deepEqual(initial[0].stages.map(stage=>stage.probability),[20,40,60,80,90,100,0]);
  assert.equal((await post(catalog,headers,{...draft,stages:draft.stages.slice(0,2)})).status,400);
  const created=await post(catalog,headers,draft);
  assert.equal(created.status,201,await created.clone().text());
  const {pipeline}=await created.json();
  assert.equal((await post(catalog,headers,{...draft,name:'EXPANSION'})).status,409);
  const foreign=await post(catalog,other,draft);
  assert.equal(foreign.status,201);
  const {pipeline:foreignPipeline}=await foreign.json();
  assert.notEqual(foreignPipeline.id,pipeline.id);
  assert.equal((await post(catalog,other,{...draft,id:pipeline.id,expectedRevision:1})).status,404);
  assert.equal((await post(catalog+'?'+scope,other,draft)).status,403);
  assert.deepEqual((await (await get(catalog+'?'+scope,other)).json()).pipelines.map(p=>p.id),['default',pipeline.id]);
  const [first,won,lost]=pipeline.stages;
  assert.deepEqual(pipeline.stages.map(stage=>stage.probability),[50,100,0]);
  // An earlier release did not persist any probability.
  await sql`UPDATE deal_pipeline_stages SET probability=NULL WHERE workspace_id=${sharing.workspaceId} AND pipeline_id=${pipeline.id}`;
  const {pipelines:legacyCatalog}=await (await get(catalog)).json();
  assert.deepEqual(legacyCatalog.find(item=>item.id===pipeline.id),pipeline);
  const data={name:'Editor expansion deal',amount:500};
  const sharedWrite='/api/crm?'+scope+'&grantId='+sharing.grantId;
  const assigned=await save(sharedWrite,other,{data,pipelineId:pipeline.id,stageId:first.id});
  assert.equal(assigned.status,201,await assigned.clone().text());
  const {record:deal}=await assigned.json();
  assert.deepEqual([deal.pipelineId,deal.stageId,deal.stageName],[pipeline.id,first.id,'Discovery']);
  assert.equal((await save(sharedWrite,other,{data,pipelineId:pipeline.id,stageId:foreignPipeline.stages[0].id})).status,404);
  assert.equal((await save('/api/crm',headers,{data,pipelineId:foreignPipeline.id,stageId:foreignPipeline.stages[0].id})).status,404);
  await assert.rejects(sql`UPDATE deals SET stage_id=${foreignPipeline.stages[0].id} WHERE id=${deal.id}`,error=>error.code==='23503');

  const settings={name:'Account expansion',id:pipeline.id,expectedRevision:1,stages:[
    {...first,name:'Qualify expansion',probability:35},{name:'Proposal',outcome:'open'},lost,won,
  ]};
  const invalid=async (index,probability)=>post(catalog,headers,{...settings,
    stages:settings.stages.map((stage,i)=>i===index?{...stage,probability}:stage)});
  assert.equal((await invalid(0,101)).status,400);
  assert.equal((await invalid(3,90)).status,400);
  const edit=await post(catalog,headers,settings);
  assert.equal(edit.status,200);
  const {pipeline:updated}=await edit.json();
  assert.deepEqual(updated.stages.map(stage=>stage.name),['Qualify expansion','Proposal','Churned','Renewed']);
  assert.deepEqual(updated.stages.map(stage=>stage.probability),[35,50,0,100]);
  const sharedCatalog=await (await get(catalog+'?'+scope,other)).json();
  assert.deepEqual(sharedCatalog.pipelines.find(item=>item.id===pipeline.id),updated);
  assert.equal((await post(catalog,headers,settings)).status,409);
  assert.equal((await post(catalog,headers,{id:updated.id,name:updated.name,expectedRevision:updated.revision,
    stages:updated.stages.filter(stage=>stage.name!=='Proposal')})).status,400);
  const path=records+'&id='+deal.id;
  const current=await (await get(path)).json();
  assert.deepEqual([current.revision,current.pipelineName,current.stageName,current.data.stage],
    [1,'Account expansion','Qualify expansion','Discovery']);
  assert.equal((await get(path,other)).status,404);
  const filter=records+'&pipelineId='+pipeline.id+'&stage='+first.id;
  assert.deepEqual((await (await get(filter)).json()).records.map(row=>row.id),[deal.id]);
  assert.deepEqual((await (await get(filter,other)).json()).records,[]);
  assert.deepEqual((await (await get(filter+'&'+scope,other)).json()).records.map(row=>row.id),[deal.id]);
  assert.deepEqual((await (await get(records+'&pipelineId=default')).json()).records.every(row=>!row.pipelineId),true);
  const moved=await save(sharedWrite,other,{id:deal.id,expectedRevision:1,data,stageId:won.id});
  assert.equal(moved.status,200);
  const {record:finalDeal}=await moved.json();
  assert.deepEqual([finalDeal.pipelineId,finalDeal.stageId,finalDeal.stageName],[pipeline.id,won.id,'Renewed']);
  const events=await sql`SELECT previous_pipeline_id,pipeline_id,previous_stage_id,stage_id,previous,data
    FROM deal_events WHERE deal_id=${deal.id} ORDER BY revision`;
  assert.deepEqual(events.map(row=>[row.previous_pipeline_id,row.pipeline_id,row.previous_stage_id,row.stage_id,row.previous?.stage,row.data.stage]),[
    [null,pipeline.id,null,first.id,undefined,'Discovery'],[pipeline.id,pipeline.id,first.id,won.id,'Discovery','Renewed'],
  ]);
  sharing.pipeline=updated;
  sharing.pipelineDeal=finalDeal;
}
