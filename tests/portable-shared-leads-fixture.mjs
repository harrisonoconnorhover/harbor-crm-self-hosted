import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Workspace viewers read shared Leads; editors also change and convert them.
export async function verifyPortableSharedLeads({request,origin,headers,other,sql,sharing}){
  const {workspaceId,grantId}=sharing;
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const send=(body,auth=headers,scope)=>request('/api/leads'+(scope?'?'+new URLSearchParams(scope):''),{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=(query,auth=headers)=>request('/api/leads?'+new URLSearchParams(query),{headers:auth});
  const marker='Shared lead '+randomUUID().slice(0,8);
  const created=await send({action:'save',data:{name:marker}});
  assert.equal(created.status,201,await created.clone().text());
  const {id}=await created.json();
  const scope={workspaceId,grantId};
  const history=(auth=headers,workspace)=>read({id,view:'history',...(workspace?{workspaceId:workspace}:{})},auth);

  assert.equal((await read({id},other)).status,404,'the member reads their own workspace without a scope');
  assert.equal((await history(other)).status,404);
  assert.equal((await history(other,randomUUID())).status,404);
  const shared=await read({id,workspaceId},other);
  assert.equal(shared.status,200);
  const lead=await shared.json();
  assert.equal(lead.data.name,marker);
  assert.ok((await (await read({search:marker,workspaceId},other)).json()).records.some(row=>row.id===id));
  assert.equal((await send({action:'save',id,expectedRevision:lead.revision,data:{name:marker+' edited'}},other)).status,404);
  assert.equal((await send({action:'save',id,expectedRevision:lead.revision,data:{name:marker+' edited'}},other,{workspaceId,grantId:randomUUID()})).status,403);
  const edited=await send({action:'save',id,expectedRevision:lead.revision,data:{name:marker+' edited'}},other,scope);
  assert.equal(edited.status,200,await edited.clone().text());
  assert.equal((await (await read({id})).json()).data.name,marker+' edited');

  // A viewer reads but can't change Leads.
  await sql`UPDATE portable_workspace_viewers SET role='viewer' WHERE id=${grantId}`;
  try{
    assert.equal((await read({id,workspaceId},other)).status,200);
    const viewed=await history(other,workspaceId);
    assert.equal(viewed.status,200);
    assert.equal(viewed.headers.get('cache-control'),'private, no-store');
    assert.deepEqual((await viewed.json()).entries.map(event=>event.revision),[2,1]);
    assert.equal((await send({action:'save',id,expectedRevision:lead.revision+1,data:{name:'Viewer edit'}},other,scope)).status,403);
    const page=await (await request('/?'+new URLSearchParams({kind:'leads',workspaceId,record:id}),{headers:other})).text();
    assert.match(page,/View only/);
    assert.match(page,/>Lead history</);
    assert.doesNotMatch(page,/>Save lead<|>Create deal</);
  }finally{await sql`UPDATE portable_workspace_viewers SET role='editor' WHERE id=${grantId}`;}

  // An editor converts the Lead into a Deal in the owner's workspace.
  const conversion={action:'convert',id,expectedRevision:lead.revision+1,dealName:marker+' deal'};
  const attempts=await Promise.all([send(conversion,other,scope),send(conversion,other,scope)]);
  assert.deepEqual(attempts.map(response=>response.status).sort(),[200,201]);
  const [first,second]=await Promise.all(attempts.map(response=>response.json()));
  const dealId=first.dealId;
  assert.ok(dealId);
  assert.equal(second.dealId,dealId,'both submissions return the same converted Deal');
  const [count]=await sql`SELECT count(*)::int AS total FROM deals WHERE workspace_id=${workspaceId} AND data->>'name'=${conversion.dealName}`;
  assert.equal(count.total,1,'the overlapping conversion creates one Deal');
  const [deal]=await sql`SELECT d.workspace_id,e.actor_id FROM deals d JOIN deal_events e ON e.workspace_id=d.workspace_id AND e.deal_id=d.id AND e.revision=1
    WHERE d.id=${dealId}`;
  const [{id:memberId,full_name:memberName}]=await sql`SELECT id,full_name FROM login_identities WHERE email='other@example.test'`;
  assert.deepEqual({...deal},{workspace_id:workspaceId,actor_id:memberId});
  const response=await history();
  assert.equal(response.status,200);
  const savedHistory=await response.json();
  assert.equal(savedHistory.next,null);
  assert.deepEqual(savedHistory.entries.map(event=>event.revision),[3,2,1],'a replay does not record another conversion');
  assert.deepEqual(savedHistory.entries.slice(0,2).map(event=>event.actorName),[memberName,memberName]);
  assert.equal(savedHistory.entries[0].data.dealId,dealId);
  assert.equal(savedHistory.entries[0].previous.dealId,null);
  assert.equal(savedHistory.entries[1].previous.data.name,marker);
  assert.equal(savedHistory.entries[1].data.data.name,marker+' edited');
  assert.doesNotMatch(JSON.stringify(savedHistory),/owner@example.test|other@example.test|actorId/);
  const page=await (await request('/?'+new URLSearchParams({kind:'leads',workspaceId}),{headers:other})).text();
  assert.match(page,/Shared workspace · Editor/);
  assert.match(page,new RegExp(marker+' edited'));
  const contactsPage=await (await request('/?'+new URLSearchParams({workspaceId}),{headers:other})).text();
  assert.match(contactsPage,new RegExp('href="/\\?kind=leads&amp;workspaceId='+workspaceId+'"'));
  await verifyPortableLeadOwnership({request,origin,headers,other,sql,sharing,existingId:id});
  return {id,dealId,actorId:memberId,conversion,savedHistory};
}

// Lead assignment uses the workspace assignee rules: the owner or an active editor, set by any editor.
export async function verifyPortableLeadOwnership({request,origin,headers,other,sql,sharing,existingId}){
  const {workspaceId,grantId}=sharing,scope={workspaceId,grantId};
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const send=(body,auth=headers,query)=>request('/api/leads'+(query?'?'+new URLSearchParams(query):''),{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async(query,auth=headers)=>{
    const response=await request('/api/leads?'+new URLSearchParams(query),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const label=row=>(row.full_name?.trim()||row.email).slice(0,100);
  const [ownerRow]=await sql`SELECT id,full_name,email FROM login_identities WHERE email='owner@example.test'`;
  const [memberRow]=await sql`SELECT id,full_name,email FROM login_identities WHERE email='other@example.test'`;
  const marker='Owned lead '+randomUUID().slice(0,8);

  // Existing Leads stay unassigned until someone edits their assignee.
  const existing=await read({id:existingId});
  assert.deepEqual([existing.assigneeId,existing.assigneeLabel],[null,null]);

  // The owner assigns at creation; an editor assigns the owner or themselves in the shared workspace.
  const create=async(name,assigneeId,auth=headers,query)=>{
    const response=await send({action:'save',data:{name:marker+' '+name},...(assigneeId===undefined?{}:{assigneeId})},auth,query);
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).id;
  };
  const mine=await create('mine',ownerRow.id);
  const theirs=await create('theirs',memberRow.id,other,scope);
  const open=[await create('open one'),await create('open two',null)];
  const owned=await read({id:mine});
  assert.deepEqual([owned.assigneeId,owned.assigneeLabel],[ownerRow.id,label(ownerRow)]);
  const delegated=await read({id:theirs});
  assert.deepEqual([delegated.assigneeId,delegated.assigneeLabel],[memberRow.id,label(memberRow)]);

  // All, My leads and Unassigned filter on the server and page with the existing cursor.
  const ids=page=>page.records.map(record=>record.id);
  const sorted=list=>[...list].sort();
  assert.deepEqual(sorted(ids(await read({search:marker}))),sorted([mine,theirs,...open]));
  assert.deepEqual(ids(await read({search:marker,owner:'mine'})),[mine]);
  assert.deepEqual(ids(await read({search:marker,owner:'mine',workspaceId},other)),[theirs],'My leads means the reader, not the owner');
  assert.deepEqual(ids(await read({search:marker,owner:'mine'},other)),[],'the member’s own workspace has none of these Leads');
  const first=await read({search:marker,owner:'unassigned',limit:'1'});
  assert.equal(first.records.length,1);
  assert.equal(first.next,first.records[0].id);
  const second=await read({search:marker,owner:'unassigned',limit:'1',after:first.next});
  assert.equal(second.next,null);
  assert.deepEqual(sorted([...ids(first),...ids(second)]),sorted(open));
  for(const query of [{owner:'someone'},{owner:ownerRow.id},{id:mine,owner:'mine'}]){
    assert.equal((await request('/api/leads?'+new URLSearchParams(query),{headers})).status,400);
  }

  // Changing and clearing are attributed to the actor; omitting assigneeId keeps the assignee.
  const current=await read({id:mine});
  const reassigned=await send({action:'save',id:mine,expectedRevision:current.revision,data:{name:current.data.name},assigneeId:memberRow.id},other,scope);
  assert.equal(reassigned.status,200,await reassigned.clone().text());
  assert.equal((await send({action:'save',id:mine,expectedRevision:current.revision,data:{name:current.data.name},assigneeId:null})).status,409,'a stale assignment is refused');
  const renamed=await send({action:'save',id:mine,expectedRevision:current.revision+1,data:{name:current.data.name+' renamed'}});
  assert.equal(renamed.status,200);
  assert.equal((await read({id:mine})).assigneeId,memberRow.id,'an omitted assignment keeps the assignee');
  assert.equal((await send({action:'save',id:mine,expectedRevision:current.revision+2,data:{name:current.data.name},assigneeId:null})).status,200);
  const cleared=await read({id:mine});
  assert.deepEqual([cleared.revision,cleared.assigneeId,cleared.assigneeLabel],[current.revision+3,null,null]);
  const history=await read({id:mine,view:'history'});
  assert.deepEqual(history.entries.map(entry=>[entry.revision,entry.actorName,entry.data.assigneeId]),[
    [4,ownerRow.full_name,null],[3,ownerRow.full_name,memberRow.id],[2,memberRow.full_name,memberRow.id],[1,ownerRow.full_name,ownerRow.id]]);
  assert.equal(history.entries[2].previous.assigneeId,ownerRow.id);
  assert.equal(history.entries[2].data.assigneeLabel,label(memberRow));

  // Viewers, foreign members, stale grants and non-members can't assign.
  const target=await read({id:theirs});
  const attempt=(assigneeId,auth=headers,query)=>send({action:'save',id:theirs,expectedRevision:target.revision,data:{name:target.data.name},assigneeId},auth,query);
  assert.equal((await attempt(memberRow.id,other)).status,404,'without a grant scope the member writes only their own workspace');
  assert.equal((await attempt(memberRow.id,other,{workspaceId,grantId:randomUUID()})).status,403);
  assert.equal((await attempt(randomUUID())).status,409,'an unknown identity is not an assignee');
  await sql`UPDATE portable_workspace_viewers SET role='viewer' WHERE id=${grantId}`;
  try{
    assert.equal((await attempt(ownerRow.id,other,scope)).status,403,'a viewer can’t assign');
    assert.equal((await attempt(memberRow.id)).status,409,'a viewer can’t be assigned');
    const kept=await read({id:theirs,workspaceId},other);
    assert.deepEqual([kept.revision,kept.assigneeId,kept.assigneeLabel],[target.revision,memberRow.id,label(memberRow)],
      'losing editor access keeps the saved assignment');
    assert.deepEqual(ids(await read({search:marker,owner:'mine',workspaceId},other)),[theirs]);
    const page=await (await request('/?'+new URLSearchParams({kind:'leads',workspaceId,record:theirs}),{headers:other})).text();
    assert.match(page,/Assignee · /);
    assert.doesNotMatch(page,/name="assigneeId"/);
    const ownerPage=await (await request('/?'+new URLSearchParams({kind:'leads',record:theirs}),{headers})).text();
    assert.match(ownerPage,/\(unavailable\)/,'the owner sees the former editor as an unavailable assignee');
    const renamedOnly=await send({action:'save',id:theirs,expectedRevision:target.revision,data:{name:target.data.name+' kept'}});
    assert.equal(renamedOnly.status,200);
    assert.equal((await read({id:theirs})).assigneeId,memberRow.id);
  }finally{await sql`UPDATE portable_workspace_viewers SET role='editor' WHERE id=${grantId}`;}

  // Events saved before assignment existed still read, as unassigned, and keep later saves intact.
  const legacy=open[0];
  await sql`UPDATE portable_lead_events SET data=data-'assigneeId'-'assigneeLabel' WHERE workspace_id=${workspaceId} AND lead_id=${legacy}`;
  const oldHistory=await read({id:legacy,view:'history'});
  assert.deepEqual(oldHistory.entries.map(entry=>[entry.revision,entry.previous,entry.data.assigneeId,entry.data.assigneeLabel]),[[1,null,null,null]]);
  const legacyLead=await read({id:legacy});
  assert.equal((await send({action:'save',id:legacy,expectedRevision:legacyLead.revision,data:{name:legacyLead.data.name},assigneeId:ownerRow.id})).status,200);
  const upgraded=await read({id:legacy,view:'history'});
  assert.deepEqual(upgraded.entries.map(entry=>[entry.revision,entry.previous?.assigneeId,entry.data.assigneeId]),[[2,null,ownerRow.id],[1,undefined,null]]);

  // Lists show the assignee; conversion keeps it on the Lead and doesn't copy it to the Deal.
  const list=await (await request('/?'+new URLSearchParams({kind:'leads',search:marker}),{headers})).text();
  assert.match(list,/<th>Assignee<\/th>/);
  assert.match(list,/>Unassigned</);
  const minePage=await request('/?'+new URLSearchParams({kind:'leads',search:marker,owner:'mine'}),{headers});
  assert.equal(minePage.status,200);
  const mineHtml=await minePage.text();
  assert.ok(mineHtml.includes(marker+' open one'));
  assert.ok(!mineHtml.includes(marker+' theirs kept'));
  const unassignedPage=await request('/?'+new URLSearchParams({kind:'leads',search:marker,owner:'unassigned'}),{headers});
  assert.equal(unassignedPage.status,200);
  const unassignedHtml=await unassignedPage.text();
  assert.ok(unassignedHtml.includes(marker+' open two'));
  assert.ok(!unassignedHtml.includes(marker+' open one'));

  const assigned=await read({id:legacy});
  const converted=await send({action:'convert',id:legacy,expectedRevision:assigned.revision,dealName:marker+' deal'});
  assert.equal(converted.status,201);
  const {dealId}=await converted.json();
  const after=await read({id:legacy});
  assert.deepEqual([after.data.leadStage,after.dealId,after.assigneeId],['Qualified',dealId,ownerRow.id]);
  const [deal]=await sql`SELECT data FROM deals WHERE workspace_id=${workspaceId} AND id=${dealId}`;
  assert.equal(deal.data.recordOwner,undefined);
}
