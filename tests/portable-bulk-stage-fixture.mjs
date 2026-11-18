import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const crm='/api/crm';

export async function verifyPortableBulkStage({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const json=async path=>{
    const response=await request(path,{headers});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const save=async body=>{
    const response=await send(crm,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const read=id=>json(crm+'?'+new URLSearchParams({kind:'deals',id}));
  const pick=rows=>rows.map(row=>({id:row.id,expectedRevision:row.revision}));
  const move=async(rows,value,mode='replace',auth=headers,path=crm)=>{
    const response=await send(path,{action:'editProperty',kind:'deals',field:'stage',mode,value,records:pick(rows)},auth);
    return {status:response.status,body:await response.json()};
  };
  const marker='Bulk stage '+randomUUID();
  const builtin=[];
  for(const n of [1,2,3])builtin.push(await save({kind:'deals',data:{name:marker+' '+n,stage:'Appointment scheduled'}}));

  // Private bulk moves keep history but only shared bulk moves capture workflows.
  const rule='/api/workflows',workflowId=randomUUID();
  assert.equal((await send(rule,{action:'save',id:workflowId,revision:0,definition:{name:'Fictional bulk stage rule',
    pipelineId:'default',stageId:'Presentation scheduled',delayMinutes:30,body:'Fictional bulk stage Note'}})).status,200);
  assert.equal((await send(rule,{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
  const runs=()=>sql`SELECT deal_id,deal_revision,issue FROM portable_workflow_runs
    WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId} ORDER BY deal_id`;
  try{
    assert.equal((await move(builtin,'Not a stage')).status,400);
    assert.equal((await move(builtin,'Presentation scheduled','clear')).status,400);
    assert.deepEqual((await Promise.all(builtin.map(row=>read(row.id)))).map(row=>[row.revision,row.data.stage]),
      builtin.map(row=>[row.revision,'Appointment scheduled']));
    assert.deepEqual(await move(builtin,'Presentation scheduled'),{status:200,body:{changed:3}});
    const moved=await Promise.all(builtin.map(row=>read(row.id)));
    for(const [index,row] of moved.entries()){
      assert.deepEqual([row.revision,row.data.stage,row.data.name,row.pipelineId],[builtin[index].revision+1,'Presentation scheduled',builtin[index].data.name,null]);
    }
    assert.deepEqual(Array.from(await runs()),[]);
    assert.deepEqual(await move(moved,'Presentation scheduled'),{status:200,body:{changed:0}});

    // A selection spanning pipelines is refused; a custom-pipeline selection moves by stage ID.
    const {pipeline}=sharing;
    const [first,...rest]=pipeline.stages;
    const target=rest.find(stage=>!stage.requiredProperties?.length&&stage.outcome==='open')??rest.find(stage=>!stage.requiredProperties?.length);
    assert.ok(target,'The shared custom pipeline has a stage without required properties.');
    const custom=[await save({kind:'deals',pipelineId:pipeline.id,stageId:first.id,data:{name:marker+' custom 1'}}),
      await save({kind:'deals',pipelineId:pipeline.id,stageId:first.id,data:{name:marker+' custom 2'}})];
    const mixed=await move([moved[0],custom[0]],target.id);
    assert.equal(mixed.status,400);
    assert.match(mixed.body.error,/different pipelines/);
    assert.equal((await move(custom,'Presentation scheduled')).status,400,'a built-in stage is not in the custom pipeline');
    assert.deepEqual(await move(custom,target.id),{status:200,body:{changed:2}});
    const customPlaced=await Promise.all(custom.map(row=>read(row.id)));
    for(const deal of customPlaced){
      assert.deepEqual([deal.pipelineId,deal.stageId,deal.stageName],[pipeline.id,target.id,target.name]);
    }
    assert.deepEqual(await move(customPlaced,target.id.toUpperCase()),{status:200,body:{changed:0}});

    // Pipeline and stage together move deals across pipelines, including a mixed selection.
    const across=async(rows,value,auth=headers,path=crm)=>{
      const response=await send(path,{action:'editProperty',kind:'deals',field:'pipeline',mode:'replace',value,records:pick(rows)},auth);
      return {status:response.status,body:await response.json()};
    };
    let current=await Promise.all(builtin.map(row=>read(row.id)));
    for(const value of ['default/Not a stage',pipeline.id+'/Presentation scheduled','default',pipeline.id+'/'+randomUUID()]){
      assert.equal((await across(current,value)).status,400,value);
    }
    assert.deepEqual(await across(current,pipeline.id+'/'+target.id),{status:200,body:{changed:3}});
    current=await Promise.all(builtin.map(row=>read(row.id)));
    assert.ok(current.every(deal=>deal.pipelineId===pipeline.id&&deal.stageId===target.id));
    assert.deepEqual(await across(current,(pipeline.id+'/'+target.id).toUpperCase()),{status:200,body:{changed:0}});
    assert.deepEqual((await Promise.all([...customPlaced,...current].map(row=>read(row.id)))).map(row=>row.revision),
      [...customPlaced,...current].map(row=>row.revision));
    const [event]=await sql`SELECT previous_pipeline_id,pipeline_id,stage_id FROM deal_events WHERE deal_id=${current[0].id} AND revision=${current[0].revision}`;
    assert.deepEqual({...event},{previous_pipeline_id:null,pipeline_id:pipeline.id,stage_id:target.id});
    const mixed2=[current[0],...await Promise.all(custom.map(row=>read(row.id)))];
    await sql`UPDATE deals SET pipeline_id=NULL,stage_id=NULL,data=jsonb_set(data,'{stage}','"Qualified to buy"') WHERE id=${mixed2[1].id}`;
    mixed2[1]=await read(mixed2[1].id);
    assert.deepEqual(await across(mixed2,'default/Qualified to buy'),{status:200,body:{changed:2}},'the deal already there is skipped');
    for(const deal of await Promise.all(mixed2.map(row=>read(row.id)))){
      assert.deepEqual([deal.pipelineId,deal.data.stage],[null,'Qualified to buy']);
    }

    assert.deepEqual(await across([current[2]],'default/Presentation scheduled'),{status:200,body:{changed:1}});
    assert.deepEqual(Array.from(await runs()),[],'private cross-pipeline moves do not capture workflows');
    const scoped=crm+'?'+new URLSearchParams({workspaceId,grantId:sharing.grantId});
    const sharedStage=await read(current[0].id),sharedPipeline=await read(current[1].id);
    assert.deepEqual(await move([sharedStage],'Presentation scheduled','replace',other,scoped),{status:200,body:{changed:1}});
    assert.deepEqual(await across([sharedPipeline],'default/Presentation scheduled',other,scoped),{status:200,body:{changed:1}});
    assert.deepEqual(await move([await read(sharedStage.id)],'Presentation scheduled','replace',other,scoped),{status:200,body:{changed:0}});
    const receipts=(await runs()).map(run=>[run.deal_id,run.deal_revision,run.issue]);
    assert.deepEqual(receipts,[sharedStage,sharedPipeline].sort((a,b)=>a.id.localeCompare(b.id))
      .map(row=>[row.id,row.revision+1,'missing_contact']));
  }finally{
    await sql`DELETE FROM portable_workflow_runs WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await sql`DELETE FROM portable_workflow_activations WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await sql`DELETE FROM portable_deal_workflows WHERE workspace_id=${workspaceId} AND id=${workflowId}`;
  }
  await reset();
}
