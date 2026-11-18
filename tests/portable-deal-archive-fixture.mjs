import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const archivePath='/api/recycle-bin';
const crm='/api/crm';
const change=(record,action)=>({kind:'deals',id:record.id,expectedRevision:record.revision,action,requestId:randomUUID()});

export async function verifyPortableDealArchive({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId,shared='&workspaceId='+workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const send=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const receipt=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return (await response.json()).receipt;
  };
  const json=async path=>{
    const response=await get(path);
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const save=async(path,body,status=201)=>{
    const response=await send(path,{action:'save',...body});
    assert.equal(response.status,status,await response.clone().text());
    const result=await response.json();
    return result.record??result;
  };

  const name='Archived fictional Deal '+randomUUID();
  const buyer=await save(crm,{kind:'contacts',data:{name:'Deal archive buyer',email:'deal-archive-buyer@example.test'}});
  let deal=await save(crm,{kind:'deals',primaryContactId:buyer.id,data:{name}});
  const id=deal.id;
  const item={id:randomUUID(),name:'Fictional archived-deal charge',sku:'',description:'',unitPriceCents:4200,
    billingFrequency:'one_time',termPayments:null,quantity:1,discountBps:0};
  assert.equal((await send('/api/deal-line-items',{dealId:id,revision:0,expectedUpdatedAt:deal.updatedAt,expectedAmount:0,
    updateAmount:false,items:[item]})).status,200);
  deal=await json(crm+'?kind=deals&id='+id);
  const quoteId=randomUUID();
  assert.equal((await send('/api/quotes',{action:'create',id:quoteId,dealId:id,expectedUpdatedAt:deal.updatedAt,lineRevision:1})).status,200);
  assert.equal((await send('/api/quotes',{action:'publish',id:quoteId,revision:1})).status,200);
  const task=await save(crm,{kind:'tasks',related:{kind:'deals',id},data:{name:'Deal archive linked task'}});
  const lead=await save('/api/leads',{contactId:buyer.id,data:{name:'Deal archive converted lead'}});
  const converted=await send('/api/leads',{action:'convert',id:lead.id,expectedRevision:lead.revision??1,dealName:'Deal archive converted deal'});
  assert.equal(converted.status,201,await converted.clone().text());
  const convertedDealId=(await converted.json()).dealId;
  const associationPath='/api/associations?'+new URLSearchParams({kind:'contacts',id:buyer.id});
  assert.equal((await send(associationPath,{action:'link',target:{kind:'deals',id},labels:['Fictional']})).status,200);
  const activityPath='/api/logged-activities?'+new URLSearchParams({kind:'deals',recordId:id});
  const activityId=randomUUID(),occurredAt=Date.now()-1000;
  assert.equal((await send(activityPath,{id:activityId,kind:'Note',occurredAt,summary:'Archived Deal retained activity'})).status,201);

  const detail=crm+'?kind=deals&id='+id,history=crm+'?kind=deals&history='+id+'&field=name';
  const search=crm+'?'+new URLSearchParams({kind:'deals',search:name});
  const postSearch=()=>send('/api/crm/search',{kind:'deals',query:name});
  const report=async()=>{
    const response=await send('/api/reporting',{action:'preview',definition:{name:'Deal archive counts',kind:'deals'}});
    assert.equal(response.status,200);
    return Number((await response.json()).result.total);
  };
  const linesPath='/api/deal-line-items?dealId='+id;
  const invoicePreview=(source,sourceId)=>'/api/invoices?'+new URLSearchParams({source,sourceId,recurring:'exclude'});
  assert.equal((await get(detail+shared,other)).status,200);
  assert.equal((await get(history)).status,200);
  assert.equal((await get(activityPath)).status,200);
  assert.equal((await get(linesPath)).status,200);
  assert.equal((await get(invoicePreview('deal',id))).status,200);
  assert.equal((await get(invoicePreview('quote',quoteId))).status,200);
  assert.equal((await json(search)).records[0].id,id);
  assert.equal((await (await postSearch()).json()).counts.deals,1);
  assert.equal((await json(crm+'?kind=tasks&id='+task.id)).dealId,id);
  const reportBefore=await report();

  const editor=await get('/?'+new URLSearchParams({kind:'deals',record:id}));
  assert.equal(editor.status,200);
  assert.match(await editor.text(),/Archive deal/);
  const binPage=await get('/?view=recycle-bin&kind=deals');
  assert.equal(binPage.status,200);
  assert.match(await binPage.text(),/Loading archived deals/);

  // A delayed stage-workflow Note for the Deal's Contact blocks archive until resolved.
  const rule='/api/workflows',workflowId=randomUUID(),stage='Qualified to buy';
  assert.equal((await send(rule,{action:'save',id:workflowId,revision:0,definition:{name:'Fictional deal archive rule',
    pipelineId:'default',stageId:stage,delayMinutes:30,body:'Fictional pending Note before Deal archive'}})).status,200);
  assert.equal((await send(rule,{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
  deal=await save(crm,{kind:'deals',id,expectedRevision:deal.revision,data:{name,stage}},200);
  assert.equal((await send(rule,{action:'setEnabled',id:workflowId,revision:2,enabled:false})).status,200);
  const [run]=await sql`SELECT job_id FROM portable_workflow_runs WHERE workflow_id=${workflowId} AND deal_id=${id}`;
  assert.ok(run?.job_id,'stage workflow queued a Note');
  const archive={...change(deal,'archive'),requestId:'00000000-0000-4000-8000-0000000000d1'};
  const pending=await send(archivePath,archive);
  assert.equal(pending.status,409);
  assert.match((await pending.json()).error,/pending workflow jobs/);
  assert.equal((await send('/api/background-jobs?recordId='+buyer.id,{action:'cancelNote',id:run.job_id})).status,200);
  // Free the workflow slot: later fixtures fill the 20-workflow workspace cap.
  await sql`DELETE FROM portable_workflow_runs WHERE workflow_id=${workflowId}`;
  await sql`DELETE FROM portable_workflow_activations WHERE workflow_id=${workflowId}`;
  await sql`DELETE FROM portable_deal_workflows WHERE id=${workflowId}`;

  assert.equal((await request(archivePath+'?kind=deals')).status,401);
  assert.equal((await send(archivePath,archive,other)).status,404);
  assert.equal((await send(archivePath,archive,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(archivePath,{...archive,expectedRevision:deal.revision+1})).status,409);
  await sql`ALTER TABLE portable_deal_archive_receipts ADD CONSTRAINT fixture_deal_archive_fail CHECK (request_id<>'00000000-0000-4000-8000-0000000000d1'::uuid)`;
  try{
    assert.equal((await send(archivePath,archive)).status,503);
    assert.equal((await json(detail)).revision,deal.revision);
  }finally{await sql`ALTER TABLE portable_deal_archive_receipts DROP CONSTRAINT fixture_deal_archive_fail`;}

  const archived=await receipt(await send(archivePath,archive));
  assert.deepEqual([archived.id,archived.action,archived.revision],[id,'archive',deal.revision+1]);
  assert.deepEqual(await receipt(await send(archivePath,archive)),archived);
  assert.equal((await send(archivePath,{...archive,action:'restore'})).status,409);
  assert.ok((await json(archivePath+'?kind=deals')).records.some(row=>row.id===id&&row.archivedAt===archived.archivedAt));
  assert.ok(!(await (await get(archivePath+'?kind=deals',other)).json()).records.some(row=>row.id===id));

  for(const path of [detail,history,activityPath,linesPath,invoicePreview('deal',id),'/api/associations?'+new URLSearchParams({kind:'deals',id})]){
    assert.equal((await get(path)).status,404,path);
  }
  assert.equal((await get(invoicePreview('quote',quoteId))).status,409);
  assert.equal((await get(detail+shared,other)).status,404);
  assert.deepEqual((await json(search)).records,[]);
  assert.equal((await (await postSearch()).json()).counts.deals,0);
  assert.equal(await report(),reportBefore-1);
  assert.deepEqual((await json(associationPath)).items,[]);
  assert.deepEqual((await json(crm+'?kind=deals&primaryContactId='+buyer.id)).records.map(row=>row.id).filter(row=>row===id),[]);
  assert.equal((await json('/api/quotes?id='+quoteId)).quote.id,quoteId,'existing quotes stay readable');
  assert.equal((await send(crm,{action:'save',kind:'deals',id,expectedRevision:archived.revision,data:{name:'Stale archived edit'}})).status,404);
  assert.equal((await send('/api/deal-line-items',{dealId:id,revision:1,expectedUpdatedAt:deal.updatedAt,expectedAmount:0,
    updateAmount:false,items:[]})).status,404);
  assert.equal((await send('/api/quotes',{action:'create',id:randomUUID(),dealId:id,expectedUpdatedAt:deal.updatedAt,lineRevision:1})).status,404);
  assert.equal((await send(activityPath,{id:randomUUID(),kind:'Note',occurredAt,summary:'Stale log'})).status,404);
  assert.equal((await send(associationPath,{action:'link',target:{kind:'deals',id},labels:['Other']})).status,404);

  // The Task keeps its dormant Deal link across edits and refuses a new one.
  const stored=async()=>(await sql`SELECT revision,deal_id FROM portable_tasks WHERE workspace_id=${workspaceId} AND id=${task.id}`)[0];
  const linked=await json(crm+'?kind=tasks&id='+task.id);
  assert.deepEqual([linked.dealId,linked.dealName],[null,null]);
  assert.deepEqual((await json(crm+'?kind=tasks&dealId='+id)).records,[]);
  const before=await stored();
  const taskEdit={action:'save',kind:'tasks',id:task.id,expectedRevision:before.revision,data:{name:'Edited beside an archived Deal'}};
  assert.equal((await send(crm,{...taskEdit,related:{kind:'deals',id}})).status,404);
  assert.equal((await send(crm,{action:'save',kind:'tasks',related:{kind:'deals',id},data:{name:'New link to archived Deal'}})).status,404);
  assert.equal((await send(crm,taskEdit)).status,200);
  assert.deepEqual({...await stored()},{revision:before.revision+1,deal_id:id});
  // A legacy contact clear keeps the dormant Deal link instead of re-requesting it.
  assert.equal((await send(crm,{...taskEdit,expectedRevision:before.revision+1,contactId:null})).status,200);
  assert.deepEqual({...await stored()},{revision:before.revision+2,deal_id:id});

  // A converted Lead points to its archived Deal through the Recycle Bin.
  const convertedArchive=await json(crm+'?kind=deals&id='+convertedDealId);
  await receipt(await send(archivePath,change(convertedArchive,'archive')));
  const leadRecord=await json('/api/leads?id='+lead.id);
  assert.deepEqual([leadRecord.dealId,leadRecord.dealArchived],[convertedDealId,true]);
  const reconvert=await send('/api/leads',{action:'convert',id:lead.id,expectedRevision:leadRecord.revision,dealName:'Second conversion'});
  assert.equal(reconvert.status,200);
  assert.deepEqual(await reconvert.json(),{id:lead.id,dealId:convertedDealId,created:false});

  const restored=await receipt(await send(archivePath,change(archived,'restore')));
  assert.deepEqual(restored,{id,action:'restore',revision:deal.revision+2,archivedAt:null});
  const visible=await json(detail);
  assert.deepEqual([visible.id,visible.revision,visible.data.name],[id,restored.revision,name]);
  assert.deepEqual((await json(crm+'?kind=tasks&id='+task.id)).dealId,id);
  assert.deepEqual((await json(associationPath)).items.map(row=>row.target.id),[id]);
  assert.equal((await get(linesPath)).status,200);
  assert.equal((await get(invoicePreview('quote',quoteId))).status,200);
  // The converted Lead's Deal stays archived.
  assert.equal(await report(),reportBefore-1);
  const events=(await sql`SELECT revision FROM deal_events WHERE deal_id=${id} ORDER BY revision`).map(row=>row.revision);
  assert.deepEqual(events.slice(-2),[restored.revision-1,restored.revision]);

  // Leave one archived Deal with line items and a linked Task for the second-instance restore.
  const recoveryDeal=await save(crm,{kind:'deals',data:{name:'Fictional recovered Deal '+randomUUID(),amount:0}});
  assert.equal((await send('/api/deal-line-items',{dealId:recoveryDeal.id,revision:0,expectedUpdatedAt:recoveryDeal.updatedAt,
    expectedAmount:0,updateAmount:false,items:[{...item,id:randomUUID()}]})).status,200);
  const recoveryTask=await save(crm,{kind:'tasks',related:{kind:'deals',id:recoveryDeal.id},data:{name:'Recovered Deal task'}});
  const current=await json(crm+'?kind=deals&id='+recoveryDeal.id);
  const recoveryArchive=change(current,'archive');
  const recoveryReceipt=await receipt(await send(archivePath,recoveryArchive));
  await reset();
  return {archive:recoveryArchive,receipt:recoveryReceipt,deal:current,taskId:recoveryTask.id};
}

export async function verifyRestoredPortableDealArchive({restored,origin,owner,other,source,sourceOwner,fixture}){
  const send=(input,auth=owner)=>restored(archivePath,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(input)});
  const read=async(path,auth=owner)=>{
    const response=await restored(path,{headers:auth});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const receipt=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).receipt;
  };
  const id=fixture.deal.id,detail=crm+'?kind=deals&id='+id,task=crm+'?kind=tasks&id='+fixture.taskId;
  const lines='/api/deal-line-items?dealId='+id;
  // The restored database carries the receipt, the archived state, line items and the retained Task link.
  assert.deepEqual(await receipt(await send(fixture.archive)),fixture.receipt);
  assert.equal((await restored(detail,{headers:owner})).status,404);
  assert.equal((await restored(lines,{headers:owner})).status,404);
  assert.ok((await read(archivePath+'?kind=deals')).records.some(row=>row.id===id));
  assert.equal((await read(task)).dealId,null);
  assert.equal((await send(change(fixture.receipt,'restore'),other)).status,404);
  const result=await receipt(await send(change(fixture.receipt,'restore')));
  assert.deepEqual(result,{id,action:'restore',revision:fixture.receipt.revision+1,archivedAt:null});
  const visible=await read(detail);
  assert.deepEqual([visible.id,visible.revision,visible.data.name],[id,result.revision,fixture.deal.data.name]);
  assert.equal((await read(lines)).items.length,1);
  assert.equal((await read(task)).dealId,id);
  // The source instance stays independent of the restored copy.
  assert.equal((await source(detail,{headers:sourceOwner})).status,404);
}
