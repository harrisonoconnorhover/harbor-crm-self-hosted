import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableDormantContactLinkWrites({request,origin,headers,other,record,sql,sharing,contactId,related}){
  const send=(path,body,auth=headers)=>request(path,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const specs=[
    {kind:'deals',path:'/api/crm',table:'deals',link:'primaryContactId',column:'primary_contact_id'},
    {kind:'tasks',path:'/api/crm',table:'portable_tasks',link:'contactId',column:'contact_id'},
    {kind:'leads',path:'/api/leads',table:'portable_leads',link:'contactId',column:'contact_id'},
    {kind:'tickets',path:'/api/tickets',table:'portable_tickets',link:'contactId',column:'contact_id'},
  ].map((spec,index)=>({...spec,id:related[index].id}));
  const state=async spec=>(await sql`SELECT revision,${sql(spec.column)} AS contact_id FROM ${sql(spec.table)}
    WHERE workspace_id=${sharing.workspaceId} AND id=${spec.id}`)[0];
  const dealWrite='/api/crm?'+new URLSearchParams({workspaceId:sharing.workspaceId,grantId:sharing.grantId});
  const rule='/api/workflows',workflowId=randomUUID(),stage='Qualified to buy';
  const definition={name:'Fictional dormant-contact stage rule',pipelineId:'default',stageId:stage,
    delayMinutes:30,body:'Never queue this note for the dormant Contact'};
  assert.equal((await send(rule,{action:'save',id:workflowId,revision:0,definition})).status,200);
  assert.equal((await send(rule,{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);

  for(const spec of specs){
    const {kind,path,link,id}=spec;
    const isDeal=kind==='deals';
    const base={action:'save',...(path==='/api/crm'?{kind}:{}),data:{name:'Edited independent '+kind,
      ...(isDeal?{stage}:{}),...(kind==='tasks'?{status:'Completed'}:{})}};
    const update={...base,id,expectedRevision:1};
    assert.equal((await send(path,{...base,[link]:contactId})).status,404,'reject new dormant '+kind+' link');
    assert.equal((await send(path,{...update,[link]:contactId})).status,404,'reject explicit dormant '+kind+' link');
    if(kind==='tasks'){
      assert.equal((await send(path,{...update,related:{kind:'contacts',id:contactId}})).status,404);
    }
    assert.deepEqual({...await state(spec)},{revision:1,contact_id:contactId});
    const edited=await send(isDeal?dealWrite:path,update,isDeal?other:headers);
    assert.equal(edited.status,200,await edited.clone().text());
    const receipt=await edited.json();
    if(receipt.record)assert.equal(receipt.record[link],null);
    assert.deepEqual({...await state(spec)},{revision:2,contact_id:contactId});
  }
  const [receipt]=await sql`SELECT deal_revision,job_id,issue FROM portable_workflow_runs WHERE workflow_id=${workflowId}`;
  assert.deepEqual({...receipt},{deal_revision:2,job_id:null,issue:'missing_contact'});
  assert.equal((await sql`SELECT id FROM portable_jobs WHERE contact_id=${contactId}`).length,0);
  assert.equal((await send(rule,{action:'setEnabled',id:workflowId,revision:2,enabled:false})).status,200);

  const [,task,lead,ticket]=specs;
  const linkedDealName='Fictional conversion after replacing dormant link';
  const convert={action:'convert',id:lead.id,expectedRevision:2,dealName:linkedDealName};
  assert.equal((await send(lead.path,convert)).status,404);
  assert.deepEqual({...await state(lead)},{revision:2,contact_id:contactId});
  assert.equal((await sql`SELECT id FROM deals WHERE data->>'name'=${linkedDealName}`).length,0);

  const closed=await send(ticket.path,{action:'status',id:ticket.id,expectedRevision:2,status:'Closed'});
  assert.equal(closed.status,200,await closed.clone().text());
  assert.equal((await closed.json()).record.contactId,null);
  assert.deepEqual({...await state(ticket)},{revision:3,contact_id:contactId});
  const unlinkedTicket=await send(ticket.path,{action:'save',id:ticket.id,expectedRevision:3,contactId:null,
    data:{name:'Ticket with explicit clear',ticketStatus:'Closed'}});
  assert.equal(unlinkedTicket.status,200);
  assert.deepEqual({...await state(ticket)},{revision:4,contact_id:null});

  const taskEdit={action:'save',kind:'tasks',id:task.id,data:{name:'Task with explicit link changes'}};
  assert.equal((await send(task.path,{...taskEdit,expectedRevision:2,related:null})).status,200);
  assert.deepEqual({...await state(task)},{revision:3,contact_id:null});
  assert.equal((await send(task.path,{...taskEdit,expectedRevision:3,related:{kind:'contacts',id:record.id}})).status,200);
  assert.deepEqual({...await state(task)},{revision:4,contact_id:record.id});
  assert.equal((await send(task.path,{...taskEdit,expectedRevision:4,contactId:null})).status,200);
  assert.deepEqual({...await state(task)},{revision:5,contact_id:null});

  const replacement=await send(lead.path,{action:'save',id:lead.id,expectedRevision:2,contactId:record.id,data:{name:'Relinked lead'}});
  assert.equal(replacement.status,200,await replacement.clone().text());
  const requestConversion={...convert,expectedRevision:3};
  const converted=await send(lead.path,requestConversion);
  assert.equal(converted.status,201,await converted.clone().text());
  const {dealId}=await converted.json();
  assert.equal((await sql`SELECT primary_contact_id FROM deals WHERE id=${dealId}`)[0].primary_contact_id,record.id);
  const [source]=await sql`SELECT archived_at FROM contacts WHERE workspace_id=${sharing.workspaceId} AND id=${record.id}`;
  await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${sharing.workspaceId} AND id=${record.id}`;
  try{
    const replay=await send(lead.path,requestConversion);
    assert.equal(replay.status,200);
    assert.equal((await replay.json()).dealId,dealId);
    assert.equal((await sql`SELECT id FROM deals WHERE data->>'name'=${linkedDealName}`).length,1);
  }finally{
    await sql`UPDATE contacts SET archived_at=${source.archived_at} WHERE workspace_id=${sharing.workspaceId} AND id=${record.id}`;
  }
}
