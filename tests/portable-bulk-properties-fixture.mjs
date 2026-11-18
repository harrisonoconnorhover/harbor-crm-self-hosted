import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const crm='/api/crm';

export async function verifyPortableBulkProperties({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers)=>request(path,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
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
  const read=(kind,id)=>json(crm+'?'+new URLSearchParams({kind,id}));
  const current=(kind,rows)=>Promise.all(rows.map(row=>read(kind,row.id)));
  const pick=rows=>rows.map(row=>({id:row.id,expectedRevision:row.revision}));
  const edit=async(kind,rows,field,mode,value,auth=headers,path=crm)=>{
    const response=await send(path,{action:'editProperty',kind,field,mode,...(value===undefined?{}:{value}),records:pick(rows)},auth);
    return {status:response.status,body:await response.json()};
  };
  const [{id:ownerId}]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  const [{id:memberId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;

  const marker='Bulk property '+randomUUID();
  const contacts=[];
  for(const n of [1,2,3])contacts.push(await save({kind:'contacts',data:{name:marker+' contact '+n,email:'bulk-'+n+'-'+randomUUID().slice(0,8)+'@example.test',lifecycle:'Lead'}}));
  const deals=[await save({kind:'deals',data:{name:marker+' deal 1',amount:100,stage:'Qualified to buy'}}),
    await save({kind:'deals',data:{name:marker+' deal 2',amount:100,stage:'Qualified to buy'}})];
  const created=await send('/api/custom-properties',{action:'create',kind:'contacts',label:marker+' tags',type:'multiselect',options:['North','South','East']});
  assert.equal(created.status,201,await created.clone().text());
  const tags=(await created.json()).property;
  const tagField='custom:'+tags.id;
  const workflowId=randomUUID(),workflows='/api/workflows';
  const runs=()=>sql`SELECT r.contact_id,r.contact_revision,r.job_id,j.actor_id,j.kind,j.status FROM portable_workflow_runs r
    LEFT JOIN portable_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
    WHERE r.workspace_id=${workspaceId} AND r.workflow_id=${workflowId}`;
  let reviewTime;
  try{
    assert.equal((await send(workflows,{action:'save',id:workflowId,revision:0,definition:{
      name:marker+' lifecycle workflow',trigger:'contact_lifecycle',lifecycle:'Customer',
      delayMinutes:30,body:'Review the fictional customer’s onboarding.',
    }})).status,200);
    assert.equal((await send(workflows,{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
    // Fields that identify a record, unknown fields and invalid values change nothing.
    for(const [kind,rows,field] of [['contacts',contacts,'name'],['contacts',contacts,'email'],['deals',deals,'stage'],
      ['contacts',contacts,'notAField'],['contacts',contacts,'custom:not-a-uuid'],['contacts',contacts,'custom:'+randomUUID()]]){
      assert.equal((await edit(kind,rows,field,'replace','Changed')).status,400,kind+' '+field);
    }
    assert.equal((await edit('contacts',contacts,'lifecycle','replace','Not a stage')).status,400);
    assert.equal((await edit('contacts',contacts,'lifecycle','append',['Customer'])).status,400);
    assert.equal((await edit('contacts',contacts,'lifecycle','clear')).status,400,'lifecycle has no empty value');
    const stale=contacts.map((row,index)=>index===2?{...row,revision:row.revision+1}:row);
    assert.equal((await edit('contacts',stale,'lifecycle','replace','Customer')).status,409);
    assert.deepEqual((await current('contacts',contacts)).map(row=>[row.revision,row.data.lifecycle]),contacts.map(row=>[row.revision,'Lead']));

    // Replace a standard select on every selected Contact, attributed to the actor.
    const lifecycle=await edit('contacts',contacts,'lifecycle','replace','Customer');
    assert.deepEqual(lifecycle,{status:200,body:{changed:3}});
    let rows=await current('contacts',contacts);
    for(const [index,row] of rows.entries()){
      assert.deepEqual([row.revision,row.data.lifecycle,row.data.name,row.data.email],
        [contacts[index].revision+1,'Customer',contacts[index].data.name,contacts[index].data.email]);
      const [event]=await sql`SELECT actor_id FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${row.id} AND revision=${row.revision}`;
      assert.equal(event.actor_id,ownerId);
    }
    assert.deepEqual(await edit('contacts',rows,'lifecycle','replace','Customer'),{status:200,body:{changed:0}});
    assert.deepEqual((await current('contacts',rows)).map(row=>row.revision),rows.map(row=>row.revision));
    assert.deepEqual(Array.from(await runs()),[],'private bulk lifecycle edits do not capture workflows');

    // Multiple-choice custom properties support add, remove and clear.
    assert.deepEqual((await edit('contacts',rows,tagField,'append',['North','South'])).body,{changed:3});
    rows=await current('contacts',rows);
    assert.ok(rows.every(row=>JSON.stringify(row.data.custom?.[tags.id])===JSON.stringify(['North','South'])));
    assert.equal((await edit('contacts',rows,tagField,'replace')).status,400);
    assert.deepEqual((await current('contacts',rows)).map(row=>[row.revision,row.data.custom?.[tags.id]]),
      rows.map(row=>[row.revision,['North','South']]));
    assert.deepEqual((await edit('contacts',rows,tagField,'append',['South','East'])).body,{changed:3});
    rows=await current('contacts',rows);
    assert.deepEqual(rows[0].data.custom[tags.id],['North','South','East']);
    assert.deepEqual((await edit('contacts',rows,tagField,'remove',['North'])).body,{changed:3});
    rows=await current('contacts',rows);
    assert.deepEqual(rows[1].data.custom[tags.id],['South','East']);
    assert.equal((await edit('contacts',rows,tagField,'append',['Nowhere'])).status,400);
    assert.deepEqual((await edit('contacts',rows,tagField,'clear')).body,{changed:3});
    rows=await current('contacts',rows);
    assert.ok(rows.every(row=>row.data.custom?.[tags.id]===undefined));

    const dateProperty=await send('/api/custom-properties',{action:'create',kind:'contacts',label:marker+' review time',type:'datetime'});
    assert.equal(dateProperty.status,201,await dateProperty.clone().text());
    reviewTime=(await dateProperty.json()).property.id;
    const dateField='custom:'+reviewTime;
    assert.equal((await edit('contacts',rows,dateField,'replace','2026-11-12T13:30')).status,400);
    assert.deepEqual((await edit('contacts',rows,dateField,'replace','2026-11-12T18:30:00.000Z')).body,{changed:3});
    rows=await current('contacts',rows);
    assert.ok(rows.every(row=>row.data.custom?.[reviewTime]==='2026-11-12T18:30:00.000Z'));

    // A standard text extension can be set and cleared.
    assert.deepEqual((await edit('contacts',rows,'department','replace','Fictional operations')).body,{changed:3});
    rows=await current('contacts',rows);
    assert.ok(rows.every(row=>row.data.department==='Fictional operations'));
    assert.deepEqual((await edit('contacts',rows,'department','clear')).body,{changed:3});
    rows=await current('contacts',rows);
    assert.ok(rows.every(row=>!row.data.department));

    // Deals keep their stage when another property changes.
    assert.deepEqual(await edit('deals',deals,'amount','replace',250),{status:200,body:{changed:2}});
    for(const deal of await current('deals',deals)){
      assert.deepEqual([deal.data.amount,deal.data.stage,deal.pipelineId],[250,'Qualified to buy',null]);
    }
    assert.equal((await edit('deals',await current('deals',deals),'amount','replace','not a number')).status,400);

    // Shared editors edit through their grant; the change is attributed to them.
    const scoped=crm+'?'+new URLSearchParams({workspaceId,grantId:sharing.grantId});
    const sharedEdit=await edit('contacts',rows,'leadStatus','replace','Open',other,scoped);
    assert.deepEqual(sharedEdit,{status:200,body:{changed:3}});
    for(const row of await current('contacts',rows)){
      assert.equal(row.data.leadStatus,'Open');
      const [event]=await sql`SELECT actor_id FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${row.id} AND revision=${row.revision}`;
      assert.equal(event.actor_id,memberId);
    }
    assert.equal((await edit('contacts',rows,'leadStatus','replace','Open',other)).status,404,'no scope means the member’s own workspace');
    const [contact]=await current('contacts',rows.slice(0,1));
    assert.deepEqual(await edit('contacts',[contact],'lifecycle','replace','Lead',other,scoped),{status:200,body:{changed:1}});
    const lead=await read('contacts',contact.id);
    assert.deepEqual(await edit('contacts',[lead],'lifecycle','replace','Customer',other,scoped),{status:200,body:{changed:1}});
    const customer=await read('contacts',contact.id);
    assert.deepEqual(await edit('contacts',[customer],'lifecycle','replace','Customer',other,scoped),{status:200,body:{changed:0}});
    const receipts=(await runs()).map(run=>[run.contact_id,run.contact_revision,run.actor_id,run.kind,run.status]);
    assert.deepEqual(receipts,[[contact.id,customer.revision,memberId,'note','queued']]);
  }finally{
    const jobIds=(await runs()).flatMap(run=>run.job_id?[run.job_id]:[]);
    await sql`DELETE FROM portable_workflow_runs WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    if(jobIds.length)await sql`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=ANY(${jobIds}::uuid[])`;
    await sql`DELETE FROM portable_workflow_activations WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await sql`DELETE FROM portable_deal_workflows WHERE workspace_id=${workspaceId} AND id=${workflowId}`;
    for(const id of [tags.id,reviewTime].filter(Boolean)){
      await sql`UPDATE contacts SET data=data #- ${'{custom,'+id+'}'}::text[] WHERE workspace_id=${workspaceId} AND data->'custom' ? ${id}`;
      await sql`DELETE FROM portable_custom_properties WHERE id=${id}`;
    }
  }
  await reset();
}
