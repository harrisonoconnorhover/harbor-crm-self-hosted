import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const crm='/api/crm',mergePath='/api/record-merge';

export async function verifyPortableCompanyMerge({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const create=async(path,body)=>{
    const response=await send(path,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    const result=await response.json();
    return result.record??result;
  };
  const read=async path=>{
    const response=await request(path,{headers});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const call=async(body,auth=headers,path=mergePath)=>{
    const response=await send(path,body,auth);
    const result=await response.json();
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return {status:response.status,...result};
  };
  const preview=(primary,secondary,auth,path)=>call({action:'preview',kind:'companies',primaryId:primary.id,secondaryId:secondary.id},auth,path);
  const commit=(review,choices={},requestId=randomUUID(),auth,path)=>call({action:'merge',kind:'companies',primaryId:review.primary.id,
    secondaryId:review.secondary.id,requestId,expectedRevisions:{primary:review.primary.revision,secondary:review.secondary.revision},choices},auth,path);
  const [{id:ownerId}]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  const [{id:memberId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;

  const marker='Merge '+randomUUID();
  const created=await send('/api/custom-properties',{action:'create',kind:'companies',label:marker+' region',type:'text'});
  assert.equal(created.status,201,await created.clone().text());
  const region=(await created.json()).property,regionField='custom:'+region.id;
  try{
    const keep=await create(crm,{kind:'companies',data:{name:marker+' keep',industry:'Fictional software'}});
    const domain='merge-'+randomUUID().slice(0,8)+'.example.test';
    const duplicate=await create(crm,{kind:'companies',data:{name:marker+' duplicate',domain,industry:'Fictional retail',city:'Fictional City',
      custom:{[region.id]:'North'}}});
    await sql`UPDATE companies SET created_at='2019-01-01T00:00:00Z' WHERE workspace_id=${workspaceId} AND id=${duplicate.id}`;
    const contact=await create(crm,{kind:'contacts',primaryCompanyId:duplicate.id,data:{name:marker+' contact'}});
    const dormant=await create(crm,{kind:'contacts',primaryCompanyId:duplicate.id,data:{name:marker+' archived contact'}});
    const archived=await send('/api/recycle-bin',{action:'archive',id:dormant.id,expectedRevision:dormant.revision,requestId:randomUUID()});
    assert.equal(archived.status,200,await archived.clone().text());
    const deal=await create(crm,{kind:'deals',companyId:duplicate.id,data:{name:marker+' deal'}});
    const task=await create(crm,{kind:'tasks',related:{kind:'companies',id:duplicate.id},data:{name:marker+' task'}});
    const lead=await create('/api/leads',{companyId:duplicate.id,data:{name:marker+' lead'}});
    const ticket=await create('/api/tickets',{companyId:duplicate.id,data:{name:marker+' ticket'}});
    const activityId=randomUUID();
    assert.equal((await send('/api/logged-activities?'+new URLSearchParams({kind:'companies',recordId:duplicate.id}),
      {id:activityId,kind:'Note',occurredAt:Date.now()-1000,summary:'Fictional merged Company note'})).status,201);
    const contactLinks='/api/associations?'+new URLSearchParams({kind:'contacts',id:contact.id});
    for(const [id,labels] of [[keep.id,['Buyer']],[duplicate.id,['Billing']]]){
      assert.equal((await send(contactLinks,{action:'link',target:{kind:'companies',id},labels})).status,200);
    }
    assert.equal((await send('/api/associations?'+new URLSearchParams({kind:'companies',id:keep.id}),
      {action:'link',target:{kind:'companies',id:duplicate.id},labels:['Duplicate']})).status,200);

    // Input, origin and ownership checks.
    assert.equal((await request(mergePath,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,401);
    assert.equal((await send(mergePath,{action:'preview',kind:'companies',primaryId:keep.id,secondaryId:duplicate.id},headers,'https://outside.example.test')).status,403);
    assert.equal((await preview(keep,keep)).status,400);
    assert.equal((await preview(keep,contact)).status,404,'a Contact is not a Company');
    assert.equal((await preview(keep,duplicate,other)).status,404,'no scope means the member’s own workspace');

    let review=(await preview(keep,duplicate)).preview;
    assert.deepEqual([review.primary.id,review.secondary.id],[keep.id,duplicate.id]);
    assert.equal(review.secondary.createdAt,'2019-01-01T00:00:00.000Z');
    assert.deepEqual([review.defaults.name,review.defaults.domain,review.defaults.city,review.defaults.industry,review.defaults[regionField]],
      ['primary','secondary','secondary','primary','secondary']);
    assert.deepEqual(review.counts,{contacts:2,deals:1,leads:1,tickets:1,tasks:1,activities:1,associations:2});

    // A newer edit to either Company makes the review stale and changes nothing.
    const edited=await send(crm,{action:'save',kind:'companies',id:keep.id,expectedRevision:keep.revision,data:{...keep.data,website:'https://keep.example.test'}});
    assert.equal(edited.status,200,await edited.clone().text());
    assert.equal((await commit(review)).status,409);
    assert.equal((await read(crm+'?kind=contacts&id='+contact.id)).primaryCompanyId,duplicate.id);
    assert.equal((await commit({...(await preview(keep,duplicate)).preview},{notAField:'secondary'})).status,409);

    review=(await preview(keep,duplicate)).preview;
    const requestId=randomUUID();
    const merged=await commit(review,{name:'secondary',industry:'primary'},requestId);
    assert.equal(merged.status,200,JSON.stringify(merged));
    assert.deepEqual(merged.receipt,{primaryId:keep.id,secondaryId:duplicate.id,revision:review.primary.revision+1,
      moved:{contacts:2,deals:1,leads:1,tickets:1,tasks:1,activities:1,associations:2}});

    // The kept Company has the chosen values, its newer edit and the oldest creation date.
    const kept=await read(crm+'?kind=companies&id='+keep.id);
    assert.deepEqual([kept.revision,kept.data.name,kept.data.domain,kept.data.city,kept.data.industry,kept.data.website,kept.data.custom?.[region.id]],
      [review.primary.revision+1,marker+' duplicate',domain,'Fictional City','Fictional software','https://keep.example.test','North']);
    assert.equal(new Date(kept.createdAt).toISOString(),'2019-01-01T00:00:00.000Z');
    assert.equal((await request(crm+'?kind=companies&id='+duplicate.id,{headers})).status,404);
    const [gone]=await sql`SELECT archived_at,merged_into_id FROM companies WHERE workspace_id=${workspaceId} AND id=${duplicate.id}`;
    assert.ok(gone.archived_at);
    assert.equal(gone.merged_into_id,keep.id);

    // Every linked record now points at the kept Company, with attributed history.
    const movedContact=await read(crm+'?kind=contacts&id='+contact.id);
    assert.deepEqual([movedContact.primaryCompanyId,movedContact.revision],[keep.id,contact.revision+1]);
    const [contactEvent]=await sql`SELECT actor_id,previous_primary_company_id,primary_company_id FROM contact_events
      WHERE workspace_id=${workspaceId} AND contact_id=${contact.id} AND revision=${movedContact.revision}`;
    assert.deepEqual({...contactEvent},{actor_id:ownerId,previous_primary_company_id:duplicate.id,primary_company_id:keep.id});
    const [dormantRow]=await sql`SELECT primary_company_id,revision FROM contacts WHERE workspace_id=${workspaceId} AND id=${dormant.id}`;
    assert.deepEqual([dormantRow.primary_company_id,dormantRow.revision],[keep.id,dormant.revision+1],'archived Contact keeps its archive revision');
    assert.equal((await read(crm+'?kind=deals&id='+deal.id)).companyId,keep.id);
    assert.equal((await read(crm+'?kind=tasks&id='+task.id)).companyId,keep.id);
    assert.equal((await read('/api/leads?id='+lead.id)).companyId,keep.id);
    const leadHistory=await read('/api/leads?view=history&id='+lead.id);
    assert.deepEqual(leadHistory.entries.map(event=>event.revision),[2,1]);
    assert.equal(leadHistory.entries[0].previous.companyId,duplicate.id);
    assert.equal(leadHistory.entries[0].data.companyId,keep.id);
    const movedTicket=await read('/api/tickets?id='+ticket.id);
    assert.deepEqual([movedTicket.companyId,movedTicket.companyName],[keep.id,marker+' duplicate']);
    const [activity]=await sql`SELECT company_id FROM portable_record_activities WHERE workspace_id=${workspaceId} AND id=${activityId}`;
    assert.equal(activity.company_id,keep.id);
    const contactItems=(await read(contactLinks)).items;
    assert.deepEqual(contactItems.map(item=>[item.target.id,item.labels]),[[keep.id,['Billing','Buyer']]]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM portable_associations WHERE workspace_id=${workspaceId}
      AND (first_id=${duplicate.id} OR second_id=${duplicate.id})`)[0].n,0);

    // The merged Company is not in the Recycle Bin and can't be restored.
    const bin=await read('/api/recycle-bin?kind=companies');
    assert.ok(!bin.records.some(row=>row.id===duplicate.id));
    assert.equal((await send('/api/recycle-bin',{kind:'companies',action:'restore',id:duplicate.id,
      expectedRevision:review.secondary.revision+1,requestId:randomUUID()})).status,404);
    assert.equal((await send(crm,{action:'save',kind:'deals',id:deal.id,expectedRevision:(await read(crm+'?kind=deals&id='+deal.id)).revision,
      companyId:duplicate.id,data:{name:marker+' deal'}})).status,404,'a stale form can’t relink the merged Company');

    // A lost-response retry replays the receipt without a second change.
    assert.deepEqual((await commit(review,{name:'secondary',industry:'primary'},requestId)).receipt,merged.receipt);
    assert.equal((await read(crm+'?kind=companies&id='+keep.id)).revision,kept.revision);
    const third=await create(crm,{kind:'companies',data:{name:marker+' third'}});
    assert.equal((await commit({primary:kept,secondary:third},{},requestId)).status,409,'a request ID belongs to one merge');

    // Shared editors merge through their grant; the change is attributed to them.
    const scoped=mergePath+'?'+new URLSearchParams({workspaceId,grantId:sharing.grantId});
    assert.equal((await preview(kept,third,other,mergePath+'?'+new URLSearchParams({workspaceId,grantId:randomUUID()}))).status,403);
    const [grant]=await sql`SELECT record_activities FROM portable_workspace_viewers WHERE id=${sharing.grantId}`;
    await sql`UPDATE portable_workspace_viewers SET record_activities=false WHERE id=${sharing.grantId}`;
    try{
      assert.equal((await preview(third,kept,other,scoped)).status,403);
      assert.equal((await commit({primary:third,secondary:kept},{},randomUUID(),other,scoped)).status,403);
      await sql`UPDATE portable_workspace_viewers SET record_activities=true WHERE id=${sharing.grantId}`;
      const sharedReview=(await preview(third,kept,other,scoped)).preview;
      const sharedMerge=await commit(sharedReview,{},randomUUID(),other,scoped);
      assert.equal(sharedMerge.status,200,JSON.stringify(sharedMerge));
    }finally{
      await sql`UPDATE portable_workspace_viewers SET record_activities=${grant.record_activities} WHERE id=${sharing.grantId}`;
    }
    const [sharedEvent]=await sql`SELECT actor_id FROM company_events WHERE workspace_id=${workspaceId} AND company_id=${third.id} AND revision=${third.revision+1}`;
    assert.equal(sharedEvent.actor_id,memberId);
    assert.equal((await read(crm+'?kind=contacts&id='+contact.id)).primaryCompanyId,third.id,'links follow a second merge');

    // The list page offers the merge once two Companies are selected.
    const page=await (await request('/?'+new URLSearchParams({kind:'companies',search:marker}),{headers})).text();
    assert.match(page,new RegExp('aria-label="Select '+marker+' third"'));
    return {primaryId:third.id,secondaryIds:[duplicate.id,keep.id],contactId:contact.id};
  }finally{
    await sql`UPDATE companies SET data=data #- ${'{custom,'+region.id+'}'}::text[] WHERE workspace_id=${workspaceId} AND data->'custom' ? ${region.id}`;
    await sql`DELETE FROM portable_custom_properties WHERE id=${region.id}`;
    await reset();
  }
}

// After a second-instance restore the merged Companies stay merged and links stay moved.
export async function verifyRestoredPortableCompanyMerge({restored,origin,owner,fixture}){
  const read=async path=>{
    const response=await restored(path,{headers:owner});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  assert.equal((await read(crm+'?kind=companies&id='+fixture.primaryId)).id,fixture.primaryId);
  for(const id of fixture.secondaryIds){
    assert.equal((await restored(crm+'?kind=companies&id='+id,{headers:owner})).status,404);
    const response=await restored('/api/recycle-bin',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
      body:JSON.stringify({kind:'companies',action:'restore',id,expectedRevision:1,requestId:randomUUID()})});
    assert.equal(response.status,404);
  }
  assert.ok(!(await read('/api/recycle-bin?kind=companies')).records.some(row=>fixture.secondaryIds.includes(row.id)));
  assert.equal((await read(crm+'?kind=contacts&id='+fixture.contactId)).primaryCompanyId,fixture.primaryId);
}
