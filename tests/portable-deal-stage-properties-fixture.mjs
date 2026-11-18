import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const settings='/api/pipeline',crm='/api/crm',imports='/api/crm/import',workflows='/api/workflows';
const rules=[{field:'closeDate',required:true},{field:'nextStep',required:true}];
const expectedFields=[{field:'closeDate',label:'Close date'},{field:'nextStep',label:'Next step'}];
const post=(request,origin,headers,path,body)=>request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
  body:JSON.stringify(body)});

export async function verifyPortableDealStageProperties({request,origin,headers,other,sql,sharing,contact}){
  const send=(path,body,auth=headers)=>post(request,origin,auth,path,body);
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const save=(data,auth=headers,path=crm)=>send(path,{action:'save',kind:'deals',...data},auth);
  const scoped=crm+'?'+new URLSearchParams({workspaceId:sharing.workspaceId,grantId:sharing.grantId});
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const name='Fictional required properties';
  const stages=[{name:'Working',outcome:'open'},{name:'Accepted',outcome:'won'},{name:'Passed',outcome:'lost'}];
  assert.equal((await send(settings,{name,stages:[stages[0],{...stages[1],requiredProperties:[{field:'owner',required:true}]},stages[2]]})).status,400);
  const created=await send(settings,{name,stages});
  assert.equal(created.status,201,await created.clone().text());
  const {pipeline}=await created.json();
  const [working,accepted]=pipeline.stages;
  const draft={pipelineId:pipeline.id,stageId:accepted.id,data:{name:'Fictional legacy accepted deal'}};
  const old=await save(draft);
  assert.equal(old.status,201);
  const {record:legacy}=await old.json();
  const newDeal=await save({pipelineId:pipeline.id,stageId:working.id,data:{name:'Fictional board move'},primaryContactId:contact.id});
  assert.equal(newDeal.status,201);
  const {record:card}=await newDeal.json();

  const csv='Name,Pipeline,Deal stage\nFictional imported deal,'+name+',Accepted';
  const preview=async value=>{
    const response=await send(imports,{action:'preview',kind:'deals',csv:value});
    assert.equal(response.status,200);
    return response.json();
  };
  const before=await preview(csv);
  assert.equal(before.created,1);
  const setting={id:pipeline.id,name,expectedRevision:1,
    stages:pipeline.stages.map(stage=>stage.id===accepted.id?{...stage,requiredProperties:rules}:{...stage,...(stage.id===working.id?{probability:33}:{})})};
  assert.equal((await send(settings+'?workspaceId='+sharing.workspaceId,setting,other)).status,403);
  const set=await send(settings,setting);
  assert.equal(set.status,200,await set.clone().text());
  assert.equal((await send(settings,setting)).status,409);
  const {pipeline:configured}=await set.json();
  assert.deepEqual(configured.stages[1].requiredProperties,rules);
  // Older catalog clients do not send the new property and must not erase it.
  const oldClient={...setting,expectedRevision:configured.revision,
    stages:configured.stages.map(({id,name,outcome})=>({id,name,outcome}))};
  const preserved=await send(settings,oldClient);
  assert.equal(preserved.status,200,await preserved.clone().text());
  const {pipeline:currentPipeline}=await preserved.json();
  assert.deepEqual(currentPipeline.stages[1].requiredProperties,rules);
  assert.equal(currentPipeline.stages[0].probability,33);
  assert.equal((await save({...draft,id:legacy.id,expectedRevision:1,data:{name:'Unrelated legacy edit'}})).status,200);

  const rejected=await save({...draft,data:{name:'Fictional invalid create'}});
  assert.equal(rejected.status,400);
  assert.deepEqual((await rejected.json()).fields,expectedFields);
  const staleImport=await send(imports,{action:'import',kind:'deals',csv,review:before.review,requestId:randomUUID()});
  assert.equal(staleImport.status,409);
  const required=await preview(csv);
  assert.equal(required.errors,1);
  assert.match(required.rows[0].message,/Close date, Next step/);
  assert.equal((await send(imports,{action:'import',kind:'deals',csv,review:required.review,requestId:randomUUID()})).status,400);

  const workflowId=randomUUID();
  const definition={name:'Fictional stage rule workflow',pipelineId:pipeline.id,stageId:accepted.id,delayMinutes:30,body:'Fictional note after required stage'};
  assert.equal((await send(workflows,{action:'save',id:workflowId,revision:0,definition})).status,200);
  assert.equal((await send(workflows,{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
  const runs=()=>sql`SELECT j.actor_id FROM portable_workflow_runs r JOIN portable_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id WHERE r.workflow_id=${workflowId}`;
  const events=()=>sql`SELECT revision FROM deal_events WHERE deal_id=${card.id} ORDER BY revision`;
  const move={id:card.id,expectedRevision:card.revision,stageId:accepted.id,data:{...card.data,stage:accepted.name}};
  const boardMove=await save(move,other,scoped);
  assert.equal(boardMove.status,400,await boardMove.clone().text());
  assert.deepEqual((await boardMove.json()).fields,expectedFields);
  assert.deepEqual((await events()).map(row=>row.revision),[1]);
  assert.equal((await runs()).length,0);

  const complete={...move,data:{...move.data,closeDate:'2026-12-31',nextStep:'Send fictional follow-up'}};
  const moved=await save(complete,other,scoped);
  assert.equal(moved.status,200,await moved.clone().text());
  const {record:acceptedDeal}=await moved.json();
  assert.equal(acceptedDeal.stageId,accepted.id);
  assert.equal(acceptedDeal.data.closeDate,'2026-12-31');
  assert.deepEqual((await events()).map(row=>row.revision),[1,2]);
  const [editor]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  assert.deepEqual(Array.from(await runs()),[{actor_id:editor.id}]);
  assert.equal((await send(workflows,{action:'setEnabled',id:workflowId,revision:2,enabled:false})).status,200);

  const erase={id:acceptedDeal.id,expectedRevision:acceptedDeal.revision,data:{...acceptedDeal.data,nextStep:''}};
  const erased=await save(erase);
  assert.equal(erased.status,400);
  assert.deepEqual((await erased.json()).fields,[expectedFields[1]]);
  const goodCsv='Name,Pipeline,Deal stage,Close date,Next step\nFictional valid import,'+name+',Accepted,2026-12-31,Check terms';
  const ready=await preview(goodCsv);
  assert.equal(ready.created,1,JSON.stringify(ready.rows));
  assert.equal((await send(imports,{action:'import',kind:'deals',csv:goodCsv,review:ready.review,requestId:randomUUID()})).status,201);
  assert.equal((await runs()).length,1,'Import still does not enroll a Deal stage workflow.');
  assert.equal((await get('/?kind=deals&view=board&pipelineId='+pipeline.id+'&workspaceId='+sharing.workspaceId,other)).status,200);
  await reset();
  const property=async (kind,label,auth=headers)=>{
    const response=await send('/api/custom-properties',{action:'create',kind,label,type:'number'},auth);
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).property;
  };
  const score=await property('deals','Fictional handoff score');
  await property('deals','Name');
  const collision=await send(imports,{action:'columns',kind:'deals',
    csv:'Name,Deal Name,Fictional handoff score\nFictional deal,Other name,0'});
  assert.equal(collision.status,200);
  assert.deepEqual((await collision.json()).columns.map(column=>column.target),['name','','custom:'+score.id]);
  const wrongKind=await property('contacts','Fictional contact score');
  const foreign=await property('deals','Fictional foreign score',other);
  const settingWithCustom=id=>({...oldClient,expectedRevision:currentPipeline.revision,
    stages:currentPipeline.stages.map(stage=>stage.id===accepted.id
      ?{...stage,requiredProperties:[...rules,{field:'custom:'+id,required:true}]}:stage)});
  for(const id of [wrongKind.id,foreign.id,randomUUID()]){
    const denied=await send(settings,settingWithCustom(id));
    assert.equal(denied.status,400);
    assert.match((await denied.json()).error,/this workspace/);
  }
  const withCustom=await send(settings,settingWithCustom(score.id));
  assert.equal(withCustom.status,200,await withCustom.clone().text());
  const {pipeline:customPipeline}=await withCustom.json();
  const expectedCustom=[{field:'custom:'+score.id,label:score.label}];
  const stillRequired=await preview(goodCsv);
  assert.equal(stillRequired.errors,1);
  assert.match(stillRequired.rows[0].message,/Fictional handoff score/);
  assert.equal((await send(imports,{action:'import',kind:'deals',csv:goodCsv,review:ready.review,requestId:randomUUID()})).status,409);
  const workingDeal=(await (await save({pipelineId:pipeline.id,stageId:working.id,data:{name:'Fictional custom handoff'}})).json()).record;
  const customMove={...complete,id:workingDeal.id,expectedRevision:workingDeal.revision};
  const missingCustom=await save(customMove,other,scoped);
  assert.equal(missingCustom.status,400);
  assert.deepEqual((await missingCustom.json()).fields,expectedCustom);
  const customMoved=await save({...customMove,data:{...customMove.data,custom:{[score.id]:0}}},other,scoped);
  assert.equal(customMoved.status,200,await customMoved.clone().text());
  const {record:customDeal}=await customMoved.json();
  assert.equal(customDeal.data.custom[score.id],0);
  const eraseCustom={id:customDeal.id,expectedRevision:customDeal.revision,data:{...customDeal.data,custom:{[score.id]:null}}};
  const deniedClear=await save(eraseCustom);
  assert.equal(deniedClear.status,400);
  assert.deepEqual((await deniedClear.json()).fields,expectedCustom);
  assert.equal((await save({...draft,data:{name:'Fictional missing custom value',closeDate:'2026-12-31',nextStep:'Call'}})).status,400);
  await reset();
  const customCsv=`Name,Pipeline,Deal stage,Close date,Next step,${score.label}\nFictional custom CSV deal,${name},Accepted,2026-12-31,Call,0`;
  const mapped=await send(imports,{action:'columns',kind:'deals',csv:customCsv});
  assert.equal(mapped.status,200);
  const mapping=(await mapped.json()).columns.map(column=>column.target);
  assert.deepEqual(mapping,['name','pipelineId','stage','closeDate','nextStep','custom:'+score.id]);
  assert.equal((await preview(customCsv)).errors,1,'Legacy automatic mapping still ignores custom headers');
  for(const foreignMapping of [wrongKind.id,foreign.id]){
    assert.equal((await send(imports,{action:'preview',kind:'deals',csv:customCsv,
      mapping:[...mapping.slice(0,-1),'custom:'+foreignMapping]})).status,400);
  }
  const customPreview=async csv=>{
    const response=await send(imports,{action:'preview',kind:'deals',csv,mapping});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  assert.equal((await customPreview(customCsv.replace(/,0$/,',invalid'))).errors,1);
  const selected=await customPreview(customCsv);
  assert.equal(selected.created,1);
  assert.deepEqual(selected.rows[0].custom,[{label:score.label,value:0}]);
  const rename=await send('/api/custom-properties',{action:'rename',kind:'deals',id:score.id,
    label:'Fictional revised handoff score',expectedRevision:score.revision});
  assert.equal(rename.status,200,await rename.clone().text());
  const renamed=(await rename.json()).property;
  const customImport={action:'import',kind:'deals',csv:customCsv,mapping,review:selected.review,requestId:randomUUID()};
  assert.equal((await send(imports,customImport)).status,409);
  const fresh=await customPreview(customCsv);
  assert.deepEqual(fresh.rows[0].custom,[{label:renamed.label,value:0}]);
  const committed={...customImport,review:fresh.review};
  assert.equal((await send(imports,committed)).status,201);
  assert.equal((await send(imports,committed)).status,200);
  const imported=await (await get(crm+'?kind=deals&search=Fictional+custom+CSV+deal')).json();
  assert.equal(imported.records.length,1);
  assert.equal(imported.records[0].data.custom[score.id],0);
  assert.equal(imported.records[0].stageId,accepted.id);
  await reset();
  return {pipeline:customPipeline,deal:customDeal,erase:eraseCustom,
    expected:[{field:'custom:'+score.id,label:renamed.label}],imported:imported.records[0],importRequest:committed};
}

export async function verifyRestoredPortableDealStageProperties({request,origin,owner,other,fixture}){
  const catalog=await (await request(settings,{headers:owner})).json();
  assert.deepEqual(catalog.pipelines.find(item=>item.id===fixture.pipeline.id),fixture.pipeline);
  const query=crm+'?kind=deals&id='+fixture.deal.id;
  assert.deepEqual(await (await request(query,{headers:owner})).json(),fixture.deal);
  assert.equal((await request(query,{headers:other})).status,404);
  const denied=await post(request,origin,owner,crm,{action:'save',kind:'deals',...fixture.erase});
  assert.equal(denied.status,400);
  assert.deepEqual((await denied.json()).fields,fixture.expected);
  const restoredImport=await request(crm+'?kind=deals&id='+fixture.imported.id,{headers:owner});
  assert.deepEqual(await restoredImport.json(),fixture.imported);
  assert.equal((await post(request,origin,owner,imports,fixture.importRequest)).status,200);
}
